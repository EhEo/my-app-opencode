import { describe, it, expect, beforeEach, vi } from "vitest";

// runExec is mocked as a PLAIN function (not a vi.fn). A vi.fn whose
// implementation throws/rejects is surfaced by vitest 4 as a test failure even
// when the code under test catches it; a plain function returning a rejected
// promise that detectCli awaits+catches is not. We capture calls manually.
type ExecResult = { code: number; stdout: string; stderr: string };
let behavior: () => Promise<ExecResult>;
const calls: unknown[] = [];

vi.mock("../agentExec", () => ({
  runExec: (o: unknown) => {
    calls.push(o);
    return behavior();
  },
}));

import { detectCli } from "../workers";

beforeEach(() => {
  calls.length = 0;
});

describe("detectCli", () => {
  it("is true when the probe exits 0", async () => {
    behavior = () => Promise.resolve({ code: 0, stdout: "v1.2.3", stderr: "" });
    expect(await detectCli("codex")).toBe(true);
    expect(calls[0]).toMatchObject({ program: "codex", args: ["--version"], timeoutSec: 5 });
  });

  it("is false on non-zero exit", async () => {
    behavior = () => Promise.resolve({ code: 1, stdout: "", stderr: "nope" });
    expect(await detectCli("codex")).toBe(false);
  });

  it("is false when runExec rejects (not installed / timeout)", async () => {
    behavior = () => Promise.reject(new Error("spawn error"));
    expect(await detectCli("nope")).toBe(false);
  });
});
