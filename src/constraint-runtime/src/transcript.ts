export class TranscriptStore {
  entries: string[] = [];
  flushed: boolean = false;

  append(entry: string): void {
    this.entries.push(entry);
    this.flushed = false;
  }

  compact(keepLast: number = 10): void {
    if (this.entries.length > keepLast) {
      this.entries = this.entries.slice(-keepLast);
    }
  }

  replay(): string[] {
    return [...this.entries];
  }

  flush(): void {
    this.flushed = true;
  }
}
