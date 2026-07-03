import {
  PROVIDER_PRESETS,
  type ImportedFlavor,
  type ImportedProviderMeta,
  type ProviderStore,
} from "./settings";
import { invoke } from "@tauri-apps/api/core";
import { createTauriFetch } from "./tauriFetch";

export interface AuthEntry {
  id: string;
  type: string;
  key?: string;
}

export interface RegistryProvider {
  name: string;
  api: string;
  npm: string;
  models: string[];
}
export type Registry = Record<string, RegistryProvider>;

export type SkipReason = "oauth-p2" | "unknown-provider" | "unsupported-type";

export interface ImportPlanItem {
  id: string;
  key: string;
  presetConflict: boolean;
  meta: ImportedProviderMeta;
}
export interface ImportPlan {
  items: ImportPlanItem[];
  skipped: { id: string; reason: SkipReason }[];
}
export interface ImportSummary {
  added: string[];
  updated: string[];
  skipped: { id: string; reason: SkipReason }[];
  unusable: string[];
}

/** Snapshot of models.dev for the providers observed in real auth.json files.
 *  Used only when the live registry fetch fails. kilo's 345-model list is too
 *  large to pin — live fetch provides it. */
export const BUNDLED_REGISTRY: Registry = {
  opencode: {
    name: "OpenCode Zen",
    api: "https://opencode.ai/zen/v1",
    npm: "@ai-sdk/openai-compatible",
    models: ["glm-5.2", "glm-4.7", "kimi-k2", "minimax-m2.5", "deepseek-v4-flash"],
  },
  "opencode-go": {
    name: "OpenCode Go",
    api: "https://opencode.ai/zen/go/v1",
    npm: "@ai-sdk/openai-compatible",
    models: ["glm-5.2", "glm-5.1", "kimi-k2.7-code", "deepseek-v4-pro", "qwen3.7-max"],
  },
  "zai-coding-plan": {
    name: "Z.AI Coding Plan",
    api: "https://api.z.ai/api/coding/paas/v4",
    npm: "@ai-sdk/openai-compatible",
    models: ["glm-5.2", "glm-5.1", "glm-4.7", "glm-5-turbo", "glm-5v-turbo", "glm-4.5-air"],
  },
  "minimax-coding-plan": {
    name: "MiniMax Token Plan",
    api: "https://api.minimax.io/anthropic/v1",
    npm: "@ai-sdk/anthropic",
    models: ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M3", "MiniMax-M2.1", "MiniMax-M2"],
  },
  kilo: {
    name: "Kilo Gateway",
    api: "https://api.kilo.ai/api/gateway",
    npm: "@ai-sdk/openai-compatible",
    models: [],
  },
};

/** Anthropic-flavor providers with a known OpenAI-compatible endpoint the
 *  same key works on. Import maps baseUrl here so our engine can call them. */
const ALTERNATE_OPENAI_BASE: Record<string, string> = {
  "minimax-coding-plan": "https://api.minimax.io/v1",
  minimax: "https://api.minimax.io/v1",
};

export function parseAuthJson(raw: string): AuthEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("opencode auth.json 파싱에 실패했습니다");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("opencode auth.json 형식이 예상과 다릅니다");
  }
  const out: AuthEntry[] = [];
  for (const [id, v] of Object.entries(data)) {
    if (typeof v !== "object" || v === null) continue;
    const t = (v as { type?: unknown }).type;
    const key = (v as { key?: unknown }).key;
    out.push({
      id,
      type: typeof t === "string" ? t : "other",
      key: typeof key === "string" ? key : undefined,
    });
  }
  return out;
}

export function flavorOf(npm: string): ImportedFlavor {
  if (npm.startsWith("@ai-sdk/openai")) return "openai";
  if (npm === "@ai-sdk/anthropic") return "anthropic";
  return "other";
}

