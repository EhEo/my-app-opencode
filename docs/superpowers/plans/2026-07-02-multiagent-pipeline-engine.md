# Multi-Agent Pipeline Engine (TS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless TypeScript engine for the 3-stage (plan→code→review) multi-agent pipeline — worker backend registry, a client for the Rust `agent_exec_*` commands, a usage/soft-guard module, and the orchestrator — all unit-tested with vitest. No UI (that is Plan 3).

**Architecture:** Four new modules under `src/lib/` plus type additions to `src/lib/settings.ts`. Each module has one responsibility and a small, injected-dependency surface so it is testable in isolation without a running Tauri app. `pipeline.ts` composes the others; dependencies (`runAgent`, `runExec`, `callTool`) are injected so the orchestrator can be tested with fakes. Backends resolve through a registry keyed by worker id; the default for every stage is the existing in-app AI (`runAgent`), and a stage may point at a CLI or MCP worker instead.

**Tech Stack:** TypeScript, React 19 app (Vite 7), `@tauri-apps/api` (invoke + Channel), vitest (new dev dependency), existing `src/lib/agent.ts` (`runAgent`), `src/lib/mcp.ts` (`callTool`), `src/lib/settings.ts` (`ProviderStore`).

## Global Constraints

- Plan 1 is merged: the Rust commands `agent_exec_start`, `agent_exec_kill`, `read_usage_logs` exist. Event shape from `agent_exec_start` is `{type:"stdout",data:number[]} | {type:"stderr",data:number[]} | {type:"exit",code:number}`. `read_usage_logs` returns `{ byTool: Record<string,{inputTokens:number;outputTokens:number}> }`.
- `agent_exec_start` params (camelCase): `{ id, program, args, cwd?, stdin?, env?, onEvent }`. `agent_exec_kill` params: `{ id }`.
- Every `agent_exec_start` call MUST pass a unique `id` — generate it with `crypto.randomUUID()` inside `agentExec.ts` (never caller-supplied). This closes the duplicate-id race left open in Plan 1.
- Default pipeline stages, in order: `plan`, `code`, `review`. Each stage's default backend is in-app (`runAgent`). Only the `code` stage writes files; `review` is read-only (report).
- No UI in this plan. No changes to `src-tauri/`. No changes to existing runtime behavior of `agent.ts`/`ChatPanel` (only additive imports/types).
- TypeScript strict: no `any` in exported signatures; the repo compiles with `pnpm exec tsc --noEmit`.
- Verify gate after every task: `pnpm test` (vitest run) passes AND `pnpm exec tsc --noEmit` passes.

---

### Task 1: Add the vitest test runner

**Files:**
- Modify: `package.json` (devDependency + scripts)
- Create: `vitest.config.ts`
- Create: `src/lib/__tests__/sanity.test.ts`

**Interfaces:**
- Produces: `pnpm test` runs vitest once (CI mode); `pnpm test:watch` watches. Test files live at `src/lib/__tests__/*.test.ts`.

- [ ] **Step 1: Install vitest**

Run: `pnpm add -D vitest`
Expected: `package.json` gains `vitest` under devDependencies; lockfile updates.

- [ ] **Step 2: Create the vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Add test scripts**

In `package.json`, add to `"scripts"`:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 4: Write a sanity test**

Create `src/lib/__tests__/sanity.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("vitest runner", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it**

Run: `pnpm test`
Expected: 1 passed. Then run `pnpm exec tsc --noEmit` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/lib/__tests__/sanity.test.ts
git commit -m "test: add vitest runner"
```

---

### Task 2: `workers.ts` — backend registry, resolution, CLI arg templating

**Files:**
- Modify: `src/lib/settings.ts` (add `WorkerBackend`, `StageConfig` types + optional `workers`/`pipeline` fields on `ProviderStore`)
- Create: `src/lib/workers.ts`
- Create: `src/lib/__tests__/workers.test.ts`

