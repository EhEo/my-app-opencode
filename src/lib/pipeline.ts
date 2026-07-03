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

export function buildBrief(
  request: string,
  stage: StageConfig,
  prior: StageResult[],
): string {
  const parts: string[] = [stage.prompt ?? "", `# Request\n${request}`];
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
