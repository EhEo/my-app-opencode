# Multi-Agent Wiring & Logic Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Plan-2 pipeline engine to the app's real capabilities and add the supporting logic — the `PipelineDeps` adapters that bridge `runPipeline` to the existing `runAgent` (in-app) and `callTool` (MCP), CLI availability detection, and session token estimation for the soft guard. All three are unit-tested with vitest. The React UI that consumes these (PipelinePanel, UsageStrip, Agents settings tab) is Plan 4.

**Architecture:** Three additions under `src/lib/`: `pipelineDeps.ts` (builds a `PipelineDeps` from a `ProviderStore`; translates `runAgent`'s callback/void/`onDone("aborted")` contract into the pipeline's `Promise<string>`/throw-on-abort contract, and `callTool`'s `{result}` into a string), a `detectCli` function added to `workers.ts`, and `usageSession.ts` (token estimation + session accumulation + a combined in-app/CLI snapshot). No changes to `agent.ts`, `mcp.ts`, `pipeline.ts`, or `src-tauri/`.

**Tech Stack:** TypeScript, vitest (present since Plan 2), existing `src/lib/agent.ts` (`runAgent`, `ChatMessage`), `src/lib/mcp.ts` (`callTool`), `src/lib/settings.ts` (`ProviderStore`, `resolveConnection`, `PROVIDER_PRESETS`), `src/lib/pipeline.ts` (`PipelineDeps`), `src/lib/agentExec.ts` (`runExec`), `src/lib/usage.ts` (`readCliUsage`, `UsageTotals`, `guardState`).

## Global Constraints

- Do NOT modify `agent.ts`, `mcp.ts`, `pipeline.ts`, `agentExec.ts`, `usage.ts`, or anything in `src-tauri/`. This plan is additive: new files + a `detectCli` export appended to `workers.ts`.
- The final Plan-2 review flagged the exact adapter contract, which is BINDING here:
  - `runAgent(opts)` returns `Promise<void>` and streams via `opts.callbacks`. It signals abort by calling `callbacks.onDone("aborted", …)` — it does NOT throw on abort. The `runInapp` adapter MUST translate an `"aborted"` (or `"max_iterations"` treated as done) correctly and MUST reject with `Error("aborted")` on abort, else the pipeline treats an aborted stage as a successful empty output.
  - `runAgent`'s `AgentCallbacks` requires ALL of: `onToken`, `onAssistantText`, `onToolStart`, `onToolEnd`, `onFileChanged`, `onDone`, `onError`. Provide no-op stubs for the ones the adapter doesn't use.
  - `callTool(fullName, args)` returns `Promise<{ result: string; changedPath?: string }>`. MCP tool full name format is `mcp__${server}__${tool}` (matches `mcp.ts`'s `NAMESPACE_PREFIX` + `__` join). The `runMcp` adapter passes the brief as `{ input: brief }` and returns `.result`.
- `PipelineDeps.runInapp` signature: `(backend: Extract<WorkerBackend,{kind:"inapp"}>, brief: string, onToken?: (d:string)=>void, signal?: AbortSignal) => Promise<string>`. `PipelineDeps.runMcp`: `(backend: Extract<WorkerBackend,{kind:"mcp"}>, brief: string) => Promise<string>`.
- TypeScript strict; repo has `noUnusedLocals: true`. No `any` in exported signatures.
- Commit hygiene: stage ONLY the files each task creates/edits (there are unrelated pre-existing modified tracked files — never `git commit -am`).
- Verify gate after every task: `pnpm test` (full vitest suite) passes AND `pnpm exec tsc --noEmit` passes.

---

### Task 1: `pipelineDeps.ts` — in-app + MCP adapters

**Files:**
- Create: `src/lib/pipelineDeps.ts`
- Create: `src/lib/__tests__/pipelineDeps.test.ts`

**Interfaces:**
- Consumes: `runAgent` (agent.ts), `callTool` (mcp.ts), `resolveConnection`/`PROVIDER_PRESETS`/`ProviderStore`/`Settings` (settings.ts), `PipelineDeps` (pipeline.ts), `WorkerBackend` (settings.ts).
- Produces (consumed by Plan 4 PipelinePanel):
  - `function resolveInappSettings(store: ProviderStore, backend: { providerId: string; model?: string }): Settings | null` — for `providerId === ""` uses `resolveConnection(store)` (optionally overriding `model`); for a specific provider id builds `{baseUrl, apiKey, model}` from the preset + stored entry; returns `null` when it can't form a complete connection.
  - `function makePipelineDeps(store: ProviderStore): PipelineDeps` — the adapters.

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/pipelineDeps.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/__tests__/pipelineDeps.test.ts`
Expected: FAIL — `Cannot find module '../pipelineDeps'`.

- [ ] **Step 3: Create `pipelineDeps.ts`**

Create `src/lib/pipelineDeps.ts`:

```ts
import { runAgent } from "./agent";
import { callTool } from "./mcp";
import {
  resolveConnection,
  PROVIDER_PRESETS,
  type ProviderStore,
  type Settings,
} from "./settings";
import type { PipelineDeps } from "./pipeline";

export function resolveInappSettings(
  store: ProviderStore,
  backend: { providerId: string; model?: string },
): Settings | null {
  if (backend.providerId === "") {
    const base = resolveConnection(store);
    if (base === null) return null;
    return backend.model !== undefined && backend.model !== ""
      ? { ...base, model: backend.model }
      : base;
  }
  const preset = PROVIDER_PRESETS.find((p) => p.id === backend.providerId);
  const entry = store.providers[backend.providerId];
  if (preset === undefined || entry === undefined) return null;
  const baseUrl = entry.baseUrlOverride ?? preset.baseUrl;
  const model = backend.model || preset.models[0] || store.activeModel;
  if (baseUrl === "" || model === "") return null;
  return { baseUrl, apiKey: entry.apiKey, model };
}

export function makePipelineDeps(store: ProviderStore): PipelineDeps {
  return {
    runInapp: (backend, brief, onToken, signal) =>
      new Promise<string>((resolve, reject) => {
        const settings = resolveInappSettings(store, backend);
        if (settings === null) {
          reject(new Error("no in-app provider configured"));
          return;
        }
        let text = "";
        void runAgent({
          settings,
          systemPrompt: backend.systemPrompt,
          messages: [{ role: "user", content: brief }],
          signal,
          callbacks: {
            onToken: (d) => {
              text += d;
              onToken?.(d);
            },
            onAssistantText: () => {},
            onToolStart: () => {},
            onToolEnd: () => {},
            onFileChanged: () => {},
            onDone: (reason) => {
              if (reason === "aborted") {
                reject(new Error("aborted"));
                return;
              }
              resolve(text);
            },
            onError: (err) => reject(err),
          },
        });
      }),
    runMcp: async (backend, brief) => {
      const res = await callTool(`mcp__${backend.server}__${backend.tool}`, {
        input: brief,
      });
      return res.result;
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/__tests__/pipelineDeps.test.ts`
Expected: PASS (all). Then `pnpm exec tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipelineDeps.ts src/lib/__tests__/pipelineDeps.test.ts
git commit -m "feat: pipelineDeps.ts — runAgent/callTool adapters for the pipeline (abort→throw)"
```

---

### Task 2: `detectCli` — CLI availability probe

**Files:**
- Modify: `src/lib/workers.ts` (append `detectCli`)
- Create: `src/lib/__tests__/detectCli.test.ts`

**Interfaces:**
- Consumes: `runExec` (agentExec.ts).
- Produces (consumed by Plan 4 Agents tab):
  - `async function detectCli(command: string): Promise<boolean>` — runs `command --version` via `runExec` with a 5s timeout; returns `true` if it exits 0, `false` on non-zero exit OR any thrown error (spawn failure / timeout). Never throws.

- [ ] **Step 1: Write failing tests (mock runExec)**

Create `src/lib/__tests__/detectCli.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// runExec is mocked as a PLAIN function (not a vi.fn): vitest 4 surfaces a
// vi.fn whose implementation throws/rejects as a test failure even when the
// code under test catches it. A plain function returning a rejected promise
// that detectCli awaits+catches is fine. Calls are captured manually.
type ExecResult = { code: number; stdout: string; stderr: string };
let behavior: () => Promise<ExecResult>;
const calls: unknown[] = [];

vi.mock("../agentExec", () => ({
  runExec: (o: unknown) => {
    calls.push(o);
    return behavior();
  },
}));

import { detectCli } from "../workers";

beforeEach(() => {
  calls.length = 0;
});

describe("detectCli", () => {
  it("is true when the probe exits 0", async () => {
    behavior = () => Promise.resolve({ code: 0, stdout: "v1.2.3", stderr: "" });
    expect(await detectCli("codex")).toBe(true);
    expect(calls[0]).toMatchObject({ program: "codex", args: ["--version"], timeoutSec: 5 });
  });
  it("is false on non-zero exit", async () => {
    behavior = () => Promise.resolve({ code: 1, stdout: "", stderr: "nope" });
    expect(await detectCli("codex")).toBe(false);
  });
  it("is false when runExec rejects (not installed / timeout)", async () => {
    behavior = () => Promise.reject(new Error("spawn error"));
    expect(await detectCli("nope")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/__tests__/detectCli.test.ts`
Expected: FAIL — `detectCli` is not exported from `../workers`.

- [ ] **Step 3: Append `detectCli` to `workers.ts`**

Add to `src/lib/workers.ts` (new import at top + function at the end):

```ts
import { runExec } from "./agentExec";
```

```ts
export async function detectCli(command: string): Promise<boolean> {
  try {
    const res = await runExec({ program: command, args: ["--version"], timeoutSec: 5 });
    return res.code === 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/__tests__/detectCli.test.ts`
Expected: PASS. Then `pnpm exec tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workers.ts src/lib/__tests__/detectCli.test.ts
git commit -m "feat: detectCli — probe a CLI worker's availability via --version"
```

---

### Task 3: `usageSession.ts` — token estimation + combined snapshot

**Files:**
- Create: `src/lib/usageSession.ts`
- Create: `src/lib/__tests__/usageSession.test.ts`

**Interfaces:**
- Consumes: `readCliUsage`, `UsageTotals`, `totalTokens`, `guardState`, `GuardState` (usage.ts).
- Produces (consumed by Plan 4 UsageStrip + PipelinePanel guard):
  - `function estimateTokens(text: string): number` — `Math.ceil(text.length / 4)` (rough; in-app streaming gives no exact usage, so the guard uses an estimate).
  - `class SessionUsage` with `addInapp(text: string): void` (accumulates `estimateTokens`), `get inappTokens(): number`, and `async snapshot(budgetTokens: number | undefined, warnRatio: number): Promise<{ inappTokens: number; cli: Record<string, UsageTotals>; sessionTokens: number; guard: GuardState }>` where `sessionTokens = inappTokens + sum(totalTokens(cli[*]))` and `guard = guardState(sessionTokens, budgetTokens, warnRatio)`. `snapshot` calls `readCliUsage` (which is itself fail-open → `{}`).

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/usageSession.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const readCliUsageMock = vi.fn();
vi.mock("../usage", async (orig) => {
  const actual = await orig<typeof import("../usage")>();
  return { ...actual, readCliUsage: () => readCliUsageMock() };
});

import { estimateTokens, SessionUsage } from "../usageSession";

beforeEach(() => readCliUsageMock.mockReset());

describe("estimateTokens", () => {
  it("is ceil(len/4)", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("SessionUsage", () => {
  it("accumulates in-app estimates", () => {
    const s = new SessionUsage();
    s.addInapp("abcd"); // 1
    s.addInapp("abcd"); // 1
    expect(s.inappTokens).toBe(2);
  });

  it("combines in-app + CLI into sessionTokens and computes the guard", async () => {
    readCliUsageMock.mockResolvedValue({
      claude: { inputTokens: 10, outputTokens: 5 }, // 15
    });
    const s = new SessionUsage();
    s.addInapp("abcd"); // 1
    const snap = await s.snapshot(20, 0.8); // budget 20, warn at 16
    expect(snap.inappTokens).toBe(1);
    expect(snap.sessionTokens).toBe(16); // 1 + 15
    expect(snap.guard).toBe("warn"); // 16 >= 20*0.8
  });

  it("is ok when under budget and fail-open on empty CLI usage", async () => {
    readCliUsageMock.mockResolvedValue({});
    const s = new SessionUsage();
    s.addInapp("abcd"); // 1
    const snap = await s.snapshot(1000, 0.8);
    expect(snap.sessionTokens).toBe(1);
    expect(snap.guard).toBe("ok");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/__tests__/usageSession.test.ts`
Expected: FAIL — `Cannot find module '../usageSession'`.

- [ ] **Step 3: Create `usageSession.ts`**

Create `src/lib/usageSession.ts`:

```ts
import {
  readCliUsage,
  totalTokens,
  guardState,
  type UsageTotals,
  type GuardState,
} from "./usage";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface UsageSnapshot {
  inappTokens: number;
  cli: Record<string, UsageTotals>;
  sessionTokens: number;
  guard: GuardState;
}

export class SessionUsage {
  private inapp = 0;

  addInapp(text: string): void {
    this.inapp += estimateTokens(text);
  }

  get inappTokens(): number {
    return this.inapp;
  }

  async snapshot(
    budgetTokens: number | undefined,
    warnRatio: number,
  ): Promise<UsageSnapshot> {
    const cli = await readCliUsage();
    let cliTotal = 0;
    for (const t of Object.values(cli)) {
      cliTotal += totalTokens(t);
    }
    const sessionTokens = this.inapp + cliTotal;
    return {
      inappTokens: this.inapp,
      cli,
      sessionTokens,
      guard: guardState(sessionTokens, budgetTokens, warnRatio),
    };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/__tests__/usageSession.test.ts`
Expected: PASS. Then run the full suite `pnpm test` → all pass, and `pnpm exec tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/usageSession.ts src/lib/__tests__/usageSession.test.ts
git commit -m "feat: usageSession.ts — session token estimation + combined in-app/CLI guard snapshot"
```

---

## Self-Review

**Spec coverage (`2026-07-02-multiagent-pipeline-mvp.md` + Plan-2 final-review seams):**
- Plan-2 seam "runInapp adapter: accumulate text, map systemPrompt/model, translate abort→throw" → Task 1 (`makePipelineDeps.runInapp`: accumulates `onToken`, passes `systemPrompt`, rejects on `onDone("aborted")`/`onError`) ✅. Model/provider mapping → `resolveInappSettings` ✅.
- Plan-2 seam "runMcp adapter: compose fullName, brief→args, unwrap result" → Task 1 (`mcp__${server}__${tool}`, `{input:brief}`, `.result`) ✅.
- §3 `workers.ts` CLI detection → Task 2 `detectCli` ✅.
- §6 usage soft-guard needs a session token number → Task 3 `SessionUsage.snapshot` combines in-app estimate + CLI (`readCliUsage`) and computes `guardState` ✅. (In-app exact token capture would require modifying `agent.ts`, which is out of scope by the Global Constraints; estimation is the documented soft-guard basis.)
- **Deferred to Plan 4 (UI):** `PipelinePanel.tsx` (ChatPanel mode toggle, stage cards, backend dropdowns, guard banner, run/stop), `UsageStrip.tsx`, Agents settings tab (worker CRUD + pipeline defaults + guard settings + a "detect" button calling `detectCli`), and file-as-memory transcript writing. This plan produces the tested logic those UI pieces consume.

**Placeholder scan:** none — every step has complete code. ✅

**Type consistency:** `PipelineDeps` shapes in Task 1 match `pipeline.ts`'s exported `PipelineDeps` (runInapp `(backend, brief, onToken?, signal?)=>Promise<string>`, runMcp `(backend, brief)=>Promise<string>`). `resolveInappSettings` returns `Settings` (`{baseUrl,apiKey,model}`) matching `settings.ts`. `runExec` options in Task 2 (`program/args/timeoutSec`) match `agentExec.ts`'s `ExecOptions`. Task 3 uses `UsageTotals`/`totalTokens`/`guardState`/`GuardState` exactly as exported by `usage.ts`. `runAgent`'s `AgentCallbacks` — all seven callbacks provided (Task 1) per the Global Constraints. ✅
