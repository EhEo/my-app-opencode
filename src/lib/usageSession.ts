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
