import { invoke } from "@tauri-apps/api/core";
import { createLlmClient } from "./llm";

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Wire format for createLlmClient. Undefined/"openai" = OpenAI-compatible
   *  chat completions (the default for all built-in presets). "anthropic" =
   *  routed through the Anthropic Messages API adapter (opencodeImport.ts
   *  sets this from the imported provider's flavor). */
  flavor?: "openai" | "anthropic";
}

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  docsUrl: string | null;
  hint: string | null;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "zai-coding-plan",
    label: "z.ai (Coding Plan)",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    models: ["glm-5.2", "glm-5-turbo", "glm-4.6", "glm-4.5"],
    docsUrl: "https://z.ai",
    hint: "z.ai Coding Plan 구독용 엔드포인트. GLM 코딩 모델.",
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    models: ["MiniMax-M1", "MiniMax-M3", "abab6.5s-chat"],
    docsUrl: "https://platform.minimax.io",
    hint: "MiniMax OpenAI 호환 엔드포인트 (국제).",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
    docsUrl: "https://platform.openai.com/api-keys",
    hint: "표준 OpenAI API.",
  },
  {
    id: "custom",
    label: "사용자 정의 (OpenAI 호환)",
    baseUrl: "",
    models: [],
    docsUrl: null,
    hint: "LM Studio, Ollama, vLLM 등任意 OpenAI 호환 엔드포인트.",
  },
];

export interface ProviderEntry {
  apiKey: string;
  baseUrlOverride: string | null;
  modelsOverride: string[] | null;
}

export type ImportedFlavor = "openai" | "anthropic" | "other";

/** Metadata for a provider imported from opencode. The API key itself lives
 *  in store.providers[id].apiKey (single storage path, reuses existing UI). */
export interface ImportedProviderMeta {
  label: string;
  baseUrl: string;
  models: string[];
  flavor: ImportedFlavor;
  usable: boolean;
  importedAt: string;
}

export type McpServerType = "remote";

export interface McpServerEntry {
  type: McpServerType;
  url: string;
  enabled: boolean;
}

export type WorkerBackend =
  | { kind: "inapp"; providerId: string; model?: string; systemPrompt?: string }
  | {
      kind: "cli";
      command: string;
      argsTemplate: string[];
      briefMode: "stdin" | "arg";
      cwd?: string;
      timeoutSec?: number;
      resultParse?: "raw" | "json";
    }
  | { kind: "mcp"; server: string; tool: string };

export interface StageConfig {
  id: "plan" | "code" | "review";
  label: string;
  backendId?: string;
  enabled: boolean;
}

export interface ProviderStore {
  activeProviderId: string;
  activeModel: string;
  providers: Record<string, ProviderEntry>;
  mcp?: Record<string, McpServerEntry>;
  skills?: Record<string, { enabled: boolean }>;
  /** Terminal shell command/path. Empty or undefined = platform default. */
  terminalShell?: string;
  workers?: Record<string, WorkerBackend>;
  pipeline?: { stages: StageConfig[] };
  usageGuard?: {
    enabled: boolean;
    perRunBudgetTokens?: number;
    warnRatio: number;
    providers?: string[];
  };
  importedProviders?: Record<string, ImportedProviderMeta>;
}

// Shell presets offered in Settings. `command` is passed to the backend; an
// empty command means "use the platform default".
export interface ShellPreset {
  id: string;
  label: string;
  command: string;
}

export const SHELL_PRESETS: ShellPreset[] = [
  { id: "auto", label: "시스템 기본값 (Auto)", command: "" },
  { id: "pwsh", label: "PowerShell 7 (pwsh)", command: "pwsh" },
  { id: "powershell", label: "Windows PowerShell", command: "powershell" },
  { id: "cmd", label: "명령 프롬프트 (cmd)", command: "cmd" },
  { id: "bash", label: "Bash / Git Bash", command: "bash" },
];

export function emptyStore(): ProviderStore {
  return { activeProviderId: "zai-coding-plan", activeModel: "", providers: {} };
}

function isStore(value: unknown): value is ProviderStore {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.activeProviderId === "string" &&
    typeof v.activeModel === "string" &&
    typeof v.providers === "object" &&
    v.providers !== null
  );
}

export async function loadProviderStore(): Promise<ProviderStore> {
  const raw = await invoke<unknown>("get_settings");
  if (raw === null || !isStore(raw)) return emptyStore();
  return raw;
}

export async function saveProviderStore(store: ProviderStore): Promise<void> {
  await invoke<void>("set_settings", { settings: store });
}

/** Imported providers materialized as presets so they join the same UI and
 *  resolution path. Built-in preset ids win on collision. */
export function importedPresets(store: ProviderStore): ProviderPreset[] {
  return Object.entries(store.importedProviders ?? {})
    .filter(([id]) => !PROVIDER_PRESETS.some((p) => p.id === id))
    .map(([id, m]) => ({
      id,
      label: `${m.label} (opencode)`,
      baseUrl: m.baseUrl,
      models: m.models,
      docsUrl: null,
      hint: m.usable ? "opencode에서 가져옴" : "형식 미지원 — 어댑터 추가 예정",
    }));
}

export function findPreset(
  store: ProviderStore,
  id: string,
): ProviderPreset | undefined {
  return (
    PROVIDER_PRESETS.find((p) => p.id === id) ??
    importedPresets(store).find((p) => p.id === id)
  );
}

export function isProviderUsable(store: ProviderStore, id: string): boolean {
  const meta = store.importedProviders?.[id];
  return meta === undefined || meta.usable;
}

export function resolveConnection(store: ProviderStore): Settings | null {
  const preset = findPreset(store, store.activeProviderId);
  if (preset === undefined) return null;
  if (!isProviderUsable(store, preset.id)) return null;
  const entry = store.providers[preset.id] ?? {
    apiKey: "",
    baseUrlOverride: null,
    modelsOverride: null,
  };
  const baseUrl = entry.baseUrlOverride ?? preset.baseUrl;
  const apiKey = entry.apiKey;
  const model = store.activeModel || preset.models[0] || "";
  if (baseUrl === "" || model === "") return null;
  const importedFlavor = store.importedProviders?.[preset.id]?.flavor;
  return {
    baseUrl,
    apiKey,
    model,
    flavor: importedFlavor === "anthropic" ? "anthropic" : undefined,
  };
}

export async function loadSettings(): Promise<Settings | null> {
  const store = await loadProviderStore();
  return resolveConnection(store);
}

export async function testConnection(
  s: Settings,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = createLlmClient(s);
    await client.chat.completions.create({
      model: s.model,
      max_tokens: 5,
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true };
  } catch (e) {
    const err = e as {
      name?: string;
      message?: string;
      status?: number;
      cause?: { message?: string };
    };
    const parts = [err.name, err.message].filter(Boolean);
    let msg = parts.length > 0 ? parts.join(": ") : String(e);
    if (err.status !== undefined) msg += ` [HTTP ${err.status}]`;
    if (err.cause?.message) msg += ` (cause: ${err.cause.message})`;
    return { ok: false, error: msg };
  }
}
