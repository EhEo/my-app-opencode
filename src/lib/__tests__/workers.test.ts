import { describe, it, expect } from "vitest";
import {
  resolveBackend,
  buildCliArgs,
  DEFAULT_INAPP_BACKEND,
  DEFAULT_STAGES,
  type WorkerBackend,
} from "../workers";

describe("resolveBackend", () => {
  const workers: Record<string, WorkerBackend> = {
    "codex-cli": { kind: "cli", command: "codex", argsTemplate: ["exec", "@brief"], briefMode: "arg" },
  };

  it("returns the registered backend by id", () => {
    expect(resolveBackend(workers, "codex-cli")).toEqual(workers["codex-cli"]);
  });

  it("falls back to in-app when id is undefined", () => {
    expect(resolveBackend(workers, undefined)).toEqual(DEFAULT_INAPP_BACKEND);
  });

  it("falls back to in-app when id is unknown", () => {
    expect(resolveBackend(workers, "nope")).toEqual(DEFAULT_INAPP_BACKEND);
  });

  it("falls back to in-app when workers map is undefined", () => {
    expect(resolveBackend(undefined, "codex-cli")).toEqual(DEFAULT_INAPP_BACKEND);
  });
});

describe("buildCliArgs", () => {
  it("replaces the @brief token", () => {
    expect(buildCliArgs(["exec", "@brief"], "do it")).toEqual(["exec", "do it"]);
  });
  it("passes through args without the token", () => {
    expect(buildCliArgs(["--json", "run"], "x")).toEqual(["--json", "run"]);
  });
});

describe("DEFAULT_STAGES", () => {
  it("is plan, code, review — all enabled, in order", () => {
    expect(DEFAULT_STAGES.map((s) => s.id)).toEqual(["plan", "code", "review"]);
    expect(DEFAULT_STAGES.every((s) => s.enabled)).toBe(true);
  });
});
