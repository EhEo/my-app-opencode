# opencode 설정 가져오기 P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** opencode의 `auth.json` API 키 프로바이더들을 버튼 한 번으로 가져와(upsert) 설정에서 선택·사용할 수 있게 한다.

**Architecture:** Rust가 고정 경로의 auth.json을 읽어 주고(신규 명령), TS 순수 함수(`parseAuthJson`→`planImport`→`applyImport`)가 models.dev 레지스트리(실패 시 내장 스냅샷)와 결합해 `ProviderStore`를 upsert한다. 가져온 프로바이더는 `importedProviders` 메타로 저장되고 `importedPresets()`/`findPreset()`을 통해 기존 프리셋과 같은 UI·해석 경로에 합류한다.

**Tech Stack:** Tauri v2(Rust command), React 19 + TypeScript, vitest, 기존 `createTauriFetch`(Rust proxy 경유 fetch).

## Global Constraints

- spec: `docs/superpowers/specs/2026-07-03-opencode-import-design.md`. 아래는 그 binding 요구.
- auth.json 경로 고정: `%USERPROFILE%\.local\share\opencode\auth.json` — **읽기 전용**, 임의 경로 인자 금지.
- `type:"api"`만 가져옴. `type:"oauth"`는 skip(reason `oauth-p2`), 그 외 type은 skip(reason `unsupported-type`), 레지스트리에 없는 id는 skip(reason `unknown-provider`).
- upsert: 기존 항목 갱신 + 새 항목 추가. **auth.json에 없는 기존 항목을 삭제하지 않는다.**
- flavor 정책: npm이 `@ai-sdk/openai*` → usable. `@ai-sdk/anthropic` → 대체 매핑(`minimax-coding-plan`/`minimax` → `https://api.minimax.io/v1`) 있으면 usable, 없으면 usable=false로 가져와 UI에서 "형식 미지원" 배지+선택 불가. 그 외 npm → usable=false.
- 프리셋 ID 충돌(`zai-coding-plan`, `minimax`, `openai`, `custom`): importedProviders 항목을 만들지 않고 기존 `providers[id]`의 apiKey·modelsOverride만 갱신.
- **spec §4 정제(구현 확정)**: API 키는 `ImportedProviderMeta`가 아니라 기존 `store.providers[id].apiKey`에 **단일 경로로 저장**한다(기존 키 입력 UI·마스킹 재사용). `importedProviders`는 메타데이터만 담는다.
- 키 값을 콘솔/로그/화면에 노출하지 않는다(기존 password 필드 마스킹 재사용).
- models.dev 조회는 `createTauriFetch()` 경유 GET(키 미포함). 실패 시 `BUNDLED_REGISTRY` 폴백 + 요약에 표시.
- 게이트: `pnpm exec tsc --noEmit` 0 + `pnpm test` green + `cargo check` 0 + `pnpm build` 성공.

## File Structure

- Create `src/lib/opencodeImport.ts` — 파싱·레지스트리·계획·적용(순수 함수 중심) + 오케스트레이터.
- Create `src/lib/__tests__/opencodeImport.test.ts`, `src/lib/__tests__/settingsImported.test.ts`.
- Modify `src/lib/settings.ts` — `ImportedProviderMeta`, `importedPresets()`, `findPreset()`, `isProviderUsable()`, `resolveConnection` 확장.
- Modify `src/lib/pipelineDeps.ts:22` — 프리셋 조회를 `findPreset`으로.
- Modify `src/components/SettingsModal.tsx` — 프로바이더 목록에 imported 합류 + "opencode에서 가져오기" 버튼/요약.
- Modify `src-tauri/src/lib.rs` — `read_opencode_auth` 명령 + 핸들러 등록.
- Modify `src/styles.css` — import 행 스타일 2줄.

---

### Task 1: Rust `read_opencode_auth` 명령

**Files:**
- Modify: `src-tauri/src/lib.rs` (get_settings/set_settings 근처에 추가 + `generate_handler!` 목록 등록)

**Interfaces:**
- Produces: Tauri command `read_opencode_auth() -> Result<String, String>` — auth.json 원문 문자열. 파일 없으면 한국어 에러 메시지. (프런트는 `invoke<string>("read_opencode_auth")`로 호출)

- [ ] **Step 1: 명령 구현** — `set_settings` 함수 뒤에 추가:

