import { CostTracker } from './cost_tracker.js';

export function applyCostHook(tracker: CostTracker, label: string, units: number): CostTracker {
  tracker.record(label, units);
  return tracker;
}
