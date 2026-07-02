import { describe, it, expect, vi, beforeEach } from "vitest";

const runExecMock = vi.fn();
vi.mock("../agentExec", () => ({ runExec: (o: unknown) => runExecMock(o) }));

import { detectCli } from "../workers";

beforeEach(() => runExecMock.mockReset());

describe("detectCli", () => {
  it("is true when the probe exits 0", async () => {
    runExecMock.mockResolvedValue({ code: 0, stdout: "v1.2.3", stderr: "" });
    expect(await detectCli("codex")).toBe(true);
    expect(runExecMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: "codex", args: ["--version"], timeoutSec: 5 }),
    );
  });
  it("is false on non-zero exit", async () => {
    runExecMock.mockResolvedValue({ code: 1, stdout: "", stderr: "nope" });
    expect(await detectCli("codex")).toBe(false);
  });
  it("is false when runExec throws (not installed / timeout)", async () => {
    runExecMock.mockRejectedValue(new Error("spawn error"));
    expect(await detectCli("nope")).toBe(false);
  });
});
