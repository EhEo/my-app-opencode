import { describe, it, expect } from "vitest";
import { formatCount } from "../format";

describe("formatCount", () => {
  it("passes small numbers through", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });
  it("uses one-decimal k for thousands", () => {
    expect(formatCount(1000)).toBe("1.0k");
    expect(formatCount(1234)).toBe("1.2k");
    expect(formatCount(12345)).toBe("12.3k");
  });
  it("guards against negative / NaN", () => {
    expect(formatCount(-5)).toBe("0");
    expect(formatCount(Number.NaN)).toBe("0");
  });
});
