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
