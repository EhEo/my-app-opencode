import { describe, it, expect } from "vitest";
import { fileKind } from "../fileKind";

describe("fileKind", () => {
  it("classifies images", () => {
    expect(fileKind("a/b/pic.PNG")).toBe("image");
    expect(fileKind("x.svg")).toBe("image");
  });
  it("classifies documents", () => {
    expect(fileKind("r.pdf")).toBe("pdf");
    expect(fileKind("d.docx")).toBe("docx");
    expect(fileKind("s.xlsx")).toBe("xlsx");
    expect(fileKind("p.pptx")).toBe("pptx");
  });
  it("classifies markdown", () => {
    expect(fileKind("README.md")).toBe("markdown");
  });
  it("classifies known binaries", () => {
    expect(fileKind("a.zip")).toBe("binary");
    expect(fileKind("v.mp4")).toBe("binary");
  });
  it("defaults source/unknown to text", () => {
    expect(fileKind("src/App.tsx")).toBe("text");
    expect(fileKind("noext")).toBe("text");
    expect(fileKind("data.json")).toBe("text");
  });
});
