export class CostTracker {
  totalUnits: number = 0;
  events: string[] = [];

  record(label: string, units: number): void {
    this.totalUnits += units;
    this.events.push(`${label}:${units}`);
  }
}
