# Multi-Agent Pipeline UI Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the UI that lets a user run the 3-stage (plan→code→review) pipeline: a `[Chat | Pipeline]` mode toggle in the right-hand panel, a `PipelinePanel` with per-stage backend selection + streaming output + a soft-guard pause, a `UsageStrip`, and an "Agents" settings tab (worker registry + pipeline defaults + guard settings + CLI detection). This wires the Plan-2 engine (`runPipeline`) and Plan-3 logic (`makePipelineDeps`, `SessionUsage`, `detectCli`) to real user interaction.

**Architecture:** One tiny testable helper (`format.ts`) plus React components. `PipelinePanel` owns a run: it builds `deps = makePipelineDeps(store)` per run, tracks a synchronous in-app token estimate for the guard (so `runPipeline`'s sync `guardBeforeStage` works), drives stage cards from `runPipeline` callbacks, and resolves `onGuardPause` from a banner. `ChatPanel` gains a `mode` state and renders `PipelinePanel` in pipeline mode. The Agents tab edits `ProviderStore.workers`/`pipeline`/`usageGuard` and persists via the existing Save flow.

**Tech Stack:** React 19 + TS, existing `src/lib/pipeline.ts` (`runPipeline`, `StageResult`), `src/lib/pipelineDeps.ts` (`makePipelineDeps`), `src/lib/workers.ts` (`resolveBackend`, `DEFAULT_STAGES`, `detectCli`), `src/lib/usage.ts` (`guardState`, `GuardState`), `src/lib/usageSession.ts` (`SessionUsage`, `estimateTokens`), `src/lib/settings.ts` (`ProviderStore`, `loadProviderStore`, `WorkerBackend`, `StageConfig`), existing CSS classes in `src/styles.css`.

## Global Constraints

- Reuse existing CSS classes where possible (`chat-panel`, `chat-panel__header`, `settings-modal__*`, `toolbar__btn`, `chat-tool-card`, `chat-input__*`); add new classes only where needed and keep styling minimal.
- `runPipeline` signature (from `pipeline.ts`): `runPipeline({ request, stages, workers?, guardBeforeStage?, callbacks?, signal?, deps })`. `guardBeforeStage(stageId) => "ok"|"warn"` is SYNC; `callbacks.onGuardPause(stageId) => Promise<boolean>` is async. `callbacks`: `onStageStart(stage)`, `onStageToken(stageId, delta)`, `onStageEnd(result: StageResult)`, `onGuardPause`.
- Because `guardBeforeStage` is sync but real usage (CLI JSONL) is async, the guard uses a SYNCHRONOUS running in-app token estimate (accumulated from streamed output via `estimateTokens`) compared with `usageGuard.perRunBudgetTokens`. The `UsageStrip` separately shows the full async snapshot (in-app + CLI).
- MCP note (from Plan-3 review): a resolved stage whose backend is MCP may still contain `ERROR: …` in its output — do not style MCP output as success purely because it resolved; show the raw output.
- Build `deps` fresh per run via `makePipelineDeps(store)` — do not cache across settings edits.
- `pnpm exec tsc --noEmit` must pass (strict, `noUnusedLocals`, no `any` in component prop types). Do not break existing chat behavior.
- Verify gate per task: `pnpm exec tsc --noEmit` exit 0, `pnpm test` still green (existing 35 tests), plus the task's manual smoke step where specified.

---

### Task 1: `format.ts` — compact token count formatter

**Files:**
- Create: `src/lib/format.ts`
- Create: `src/lib/__tests__/format.test.ts`

**Interfaces:**
- Produces: `function formatCount(n: number): string` — `< 1000` → the integer as-is; `>= 1000` → one-decimal `k` (e.g. `1234 → "1.2k"`, `12345 → "12.3k"`); negatives/NaN → `"0"`.

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatCount } from "../format";

