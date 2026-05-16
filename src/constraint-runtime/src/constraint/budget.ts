import { UsageSummary } from '../models.js';

export class BudgetTracker {
  constructor(
    public maxBudgetTokens: number = 2000,
    public maxTurns: number = 8,
    public compactAfterTurns: number = 12
  ) {}

  addTurn(inputTokens: number, outputTokens: number): UsageSummary {
    return { inputTokens, outputTokens };
  }

  isBudgetExceeded(usage: UsageSummary): boolean {
    return usage.inputTokens + usage.outputTokens > this.maxBudgetTokens;
  }

  isTurnLimitExceeded(currentTurns: number): boolean {
    return currentTurns >= this.maxTurns;
  }

  shouldCompact(turnCount: number): boolean {
    return turnCount > this.compactAfterTurns;
  }
}