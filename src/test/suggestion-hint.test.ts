/**
 * P-Action 1: Next-action hint — 4 仓库共识 (deusyu / walkinglabs / 马书 / AHE)
 * "错误信息 = 修复指令" 在 adaptive-scan 的 5 类 suggestion 上落地.
 */

import { describe, it, expect } from 'vitest';
import {
  suggestionHint,
  type SuggestionKind,
  type SuggestionAction,
} from '../pi-ecosystem-judgment/adaptive-scan.js';

describe('suggestionHint', () => {
  const metrics = { usage7d: 0, usage30d: 0, daysSinceLastUse: 30, totalUsage: 1 };

  it('rising + boost — 含具体数字 + 下一步命令', () => {
    const h = suggestionHint('rising', 'boost', metrics);
    expect(h).toContain('boost');
    expect(h).toContain('conflicts.jsonl');
  });

  it('stale + deprecate — 警告误判风险, 给验证命令', () => {
    const h = suggestionHint('stale', 'deprecate', { ...metrics, daysSinceLastUse: 100, totalUsage: 2 });
    expect(h).toContain('judgments:search');
    expect(h).toContain('deprecate');
  });

  it('unused + review — 三步诊断流程', () => {
    const h = suggestionHint('unused', 'review', { ...metrics, totalUsage: 0 });
    expect(h).toContain('judgments:debug');
    expect(h).toContain('D 路径');
  });

  it('causal_conflict + review — 提示用 causal power 决策', () => {
    const h = suggestionHint('causal_conflict', 'review', metrics);
    expect(h).toContain('causal');
    expect(h).toContain('persona.json');
  });

  it('low_causal_power + review — 给 do-calculus 审计入口', () => {
    const h = suggestionHint('low_causal_power', 'review', metrics);
    expect(h).toContain('causal:audit');
  });

  it('所有 5 类 + 3 action 组合都不返回空', () => {
    const kinds: SuggestionKind[] = ['stale', 'rising', 'unused', 'causal_conflict', 'low_causal_power'];
    const actions: SuggestionAction[] = ['deprecate', 'boost', 'review'];
    for (const k of kinds) {
      for (const a of actions) {
        const h = suggestionHint(k, a, metrics);
        expect(h.length).toBeGreaterThan(20);
        expect(h).toMatch(/[一-鿿]/);  // 至少含一个中文字符
      }
    }
  });
});
