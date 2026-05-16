import { ToolPermissionContext } from '../constraint/permission.js';
import { BudgetTracker } from '../constraint/budget.js';

export interface RuntimeSession {
  sessionId: string;
  messages: string[];
  context: Record<string, unknown>;
  turnCount: number;
}

export class Session implements RuntimeSession {
  constructor(
    public sessionId: string,
    public messages: string[] = [],
    public context: Record<string, unknown> = {},
    public turnCount: number = 0,
    public permissionContext: ToolPermissionContext = ToolPermissionContext.fromIterables(),
    public budget: BudgetTracker = new BudgetTracker()
  ) {}

  addMessage(msg: string): void {
    this.messages.push(msg);
    this.turnCount++;
  }

  get history(): string[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
    this.turnCount = 0;
  }

  setContext(key: string, value: unknown): void {
    this.context[key] = value;
  }

  getContext(key: string): unknown {
    return this.context[key];
  }
}
