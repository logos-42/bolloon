export interface HistoryEvent {
  title: string;
  detail: string;
}

export class HistoryLog {
  events: HistoryEvent[] = [];

  add(title: string, detail: string): void {
    this.events.push({ title, detail });
  }

  asMarkdown(): string {
    return ['# Session History', '', ...this.events.map(e => `- ${e.title}: ${e.detail}`)].join('\n');
  }
}