```rust
/// Read opencode's auth.json (fixed path, read-only). Deliberately takes no
/// path argument — this is not a general file-read surface.
#[tauri::command]
fn read_opencode_auth() -> Result<String, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "홈 디렉터리를 찾을 수 없습니다".to_string())?;
    let path = std::path::PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json");
    if !path.exists() {
        return Err(
            "opencode auth.json을 찾을 수 없습니다 (opencode 설치/로그인 기록 없음)".to_string(),
        );
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: 핸들러 등록** — `tauri::generate_handler![` 목록(기존 `get_settings,` 줄 근처)에 `read_opencode_auth,` 추가.

- [ ] **Step 3: 검증**

Run: `cd src-tauri && cargo check`
Expected: 에러 0 (경고 무시).

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: read_opencode_auth 명령 (opencode auth.json 고정경로 읽기)"
```

---

### Task 2: settings.ts — importedProviders 메타 + 프리셋 합류

**Files:**
- Modify: `src/lib/settings.ts`
- Modify: `src/lib/pipelineDeps.ts:22-24`
- Test: `src/lib/__tests__/settingsImported.test.ts` (Create)

**Interfaces:**
- Consumes: 기존 `ProviderPreset`, `ProviderStore`, `PROVIDER_PRESETS`, `resolveConnection`.
- Produces (Task 3·4가 사용):
  - `type ImportedFlavor = "openai" | "anthropic" | "other"`
  - `interface ImportedProviderMeta { label: string; baseUrl: string; models: string[]; flavor: ImportedFlavor; usable: boolean; importedAt: string }`
  - `ProviderStore.importedProviders?: Record<string, ImportedProviderMeta>`
  - `importedPresets(store: ProviderStore): ProviderPreset[]`
  - `findPreset(store: ProviderStore, id: string): ProviderPreset | undefined`
  - `isProviderUsable(store: ProviderStore, id: string): boolean`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/lib/__tests__/settingsImported.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run src/lib/__tests__/settingsImported.test.ts`
Expected: FAIL — `importedPresets` export 없음.

- [ ] **Step 3: settings.ts 구현** — `ProviderEntry` 인터페이스 아래에 추가:

```ts
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
```

`ProviderStore`에 필드 추가(usageGuard 아래):

```ts
  importedProviders?: Record<string, ImportedProviderMeta>;
```

`resolveConnection` 위에 헬퍼 3개 추가:

```ts
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
```

`resolveConnection`의 첫 두 줄을 교체:

```ts
export function resolveConnection(store: ProviderStore): Settings | null {
  const preset = findPreset(store, store.activeProviderId);
  if (preset === undefined) return null;
  if (!isProviderUsable(store, preset.id)) return null;
  // ...이하 기존 코드 그대로...
```

- [ ] **Step 4: pipelineDeps.ts 결선** — `resolveInappSettings`에서:

기존(22-24행):
```ts
  const preset = PROVIDER_PRESETS.find((p) => p.id === backend.providerId);
  const entry = store.providers[backend.providerId];
  if (preset === undefined || entry === undefined) return null;
```
교체:
```ts
  const preset = findPreset(store, backend.providerId);
  const entry = store.providers[backend.providerId];
  if (preset === undefined || entry === undefined) return null;
  if (!isProviderUsable(store, backend.providerId)) return null;
```
import 문에서 `PROVIDER_PRESETS` 제거하고 `findPreset, isProviderUsable` 추가 (다른 곳에서 PROVIDER_PRESETS를 안 쓰면 — 이 파일에선 22행이 유일).

- [ ] **Step 5: 통과 확인**

Run: `pnpm exec vitest run` 그리고 `pnpm exec tsc --noEmit`
Expected: 전체 green(기존 51 + 신규 5), tsc 0.

- [ ] **Step 6: 커밋**

```bash
git add src/lib/settings.ts src/lib/pipelineDeps.ts src/lib/__tests__/settingsImported.test.ts
git commit -m "feat: importedProviders 메타 + findPreset로 프리셋/가져온 프로바이더 합류"
```

---

### Task 3: opencodeImport.ts — 파싱·계획·적용 (순수 코어)

**Files:**
- Create: `src/lib/opencodeImport.ts`
- Test: `src/lib/__tests__/opencodeImport.test.ts` (Create)

**Interfaces:**
- Consumes: Task 2의 `ImportedProviderMeta`, `PROVIDER_PRESETS`, `ProviderStore` (from `./settings`).
- Produces (Task 4가 사용):
  - `parseAuthJson(raw: string): AuthEntry[]` (throw on invalid)
  - `flavorOf(npm: string): ImportedFlavor`
  - `BUNDLED_REGISTRY: Registry`
  - `planImport(entries: AuthEntry[], registry: Registry, now: string): ImportPlan`
  - `applyImport(store: ProviderStore, plan: ImportPlan): { store: ProviderStore; summary: ImportSummary }`
  - 타입: `AuthEntry { id; type; key? }`, `Registry = Record<string, { name; api; npm; models: string[] }>`, `SkipReason = "oauth-p2" | "unknown-provider" | "unsupported-type"`, `ImportSummary { added: string[]; updated: string[]; skipped: { id: string; reason: SkipReason }[]; unusable: string[] }`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/lib/__tests__/opencodeImport.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run src/lib/__tests__/opencodeImport.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/lib/opencodeImport.ts`:

```ts
import {
  PROVIDER_PRESETS,
  type ImportedFlavor,
  type ImportedProviderMeta,
  type ProviderStore,
} from "./settings";

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
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run` 그리고 `pnpm exec tsc --noEmit`
Expected: 전체 green(신규 11개 포함), tsc 0.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/opencodeImport.ts src/lib/__tests__/opencodeImport.test.ts
git commit -m "feat: opencode auth.json 가져오기 코어 (파싱·계획·적용, 테스트)"
```

---

### Task 4: 레지스트리 조회 + 오케스트레이터 + 설정 UI

**Files:**
- Modify: `src/lib/opencodeImport.ts` (fetchRegistry, importFromOpencode 추가)
- Modify: `src/components/SettingsModal.tsx` (프로바이더 목록 합류 + 가져오기 버튼)
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task 1 `read_opencode_auth`, Task 2 `importedPresets`/`findPreset`, Task 3 전부, 기존 `createTauriFetch`(`./tauriFetch`).
- Produces: `importFromOpencode(store): Promise<{ store: ProviderStore; summary: ImportSummary; registryFallback: boolean }>`

- [ ] **Step 1: fetchRegistry + importFromOpencode** — `opencodeImport.ts` 상단 import에 추가:

```ts
import { invoke } from "@tauri-apps/api/core";
import { createTauriFetch } from "./tauriFetch";
```

파일 끝에 추가:

```ts
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
```

- [ ] **Step 2: SettingsModal — 프로바이더 목록에 imported 합류**

import 문 수정: `../lib/settings`에서 `importedPresets, findPreset` 추가, `../lib/opencodeImport`에서 `importFromOpencode` 추가.

`activePreset` memo(113-115행 부근) 교체:
```ts
  const activePreset: ProviderPreset = useMemo(() => {
    const found = findPreset(store, store.activeProviderId);
    return found ?? PROVIDER_PRESETS[0];
  }, [store, store.activeProviderId]);
```

프로바이더 목록 렌더(379행 부근) — `PROVIDER_PRESETS.map(...)`을 다음으로 교체(버튼 내부 JSX는 기존 그대로 유지하되 `disabled`·배지만 추가):
```tsx
              {[...PROVIDER_PRESETS, ...importedPresets(store)].map((preset) => {
                const selected = preset.id === store.activeProviderId;
                const unusable =
                  store.importedProviders?.[preset.id]?.usable === false;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={unusable}
                    className={
                      "settings-modal__provider" +
                      (selected ? " settings-modal__provider--selected" : "") +
                      (unusable ? " settings-modal__provider--disabled" : "")
                    }
                    onClick={() => setActiveProvider(preset.id)}
                  >
                    {/* ...기존 라디오·라벨·힌트 JSX 그대로... */}
                  </button>
                );
              })}
```

- [ ] **Step 3: 가져오기 버튼 + 요약** — state 추가(다른 useState들 옆):
```ts
  const [importMsg, setImportMsg] = useState<string | null>(null);
```
핸들러 추가(handleApiKeyChange 근처):
```ts
  const handleImportOpencode = useCallback(async (): Promise<void> => {
    setImportMsg("가져오는 중…");
    try {
      const { store: next, summary, registryFallback } =
        await importFromOpencode(store);
      setStore(next);
      let msg = `추가 ${summary.added.length} · 갱신 ${summary.updated.length} · 건너뜀 ${summary.skipped.length}`;
      if (summary.skipped.some((s) => s.reason === "oauth-p2")) {
        msg += " (OAuth는 P2에서 지원 예정)";
      }
      if (summary.unusable.length > 0) {
        msg += ` · 형식 미지원 ${summary.unusable.length}`;
      }
      if (registryFallback) msg += " · 레지스트리 접속 실패, 내장 목록 사용";
      msg += " — 저장을 눌러 적용하세요";
      setImportMsg(msg);
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : String(e));
    }
  }, [store]);