**Interfaces:**
- Consumes: `ProviderStore` from `settings.ts`.
- Produces (consumed by Task 5 pipeline):
  - `type WorkerBackend = { kind:"inapp"; providerId:string; model?:string; systemPrompt?:string } | { kind:"cli"; command:string; argsTemplate:string[]; briefMode:"stdin"|"arg"; cwd?:string; timeoutSec?:number; resultParse?:"raw"|"json" } | { kind:"mcp"; server:string; tool:string }`
  - `interface StageConfig { id:"plan"|"code"|"review"; label:string; backendId?:string; enabled:boolean }`
  - `const DEFAULT_STAGES: StageConfig[]`
  - `const DEFAULT_INAPP_BACKEND: WorkerBackend` (kind "inapp", providerId "", meaning "use the active provider")
  - `function resolveBackend(workers: Record<string,WorkerBackend>|undefined, backendId: string|undefined): WorkerBackend` — returns the registered backend for `backendId`, or `DEFAULT_INAPP_BACKEND` when `backendId` is undefined or unknown.
  - `function buildCliArgs(argsTemplate: string[], brief: string): string[]` — replaces the exact token `"@brief"` in each arg with `brief`; args without the token pass through unchanged.

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/workers.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/__tests__/workers.test.ts`
Expected: FAIL — `Cannot find module '../workers'`.

- [ ] **Step 3: Add types to `settings.ts`**

In `src/lib/settings.ts`, add these exported types (near `McpServerEntry`) and two optional fields on the `ProviderStore` interface:

```ts
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
```

Add to the `ProviderStore` interface (alongside `mcp?`/`skills?`):

```ts
  workers?: Record<string, WorkerBackend>;
  pipeline?: { stages: StageConfig[] };
```

- [ ] **Step 4: Create `workers.ts`**

Create `src/lib/workers.ts`:

```ts
import type { WorkerBackend, StageConfig } from "./settings";

export type { WorkerBackend, StageConfig } from "./settings";

// providerId "" means: use the store's currently active provider/model
// (resolved later by the pipeline via the existing settings.resolveConnection).
export const DEFAULT_INAPP_BACKEND: WorkerBackend = {
  kind: "inapp",
  providerId: "",
};

export const DEFAULT_STAGES: StageConfig[] = [
  { id: "plan", label: "Plan", enabled: true },
  { id: "code", label: "Code", enabled: true },
  { id: "review", label: "Review", enabled: true },
];

export function resolveBackend(
  workers: Record<string, WorkerBackend> | undefined,
  backendId: string | undefined,
): WorkerBackend {
  if (backendId !== undefined && workers !== undefined) {
    const found = workers[backendId];
    if (found !== undefined) return found;
  }
  return DEFAULT_INAPP_BACKEND;
}

