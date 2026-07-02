import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core: Channel captures its onmessage; invoke("agent_exec_start")
// drives the channel with scripted events, then resolves. invoke("agent_exec_kill") is a spy.
const killSpy = vi.fn();

vi.mock("@tauri-apps/api/core", () => {
  class Channel {
    onmessage?: (m: unknown) => void;
  }
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "agent_exec_kill") {
      killSpy(args);
      return;
    }
    if (cmd === "agent_exec_start") {
      const ch = (args.onEvent as { onmessage?: (m: unknown) => void });
      // "hi" = bytes [104,105]
      ch.onmessage?.({ type: "stdout", data: [104, 105] });
      ch.onmessage?.({ type: "exit", code: 0 });
      return;
    }
    return;
  });
  return { Channel, invoke };
});

import { runExec } from "../agentExec";

beforeEach(() => {
  killSpy.mockClear();
});

describe("runExec", () => {
  it("accumulates stdout and resolves on exit", async () => {
    const chunks: string[] = [];
    const res = await runExec({
      program: "echo",
      args: ["hi"],
      onStdout: (c) => chunks.push(c),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("hi");
    expect(chunks.join("")).toBe("hi");
  });

  it("kills and rejects when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runExec({ program: "sleep", args: ["10"], signal: ac.signal }),
    ).rejects.toThrow("aborted");
    expect(killSpy).toHaveBeenCalledTimes(1);
  });
});
