import type OpenAI from "openai";
import { createClient } from "./llm";
import { getAgentTools, executeTool } from "./tools";
import { loadProviderStore } from "./settings";
import {
  buildSkillsPrompt,
  loadAllInstalledSkills,
  type InstalledSkill,
} from "./skills";
import type { Settings } from "./settings";
import type { ToolCall } from "./tools";

export type { Settings } from "./settings";
export type { ToolCall } from "./tools";
export { isWriteTool } from "./tools";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface AgentCallbacks {
  onToken(delta: string): void;
  onAssistantText(content: string): void;
  onToolStart(call: ToolCall): void;
  onToolEnd(call: ToolCall, result: string, error?: string): void;
  onFileChanged(path: string): void;
  onDone(reason: "completed" | "aborted" | "max_iterations", finalMessages?: ChatMessage[]): void;
  onError(err: Error): void;
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are opencode-desktop's AI coding assistant. You operate inside the user's workspace and can use tools: read_file, write_file, list_dir, run_command. Read files before editing, make minimal targeted changes, and verify with run_command when relevant. Be concise. When the task is done, respond with a short summary and no further tool calls.";

export interface RunAgentOptions {
  settings: Settings;
  systemPrompt?: string;
  messages: ChatMessage[];
  callbacks: AgentCallbacks;
  signal?: AbortSignal;
  maxIterations?: number;
}

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type StreamChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

function toOpenAIMessage(m: ChatMessage): OpenAIMessage {
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant" as const,
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    };
  }
  if (m.role === "tool") {
    return {
      role: "tool" as const,
      tool_call_id: m.toolCallId ?? "",
      content: m.content,
    };
  }
  if (m.role === "user") {
    return { role: "user" as const, content: m.content };
  }
  if (m.role === "system") {
    return { role: "system" as const, content: m.content };
  }
  return { role: "assistant" as const, content: m.content || null };
}

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && raw) return raw as Record<string, unknown>;
  return {};
}

export async function runAgent(opts: RunAgentOptions): Promise<void> {
  const { settings, callbacks } = opts;
  // Hoisted so the catch handler can hand the partial history to onDone on abort.
  const working: ChatMessage[] = opts.messages.map((m) => ({ ...m }));
  try {
    const client = createClient(settings);
    let sys = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    try {
      const store = await loadProviderStore();
      const enabledMap = store.skills ?? {};
      const installedSkills: InstalledSkill[] =
        await loadAllInstalledSkills();
      const skillsBlock = buildSkillsPrompt(installedSkills, enabledMap);
      if (skillsBlock.length > 0) {
        sys = sys + "\n\n" + skillsBlock;
      }
    } catch {
      void 0;
    }
    const maxIter = opts.maxIterations ?? 25;

    for (let iter = 0; iter < maxIter; iter++) {
      if (opts.signal?.aborted) {
        callbacks.onDone("aborted", working);
        return;
      }

      const requestMessages: OpenAIMessage[] = [
        { role: "system", content: sys },
        ...working.map(toOpenAIMessage),
      ];

      const stream = await client.chat.completions.create(
        {
          model: settings.model,
          messages: requestMessages,
          tools: getAgentTools(),
          stream: true,
        },
        opts.signal ? { signal: opts.signal } : undefined,
      );

      let content = "";
      const toolAcc: Record<number, { id: string; name: string; args: string }> =
        {};

      for await (const chunk of stream as AsyncIterable<StreamChunk>) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta.content) {
          content += delta.content;
          callbacks.onToken(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            const slot =
              toolAcc[idx] ?? (toolAcc[idx] = { id: "", name: "", args: "" });
            if (tc.id) slot.id += tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
        }
      }

      const finalToolCalls: ToolCall[] = Object.keys(toolAcc)
        .map(Number)
        .sort((a, b) => a - b)
        .map((idx) => {
          const t = toolAcc[idx];
          return { id: t.id, name: t.name, args: safeParseArgs(t.args) };
        });

      if (finalToolCalls.length === 0) {
        callbacks.onAssistantText(content);
        // Persist the final assistant turn into history — without this it is
        // shown in the UI but dropped from `messages`, so the next turn loses it.
        working.push({ role: "assistant", content });
        callbacks.onDone("completed", working);
        return;
      }

      // Finalize any text streamed alongside the tool calls so its UI bubble
      // stops rendering as perpetually "streaming".
      if (content.length > 0) {
        callbacks.onAssistantText(content);
      }
      working.push({ role: "assistant", content, toolCalls: finalToolCalls });

      for (const call of finalToolCalls) {
        callbacks.onToolStart(call);
        try {
          const { result, changedPath, error } = await executeTool(
            call.name,
            call.args,
          );
          callbacks.onToolEnd(call, result, error);
          if (changedPath) callbacks.onFileChanged(changedPath);
          working.push({
            role: "tool",
            toolCallId: call.id,
            content: result,
          });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          callbacks.onToolEnd(call, "", errMsg);
          working.push({
            role: "tool",
            toolCallId: call.id,
            content: "ERROR: " + errMsg,
          });
        }
      }
    }

    callbacks.onDone("max_iterations", working);
  } catch (err) {
    // A user Stop (AbortSignal) surfaces here as a thrown abort error. Treat it
    // as a clean "aborted" completion rather than an error card, and keep the
    // partial history so this turn's tool records aren't lost.
    if (opts.signal?.aborted) {
      callbacks.onDone("aborted", working);
      return;
    }
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