export function planImport(
  entries: AuthEntry[],
  registry: Registry,
  now: string,
): ImportPlan {
  const items: ImportPlanItem[] = [];
  const skipped: { id: string; reason: SkipReason }[] = [];
  for (const e of entries) {
    if (e.type === "oauth") {
      skipped.push({ id: e.id, reason: "oauth-p2" });
      continue;
    }
    if (e.type !== "api" || e.key === undefined || e.key === "") {
      skipped.push({ id: e.id, reason: "unsupported-type" });
      continue;
    }
    const reg = registry[e.id];
    if (reg === undefined) {
      skipped.push({ id: e.id, reason: "unknown-provider" });
      continue;
    }
    const flavor = flavorOf(reg.npm);
    let baseUrl = reg.api;
    let usable = flavor === "openai";
    if (flavor === "anthropic" && ALTERNATE_OPENAI_BASE[e.id] !== undefined) {
      baseUrl = ALTERNATE_OPENAI_BASE[e.id];
      usable = true;
    }
    items.push({
      id: e.id,
      key: e.key,
      presetConflict: PROVIDER_PRESETS.some((p) => p.id === e.id),
      meta: {
        label: reg.name,
        baseUrl,
        models: reg.models,
        flavor,
        usable,
        importedAt: now,
      },
    });
  }
  return { items, skipped };
}

export function applyImport(
  store: ProviderStore,
  plan: ImportPlan,
): { store: ProviderStore; summary: ImportSummary } {
  const next: ProviderStore = {
    ...store,
    providers: { ...store.providers },
    importedProviders: { ...(store.importedProviders ?? {}) },
  };
  const added: string[] = [];
  const updated: string[] = [];
  const unusable: string[] = [];
  for (const item of plan.items) {
    const prev = next.providers[item.id];
    const existed = item.presetConflict
      ? prev !== undefined && prev.apiKey !== ""
      : next.importedProviders![item.id] !== undefined;
    next.providers[item.id] = {
      apiKey: item.key,
      baseUrlOverride: prev?.baseUrlOverride ?? null,
      modelsOverride: item.presetConflict
        ? item.meta.models
        : (prev?.modelsOverride ?? null),
    };
    if (!item.presetConflict) {
      next.importedProviders![item.id] = item.meta;
      if (!item.meta.usable) unusable.push(item.id);
    }
    (existed ? updated : added).push(item.id);
  }
  return {
    store: next,
    summary: { added, updated, skipped: plan.skipped, unusable },
  };
}

export async function fetchRegistry(): Promise<Registry> {
  const tfetch = createTauriFetch();
  const res = await tfetch("https://models.dev/api.json", { method: "GET" });
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
  const data = (await res.json()) as Record<
    string,
    { name?: string; api?: string; npm?: string; models?: Record<string, unknown> }
  >;
  const out: Registry = {};
  for (const [id, p] of Object.entries(data)) {
    if (typeof p !== "object" || p === null) continue;
    if (typeof p.api !== "string" || typeof p.npm !== "string") continue;
    out[id] = {
      name: typeof p.name === "string" ? p.name : id,
      api: p.api,
      npm: p.npm,
      models: Object.keys(p.models ?? {}),
    };
  }
  return out;
}

/** One-shot import: read opencode's auth.json, resolve providers via the
 *  models.dev registry (bundled snapshot on failure), and upsert the store.
 *  Never touches opencode's files beyond the read. */
export async function importFromOpencode(store: ProviderStore): Promise<{
  store: ProviderStore;
  summary: ImportSummary;
  registryFallback: boolean;
}> {
  const raw = await invoke<string>("read_opencode_auth");
  const entries = parseAuthJson(raw);
  let registry: Registry;
  let registryFallback = false;
  try {
    registry = await fetchRegistry();
  } catch {
    registry = BUNDLED_REGISTRY;
    registryFallback = true;
  }
  const plan = planImport(entries, registry, new Date().toISOString());
  return { ...applyImport(store, plan), registryFallback };
}
