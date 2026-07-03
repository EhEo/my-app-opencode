import { describe, it, expect, vi } from "vitest";
import { runPipeline, buildBrief, type PipelineDeps } from "../pipeline";
import { DEFAULT_STAGES } from "../workers";
import type { StageConfig } from "../settings";

const okDeps: PipelineDeps = {
  runInapp: async (_b, brief, onToken) => {
    onToken?.("tok");
    return `inapp:${brief.slice(0, 4)}`;
  },
  runMcp: async () => "mcp-out",
};

describe("buildBrief", () => {
  it("includes the request and prior outputs", () => {
    const brief = buildBrief("add auth", DEFAULT_STAGES[1], [
      { stageId: "plan", label: "Plan", backendKind: "inapp", output: "PLAN-TEXT" },
    ]);
    expect(brief).toContain("add auth");
    expect(brief).toContain("PLAN-TEXT");
  });
});

describe("runPipeline", () => {
  it("runs all enabled stages in order and collects results", async () => {
    const results = await runPipeline({
      request: "add auth",
      stages: DEFAULT_STAGES,
      deps: okDeps,
    });
    expect(results.map((r) => r.stageId)).toEqual(["plan", "code", "review"]);
    expect(results.every((r) => r.output.startsWith("inapp:"))).toBe(true);
  });

  it("pauses on guard warn and aborts if the user declines", async () => {
    const onGuardPause = vi.fn(async () => false);
    const results = await runPipeline({
      request: "x",
      stages: DEFAULT_STAGES,
      guardBeforeStage: () => "warn",
      callbacks: { onGuardPause },
      deps: okDeps,
    });
    expect(onGuardPause).toHaveBeenCalledTimes(1);
    expect(results).toEqual([]); // aborted before the first stage ran
  });

  it("stops on the first stage error", async () => {
    const failing: PipelineDeps = {
      runInapp: async () => {
        throw new Error("boom");
      },
      runMcp: async () => "x",
    };
    const results = await runPipeline({
      request: "x",
      stages: DEFAULT_STAGES,
      deps: failing,
    });
    expect(results).toHaveLength(1);
    expect(results[0].error).toContain("boom");
  });

  it("skips disabled stages", async () => {
    const stages: StageConfig[] = [
      { id: "plan", label: "Plan", enabled: false },
      { id: "code", label: "Code", enabled: true },
      { id: "review", label: "Review", enabled: false },
    ];
    const results = await runPipeline({ request: "x", stages, deps: okDeps });
    expect(results.map((r) => r.stageId)).toEqual(["code"]);
  });
});

describe("buildBrief with custom prompts", () => {
  it("includes the stage's own prompt text", () => {
    const stage: StageConfig = {
      id: "w1",
      label: "Worker 1",
      enabled: true,
      prompt: "Do the research.",
    };
    const brief = buildBrief("find bugs", stage, []);
    expect(brief).toBe("Do the research.\n\n# Request\nfind bugs");
  });

  it("omits the prompt section entirely when prompt is empty or undefined", () => {
    const noPrompt: StageConfig = { id: "w1", label: "Worker 1", enabled: true };
    expect(buildBrief("find bugs", noPrompt, [])).toBe("# Request\nfind bugs");

    const emptyPrompt: StageConfig = { id: "w2", label: "Worker 2", enabled: true, prompt: "" };
    expect(buildBrief("find bugs", emptyPrompt, [])).toBe("# Request\nfind bugs");
  });
});

describe("runPipeline with an arbitrary custom stage list", () => {
  it("runs a 4-stage worker+judge chain with free-form ids and per-stage prompts", async () => {
    const stages: StageConfig[] = [
      { id: "worker1", label: "Worker 1", enabled: true, prompt: "Research the codebase." },
      { id: "worker2", label: "Worker 2", enabled: true, prompt: "Implement the change." },
      { id: "worker3", label: "Worker 3", enabled: true, prompt: "Write tests." },
      {
        id: "judge",
        label: "Judge",
        enabled: true,
        prompt: "Review all prior outputs and give a final verdict.",
      },
    ];
    const results = await runPipeline({ request: "add auth", stages, deps: okDeps });
    expect(results.map((r) => r.stageId)).toEqual(["worker1", "worker2", "worker3", "judge"]);
    expect(results.every((r) => r.output.startsWith("inapp:"))).toBe(true);
  });

  it("runs with zero stages without crashing", async () => {
    const results = await runPipeline({ request: "x", stages: [], deps: okDeps });
    expect(results).toEqual([]);
  });
});
