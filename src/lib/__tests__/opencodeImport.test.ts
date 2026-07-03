import { describe, it, expect } from "vitest";
import {
  parseAuthJson,
  planImport,
  applyImport,
  flavorOf,
  BUNDLED_REGISTRY,
} from "../opencodeImport";
import { emptyStore } from "../settings";

const AUTH_FIXTURE = JSON.stringify({
  opencode: { type: "api", key: "zen-key" },
  "zai-coding-plan": { type: "api", key: "zai-key" },
  "minimax-coding-plan": { type: "api", key: "mm-key" },
  openai: { type: "oauth", refresh: "r", access: "a", expires: 1 },
  mystery: { type: "api", key: "m-key" },
});
const NOW = "2026-07-03T00:00:00Z";

describe("parseAuthJson", () => {
  it("parses entries with id/type/key", () => {
    const entries = parseAuthJson(AUTH_FIXTURE);
    expect(entries).toHaveLength(5);
    expect(entries.find((e) => e.id === "opencode")).toEqual({
      id: "opencode",
      type: "api",
      key: "zen-key",
    });
    expect(entries.find((e) => e.id === "openai")?.type).toBe("oauth");
  });

  it("throws on invalid json / non-object roots", () => {
    expect(() => parseAuthJson("not json")).toThrow();
    expect(() => parseAuthJson("[1,2]")).toThrow();
  });
});

describe("flavorOf", () => {
  it("maps npm package to flavor", () => {
    expect(flavorOf("@ai-sdk/openai-compatible")).toBe("openai");
    expect(flavorOf("@ai-sdk/anthropic")).toBe("anthropic");
    expect(flavorOf("@ai-sdk/google")).toBe("other");
  });
});

describe("planImport", () => {
  it("plans api entries, skips oauth and unknown ids", () => {
    const plan = planImport(parseAuthJson(AUTH_FIXTURE), BUNDLED_REGISTRY, NOW);
    expect(plan.items.map((i) => i.id).sort()).toEqual([
      "minimax-coding-plan",
      "opencode",
      "zai-coding-plan",
    ]);
    expect(plan.skipped).toContainEqual({ id: "openai", reason: "oauth-p2" });
    expect(plan.skipped).toContainEqual({
      id: "mystery",
      reason: "unknown-provider",
    });
  });

  it("maps anthropic-flavor minimax to its OpenAI-compatible base", () => {
    const plan = planImport(parseAuthJson(AUTH_FIXTURE), BUNDLED_REGISTRY, NOW);
    const mm = plan.items.find((i) => i.id === "minimax-coding-plan");
    expect(mm?.meta.baseUrl).toBe("https://api.minimax.io/v1");
    expect(mm?.meta.usable).toBe(true);
  });

  it("marks anthropic-flavor without alternate as unusable", () => {
    const registry = {
      ...BUNDLED_REGISTRY,
      "some-anthropic": {
        name: "SomeAnthropic",
        api: "https://a.example/v1",
        npm: "@ai-sdk/anthropic",
        models: ["m"],
      },
    };
    const auth = JSON.stringify({ "some-anthropic": { type: "api", key: "k" } });
    const plan = planImport(parseAuthJson(auth), registry, NOW);
    const item = plan.items.find((i) => i.id === "some-anthropic");
    expect(item?.meta.usable).toBe(false);
    expect(item?.meta.baseUrl).toBe("https://a.example/v1");
  });

  it("marks preset-colliding ids as presetConflict", () => {
    const plan = planImport(parseAuthJson(AUTH_FIXTURE), BUNDLED_REGISTRY, NOW);
    expect(
      plan.items.find((i) => i.id === "zai-coding-plan")?.presetConflict,
    ).toBe(true);
    expect(plan.items.find((i) => i.id === "opencode")?.presetConflict).toBe(
      false,
    );
  });
});

describe("applyImport", () => {
  it("adds new providers: key into providers[id], meta into importedProviders", () => {
    const plan = planImport(parseAuthJson(AUTH_FIXTURE), BUNDLED_REGISTRY, NOW);
    const { store, summary } = applyImport(emptyStore(), plan);
    expect(store.providers["opencode"]?.apiKey).toBe("zen-key");
    expect(store.importedProviders?.["opencode"]?.label).toBe("OpenCode Zen");
    expect(summary.added).toContain("opencode");
  });

  it("preset conflict: updates providers[id] only, no importedProviders entry", () => {
    const plan = planImport(parseAuthJson(AUTH_FIXTURE), BUNDLED_REGISTRY, NOW);
    const { store } = applyImport(emptyStore(), plan);
    expect(store.providers["zai-coding-plan"]?.apiKey).toBe("zai-key");
    expect(store.providers["zai-coding-plan"]?.modelsOverride).toEqual(
      BUNDLED_REGISTRY["zai-coding-plan"].models,
    );
    expect(store.importedProviders?.["zai-coding-plan"]).toBeUndefined();
  });

  it("upsert: re-import updates key and reports updated (not added)", () => {
    const plan1 = planImport(parseAuthJson(AUTH_FIXTURE), BUNDLED_REGISTRY, NOW);
    const first = applyImport(emptyStore(), plan1).store;
    const changed = JSON.parse(AUTH_FIXTURE) as Record<string, unknown>;
    changed["opencode"] = { type: "api", key: "zen-key-2" };
    const plan2 = planImport(
      parseAuthJson(JSON.stringify(changed)),
      BUNDLED_REGISTRY,
      NOW,
    );
    const { store, summary } = applyImport(first, plan2);
    expect(store.providers["opencode"]?.apiKey).toBe("zen-key-2");
    expect(summary.updated).toContain("opencode");
    expect(summary.added).not.toContain("opencode");
  });

  it("does not remove providers absent from auth.json", () => {
    const first = applyImport(
      emptyStore(),
      planImport(parseAuthJson(AUTH_FIXTURE), BUNDLED_REGISTRY, NOW),
    ).store;
    const only = JSON.stringify({ opencode: { type: "api", key: "k" } });
    const { store } = applyImport(
      first,
      planImport(parseAuthJson(only), BUNDLED_REGISTRY, NOW),
    );
    expect(store.importedProviders?.["minimax-coding-plan"]).toBeDefined();
  });
});