describe("formatCount", () => {
  it("passes small numbers through", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });
  it("uses one-decimal k for thousands", () => {
    expect(formatCount(1000)).toBe("1.0k");
    expect(formatCount(1234)).toBe("1.2k");
    expect(formatCount(12345)).toBe("12.3k");
  });
  it("guards against negative / NaN", () => {
    expect(formatCount(-5)).toBe("0");
    expect(formatCount(Number.NaN)).toBe("0");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/__tests__/format.test.ts`
Expected: FAIL — `Cannot find module '../format'`.

- [ ] **Step 3: Create `format.ts`**

```ts
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  return `${(n / 1000).toFixed(1)}k`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/__tests__/format.test.ts`
Expected: PASS. Then `pnpm exec tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/format.ts src/lib/__tests__/format.test.ts
git commit -m "feat: formatCount — compact token count formatter"
```

---

### Task 2: `UsageStrip.tsx` — usage + guard display

**Files:**
- Create: `src/components/UsageStrip.tsx`
- Modify: `src/styles.css` (append `.usage-strip` rules)

**Interfaces:**
- Consumes: `formatCount` (format.ts), `UsageSnapshot` (usageSession.ts), `GuardState` (usage.ts).
- Produces: `function UsageStrip({ snapshot }: { snapshot: UsageSnapshot | null }): React.JSX.Element` — a thin strip showing session tokens, per-tool CLI tokens, and an ok/warn guard badge. Renders a muted placeholder when `snapshot === null`.

- [ ] **Step 1: Create the component**

Create `src/components/UsageStrip.tsx`:

```tsx
import { formatCount } from "../lib/format";
import { totalTokens } from "../lib/usage";
import type { UsageSnapshot } from "../lib/usageSession";

export function UsageStrip({
  snapshot,
}: {
  snapshot: UsageSnapshot | null;
}): React.JSX.Element {
  if (snapshot === null) {
    return <div className="usage-strip usage-strip--empty">usage —</div>;
  }
  const tools = Object.entries(snapshot.cli).filter(
    ([, t]) => totalTokens(t) > 0,
  );
  return (
    <div className="usage-strip">
      <span className="usage-strip__item">
        session {formatCount(snapshot.sessionTokens)}
      </span>
      <span className="usage-strip__item usage-strip__item--muted">
        inapp {formatCount(snapshot.inappTokens)}
      </span>
      {tools.map(([name, t]) => (
        <span key={name} className="usage-strip__item usage-strip__item--muted">
          {name} {formatCount(totalTokens(t))}
        </span>
      ))}
      <span
        className={
          "usage-strip__guard" +
          (snapshot.guard === "warn" ? " usage-strip__guard--warn" : "")
        }
      >
        {snapshot.guard === "warn" ? "⚠ budget" : "● ok"}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Append CSS**

Append to `src/styles.css`:

```css
.usage-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-subtle);
  white-space: nowrap;
  overflow-x: auto;
}
.usage-strip--empty { opacity: 0.6; }
.usage-strip__item--muted { opacity: 0.7; }
.usage-strip__guard { margin-left: auto; color: var(--text); }
.usage-strip__guard--warn { color: var(--warn); font-weight: 600; }
```

- [ ] **Step 3: Verify build**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0 (component is unused-imported until Task 3 wires it — that's fine; `noUnusedLocals` applies to locals, not to exported components in their own file).

- [ ] **Step 4: Commit**

```bash
git add src/components/UsageStrip.tsx src/styles.css
git commit -m "feat: UsageStrip — session/CLI token + guard display"
```

---

### Task 3: `PipelinePanel.tsx` — the pipeline runner UI

**Files:**
- Modify: `src/lib/settings.ts` (add the `usageGuard?` field to `ProviderStore`)
- Create: `src/components/PipelinePanel.tsx`
- Modify: `src/styles.css` (append `.pipeline-*` rules)

**Interfaces:**
- Consumes: `runPipeline`/`StageResult` (pipeline.ts), `makePipelineDeps` (pipelineDeps.ts), `DEFAULT_STAGES`/`resolveBackend` (workers.ts), `guardState` (usage.ts), `SessionUsage`/`estimateTokens` (usageSession.ts), `loadProviderStore`/`ProviderStore`/`StageConfig` (settings.ts), `UsageStrip` (Task 2).
- Produces: `function PipelinePanel({ workspaceRoot }: { workspaceRoot: string | null }): React.JSX.Element`. Also adds `ProviderStore.usageGuard?: { enabled: boolean; perRunBudgetTokens?: number; warnRatio: number; providers?: string[] }`.

- [ ] **Step 1: Add `usageGuard` to `ProviderStore`**

Plan 2 added `workers?`/`pipeline?` to `ProviderStore` but not `usageGuard`. Add it now — in `src/lib/settings.ts`, add this optional field to the `ProviderStore` interface (alongside `workers?`/`pipeline?`):

```ts
  usageGuard?: {
    enabled: boolean;
    perRunBudgetTokens?: number;
    warnRatio: number;
    providers?: string[];
  };
```

- [ ] **Step 2: Create the component**

Create `src/components/PipelinePanel.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadProviderStore,
  type ProviderStore,
  type StageConfig,
} from "../lib/settings";
import { DEFAULT_STAGES } from "../lib/workers";
import { runPipeline, type StageResult } from "../lib/pipeline";
import { makePipelineDeps } from "../lib/pipelineDeps";
import { guardState } from "../lib/usage";
import { SessionUsage, estimateTokens, type UsageSnapshot } from "../lib/usageSession";
import { UsageStrip } from "./UsageStrip";

type StageView = {
  id: string;
  label: string;
  backendId: string | undefined; // undefined = default in-app
  status: "pending" | "running" | "done" | "error";
  output: string;
};

function initialStages(store: ProviderStore | null): StageView[] {
  const stages: StageConfig[] = store?.pipeline?.stages ?? DEFAULT_STAGES;
  return stages
    .filter((s) => s.enabled)
    .map((s) => ({
      id: s.id,
      label: s.label,
      backendId: s.backendId,
      status: "pending",
      output: "",
    }));
}

export function PipelinePanel({
  workspaceRoot,
}: {
  workspaceRoot: string | null;
}): React.JSX.Element {
  const [store, setStore] = useState<ProviderStore | null>(null);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<StageView[]>(() => initialStages(null));
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [guardPrompt, setGuardPrompt] = useState<{ resolve: (ok: boolean) => void } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<SessionUsage>(new SessionUsage());
  const sessionTokensRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await loadProviderStore();
        if (!cancelled) {
          setStore(s);
          setStages(initialStages(s));
        }
      } catch {
        void 0;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  const refreshUsage = useCallback(async (): Promise<void> => {
    const budget = store?.usageGuard?.perRunBudgetTokens;
    const warn = store?.usageGuard?.warnRatio ?? 0.8;
    try {
      const snap = await sessionRef.current.snapshot(budget, warn);
      setSnapshot(snap);
    } catch {
      void 0;
    }
  }, [store]);

  const setStageBackend = useCallback((id: string, backendId: string | undefined): void => {
    setStages((prev) => prev.map((s) => (s.id === id ? { ...s, backendId } : s)));
  }, []);

  const patchStage = useCallback((id: string, patch: Partial<StageView>): void => {
    setStages((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const handleRun = useCallback(async (): Promise<void> => {
    if (store === null || running || input.trim() === "") return;
    const guardEnabled = store.usageGuard?.enabled === true;
    const budget = store.usageGuard?.perRunBudgetTokens;
    const warn = store.usageGuard?.warnRatio ?? 0.8;

    sessionRef.current = new SessionUsage();
    sessionTokensRef.current = 0;
    setSnapshot(null);
    setStages((prev) => prev.map((s) => ({ ...s, status: "pending", output: "" })));

    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);

    const stageConfigs: StageConfig[] = stages.map((s) => ({
      id: s.id as StageConfig["id"],
      label: s.label,
      backendId: s.backendId,
      enabled: true,
    }));

    try {
      await runPipeline({
        request: input.trim(),
        stages: stageConfigs,
        workers: store.workers,
        deps: makePipelineDeps(store),
        signal: ac.signal,
        guardBeforeStage: guardEnabled
          ? () => guardState(sessionTokensRef.current, budget, warn)
          : undefined,
        callbacks: {
          onStageStart: (stage) => patchStage(stage.id, { status: "running", output: "" }),
          onStageToken: (stageId, delta) => {
            sessionRef.current.addInapp(delta);
            sessionTokensRef.current += estimateTokens(delta);
            setStages((prev) =>
              prev.map((s) => (s.id === stageId ? { ...s, output: s.output + delta } : s)),
            );
          },
          onStageEnd: (result: StageResult) => {
            patchStage(result.stageId, {
              status: result.error !== undefined ? "error" : "done",
              output: result.error !== undefined ? `[error] ${result.error}` : result.output,
            });
            void refreshUsage();
          },
          onGuardPause: (_stageId) =>
            new Promise<boolean>((resolve) => setGuardPrompt({ resolve })),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void msg;
    } finally {
      setRunning(false);
      abortRef.current = null;
      setGuardPrompt(null);
      void refreshUsage();
    }
  }, [store, running, input, stages, patchStage, refreshUsage]);

  const handleStop = useCallback((): void => {
    abortRef.current?.abort();
    if (guardPrompt !== null) {
      guardPrompt.resolve(false);
      setGuardPrompt(null);
    }
  }, [guardPrompt]);

  const resolveGuard = useCallback(
    (ok: boolean): void => {
      guardPrompt?.resolve(ok);
      setGuardPrompt(null);
    },
    [guardPrompt],
  );

  const workerIds = Object.keys(store?.workers ?? {});
  const canRun = store !== null && !running && workspaceRoot !== null && input.trim() !== "";

  return (
    <div className="pipeline-panel">
      <UsageStrip snapshot={snapshot} />
      <div className="pipeline-panel__input-row">
        <textarea
          className="chat-input__field"
          rows={2}
          placeholder={
            workspaceRoot === null ? "Open a folder first…" : "Describe the task for the pipeline…"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
        />
        {running ? (
          <button type="button" className="chat-input__btn chat-input__btn--stop" onClick={handleStop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="chat-input__btn chat-input__btn--send"
            onClick={() => void handleRun()}
            disabled={!canRun}
          >
            Run
          </button>
        )}
      </div>

      {guardPrompt !== null ? (
        <div className="pipeline-panel__guard">
          <span>⚠ 사용량이 예산 경고 임계값을 넘었습니다. 계속할까요?</span>
          <button type="button" className="toolbar__btn" onClick={() => resolveGuard(true)}>
            계속
          </button>
          <button type="button" className="toolbar__btn" onClick={() => resolveGuard(false)}>
            중지
          </button>
        </div>
      ) : null}

      <div className="pipeline-panel__stages">
        {stages.map((s) => (
          <div key={s.id} className={`pipeline-stage pipeline-stage--${s.status}`}>
            <div className="pipeline-stage__head">
              <span className="pipeline-stage__label">{s.label}</span>
              <select
                className="pipeline-stage__backend"
                value={s.backendId ?? ""}
                disabled={running}
                onChange={(e) => setStageBackend(s.id, e.target.value === "" ? undefined : e.target.value)}
              >
                <option value="">기본 (인앱)</option>
                {workerIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <span className="pipeline-stage__status">{s.status}</span>
            </div>
            {s.output.length > 0 ? (
              <pre className="pipeline-stage__output">{s.output}</pre>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Append CSS**

Append to `src/styles.css`:

```css
.pipeline-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.pipeline-panel__input-row { display: flex; gap: 6px; padding: 8px; align-items: flex-end; }
.pipeline-panel__input-row .chat-input__field { flex: 1; }
.pipeline-panel__guard {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  background: var(--bg-active-soft); color: var(--warn); font-size: 12px;
}
.pipeline-panel__stages { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
.pipeline-stage { border: 1px solid var(--border-subtle); border-radius: 4px; margin-bottom: 8px; }
.pipeline-stage__head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; }
.pipeline-stage__label { font-weight: 600; font-size: 13px; }
.pipeline-stage__backend { margin-left: 4px; background: var(--bg-editor); color: var(--text); border: 1px solid var(--border-strong); border-radius: 3px; font-size: 11px; padding: 2px 4px; }
.pipeline-stage__status { margin-left: auto; font-size: 11px; color: var(--text-muted); }
.pipeline-stage--running .pipeline-stage__status { color: var(--accent-hover); }
.pipeline-stage--error .pipeline-stage__status { color: var(--danger); }
.pipeline-stage--done .pipeline-stage__status { color: var(--info, #7cb342); }
.pipeline-stage__output { margin: 0; padding: 8px; font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; border-top: 1px solid var(--border-subtle); }
```

- [ ] **Step 4: Verify build**

Run: `pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings.ts src/components/PipelinePanel.tsx src/styles.css
git commit -m "feat: PipelinePanel — 3-stage pipeline runner UI with per-stage backend + guard"
```

---

### Task 4: Wire `PipelinePanel` into `ChatPanel` via a mode toggle

**Files:**
- Modify: `src/components/ChatPanel.tsx`

**Interfaces:**
- Consumes: `PipelinePanel` (Task 3).
- Produces: ChatPanel renders a `[Chat | Pipeline]` segmented toggle in its header; in `"pipeline"` mode it renders `<PipelinePanel workspaceRoot={workspaceRoot} />` in place of the chat messages+input; chat state is preserved across toggles.

- [ ] **Step 1: Add the mode toggle**

In `src/components/ChatPanel.tsx`:

1. Add the import at the top:
   ```tsx
   import { PipelinePanel } from "./PipelinePanel";
   ```
2. Add mode state inside the component (near the other `useState` calls):
   ```tsx
   const [mode, setMode] = useState<"chat" | "pipeline">("chat");
   ```
3. In the header (`<header className="chat-panel__header">`), add a toggle after the title `<span>`:
   ```tsx
   <div className="chat-panel__mode" role="tablist">
     <button
       type="button"
       className={`chat-panel__mode-btn${mode === "chat" ? " chat-panel__mode-btn--active" : ""}`}
       onClick={() => setMode("chat")}
     >
       Chat
     </button>
     <button
       type="button"
       className={`chat-panel__mode-btn${mode === "pipeline" ? " chat-panel__mode-btn--active" : ""}`}
       onClick={() => setMode("pipeline")}
     >
       Pipeline
     </button>
   </div>
   ```
4. Wrap the existing messages area + footer so they render only in chat mode, and render `PipelinePanel` in pipeline mode. Immediately after the closing `</header>`, change the body so it is:
   ```tsx
   {mode === "pipeline" ? (
     <PipelinePanel workspaceRoot={workspaceRoot} />
   ) : (
     <>
       {/* existing scroll container <div className="chat-messages"> … </div> and <footer className="chat-input"> … </footer> stay here unchanged */}
     </>
   )}
   ```
   (Move the existing `chat-messages` scroll `<div>` and the `chat-input` `<footer>` inside the `else` branch's fragment, verbatim — do not modify their internals.)

- [ ] **Step 2: Append CSS**

Append to `src/styles.css`:

```css
.chat-panel__mode { display: inline-flex; gap: 2px; margin-left: auto; }
.chat-panel__mode-btn {
  background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted);
  font-size: 11px; padding: 2px 8px; cursor: pointer; border-radius: 3px;
}
.chat-panel__mode-btn--active { background: var(--bg-active-soft); color: var(--text-strong); }
```

- [ ] **Step 3: Verify build**

Run: `pnpm exec tsc --noEmit` (exit 0) and `pnpm test` (existing 35 pass).

- [ ] **Step 4: Manual smoke**

Run `pnpm tauri dev`. In the app: open a folder → the right panel shows `[Chat | Pipeline]`. Click **Pipeline** → the pipeline UI appears (usage strip, input, 3 stage cards Plan/Code/Review). Click **Chat** → the chat returns with its prior state intact. (No provider configured yet is fine — Run stays disabled or errors gracefully.)

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatPanel.tsx src/styles.css
git commit -m "feat: ChatPanel Chat/Pipeline mode toggle hosting PipelinePanel"
```

---

### Task 5: "Agents" settings tab — worker registry, pipeline defaults, guard

**Files:**
- Modify: `src/components/SettingsModal.tsx` (add an `"agents"` tab + an `AgentsSection` component)

**Interfaces:**
- Consumes: `WorkerBackend`/`StageConfig`/`ProviderStore` (settings.ts), `DEFAULT_STAGES` (workers.ts), `detectCli` (workers.ts).
- Produces: a new tab "Agents" rendering `AgentsSection({ store, setStore })` that edits `store.workers`, `store.pipeline.stages` (backend per stage), and `store.usageGuard`. Persistence uses the modal's existing Save (which calls `saveProviderStore(store)`).

- [ ] **Step 1: Extend the tab type + tab button + panel**

In `src/components/SettingsModal.tsx`:

1. Add imports:
   ```tsx
   import { DEFAULT_STAGES } from "../lib/workers";
   import { detectCli } from "../lib/workers";
   import type { WorkerBackend, StageConfig } from "../lib/settings";
   ```
   (If `DEFAULT_STAGES` and `detectCli` are both from `../lib/workers`, combine into one import line.)
2. Extend the `activeTab` union to include `"agents"`:
   ```tsx
   const [activeTab, setActiveTab] = useState<"ai" | "mcp" | "skills" | "terminal" | "agents">("ai");
   ```
3. Add a tab button after the "터미널" tab button:
   ```tsx
   <button
     type="button"
     role="tab"
     aria-selected={activeTab === "agents"}
     className={`settings-modal__tab${activeTab === "agents" ? " settings-modal__tab--active" : ""}`}
     onClick={() => setActiveTab("agents")}
   >
     Agents
   </button>
   ```
4. Render the section after the terminal tab block:
   ```tsx
   {activeTab === "agents" ? <AgentsSection store={store} setStore={setStore} /> : null}
   ```

- [ ] **Step 2: Add the `AgentsSection` component**

Add near the other section components (e.g. before `TerminalSection`) in `SettingsModal.tsx`:

```tsx
interface AgentsSectionProps {
  store: ProviderStore;
  setStore: React.Dispatch<React.SetStateAction<ProviderStore>>;
}

function AgentsSection({ store, setStore }: AgentsSectionProps): React.JSX.Element {
  const [newId, setNewId] = useState("");
  const [newCmd, setNewCmd] = useState("");
  const [detected, setDetected] = useState<Record<string, boolean>>({});

  const workers = store.workers ?? {};
  const stages: StageConfig[] = store.pipeline?.stages ?? DEFAULT_STAGES;
  const guard = store.usageGuard ?? { enabled: false, warnRatio: 0.8 };

  const addCliWorker = (): void => {
    const id = newId.trim();
    const command = newCmd.trim();
    if (id === "" || command === "" || workers[id] !== undefined) return;
    const backend: WorkerBackend = {
      kind: "cli",
      command,
      argsTemplate: ["exec", "@brief"],
      briefMode: "arg",
      timeoutSec: 300,
      resultParse: "raw",
    };
    setStore((s) => ({ ...s, workers: { ...(s.workers ?? {}), [id]: backend } }));
    setNewId("");
    setNewCmd("");
  };

  const removeWorker = (id: string): void => {
    setStore((s) => {
      const next = { ...(s.workers ?? {}) };
      delete next[id];
      return { ...s, workers: next };
    });
  };

  const setStageBackend = (stageId: string, backendId: string): void => {
    const nextStages = stages.map((st) =>
      st.id === stageId ? { ...st, backendId: backendId === "" ? undefined : backendId } : st,
    );
    setStore((s) => ({ ...s, pipeline: { stages: nextStages } }));
  };

  const patchGuard = (patch: Partial<NonNullable<ProviderStore["usageGuard"]>>): void => {
    setStore((s) => ({ ...s, usageGuard: { ...guard, ...patch } }));
  };

  const runDetect = async (id: string, command: string): Promise<void> => {
    const ok = await detectCli(command);
    setDetected((d) => ({ ...d, [id]: ok }));
  };

  const workerIds = Object.keys(workers);

  return (
    <div className="settings-modal__mcp">
      <h3 className="settings-modal__section-title">CLI 워커</h3>
      <p className="settings-modal__hint">
        외부 CLI 에이전트(claude/codex/gemini 등)를 등록하면 파이프라인 단계에서 인앱 AI 대신
        선택할 수 있습니다. args의 <code>@brief</code>는 단계 브리프로 치환됩니다.
      </p>
      <ul className="settings-modal__mcp-list">
        {workerIds.map((id) => {
          const w = workers[id];
          if (w.kind !== "cli") return null;
          return (
            <li key={id} className="settings-modal__mcp-item">
              <div className="settings-modal__mcp-row1">
                <span className="settings-modal__mcp-name">{id}</span>
                <code className="settings-modal__mcp-url">
                  {w.command} {w.argsTemplate.join(" ")}
                </code>
                <button
                  type="button"
                  className="settings-modal__btn settings-modal__btn--small"
                  onClick={() => void runDetect(id, w.command)}
                >
                  탐지
                </button>
                {detected[id] !== undefined ? (
                  <span>{detected[id] ? "✓ 사용가능" : "✗ 없음"}</span>
                ) : null}
                <button
                  type="button"
                  className="settings-modal__btn settings-modal__btn--small settings-modal__btn--danger"
                  onClick={() => removeWorker(id)}
                >
                  제거
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="settings-modal__mcp-add">
        <input
          className="settings-modal__input"
          placeholder="워커 id (예: codex)"
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
        />
        <input
          className="settings-modal__input"
          placeholder="명령 (예: codex)"
          value={newCmd}
          onChange={(e) => setNewCmd(e.target.value)}
        />
        <button
          type="button"
          className="settings-modal__btn settings-modal__btn--primary settings-modal__btn--small"
          onClick={addCliWorker}
          disabled={newId.trim() === "" || newCmd.trim() === ""}
        >
          추가
        </button>
      </div>

      <h3 className="settings-modal__section-title">파이프라인 단계 기본 백엔드</h3>
      {stages.map((st) => (
        <div key={st.id} className="settings-modal__field">
          <span className="settings-modal__label">{st.label}</span>
          <select
            className="settings-modal__input settings-modal__select"
            value={st.backendId ?? ""}
            onChange={(e) => setStageBackend(st.id, e.target.value)}
          >
            <option value="">기본 (인앱 AI)</option>
            {workerIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      ))}

      <h3 className="settings-modal__section-title">사용량 가드</h3>
      <label className="settings-modal__mcp-toggle">
        <input
          type="checkbox"
          checked={guard.enabled}
          onChange={(e) => patchGuard({ enabled: e.target.checked })}
        />
        <span>실행당 예산 경고 사용</span>
      </label>
      <div className="settings-modal__field">
        <span className="settings-modal__label">실행당 예산 (토큰, 비우면 무제한)</span>
        <input
          type="number"
          className="settings-modal__input"
          value={guard.perRunBudgetTokens ?? ""}
          onChange={(e) =>
            patchGuard({
              perRunBudgetTokens: e.target.value === "" ? undefined : Number(e.target.value),
            })
          }
        />
      </div>
      <div className="settings-modal__field">
        <span className="settings-modal__label">경고 임계 비율 (0–1)</span>
        <input
          type="number"
          step="0.05"
          min="0"
          max="1"
          className="settings-modal__input"
          value={guard.warnRatio}
          onChange={(e) => patchGuard({ warnRatio: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm exec tsc --noEmit` (exit 0) and `pnpm test` (35 still pass).

- [ ] **Step 4: Manual smoke**

`pnpm tauri dev` → open Settings → **Agents** tab. Add a CLI worker (id `codex`, command `codex`) → it appears in the list; click **탐지** → shows ✓/✗. Set the **Code** stage's backend dropdown to `codex`. Toggle the guard on, set budget e.g. `50000`. Click **저장**. Reopen Settings → Agents → the worker, stage mapping, and guard persist. In the Pipeline panel, the Code stage's dropdown now defaults to `codex`.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsModal.tsx
git commit -m "feat: Agents settings tab — CLI worker registry, stage backends, usage guard"
```

---

## Self-Review

**Spec coverage (`2026-07-02-multiagent-pipeline-mvp.md` §7 + deferred items):**
- §7 ChatPanel `[Chat|Pipeline]` toggle → Task 4 ✅. PipelinePanel: input + Run/Stop + 3 stage cards + per-stage backend dropdown + streaming output + guard pause banner → Task 3 ✅. UsageStrip → Task 2 ✅.
- §7 Agents tab: CLI worker registry + [탐지] + stage→backend defaults + guard settings → Task 5 ✅.
- Plan-3 wiring notes honored: `makePipelineDeps(store)` built fresh per run (Task 3 `handleRun`), guard uses SYNC in-app estimate (`guardBeforeStage`), MCP/error output shown raw (stage `output`), no assumption resolved==success.
- **Deferred (post-MVP, noted):** file-as-memory transcript writing to `.opencode/pipeline/<runId>/`; inapp/mcp worker *editing* in the Agents tab (Task 5 registers CLI workers — the common secondary case; inapp stages already work as the default and mcp workers come from the MCP tab's servers, so a full inapp/mcp worker editor is not needed for the MVP); the `custom`-provider model-fallback hardening.

**Placeholder scan:** Component code is complete. Task 4 Step 1.4 references moving the existing `chat-messages`/`chat-input` blocks verbatim into the else-branch rather than repeating ~150 lines of unchanged JSX — this is a structural instruction, not a placeholder (the blocks are not modified, only relocated); the implementer keeps them byte-for-byte.

**Type consistency:** `PipelinePanel` prop `workspaceRoot: string | null` matches how `ChatPanel` passes it (Task 4). `StageView.backendId` / `StageConfig.backendId` both `string | undefined`. `runPipeline` call matches `pipeline.ts` (request/stages/workers/deps/signal/guardBeforeStage/callbacks; callbacks are `onStageStart/onStageToken/onStageEnd/onGuardPause`). `makePipelineDeps(store)` returns `PipelineDeps`. `guardState(number, number|undefined, number)` matches usage.ts. `UsageSnapshot` from usageSession.ts consumed by UsageStrip. `usageGuard` shape `{enabled, perRunBudgetTokens?, warnRatio, providers?}` matches settings.ts `ProviderStore.usageGuard`. No `any` in prop types.