```
AI 탭 본문 맨 위(`{/* Provider list */}` 위)에 UI 추가:
```tsx
          <div className="settings-modal__field">
            <div className="settings-modal__import-row">
              <button
                type="button"
                className="settings-modal__btn"
                onClick={() => void handleImportOpencode()}
              >
                opencode에서 가져오기
              </button>
              {importMsg !== null ? (
                <span className="settings-modal__import-msg">{importMsg}</span>
              ) : null}
            </div>
          </div>
```

- [ ] **Step 4: CSS** — `src/styles.css`의 `.settings-modal__field`(1651행 부근) 위나 근처에 추가:
```css
.settings-modal__import-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.settings-modal__import-msg { font-size: 12px; color: var(--text-muted); }
.settings-modal__provider--disabled { opacity: 0.45; cursor: default; }
```

- [ ] **Step 5: 게이트 전체**

Run: `pnpm exec tsc --noEmit` → 0 errors
Run: `pnpm exec vitest run` → 전체 green
Run: `cd src-tauri && cargo check` → 에러 0
Run: `pnpm build` → `✓ built`

- [ ] **Step 6: 커밋**

```bash
git add src/lib/opencodeImport.ts src/components/SettingsModal.tsx src/styles.css
git commit -m "feat: 설정에 'opencode에서 가져오기' — 레지스트리 조회 + upsert + 요약"
```

---

## 수동 스모크 (구현 후 오케스트레이터가 `pnpm tauri dev`로 확인)

- [ ] 설정 → AI 탭 → "opencode에서 가져오기" → 요약이 "추가 2 · 갱신 2 · 건너뜀 2 (OAuth는 P2에서 지원 예정)" 형태로 표시된다(이 PC 기준: zen·go 추가, zai·minimax 갱신, openai·google 건너뜀).
- [ ] 프로바이더 목록에 "OpenCode Zen (opencode)", "OpenCode Go (opencode)"가 나타나고 모델 목록(수십 개)이 선택 가능하다.
- [ ] 저장 후 zen/go/zai에서 "연결 테스트" 성공, 채팅 1회 동작.
- [ ] minimax(대체 엔드포인트) 연결 테스트 — 실패하면 해당 항목 한계로 기록(spec 리스크 1).
- [ ] 다시 "가져오기" 실행 → 전부 "갱신"으로 집계(upsert 확인).
- [ ] opencode 미설치 시나리오는 auth.json 이름을 임시 변경해 확인 가능(선택): 명확한 에러 메시지.

## Self-Review 노트

- **Spec 커버리지**: §3 파싱·레지스트리·flavor(T3), §4 저장 구조(T2, apiKey 단일 경로 정제는 Global Constraints에 명시), §5 Rust 명령(T1)·순수 함수(T3)·UI(T4), §6 에러(auth 없음=T1 에러 문자열, 파싱 실패=T3 throw, 레지스트리 실패=T4 폴백+요약), §7 테스트(T2 5개·T3 11개), §8 보안(고정경로·키 미출력·password 필드 재사용). ✓
- **타입 일관성**: `ImportedProviderMeta`/`ImportedFlavor`(T2 정의 → T3 소비), `ImportSummary`/`importFromOpencode`(T3/T4), `findPreset`/`importedPresets`(T2 정의 → T4 소비). ✓
- **스킵 사유**: spec의 `unsupported-flavor`는 §3.3에 따라 "skip"이 아니라 usable=false로 가져오는 것으로 확정 → skip enum은 `oauth-p2 | unknown-provider | unsupported-type`, 요약에 `unusable` 별도 집계. (spec §5와의 차이를 이렇게 해소)
