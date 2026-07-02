import { describe, it, expect } from "vitest";
import { accumulate, totalTokens, guardState } from "../usage";

describe("accumulate", () => {
  it("adds input and output", () => {
    expect(accumulate({ inputTokens: 10, outputTokens: 5 }, { input: 3, output: 7 }))
      .toEqual({ inputTokens: 13, outputTokens: 12 });
  });
});

describe("totalTokens", () => {
  it("sums both fields", () => {
    expect(totalTokens({ inputTokens: 10, outputTokens: 5 })).toBe(15);
  });
});

describe("guardState", () => {
  it("is ok when no budget set", () => {
    expect(guardState(999999, undefined, 0.8)).toBe("ok");
  });
  it("is ok below the warn ratio", () => {
    expect(guardState(700, 1000, 0.8)).toBe("ok");
  });
  it("warns at or above the warn ratio", () => {
    expect(guardState(800, 1000, 0.8)).toBe("warn");
    expect(guardState(1200, 1000, 0.8)).toBe("warn");
  });
});
