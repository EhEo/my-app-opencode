import type OpenAI from "openai";
import { invoke } from "@tauri-apps/api/core";
import { fs } from "./fs";
import { callTool as mcpCallTool, getAgentTools as getMcpAgentTools } from "./mcp";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

const BUILTIN_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full text content of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write full text content to a file (creates or overwrites). Use this to apply edits.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." },
          content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List entries of a directory in the workspace (dirs first, then files).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path; defaults to root.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the workspace root. Returns stdout, stderr, and exitCode.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
        },
        required: ["command"],
      },
    },
  },
];

export function getAgentTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [...BUILTIN_TOOLS, ...getMcpAgentTools()];
}

export const agentTools: OpenAI.Chat.Completions.ChatCompletionTool[] = BUILTIN_TOOLS;

export function isWriteTool(name: string): boolean {
  return name === "write_file";
}

const MAX_READ_CHARS = 50_000;

interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function coerceArgs(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw
    ? (raw as Record<string, unknown>)
    : {};
}

export async function executeTool(
  name: string,
  rawArgs: unknown,
): Promise<{ result: string; changedPath?: string; error?: string }> {
  const args = coerceArgs(rawArgs);
  try {
    switch (name) {
      case "read_file": {
        const path = String(args.path ?? "");
        const content = await fs.readFile(path);
        const result =
          content.length > MAX_READ_CHARS
            ? content.slice(0, MAX_READ_CHARS) +
              `\n...[truncated ${content.length - MAX_READ_CHARS} chars]`
            : content;
        return { result };
      }
      case "write_file": {
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");
        await fs.writeFile(path, content);
        // changedPath stays workspace-relative; App resolves it against the
        // workspace root to match its absolute tab keys.
        return { result: `Wrote ${path}`, changedPath: path };
      }
      case "list_dir": {
        const path = String(args.path ?? ".");
        const entries = await fs.listDir(path);
        const sorted = [...entries].sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const result = sorted
          .map((e) => `${e.isDir ? "[dir]" : "[file]"} ${e.name}`)
          .join("\n");
        return { result };
      }
      case "run_command": {
        const command = String(args.command ?? "");
        const r = await invoke<RunCommandResult>("run_command", { command });
        const cap = (s: string): string =>
          s.length > MAX_READ_CHARS
            ? s.slice(0, MAX_READ_CHARS) +
              `\n...[truncated ${s.length - MAX_READ_CHARS} chars]`
            : s;
        const result = `exitCode: ${r.exitCode}\n--- stdout ---\n${cap(
          r.stdout,
        )}\n--- stderr ---\n${cap(r.stderr)}`;
        return { result };
      }
      default:
        if (name.startsWith("mcp__")) {
          return await mcpCallTool(name, args);
        }
        return { result: `ERROR: unknown tool ${name}` };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { result: `ERROR: ${message}`, error: message };
  }
}
