/**
 * routes-chain-index.ts — 链上索引的**只读**HTTP 路由 (P5, ③)
 * =========================================================================
 * 刻意独立成文件, **不碰 src/web/server.ts**: 挂载方法见文件末尾注释。
 * 本模块只暴露**读**接口 (读已落盘索引), 全都不发 RPC、不写盘、不签名:
 *
 *   GET /api/chain/index/status
 *       → 当前索引高度 (lastSyncedBlock) / 最后同步时间 / head / 确认数门槛 / 页大小
 *   GET /api/chain/index/stats
 *       → 全量统计: tasks / created / proofSubmitted / released / refunded / disputed / expired
 *         + byFinality (observed|confirmed|finalized) + suspects (被回退的条数)
 *   GET /api/chain/index/timeline?taskKey=0x…(64hex)
 *       → 该 escrow 的事件时间线 (含块号/块哈希/logIndex/解码 args/确认数/finality/suspect)
 *   GET /api/chain/index/events?blockNumber=..&logIndex=..&limit=..
 *       → 按 cursor 增量拉取 (严格大于 cursor 的 (blockNumber, logIndex)); 无 cursor = 从头
 *
 * 挂载 (在 src/web/server.ts 里加两行即可, 本文件不改它):
 *   import { registerChainIndexRoutes } from './routes-chain-index.js';
 *   registerChainIndexRoutes(app);              // app: express.Express (或等价 router 宿主)
 *
 * 挂载点可选前缀: registerChainIndexRoutes(app, { basePath: '/api/chain/index' })
 * 读 SQLite/文件直接读 ~/.bolloon/chain/index.json; 换 HOME 用 opts.home (测试隔离)。
 * 若还想在网页上触发同步: registerChainIndexRoutes(app, { allowSync: true })
 *   → 多一个 POST /api/chain/index/sync (body: { fromBlock?: number })。默认关 —— 写操作不默认开放。
 */

import type { Express, Request, Response } from 'express';
import {
  getIndexStatus, getIndexStats, getEscrowTimeline, fetchIndexSince,
} from '../agents/chain/chain-index-query.js';

type SyncFn = (fromBlock?: number) => Promise<unknown>;

export interface ChainIndexRoutesOptions {
  /** 路由前缀, 默认 '/api/chain/index' */
  basePath?: string;
  /** 索引所在 HOME (测试隔离用; 生产用默认 ~) */
  home?: string;
  /** 是否开放 POST sync (默认 false —— 写操作不默认开放) */
  allowSync?: boolean;
  /** sync 注入 (allowSync=true 时用; 缺省则回 501) */
  sync?: SyncFn;
}

const isTaskKey = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

export function registerChainIndexRoutes(app: Express, opts: ChainIndexRoutesOptions = {}): void {
  const base = opts.basePath || '/api/chain/index';
  const home = opts.home;

  // ① 当前索引高度 + 最后同步时间
  app.get(`${base}/status`, (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, status: getIndexStatus({ home }) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ② 全量统计
  app.get(`${base}/stats`, (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, stats: getIndexStats({ home }) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ③ 按 taskKey 查 escrow 时间线
  app.get(`${base}/timeline`, (req: Request, res: Response) => {
    const taskKey = String(req.query?.taskKey || '');
    if (!isTaskKey(taskKey)) {
      return res.status(400).json({ ok: false, error: 'taskKey 必须是 0x + 64 hex' });
    }
    try {
      const tl = getEscrowTimeline(taskKey, { home });
      res.json({ ok: true, timeline: tl });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ④ 按 cursor 增量拉取
  app.get(`${base}/events`, (req: Request, res: Response) => {
    const q = req.query || {};
    const hasCursor = q.blockNumber !== undefined && q.blockNumber !== '';
    let cursor: { blockNumber: number; logIndex: number } | null = null;
    if (hasCursor) {
      const bn = Number(q.blockNumber);
      const li = q.logIndex === undefined || q.logIndex === '' ? 0 : Number(q.logIndex);
      if (!Number.isInteger(bn) || bn < 0 || !Number.isInteger(li) || li < 0) {
        return res.status(400).json({ ok: false, error: 'cursor 非法: 需要 blockNumber>=0, logIndex>=0' });
      }
      cursor = { blockNumber: bn, logIndex: li };
    }
    const limit = q.limit === undefined || q.limit === '' ? 200 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      return res.status(400).json({ ok: false, error: 'limit 必须 >= 1 的整数' });
    }
    try {
      res.json({ ok: true, page: fetchIndexSince(cursor, { home, limit }) });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // 可选: 触发一次同步 (显式 opt-in)
  if (opts.allowSync) {
    app.post(`${base}/sync`, async (req: Request, res: Response) => {
      if (!opts.sync) return res.status(501).json({ ok: false, error: '未注入 sync 实现' });
      const fromBlockRaw = req.body?.fromBlock;
      let fromBlock: number | undefined;
      if (fromBlockRaw !== undefined && fromBlockRaw !== null && fromBlockRaw !== '') {
        const n = Number(fromBlockRaw);
        if (!Number.isInteger(n) || n < 0) return res.status(400).json({ ok: false, error: 'fromBlock 必须 >= 0 的整数' });
        fromBlock = n;
      }
      try {
        res.json({ ok: true, result: await opts.sync(fromBlock) });
      } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    });
  }
}
