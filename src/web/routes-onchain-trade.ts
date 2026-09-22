/**
 * routes-onchain-trade.ts — 链上任务交易闭环的**只读**HTTP 路由 (P4, ②③)
 * =========================================================================
 * 刻意独立成文件, **不碰 src/web/server.ts** (另一个并行任务在动它)。
 * 只暴露**读**接口 —— 全都不发交易、不签名、不改链、不写盘:
 *
 *   GET /api/chain/trade/state?taskKey=0x…(64hex) | taskId=…
 *       → 该任务在 chain-state.json 里的全部链上记录 (方法/状态/确认数/是否可疑/结果哈希)
 *   GET /api/chain/trade/recovery?taskKey=… | taskId=…&pendingResultDigest=sha256:…
 *       → ★ 重启恢复决策: nextAction / mustNotRepay / verified / 为什么 (纯读盘, 不联网)
 *   GET /api/chain/trade/budget?amount=0.02&taskBudget=0.05
 *       → M1 预算硬约束预检 (单任务 0.05 / 单次 0.02): 放行 / 哪一层拦下
 *
 * 挂载 (在 src/web/server.ts 里加两行即可, 本文件不改它):
 *   import { registerOnchainTradeRoutes } from './routes-onchain-trade.js';
 *   registerOnchainTradeRoutes(app);            // app: express.Express
 *
 * 挂载点可选: registerOnchainTradeRoutes(app, { basePath: '/api/chain/trade' })
 * 换 HOME 用 opts.home (测试隔离 / 多 profile)。**没有**任何写接口 ——
 * 链上写操作必须走 CLI/任务链路 (那里有签名放行闸 + 审计), 不通过 HTTP 裸开。
 */

import type { Express, Request, Response } from 'express';
import * as os from 'os';
import {
  recoverOnchainTrade, checkOnchainAmount, onchainTaskKey,
} from '../agents/chain/onchain-trade.js';
import { loadChainState, chainStatePath } from '../agents/chain/chain-state-store.js';

export interface OnchainTradeRoutesOptions {
  /** 路由前缀, 默认 '/api/chain/trade' */
  basePath?: string;
  /** 状态所在 HOME (缺省 = 进程 HOME, 即 ~/.bolloon/chain/chain-state.json) */
  home?: string;
}

const isTaskKey = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

function homeOf(opts: OnchainTradeRoutesOptions): string {
  return opts.home || process.env.HOME || os.homedir();
}

export function registerOnchainTradeRoutes(app: Express, opts: OnchainTradeRoutesOptions = {}): void {
  const base = opts.basePath || '/api/chain/trade';

  // ① 链上记录 (按 taskKey / taskId 过滤; 不过滤 = 全部)
  app.get(`${base}/state`, (req: Request, res: Response) => {
    try {
      const home = homeOf(opts);
      const taskKey = String((req.query as any)?.taskKey || '');
      const taskId = String((req.query as any)?.taskId || '');
      if (taskKey && !isTaskKey(taskKey)) return res.status(400).json({ ok: false, error: 'taskKey 必须是 0x + 64 hex' });
      const want = (taskKey || (taskId ? onchainTaskKey(taskId) : '')).toLowerCase();
      const all = Object.values(loadChainState(home).records);
      const records = want ? all.filter((r) => String(r.taskKey).toLowerCase() === want) : all;
      res.json({
        ok: true,
        statePath: chainStatePath(home),
        taskKey: want || null,
        count: records.length,
        records,
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ② 重启恢复决策 (纯读盘; 不联网 → 不会把"读不到 RPC"当成"没付款")
  app.get(`${base}/recovery`, (req: Request, res: Response) => {
    try {
      const home = homeOf(opts);
      const q: any = req.query || {};
      const taskKey = String(q.taskKey || '');
      const taskId = String(q.taskId || '');
      if (taskKey && !isTaskKey(taskKey)) return res.status(400).json({ ok: false, error: 'taskKey 必须是 0x + 64 hex' });
      if (!taskKey && !taskId) return res.status(400).json({ ok: false, error: '要 taskKey 或 taskId' });
      const recovery = recoverOnchainTrade({
        home,
        ...(taskKey ? { taskKey } : {}),
        ...(taskId ? { taskId } : {}),
        ...(q.pendingResultDigest ? { pendingResultDigest: String(q.pendingResultDigest) } : {}),
      });
      res.json({ ok: true, recovery });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ③ M1 预算硬约束预检 (付款前必须能看得到; 纯函数, 不碰钱)
  app.get(`${base}/budget`, (req: Request, res: Response) => {
    try {
      const q: any = req.query || {};
      const amount = Number(q.amount);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'amount 必须是正数 (USDC)' });
      const decimals = Number.isFinite(Number(q.decimals)) ? Number(q.decimals) : 6;
      const atomic = BigInt(Math.round(amount * 10 ** decimals));
      const d = checkOnchainAmount({
        amountAtomic: atomic, decimals,
        budget: {
          ...(q.taskBudget !== undefined ? { taskBudget: Number(q.taskBudget) } : {}),
          ...(q.perPurchase !== undefined ? { perPurchase: Number(q.perPurchase) } : {}),
        },
      });
      res.json({ ok: true, allowed: d.ok, layer: d.layer ?? null, reason: d.reason, amountUsdc: d.amountUsdc, budget: d.budget, why: d.why });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
}
