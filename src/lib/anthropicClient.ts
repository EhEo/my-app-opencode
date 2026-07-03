import type OpenAI from "openai";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** OpenAI-shaped streaming chunk — the only shape agent.ts's for-await loop
 *  reads from (choices[0].delta.content / .tool_calls[].index/id/function). */
export interface LlmStreamChunk {
  choices?: Array<{
    delta: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

function safeParseToolArgs(raw: string | null | undefined): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Translate an OpenAI chat message array into Anthropic's shape: the system
 *  message is pulled out into a separate string, and consecutive tool-role
 *  messages (one per tool call in a turn) are merged into a single user
 *  message with multiple tool_result blocks — Anthropic requires strict
 *  user/assistant alternation and rejects back-to-back user messages. */
export function toAnthropicMessages(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): { system: string | undefined; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicToolResultBlock[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    out.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string") systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: typeof m.content === "string" ? m.content : "",
      });
      continue;
    }
    flushToolResults();
    if (m.role === "assistant") {
      const toolCalls = m.tool_calls ?? [];
      if (toolCalls.length > 0) {
        const blocks: AnthropicContentBlock[] = [];
        if (typeof m.content === "string" && m.content.length > 0) {
          blocks.push({ type: "text", text: m.content });
        }
        for (const tc of toolCalls) {
          if (tc.type !== "function") continue;
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: safeParseToolArgs(tc.function.arguments),
          });
        }
        out.push({ role: "assistant", content: blocks });
        continue;
      }
      out.push({
        role: "assistant",
        content: typeof m.content === "string" ? m.content : "",
      });
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : "" });
    }
  }
  flushToolResults();

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

/** Translate OpenAI function-tool schemas into Anthropic's tool shape. */
export function toAnthropicTools(
  tools: OpenAI.Chat.Completions.ChatCompletionTool[],
): AnthropicTool[] {
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters ?? { type: "object", properties: {} }) as Record<
        string,
        unknown
      >,
    }));
}

interface AnthropicContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: { type: string; id?: string; name?: string };
}
interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: string };
}
export type AnthropicStreamEvent =
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | { type: string; [key: string]: unknown };

interface AnthropicErrorEvent {
  type: "error";
  error: { type?: string; message?: string };
}
function isAnthropicErrorEvent(data: unknown): data is AnthropicErrorEvent {
  return (
    typeof data === "object" && data !== null && (data as { type?: unknown }).type === "error"
  );
}

/** Convert one parsed Anthropic SSE event into an OpenAI-shaped chunk, or
 *  null if the event carries nothing agent.ts's loop reads (message_start,
 *  content_block_stop, message_delta, message_stop, ping, text
 *  content_block_start). Stateless: Anthropic already tags every start/delta
 *  event with the content block `index`, so no cross-event accumulation is
 *  needed here — agent.ts's own tool_calls accumulator keys off that index. */
export function anthropicEventToChunk(data: AnthropicStreamEvent): LlmStreamChunk | null {
  if (data.type === "content_block_start") {
    const start = data as AnthropicContentBlockStartEvent;
    if (start.content_block.type === "tool_use") {
      return {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: start.index,
                  id: start.content_block.id,
                  function: { name: start.content_block.name },
                },
              ],
            },
          },
        ],
      };
    }
    return null;
  }
  if (data.type === "content_block_delta") {
    const d = data as AnthropicContentBlockDeltaEvent;
    if (d.delta.type === "text_delta") {
      return { choices: [{ delta: { content: (d.delta as { text: string }).text } }] };
    }
    if (d.delta.type === "input_json_delta") {
      return {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: d.index,
                  function: { arguments: (d.delta as { partial_json: string }).partial_json },
                },
              ],
            },
          },
        ],
      };
    }
    return null;
  }
  return null;
}

/** Parse one raw SSE line into a chunk, or null/throw. Shared by
 *  parseAnthropicSSEText (tests) and the real streaming reader (Task 2). */
function chunkFromSSELine(line: string): LlmStreamChunk | null {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith("data:")) return null;
  const jsonText = trimmed.slice(5).trim();
  if (jsonText.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (isAnthropicErrorEvent(data)) {
    throw new Error(data.error.message ?? "Anthropic stream error");
  }
  return anthropicEventToChunk(data as AnthropicStreamEvent);
}

/** Parse a full raw SSE text blob into a sequence of OpenAI-shaped chunks.
 *  Pure and network-free — used for testing the event-translation logic
 *  end-to-end without mocking fetch/ReadableStream. */
export function parseAnthropicSSEText(text: string): LlmStreamChunk[] {
  const out: LlmStreamChunk[] = [];
  for (const line of text.split("\n")) {
    const chunk = chunkFromSSELine(line);
    if (chunk !== null) out.push(chunk);
  }
  return out;
}
