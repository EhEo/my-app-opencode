import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  resolveImportNames,
  type ExternalSkillCandidate,
} from "../skills";

describe("parseFrontmatter (exported, regression check)", () => {
  it("parses name/description from YAML frontmatter, stripping quotes", () => {
    const { metadata, body } = parseFrontmatter(
      '---\nname: "brainstorming"\ndescription: "Turn ideas into designs"\n---\nBody text',
    );
    expect(metadata).toEqual({ name: "brainstorming", description: "Turn ideas into designs" });
    expect(body).toBe("Body text");
  });

  it("falls back to the first line as name when there is no frontmatter block", () => {
    const { metadata } = parseFrontmatter("just a plain skill body");
    expect(metadata).toEqual({ name: "just a plain skill body", description: "" });
  });
});

describe("resolveImportNames", () => {
  it("uses the frontmatter name as installName when there's no collision", () => {
    const candidates: ExternalSkillCandidate[] = [
      {
        source: "claude",
        label: "superpowers/brainstorming",
        path: "/c/brainstorming",
        preview: "---\nname: brainstorming\ndescription: Turn ideas into designs\n---\nBody",
      },
    ];
    const resolved = resolveImportNames(candidates, []);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("brainstorming");
    expect(resolved[0].installName).toBe("brainstorming");
    expect(resolved[0].description).toBe("Turn ideas into designs");
    expect(resolved[0].alreadyInstalled).toBe(false);
  });

  it("suffixes both candidates with their source when the same name comes from two sources", () => {
    const candidates: ExternalSkillCandidate[] = [
      {
        source: "claude",
        label: "claude-plugins-official/skill-creator",
        path: "/c/skill-creator",
        preview: '---\nname: "skill-creator"\ndescription: "Claude version"\n---\nBody',
      },
      {
        source: "codex",
        label: ".system/skill-creator",
        path: "/x/skill-creator",
        preview: '---\nname: "skill-creator"\ndescription: "Codex version"\n---\nBody',
      },
    ];
    const resolved = resolveImportNames(candidates, []);
    expect(resolved.map((r) => r.installName).sort()).toEqual([
      "skill-creator (claude)",
      "skill-creator (codex)",
    ]);
  });

  it("marks a candidate as already installed when its installName matches an existing skill", () => {
    const candidates: ExternalSkillCandidate[] = [
      {
        source: "claude",
        label: "superpowers/brainstorming",
        path: "/c/brainstorming",
        preview: "---\nname: brainstorming\ndescription: d\n---\nBody",
      },
    ];
    const resolved = resolveImportNames(candidates, ["brainstorming"]);
    expect(resolved[0].alreadyInstalled).toBe(true);
  });

  it("falls back to the last path segment of label when frontmatter has no name field", () => {
    const candidates: ExternalSkillCandidate[] = [
      {
        source: "codex",
        label: ".system/imagegen",
        path: "/x/imagegen",
        preview: "---\ndescription: Generate images\n---\nBody",
      },
    ];
    const resolved = resolveImportNames(candidates, []);
    expect(resolved[0].name).toBe("imagegen");
    expect(resolved[0].description).toBe("Generate images");
  });
});
