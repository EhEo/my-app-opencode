import { describe, it, expect } from "vitest";
import {
  emptyStore,
  importedPresets,
  findPreset,
  resolveConnection,
  type ProviderStore,
} from "../settings";

function storeWithImported(): ProviderStore {
  return {
    ...emptyStore(),
    activeProviderId: "opencode",
    activeModel: "glm-5.2",
    providers: {
      opencode: { apiKey: "k", baseUrlOverride: null, modelsOverride: null },
    },
    importedProviders: {
      opencode: {
        label: "OpenCode Zen",
        baseUrl: "https://opencode.ai/zen/v1",
        models: ["glm-5.2"],
        flavor: "openai",
        usable: true,
        importedAt: "2026-07-03T00:00:00Z",
      },
      weird: {
        label: "Weird",
        baseUrl: "https://x.example",
        models: ["m1"],
        flavor: "other",
        usable: false,
        importedAt: "2026-07-03T00:00:00Z",
      },
    },
  };
}

describe("imported providers in settings", () => {
  it("importedPresets materializes non-preset entries with (opencode) label", () => {
    const list = importedPresets(storeWithImported());
    const zen = list.find((p) => p.id === "opencode");
    expect(zen?.label).toBe("OpenCode Zen (opencode)");
    expect(zen?.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(zen?.models).toEqual(["glm-5.2"]);
  });

  it("importedPresets skips ids that collide with built-in presets", () => {
    const store = storeWithImported();
    store.importedProviders!["zai-coding-plan"] = {
      label: "Z",
      baseUrl: "https://z.example",
      models: [],
      flavor: "openai",
      usable: true,
      importedAt: "",
    };
    expect(
      importedPresets(store).some((p) => p.id === "zai-coding-plan"),
    ).toBe(false);
  });

  it("findPreset resolves built-in first, then imported", () => {
    const store = storeWithImported();
    expect(findPreset(store, "openai")?.label).toBe("OpenAI");
    expect(findPreset(store, "opencode")?.label).toContain("(opencode)");
    expect(findPreset(store, "nope")).toBeUndefined();
  });

  it("resolveConnection works for a usable imported provider", () => {
    const s = resolveConnection(storeWithImported());
    expect(s).toEqual({
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "k",
      model: "glm-5.2",
    });
  });

  it("resolveConnection returns null for an unusable imported provider", () => {
    const store = storeWithImported();
    store.activeProviderId = "weird";
    store.activeModel = "m1";
    store.providers.weird = {
      apiKey: "k",
      baseUrlOverride: null,
      modelsOverride: null,
    };
    expect(resolveConnection(store)).toBeNull();
  });
});
