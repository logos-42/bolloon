import { describe, it, expect } from 'vitest';
import { ToolPermissionContext } from '../src/constraint/permission.js';
import { BudgetTracker } from '../src/constraint/budget.js';

describe('ToolPermissionContext', () => {
  it('blocks denied tools by exact name', () => {
    const ctx = ToolPermissionContext.fromIterables(['BashTool', 'FileEditTool'], []);
    expect(ctx.blocks('BashTool')).toBe(true);
    expect(ctx.blocks('FileEditTool')).toBe(true);
    expect(ctx.blocks('FileReadTool')).toBe(false);
  });

  it('blocks tools by prefix', () => {
    const ctx = ToolPermissionContext.fromIterables([], ['mcp_']);
    expect(ctx.blocks('mcp_server')).toBe(true);
    expect(ctx.blocks('mcp_client')).toBe(true);
    expect(ctx.blocks('bash_tool')).toBe(false);
  });

  it('creates permission denial', () => {
    const ctx = ToolPermissionContext.fromIterables(['BashTool'], []);
    const denial = ctx.createDenial('BashTool', 'destructive shell execution');
    expect(denial.toolName).toBe('BashTool');
    expect(denial.reason).toBe('destructive shell execution');
  });
});

describe('BudgetTracker', () => {
  it('tracks token usage', () => {
    const tracker = new BudgetTracker(1000, 8, 12);
    const usage = tracker.addTurn(100, 50);
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
  });

  it('detects budget exceeded', () => {
    const tracker = new BudgetTracker(100, 8, 12);
    expect(tracker.isBudgetExceeded({ inputTokens: 60, outputTokens: 50 })).toBe(true);
    expect(tracker.isBudgetExceeded({ inputTokens: 30, outputTokens: 30 })).toBe(false);
  });

  it('detects turn limit', () => {
    const tracker = new BudgetTracker(1000, 5, 12);
    expect(tracker.isTurnLimitExceeded(4)).toBe(false);
    expect(tracker.isTurnLimitExceeded(5)).toBe(true);
  });
});