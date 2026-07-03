import { runExec } from "./agentExec";
import type { WorkerBackend, StageConfig } from "./settings";

export type { WorkerBackend, StageConfig } from "./settings";

// providerId "" means: use the store's currently active provider/model
// (resolved later by the pipeline via the existing settings.resolveConnection).
export const DEFAULT_INAPP_BACKEND: WorkerBackend = {
  kind: "inapp",
  providerId: "",
};

export const DEFAULT_STAGES: StageConfig[] = [
  {
    id: "plan",
    label: "Plan",
    enabled: true,
    prompt: "You are the PLAN stage. Produce a concise step-by-step plan. Do not write files.",
  },
  {
    id: "code",
    label: "Code",
    enabled: true,
    prompt: "You are the CODE stage. Implement the plan. Use tools to read and write files.",
  },
  {
    id: "review",
    label: "Review",
    enabled: true,
    prompt:
      "You are the REVIEW stage. Read the changes and report issues. Read-only — do not modify files.",
  },
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

export async function detectCli(command: string): Promise<boolean> {
  try {
    const res = await runExec({ program: command, args: ["--version"], timeoutSec: 5 });
    return res.code === 0;
  } catch {
    return false;
  }
}
