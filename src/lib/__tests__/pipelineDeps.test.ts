import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentCallbacks, RunAgentOptions } from "../agent";
import type { ProviderStore } from "../settings";

const runAgentMock = vi.fn();
const callToolMock = vi.fn();

vi.mock("../agent", () => ({ runAgent: (o: RunAgentOptions) => runAgentMock(o) }));
vi.mock("../mcp", () => ({ callTool: (n: string, a: unknown) => callToolMock(n, a) }));

import { makePipelineDeps, resolveInappSettings } from "../pipelineDeps";

const store: ProviderStore = {
  activeProviderId: "openai",
  activeModel: "gpt-4o",
  providers: { openai: { apiKey: "sk-x", baseUrlOverride: null, modelsOverride: null } },
};

beforeEach(() => {
  runAgentMock.mockReset();
  callToolMock.mockReset();
});

describe("resolveInappSettings", () => {
  it("uses the active provider for providerId ''", () => {
    const s = resolveInappSettings(store, { providerId: "" });
    expect(s).toEqual({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-x", model: "gpt-4o" });
  });
  it("applies a model override", () => {
    const s = resolveInappSettings(store, { providerId: "", model: "gpt-4o-mini" });
    expect(s?.model).toBe("gpt-4o-mini");
  });
  it("returns null when the provider has no usable connection", () => {
    const empty: ProviderStore = { activeProviderId: "custom", activeModel: "", providers: {} };
    expect(resolveInappSettings(empty, { providerId: "" })).toBeNull();
  });

  it("carries the imported provider's flavor through for an explicit providerId", () => {
    const withImported: ProviderStore = {
      ...store,
      importedProviders: {
        "minimax-coding-plan": {
          label: "MiniMax Token Plan",
          baseUrl: "https://api.minimax.io/anthropic/v1",
          models: ["MiniMax-M2.7"],
          flavor: "anthropic",
          usable: true,
          importedAt: "2026-07-03T00:00:00Z",
        },
      },
      providers: {
        ...store.providers,
        "minimax-coding-plan": { apiKey: "k", baseUrlOverride: null, modelsOverride: null },
      },
    };
    const s = resolveInappSettings(withImported, { providerId: "minimax-coding-plan" });
    expect(s).toEqual({
      baseUrl: "https://api.minimax.io/anthropic/v1",
      apiKey: "k",
      model: "MiniMax-M2.7",
      flavor: "anthropic",
    });
  });
});

describe("makePipelineDeps.runInapp", () => {
  it("resolves with the accumulated streamed text on completion", async () => {
    runAgentMock.mockImplementation((o: RunAgentOptions) => {
      const cb = o.callbacks as AgentCallbacks;
      cb.onToken("hel");
      cb.onToken("lo");
      cb.onDone("completed", []);
      return Promise.resolve();
    });
    const deps = makePipelineDeps(store);
    const out = await deps.runInapp({ kind: "inapp", providerId: "" }, "brief", undefined, undefined);
    expect(out).toBe("hello");
  });

  it("rejects with 'aborted' when onDone reports aborted", async () => {
    runAgentMock.mockImplementation((o: RunAgentOptions) => {
      (o.callbacks as AgentCallbacks).onDone("aborted", []);
      return Promise.resolve();
    });
    const deps = makePipelineDeps(store);
    await expect(
      deps.runInapp({ kind: "inapp", providerId: "" }, "b", undefined, undefined),
    ).rejects.toThrow("aborted");
  });

  it("rejects when onError fires", async () => {
    runAgentMock.mockImplementation((o: RunAgentOptions) => {
      (o.callbacks as AgentCallbacks).onError(new Error("boom"));
      return Promise.resolve();
    });
    const deps = makePipelineDeps(store);
    await expect(
      deps.runInapp({ kind: "inapp", providerId: "" }, "b", undefined, undefined),
    ).rejects.toThrow("boom");
  });

  it("rejects when no provider is configured", async () => {
    const empty: ProviderStore = { activeProviderId: "custom", activeModel: "", providers: {} };
    const deps = makePipelineDeps(empty);
    await expect(
      deps.runInapp({ kind: "inapp", providerId: "" }, "b", undefined, undefined),
    ).rejects.toThrow(/provider/i);
  });
});

describe("makePipelineDeps.runMcp", () => {
  it("composes the namespaced tool name and unwraps result", async () => {
    callToolMock.mockResolvedValue({ result: "R" });
    const deps = makePipelineDeps(store);
    const out = await deps.runMcp({ kind: "mcp", server: "gh", tool: "search" }, "brief");
    expect(callToolMock).toHaveBeenCalledWith("mcp__gh__search", { input: "brief" });
    expect(out).toBe("R");
  });
});
