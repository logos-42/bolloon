/**
 * context-manager.test.ts — Context OS 资源管理器单元测试 (2026-08-06)
 *
 * 覆盖:
 *   - 配置默认值 (1M 窗口 / 0.55 压缩 / 0.5 warning) + env 覆盖
 *   - usage 阶段迁移 (normal → warning → compressing → compressed)
 *   - warning 事件只触发一次
 *   - compress start/complete 事件 + snapshot 字段
 *   - snapshot 磁盘持久化 + 恢复
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ContextManager,
  getContextConfig,
  usageFromTokens,
  saveSnapshotToDisk,
  loadLatestSnapshot,
  _resetContextManagerForTest,
  type ContextSnapshot,
} from '../bootstrap/context-manager.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = path.join(os.tmpdir(), 'bolloon-ctx-test', String(Date.now()));

describe('getContextConfig', () => {
  it('默认 1M 窗口 / 0.55 压缩 / 0.5 warning', () => {
    const cfg = getContextConfig({} as NodeJS.ProcessEnv);
    expect(cfg.maxTokens).toBe(1_000_000);
    expect(cfg.compressionThreshold).toBe(0.55);
    expect(cfg.warningThreshold).toBe(0.5);
  });

  it('env 覆盖 MAX_CONTEXT_TOKENS / COMPRESSION_THRESHOLD / WARNING_THRESHOLD', () => {
    const cfg = getContextConfig({ MAX_CONTEXT_TOKENS: '200000', COMPRESSION_THRESHOLD: '0.6', WARNING_THRESHOLD: '0.4' } as any);
    expect(cfg.maxTokens).toBe(200000);
    expect(cfg.compressionThreshold).toBe(0.6);
    expect(cfg.warningThreshold).toBe(0.4);
  });

  it('warning 阈值不会超过压缩阈值', () => {
    const cfg = getContextConfig({ WARNING_THRESHOLD: '0.9' } as any);
    expect(cfg.warningThreshold).toBeLessThanOrEqual(cfg.compressionThreshold);
  });
});

describe('usageFromTokens', () => {
  const cfg = { maxTokens: 1_000_000, compressionThreshold: 0.55, warningThreshold: 0.5 };

  it('normal: < 50%', () => {
    expect(usageFromTokens(100_000, cfg).stage).toBe('normal');
  });

  it('warning: 50%-55%', () => {
    expect(usageFromTokens(520_000, cfg).stage).toBe('warning');
  });

  it('compressing: >= 55%', () => {
    expect(usageFromTokens(560_000, cfg).stage).toBe('compressing');
  });
});

describe('ContextManager 事件', () => {
  beforeEach(() => _resetContextManagerForTest());
  afterEach(() => _resetContextManagerForTest());

  it('normal → warning 只触发一次 context.warning 事件', () => {
    const cm = new ContextManager({ maxTokens: 1_000_000, compressionThreshold: 0.55, warningThreshold: 0.5 });
    const warnings: any[] = [];
    cm.onEvent((e) => { if (e.type === 'context.warning') warnings.push(e); });
    cm.updateUsage(520_000);
    cm.updateUsage(530_000);  // 仍在 warning 区间 → 不重复发
    cm.updateUsage(100_000);  // 回落 normal
    cm.updateUsage(520_000);  // 再次进入 warning → 再发一次
    expect(warnings.length).toBe(2);
    expect(warnings[0].usage.stage).toBe('warning');
  });

  it('compress start → complete 事件 + snapshot 持久化', async () => {
    const cm = new ContextManager({ maxTokens: 1_000_000, compressionThreshold: 0.55, warningThreshold: 0.5 });
    const events: string[] = [];
    cm.onEvent((e) => events.push(e.type));
    cm.markCompressStart(600_000);
    const snap: ContextSnapshot = {
      id: 'test-1',
      timestamp: Date.now(),
      beforeTokens: 600_000,
      afterTokens: 100_000,
      summary: '测试摘要',
      preservedMemory: ['- 用户目标'],
      agentId: 'agent_test',
      channelId: 'ch_test',
    };
    cm.markCompressComplete(snap);
    expect(events).toContain('context.compress.start');
    expect(events).toContain('context.compress.complete');
    expect(events).toContain('context.snapshot.created');
    // usage 更新为压缩后
    expect(cm.getUsage().stage).toBe('compressed');
    expect(cm.getUsage().lastSavedTokens).toBe(500_000);
  });

  it('snapshot 落盘后可恢复 (loadLatestSnapshot)', async () => {
    const snap: ContextSnapshot = {
      id: 'disk-1',
      timestamp: Date.now(),
      beforeTokens: 800_000,
      afterTokens: 200_000,
      summary: '磁盘快照',
      preservedMemory: [],
    };
    const file = await saveSnapshotToDisk(snap, TEST_HOME);
    expect(file).toBeTruthy();
    const loaded = await loadLatestSnapshot(TEST_HOME);
    expect(loaded).toBeTruthy();
    expect(loaded!.id).toBe('disk-1');
    expect(loaded!.beforeTokens).toBe(800_000);
    // 清理
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  it('makeSnapshot 生成 uuid + before/after', () => {
    const cm = new ContextManager();
    const snap = cm.makeSnapshot({ beforeTokens: 100, afterTokens: 20, summary: 's' });
    expect(snap.id.length).toBeGreaterThan(10);
    expect(snap.beforeTokens).toBe(100);
    expect(snap.afterTokens).toBe(20);
  });
});
