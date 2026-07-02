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