export function buildCliArgs(argsTemplate: string[], brief: string): string[] {
  return argsTemplate.map((a) => (a === "@brief" ? brief : a));
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test src/lib/__tests__/workers.test.ts`
Expected: PASS (all). Then `pnpm exec tsc --noEmit` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/settings.ts src/lib/workers.ts src/lib/__tests__/workers.test.ts
git commit -m "feat: worker backend registry + resolution (workers.ts)"
```

---

### Task 3: `usage.ts` — token accounting + soft-guard state

**Files:**
- Create: `src/lib/usage.ts`
- Create: `src/lib/__tests__/usage.test.ts`

**Interfaces:**
- Produces (consumed by Task 5 pipeline + Plan 3 UI):
  - `interface UsageTotals { inputTokens: number; outputTokens: number }`
  - `function accumulate(prev: UsageTotals, add: { input: number; output: number }): UsageTotals` — pure add.
  - `function totalTokens(t: UsageTotals): number` — `inputTokens + outputTokens`.
  - `type GuardState = "ok" | "warn"`
  - `function guardState(sessionTokens: number, budgetTokens: number | undefined, warnRatio: number): GuardState` — `"warn"` when `budgetTokens` is defined and `sessionTokens >= budgetTokens * warnRatio`; otherwise `"ok"`. `warnRatio` is a 0–1 fraction.
  - `async function readCliUsage(): Promise<Record<string, UsageTotals>>` — invokes the Rust `read_usage_logs`, returns its `byTool`; on error returns `{}` (fail-open).

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/usage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { accumulate, totalTokens, guardState } from "../usage";

describe("accumulate", () => {
  it("adds input and output", () => {
    expect(accumulate({ inputTokens: 10, outputTokens: 5 }, { input: 3, output: 7 }))
      .toEqual({ inputTokens: 13, outputTokens: 12 });
  });
});

describe("totalTokens", () => {
  it("sums both fields", () => {
    expect(totalTokens({ inputTokens: 10, outputTokens: 5 })).toBe(15);
  });
});

describe("guardState", () => {
  it("is ok when no budget set", () => {
    expect(guardState(999999, undefined, 0.8)).toBe("ok");
  });
  it("is ok below the warn ratio", () => {
    expect(guardState(700, 1000, 0.8)).toBe("ok");
  });
  it("warns at or above the warn ratio", () => {
    expect(guardState(800, 1000, 0.8)).toBe("warn");
    expect(guardState(1200, 1000, 0.8)).toBe("warn");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/__tests__/usage.test.ts`
Expected: FAIL — `Cannot find module '../usage'`.

- [ ] **Step 3: Create `usage.ts`**

Create `src/lib/usage.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

export type GuardState = "ok" | "warn";

export function accumulate(
  prev: UsageTotals,
  add: { input: number; output: number },
): UsageTotals {
  return {
    inputTokens: prev.inputTokens + add.input,
    outputTokens: prev.outputTokens + add.output,
  };
}

export function totalTokens(t: UsageTotals): number {
  return t.inputTokens + t.outputTokens;
}

export function guardState(
  sessionTokens: number,
  budgetTokens: number | undefined,
  warnRatio: number,
): GuardState {
  if (budgetTokens === undefined) return "ok";
  return sessionTokens >= budgetTokens * warnRatio ? "warn" : "ok";
}

export async function readCliUsage(): Promise<Record<string, UsageTotals>> {
  try {
    const res = await invoke<{ byTool: Record<string, UsageTotals> }>(
      "read_usage_logs",
    );
    return res.byTool ?? {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/__tests__/usage.test.ts`
Expected: PASS. Then `pnpm exec tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/usage.ts src/lib/__tests__/usage.test.ts
git commit -m "feat: usage accounting + soft-guard state (usage.ts)"
```

---

### Task 4: `agentExec.ts` — TS client for the Rust streaming exec

**Files:**
- Create: `src/lib/agentExec.ts`
- Create: `src/lib/__tests__/agentExec.test.ts`

**Interfaces:**
- Consumes: Rust `agent_exec_start`/`agent_exec_kill` (see Global Constraints for shapes).
- Produces (consumed by Task 5 pipeline):
  - `interface ExecResult { code: number; stdout: string; stderr: string }`
  - `interface ExecOptions { program: string; args: string[]; cwd?: string; stdin?: string; env?: Record<string,string>; timeoutSec?: number; signal?: AbortSignal; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void }`
  - `async function runExec(opts: ExecOptions): Promise<ExecResult>` — generates a UUID id, opens a `Channel`, invokes `agent_exec_start`, decodes stdout/stderr byte chunks to UTF-8 (streaming to callbacks + accumulating), resolves `{code,stdout,stderr}` on the `exit` event. If `timeoutSec` elapses or `signal` aborts, it invokes `agent_exec_kill` and rejects with an `Error` (message `"exec timed out"` or `"aborted"`).

- [ ] **Step 1: Write failing tests (with mocked Tauri)**

Create `src/lib/__tests__/agentExec.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core: Channel captures its onmessage; invoke("agent_exec_start")
// drives the channel with scripted events, then resolves. invoke("agent_exec_kill") is a spy.
const killSpy = vi.fn();

vi.mock("@tauri-apps/api/core", () => {
  class Channel {
    onmessage?: (m: unknown) => void;
  }
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "agent_exec_kill") {
      killSpy(args);
      return;
    }
    if (cmd === "agent_exec_start") {
      const ch = (args.onEvent as { onmessage?: (m: unknown) => void });
      // "hi" = bytes [104,105]
      ch.onmessage?.({ type: "stdout", data: [104, 105] });
      ch.onmessage?.({ type: "exit", code: 0 });
      return;
    }
    return;
  });
  return { Channel, invoke };
});

import { runExec } from "../agentExec";

beforeEach(() => {
  killSpy.mockClear();
});

describe("runExec", () => {
  it("accumulates stdout and resolves on exit", async () => {
    const chunks: string[] = [];
    const res = await runExec({
      program: "echo",
      args: ["hi"],
      onStdout: (c) => chunks.push(c),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("hi");
    expect(chunks.join("")).toBe("hi");
  });

  it("kills and rejects when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runExec({ program: "sleep", args: ["10"], signal: ac.signal }),
    ).rejects.toThrow("aborted");
    expect(killSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/__tests__/agentExec.test.ts`
Expected: FAIL — `Cannot find module '../agentExec'`.

- [ ] **Step 3: Create `agentExec.ts`**

Create `src/lib/agentExec.ts`:

```ts
import { invoke, Channel } from "@tauri-apps/api/core";

interface ExecEventStdout { type: "stdout"; data: number[] }
interface ExecEventStderr { type: "stderr"; data: number[] }
interface ExecEventExit { type: "exit"; code: number }
type ExecEvent = ExecEventStdout | ExecEventStderr | ExecEventExit;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  program: string;
  args: string[];
  cwd?: string;
  stdin?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export async function runExec(opts: ExecOptions): Promise<ExecResult> {
  const id = crypto.randomUUID();
  // Separate decoders: a streaming TextDecoder keeps partial multi-byte state,
  // so stdout and stderr must not share one (interleaved chunks would corrupt).
  const outDecoder = new TextDecoder();
  const errDecoder = new TextDecoder();
  let stdout = "";
  let stderr = "";

  return await new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
    };
    const kill = (): void => {
      void invoke("agent_exec_kill", { id }).catch(() => {});
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      kill();
      reject(new Error(message));
    };
    const onAbort = (): void => fail("aborted");

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        // still generate the id/kill for symmetry, then reject
        fail("aborted");
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }
    if (opts.timeoutSec !== undefined) {
      timer = setTimeout(() => fail("exec timed out"), opts.timeoutSec * 1000);
    }

    const channel = new Channel<ExecEvent>();
    channel.onmessage = (msg: ExecEvent): void => {
      if (settled) return;
      if (msg.type === "stdout") {
        const chunk = outDecoder.decode(new Uint8Array(msg.data), { stream: true });
        stdout += chunk;
        opts.onStdout?.(chunk);
      } else if (msg.type === "stderr") {
        const chunk = errDecoder.decode(new Uint8Array(msg.data), { stream: true });
        stderr += chunk;
        opts.onStderr?.(chunk);
      } else if (msg.type === "exit") {
        settled = true;
        cleanup();
        resolve({ code: msg.code, stdout, stderr });
      }
    };

    void invoke("agent_exec_start", {
      id,
      program: opts.program,
      args: opts.args,
      cwd: opts.cwd ?? null,
      stdin: opts.stdin ?? null,
      env: opts.env ?? null,
      onEvent: channel,
    }).catch((e: unknown) => {
      fail(e instanceof Error ? e.message : String(e));
    });
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/__tests__/agentExec.test.ts`
Expected: PASS (both tests). Then `pnpm exec tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agentExec.ts src/lib/__tests__/agentExec.test.ts
git commit -m "feat: agentExec.ts — TS client for streaming CLI exec (uuid ids, timeout, abort)"
```

---

### Task 5: `pipeline.ts` — the 3-stage orchestrator

**Files:**
- Create: `src/lib/pipeline.ts`
- Create: `src/lib/__tests__/pipeline.test.ts`

**Interfaces:**
- Consumes: `resolveBackend`, `buildCliArgs`, `DEFAULT_STAGES` (workers.ts); `runExec` (agentExec.ts); `WorkerBackend`, `StageConfig` (settings.ts). In-app dispatch and MCP dispatch are injected via a `deps` object so the orchestrator is testable without `runAgent`/`callTool`.
- Produces (consumed by Plan 3 UI):
  - `interface StageResult { stageId: string; label: string; backendKind: "inapp"|"cli"|"mcp"; output: string; error?: string }`
  - `interface PipelineDeps { runInapp(backend, brief, onToken, signal): Promise<string>; runMcp(backend, brief): Promise<string> }` (exact param types in code below)
  - `interface PipelineCallbacks { onStageStart?(stage: StageConfig): void; onStageToken?(stageId: string, delta: string): void; onStageEnd?(result: StageResult): void; onGuardPause?(stageId: string): Promise<boolean> }`
  - `async function runPipeline(opts: { request: string; stages: StageConfig[]; workers?: Record<string,WorkerBackend>; guardBeforeStage?: (stageId: string) => "ok"|"warn"; callbacks?: PipelineCallbacks; signal?: AbortSignal; deps: PipelineDeps }): Promise<StageResult[]>` — runs enabled stages in order; builds each stage's brief from the request + prior results; before a stage, if `guardBeforeStage` returns `"warn"`, calls `callbacks.onGuardPause` and aborts the pipeline if it resolves `false`; dispatches to the resolved backend; stops on the first stage error.
  - `function buildBrief(request: string, stage: StageConfig, prior: StageResult[]): string` — deterministic brief text (exported for testing).

- [ ] **Step 1: Write failing tests**

Create `src/lib/__tests__/pipeline.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm test src/lib/__tests__/pipeline.test.ts`
Expected: FAIL — `Cannot find module '../pipeline'`.

- [ ] **Step 3: Create `pipeline.ts`**

Create `src/lib/pipeline.ts`:

```ts
import type { WorkerBackend, StageConfig } from "./settings";
import { resolveBackend, buildCliArgs } from "./workers";
import { runExec } from "./agentExec";

export interface StageResult {
  stageId: string;
  label: string;
  backendKind: "inapp" | "cli" | "mcp";
  output: string;
  error?: string;
}

export interface PipelineDeps {
  runInapp: (
    backend: Extract<WorkerBackend, { kind: "inapp" }>,
    brief: string,
    onToken?: (delta: string) => void,
    signal?: AbortSignal,
  ) => Promise<string>;
  runMcp: (
    backend: Extract<WorkerBackend, { kind: "mcp" }>,
    brief: string,
  ) => Promise<string>;
}

export interface PipelineCallbacks {
  onStageStart?: (stage: StageConfig) => void;
  onStageToken?: (stageId: string, delta: string) => void;
  onStageEnd?: (result: StageResult) => void;
  onGuardPause?: (stageId: string) => Promise<boolean>;
}

const STAGE_PROMPTS: Record<string, string> = {
  plan: "You are the PLAN stage. Produce a concise step-by-step plan. Do not write files.",
  code: "You are the CODE stage. Implement the plan. Use tools to read and write files.",
  review:
    "You are the REVIEW stage. Read the changes and report issues. Read-only — do not modify files.",
};

export function buildBrief(
  request: string,
  stage: StageConfig,
  prior: StageResult[],
): string {
  const parts: string[] = [STAGE_PROMPTS[stage.id] ?? "", `# Request\n${request}`];
  for (const p of prior) {
    parts.push(`# ${p.label} output\n${p.output}`);
  }
  return parts.filter((s) => s.length > 0).join("\n\n");
}

export async function runPipeline(opts: {
  request: string;
  stages: StageConfig[];
  workers?: Record<string, WorkerBackend>;
  guardBeforeStage?: (stageId: string) => "ok" | "warn";
  callbacks?: PipelineCallbacks;
  signal?: AbortSignal;
  deps: PipelineDeps;
}): Promise<StageResult[]> {
  const results: StageResult[] = [];
  for (const stage of opts.stages) {
    if (!stage.enabled) continue;
    if (opts.signal?.aborted) break;

    if (opts.guardBeforeStage?.(stage.id) === "warn") {
      const proceed = (await opts.callbacks?.onGuardPause?.(stage.id)) ?? true;
      if (!proceed) break;
    }

    opts.callbacks?.onStageStart?.(stage);
    const backend = resolveBackend(opts.workers, stage.backendId);
    const brief = buildBrief(opts.request, stage, results);

    let result: StageResult;
    try {
      if (backend.kind === "cli") {
        const stdinVal = backend.briefMode === "stdin" ? brief : undefined;
        const args =
          backend.briefMode === "arg" ? buildCliArgs(backend.argsTemplate, brief) : backend.argsTemplate;
        const exec = await runExec({
          program: backend.command,
          args,
          cwd: backend.cwd,
          stdin: stdinVal,
          timeoutSec: backend.timeoutSec,
          signal: opts.signal,
          onStdout: (c) => opts.callbacks?.onStageToken?.(stage.id, c),
        });
        const output =
          exec.code === 0 ? exec.stdout : `${exec.stdout}\n[exit ${exec.code}]\n${exec.stderr}`;
        result = { stageId: stage.id, label: stage.label, backendKind: "cli", output };
      } else if (backend.kind === "mcp") {
        const output = await opts.deps.runMcp(backend, brief);
        result = { stageId: stage.id, label: stage.label, backendKind: "mcp", output };
      } else {
        const output = await opts.deps.runInapp(
          backend,
          brief,
          (d) => opts.callbacks?.onStageToken?.(stage.id, d),
          opts.signal,
        );
        result = { stageId: stage.id, label: stage.label, backendKind: "inapp", output };
      }
    } catch (e) {
      result = {
        stageId: stage.id,
        label: stage.label,
        backendKind: backend.kind,
        output: "",
        error: e instanceof Error ? e.message : String(e),
      };
      results.push(result);
      opts.callbacks?.onStageEnd?.(result);
      break;
    }

    results.push(result);
    opts.callbacks?.onStageEnd?.(result);
  }
  return results;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/lib/__tests__/pipeline.test.ts`
Expected: PASS (all 5). Then `pnpm test` (full suite) → all pass, and `pnpm exec tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline.ts src/lib/__tests__/pipeline.test.ts
git commit -m "feat: pipeline.ts — 3-stage plan/code/review orchestrator"
```

---

## Self-Review

**Spec coverage (§ of `2026-07-02-multiagent-pipeline-mvp.md`):**
- §3 `lib/workers.ts` (registry, resolution, CLI detection) → Task 2 ✅ (CLI *detection* — probing `--version` — is a Plan 3 settings concern; Task 2 covers registry+resolution+arg templating, which is what the engine needs).
- §3 `lib/agentExec.ts` → Task 4 ✅. §3 `lib/usage.ts` → Task 3 ✅. §3 `lib/pipeline.ts` → Task 5 ✅.
- §4 data model (`WorkerBackend`, `StageConfig`, `workers?`/`pipeline?` on `ProviderStore`) → Task 2 ✅. `usageGuard?` field is added in Plan 3 (settings UI owns it); the engine takes `budgetTokens`/`warnRatio` as params (Task 3) so it does not depend on that field yet.
- §5 stage flow (brief = prompt + request + prior; guard-before-stage; dispatch inapp/cli/mcp; stop on error; coding writes / review read-only via stage prompts) → Task 5 ✅. file-as-memory (`.opencode/pipeline/<runId>/`) is deferred to Plan 3 where the run has a UI/runId lifecycle; noted here as not-in-this-plan.
- §6 usage sources + soft-guard state → Task 3 ✅ (in-app accumulation via `accumulate`; CLI via `readCliUsage`→`read_usage_logs`; `guardState`).
- Plan-1 deferred Minor (duplicate-id TOCTOU) → Task 4 generates ids with `crypto.randomUUID()` inside `runExec`, closing it at the source. ✅

**Deferred to Plan 3 (explicitly not in this plan):** CLI `--version` detection UI, the `usageGuard` settings field + its wiring, `file-as-memory` transcript writing, and connecting the in-app dispatch to the real `runAgent` / MCP dispatch to real `callTool` (the pipeline takes them as injected `deps`; Plan 3's PipelinePanel supplies the real implementations).

**Placeholder scan:** No TBD/TODO/vague steps; every code + test step has complete code. ✅

**Type consistency:** `WorkerBackend`/`StageConfig` defined in `settings.ts` (Task 2), re-exported by `workers.ts`, consumed by `pipeline.ts` (Task 5) — names/shapes identical. `UsageTotals` fields (`inputTokens`/`outputTokens`) match the Rust `read_usage_logs` output (Plan 1) and `readCliUsage`'s cast. `runExec`'s `ExecOptions`/`ExecResult` (Task 4) match `pipeline.ts`'s CLI-dispatch call site (Task 5): `program/args/cwd/stdin/timeoutSec/signal/onStdout`. `PipelineDeps.runInapp` signature `(backend, brief, onToken?, signal?) => Promise<string>` matches its call in Task 5. ✅
