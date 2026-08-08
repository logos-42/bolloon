/**
 * Bolloon Bootstrap — 启动入口
 *
 * web server 启动时 (或 CLI 模式) 调一次, 完成 3 件事:
 * 1. 跑类 B 自适应扫描 (暖缓存 + 写 evolution.jsonl 启动事件)
 * 2. 收集项目 Context (Bolloon.md / git / persona / judgments / skills)
 * 3. 挂每天 0:00 定时任务
 *
 * 失败静默: 任意步骤失败 console.warn, 不抛错 (主流程不被阻塞)
 */

import { runAdaptiveScan, logEvolution } from '../pi-ecosystem-judgment/adaptive-scan.js';
import { collectBolloonContext, type BolloonContext } from './context-collector.js';
import type { AdaptiveScanResult } from '../pi-ecosystem-judgment/adaptive-scan.js';
import { migrateAllExternalAgents, defaultDeps, formatMigrationNotices, type MigrationReport } from '../migration/external-agent-migrator.js';

export interface BootstrapResult {
  context: BolloonContext;
  scanResult: AdaptiveScanResult;
  durationMs: number;
  // 失败的部分不影响主流程
  errors: string[];
  // 2026-08-08: 外部智能体 (openclaw/hermes) 数据迁移结果, 通告给用户
  externalAgentMigrations: MigrationReport[];
}

/**
 * 入口: web server / CLI 启动时调一次
 */
export async function bootstrapBolloon(opts: {
  cwd?: string;
  /** 迁移用家目录 (默认 os.homedir; 测试注入 tmp 隔离) */
  home?: string;
  /** hermes 所在 LOCALAPPDATA (默认自动探测) */
  localAppData?: string;
} = {}): Promise<BootstrapResult> {
  const start = Date.now();
  const errors: string[] = [];

  // 0. 外部智能体 (openclaw/hermes) 数据迁移 — 隐式处理, 静默跑, 结果通告用户
  let externalAgentMigrations: MigrationReport[] = [];
  try {
    const depsM = defaultDeps();
    if (opts.home) depsM.home = opts.home;
    if (opts.localAppData) depsM.localAppData = opts.localAppData;
    externalAgentMigrations = await migrateAllExternalAgents(depsM);
    for (const line of formatMigrationNotices(externalAgentMigrations)) {
      console.log(`[bootstrap] ${line}`);
    }
  } catch (err) {
    errors.push(`external-migration: ${(err as Error).message}`);
    console.warn('[bootstrap] 外部智能体迁移失败 (非致命):', err);
  }

  // 1. 类 B 启动扫描
  let scanResult: AdaptiveScanResult = {
    scannedAt: new Date().toISOString(),
    judgmentsTotal: 0,
    usageEntriesScanned: 0,
    suggestions: [],
  };
  try {
    scanResult = await runAdaptiveScan();
    const { suggestionHint } = await import('../pi-ecosystem-judgment/adaptive-scan.js');
    await logEvolution({
      ts: new Date().toISOString(),
      action: 'accept',  // 用 accept 表示"系统记录" (跟 reject 区分)
      suggestion: {
        key: 'bootstrap-startup',
        kind: 'unused',  // 占位
        judgmentId: '__bootstrap__',
        decision: 'Bolloon 启动扫描',
        reason: `本次启动扫描了 ${scanResult.judgmentsTotal} 条原则, ${scanResult.usageEntriesScanned} 条使用记录, 生成 ${scanResult.suggestions.length} 条建议`,
        action: 'review',
        hint: suggestionHint('unused', 'review', { usage7d: 0, usage30d: 0, daysSinceLastUse: 0, totalUsage: 0 }),
        metrics: { usage7d: 0, usage30d: 0, daysSinceLastUse: 0, totalUsage: 0 },
        scannedAt: scanResult.scannedAt,
      },
    });
    console.log(`[bootstrap] 类 B 启动扫描完成: ${scanResult.suggestions.length} 条建议`);
  } catch (err) {
    errors.push(`scan: ${(err as Error).message}`);
    console.warn('[bootstrap] 启动扫描失败 (非致命):', err);
  }

  // 2. 收集项目 Context
  let context: BolloonContext = {
    projectRoot: opts.cwd ?? process.cwd(),
    projectName: 'unknown',
    bolloonMd: null,
    hierarchy: { managed: null, user: null, project: null, local: null, merged: '' },
    git: null,
    persona: null,
    judgmentsSummary: { total: 0, active: 0, superseded: 0, rejected: 0, topValues: [] },
    skills: [],
    env: { os: 'unknown', nodeVersion: 'unknown', llmProvider: 'unknown' },
    pending: { goals: [], todos: [] },
    collectedAt: new Date().toISOString(),
  };
  try {
    context = await collectBolloonContext({ cwd: opts.cwd ?? process.cwd() });
    console.log(`[bootstrap] context 收集完成: ${context.judgmentsSummary.total} judgments, ${context.skills.length} skills`);
  } catch (err) {
    errors.push(`context: ${(err as Error).message}`);
    console.warn('[bootstrap] context 收集失败 (非致命):', err);
  }

  // 3. 挂定时任务 (每天 0:00 跑扫描, server 重启时丢失可接受)
  try {
    scheduleAdaptiveScanDaily();
    console.log('[bootstrap] 定时任务已挂: 每天 0:00 跑类 B 扫描');
  } catch (err) {
    errors.push(`schedule: ${(err as Error).message}`);
    console.warn('[bootstrap] 定时任务挂载失败 (非致命):', err);
  }

  const durationMs = Date.now() - start;
  console.log(`[bootstrap] 完成 (${durationMs}ms, ${errors.length} 个错误)`);

  return { context, scanResult, durationMs, errors, externalAgentMigrations };
}

// ============================================================
// 定时任务: 每天 0:00 跑类 B 自适应扫描
// ============================================================

let scheduled = false;

function scheduleAdaptiveScanDaily(): void {
  if (scheduled) return;
  scheduled = true;

  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const msUntilMidnight = next.getTime() - now.getTime();

  // 第一次: 等到明天 0:00
  setTimeout(() => {
    runAdaptiveScan().then((result) => {
      console.log(`[bootstrap] 定时扫描完成: ${result.suggestions.length} 条建议`);
    }).catch((err) => {
      console.warn('[bootstrap] 定时扫描失败:', err);
    });
    // 之后: 每 24h
    setInterval(() => {
      runAdaptiveScan().then((result) => {
        console.log(`[bootstrap] 定时扫描完成: ${result.suggestions.length} 条建议`);
      }).catch((err) => {
        console.warn('[bootstrap] 定时扫描失败:', err);
      });
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

/** 测试辅助: 重置 scheduled 标志 */
export function _resetScheduleForTest(): void {
  scheduled = false;
}
