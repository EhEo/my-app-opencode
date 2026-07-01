import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { createTauriFetch } from "./tauriFetch";
import type { McpServerEntry } from "./settings";

const tauriFetch = createTauriFetch();

const NAMESPACE_PREFIX = "mcp__";

interface ConnectedServer {
  client: Client;
  tools: McpTool[];
}

interface McpManagerState {
  servers: Map<string, ConnectedServer>;
  status: Map<string, "connecting" | "connected" | "error" | "disabled">;
  errors: Map<string, string>;
}

const state: McpManagerState = {
  servers: new Map(),
  status: new Map(),
  errors: new Map(),
};

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface McpServerStatus {
  name: string;
  url: string;
  enabled: boolean;
  status: "connecting" | "connected" | "error" | "disabled";
  error: string | null;
  toolCount: number;
}

export function getStatuses(): McpServerStatus[] {
  return Array.from(state.status.entries()).map(([name, status]) => ({
    name,
    url: state.servers.get(name) ? "" : "",
    enabled: status !== "disabled",
    status,
    error: state.errors.get(name) ?? null,
    toolCount: state.servers.get(name)?.tools.length ?? 0,
  }));
}

function namespacedName(server: string, tool: string): string {
  return `${NAMESPACE_PREFIX}${server}__${tool}`;
}

function parseNamespacedName(
  full: string,
): { server: string; tool: string } | null {
  if (!full.startsWith(NAMESPACE_PREFIX)) return null;
  const rest = full.slice(NAMESPACE_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep === -1) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

function mcpToolToOpenAiTool(
  server: string,
  tool: McpTool,
): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: namespacedName(server, tool.name),
      description: tool.description ?? `MCP tool from "${server}"`,
      parameters:
        (tool.inputSchema as Record<string, unknown> | undefined) ?? {
          type: "object",
          properties: {},
        },
    },
  };
}

export function getAgentTools(): ChatCompletionTool[] {
  const tools: ChatCompletionTool[] = [];
  for (const [server, conn] of state.servers) {
    for (const tool of conn.tools) {
      tools.push(mcpToolToOpenAiTool(server, tool));
    }
  }
  return tools;
}

export async function callTool(
  fullName: string,
  args: unknown,
): Promise<{ result: string; changedPath?: string }> {
  const parsed = parseNamespacedName(fullName);
  if (parsed === null) {
    return { result: `ERROR: not an MCP tool: ${fullName}` };
  }
  const conn = state.servers.get(parsed.server);
  if (conn === undefined) {
    return { result: `ERROR: MCP server "${parsed.server}" not connected` };
  }
  try {
    const result = await conn.client.callTool({
      name: parsed.tool,
      arguments: (args ?? {}) as Record<string, unknown>,
    });
    const content = result.content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (
            part !== null &&
            typeof part === "object" &&
            "type" in part &&
            part.type === "text" &&
            "text" in part &&
            typeof part.text === "string"
          ) {
            return part.text;
          }
          return JSON.stringify(part);
        })
        .join("\n");
      return { result: text };
    }
    if (typeof content === "string") return { result: content };
    return { result: JSON.stringify(content) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { result: `ERROR: MCP callTool failed: ${message}` };
  }
}

async function connectServer(
  name: string,
  entry: McpServerEntry,
): Promise<void> {
  state.status.set(name, "connecting");
  state.errors.delete(name);
  notify();
  try {
    const client = new Client(
      { name: "opencode-desktop", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
      fetch: tauriFetch,
    });
    await client.connect(transport);
    const list = await client.listTools();
    state.servers.set(name, { client, tools: list.tools });
    state.status.set(name, "connected");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    state.errors.set(name, message);
    state.status.set(name, "error");
    const existing = state.servers.get(name);
    if (existing !== undefined) {
      try {
        await existing.client.close();
      } catch {
        state.errors.delete(name);
      }
      state.servers.delete(name);
    }
  }
  notify();
}

async function disconnectServer(name: string): Promise<void> {
  const conn = state.servers.get(name);
  if (conn !== undefined) {
    try {
      await conn.client.close();
    } catch {
      state.errors.delete(name);
    }
    state.servers.delete(name);
  }
  state.status.set(name, "disabled");
  state.errors.delete(name);
  notify();
}

export async function applyConfig(
  config: Record<string, McpServerEntry> | undefined,
): Promise<void> {
  const desired = config ?? {};
  const desiredNames = new Set(Object.keys(desired));
  for (const existing of Array.from(state.servers.keys())) {
    if (!desiredNames.has(existing)) {
      await disconnectServer(existing);
    }
  }
  for (const [name, entry] of Object.entries(desired)) {
    if (state.status.get(name) === "connected" && state.servers.has(name)) {
      continue;
    }
    if (!entry.enabled) {
      state.status.set(name, "disabled");
      state.errors.delete(name);
      continue;
    }
    if (entry.url.trim() === "") {
      state.status.set(name, "error");
      state.errors.set(name, "URL이 비어있습니다");
      continue;
    }
    void connectServer(name, entry);
  }
  notify();
}

export async function shutdownAll(): Promise<void> {
  for (const name of Array.from(state.servers.keys())) {
    await disconnectServer(name);
  }
  for (const name of Array.from(state.status.keys())) {
    state.status.set(name, "disabled");
  }
  notify();
}