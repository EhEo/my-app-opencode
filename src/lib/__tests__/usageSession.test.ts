import { describe, it, expect, vi, beforeEach } from "vitest";

const readCliUsageMock = vi.fn();
vi.mock("../usage", async (orig) => {
  const actual = await orig<typeof import("../usage")>();
  return { ...actual, readCliUsage: () => readCliUsageMock() };
});

import { estimateTokens, SessionUsage } from "../usageSession";

beforeEach(() => readCliUsageMock.mockReset());

describe("estimateTokens", () => {
  it("is ceil(len/4)", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("SessionUsage", () => {
  it("accumulates in-app estimates", () => {
    const s = new SessionUsage();
    s.addInapp("abcd"); // 1
    s.addInapp("abcd"); // 1
    expect(s.inappTokens).toBe(2);
  });

  it("combines in-app + CLI into sessionTokens and computes the guard", async () => {
    readCliUsageMock.mockResolvedValue({
      claude: { inputTokens: 10, outputTokens: 5 }, // 15
    });
    const s = new SessionUsage();
    s.addInapp("abcd"); // 1
    const snap = await s.snapshot(20, 0.8); // budget 20, warn at 16
    expect(snap.inappTokens).toBe(1);
    expect(snap.sessionTokens).toBe(16); // 1 + 15
    expect(snap.guard).toBe("warn"); // 16 >= 20*0.8
  });

  it("is ok when under budget and fail-open on empty CLI usage", async () => {
    readCliUsageMock.mockResolvedValue({});
    const s = new SessionUsage();
    s.addInapp("abcd"); // 1
    const snap = await s.snapshot(1000, 0.8);
    expect(snap.sessionTokens).toBe(1);
    expect(snap.guard).toBe("ok");
  });
});
