import { invoke, Channel } from "@tauri-apps/api/core";

interface ExecEventStdout { type: "stdout"; data: number[] }
interface ExecEventStderr { type: "stderr"; data: number[] }
interface ExecEventExit { type: "exit"; code: number }
type ExecEvent = ExecEventStdout | ExecEventStderr | ExecEventExit;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  program: string;
  args: string[];
  cwd?: string;
  stdin?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export async function runExec(opts: ExecOptions): Promise<ExecResult> {
  const id = crypto.randomUUID();
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";

  return await new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
    };
    const kill = (): void => {
      void invoke("agent_exec_kill", { id });
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      kill();
      reject(new Error(message));
    };
    const onAbort = (): void => fail("aborted");

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        // still generate the id/kill for symmetry, then reject
        fail("aborted");
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }
    if (opts.timeoutSec !== undefined) {
      timer = setTimeout(() => fail("exec timed out"), opts.timeoutSec * 1000);
    }

    const channel = new Channel<ExecEvent>();
    channel.onmessage = (msg: ExecEvent): void => {
      if (settled) return;
      if (msg.type === "stdout") {
        const chunk = decoder.decode(new Uint8Array(msg.data), { stream: true });
        stdout += chunk;
        opts.onStdout?.(chunk);
      } else if (msg.type === "stderr") {
        const chunk = decoder.decode(new Uint8Array(msg.data), { stream: true });
        stderr += chunk;
        opts.onStderr?.(chunk);
      } else if (msg.type === "exit") {
        settled = true;
        cleanup();
        resolve({ code: msg.code, stdout, stderr });
      }
    };

    void invoke("agent_exec_start", {
      id,
      program: opts.program,
      args: opts.args,
      cwd: opts.cwd ?? null,
      stdin: opts.stdin ?? null,
      env: opts.env ?? null,
      onEvent: channel,
    }).catch((e: unknown) => {
      fail(e instanceof Error ? e.message : String(e));
    });
  });
}
