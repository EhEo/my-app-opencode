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
  const [runError, setRunError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<SessionUsage>(new SessionUsage());
  const sessionTokensRef = useRef(0);
  const guardPromptRef = useRef<{ resolve: (ok: boolean) => void } | null>(null);
  useEffect(() => {
    guardPromptRef.current = guardPrompt;
  }, [guardPrompt]);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      guardPromptRef.current?.resolve(false);
    },
    [],
  );

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
    setRunError(null);
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
      setRunError(e instanceof Error ? e.message : String(e));
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

      {runError !== null ? (
        <div className="pipeline-panel__error">{runError}</div>
      ) : null}

      <footer className="pipeline-panel__footer">
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
        <div className="pipeline-panel__meta">
          {stages.map((s) => `${s.label}: ${s.backendId ?? "인앱"}`).join("  ·  ")}
        </div>
      </footer>
    </div>
  );
}
