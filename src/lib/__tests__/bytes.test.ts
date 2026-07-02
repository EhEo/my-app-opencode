import { describe, it, expect } from "vitest";
import { base64ToUint8Array } from "../bytes";

describe("base64ToUint8Array", () => {
  it("decodes base64 to bytes", () => {
    const out = base64ToUint8Array("aGk="); // "hi"
    expect(Array.from(out)).toEqual([104, 105]);
  });
  it("handles empty", () => {
    expect(base64ToUint8Array("").length).toBe(0);
  });
});
