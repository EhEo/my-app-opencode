import { invoke, Channel } from "@tauri-apps/api/core";

export interface TerminalEventData {
  type: "data";
  data: number[];
}
export interface TerminalEventExit {
  type: "exit";
  code: number;
}
export type TerminalEvent = TerminalEventData | TerminalEventExit;

export interface TerminalHandlers {
  onData?: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
}

export async function createSession(
  cwd: string | null,
  cols: number,
  rows: number,
  handlers: TerminalHandlers,
  shell?: string | null,
): Promise<string> {
  const channel = new Channel<TerminalEvent>();
  channel.onmessage = (msg: TerminalEvent): void => {
    if (msg.type === "data") {
      handlers.onData?.(new Uint8Array(msg.data));
    } else if (msg.type === "exit") {
      handlers.onExit?.(msg.code);
    }
  };
  return await invoke<string>("terminal_create", {
    cwd,
    cols,
    rows,
    shell: shell ?? null,
    onEvent: channel,
  });
}

export async function writeSession(
  sessionId: string,
  data: string,
): Promise<void> {
  await invoke<void>("terminal_write", { sessionId, data });
}

export async function resizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke<void>("terminal_resize", { sessionId, cols, rows });
}

export async function killSession(sessionId: string): Promise<void> {
  await invoke<void>("terminal_kill", { sessionId });
}