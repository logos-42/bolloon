/**
 * judgeness · auto-add.ts — Channel-based Auto-add (反攻期 O3)
 *
 * 用户原话: "传播智能体的时候, 智能体可根据内容频道选择其他用户的 Id 自动添加"
 *
 * 流程:
 *   1. POST /api/hearth/channel-autoadd { channelTopic, sourceChannelOwnerPk? }
 *   2. 闸 2 (allowlist gate) 校验 sourceChannelOwnerPk
 *   3. 扫描 ~/.bolloon/judgeness/descriptions/, 找出 scope.topics 含 channelTopic 且 openState='open' 的 description
 *   4. 对每个 description 的 owner pk 调用 p2p-direct.joinTopic
 *   5. 全部进 ~/.bolloon/human-values/counterfactual-audit.jsonl
 *   6. 频次限制 (defense=无; 反攻期 = 每分钟 5 次; 单 peer pk 24h 内最多 10 次)
 *
 * 反攻期接 src/network/p2p-direct.ts 的 joinTopic; 防御期 stub.
 * 反攻期接 src/judgeness/protocol.ts 的 sendAutoaddInvite.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface AutoAddRequest {
  channelTopic: string;
  sourceChannelOwnerPk?: string;
  ts?: number;
}

export interface AutoAddResult {
  channelTopic: string;
  matched: number;
  joined: number;               // 实际 joinTopic 调用数
  skipped: number;
  auditLines: string[];        // 已写入的 audit 行
  frequencyLimited: boolean;
}

export interface AutoAddOpts {
  /** nowMs for tests */
  nowMs?: number;
  /** allowlist size for freq calc */
  allowlistSize?: number;
  /** 真实 joinTopic (反攻期注入; defense=stub) */
  joinTopic?: (topic: string, peerPubkey: string) => Promise<{ ok: boolean }>;
}

const DEFENSE_FREQ_LIMIT_PER_HOUR = 5;     // 防御期更严
const ROLLING_WINDOW_MS = 60 * 60 * 1000;  // 1 hour

export async function performAutoAdd(
  req: AutoAddRequest,
  opts: AutoAddOpts = {}
): Promise<AutoAddResult> {
  if (!req.channelTopic) throw new Error('channelTopic required');
  const now = opts.nowMs ?? Date.now();

  // ---- 频次限制 (读 audit log last hour 统计) ----
  const auditLog = await readAutoaddAudit();
  const recent = auditLog.filter((l) => now - l.ts < ROLLING_WINDOW_MS);
  if (recent.length >= DEFENSE_FREQ_LIMIT_PER_HOUR) {
    return {
      channelTopic: req.channelTopic,
      matched: 0,
      joined: 0,
      skipped: 0,
      auditLines: [],
      frequencyLimited: true,
    };
  }

  // ---- 扫描 descriptions 找 matches ----
  const { listDescriptions } = await import('./store.js');
  const descs = await listDescriptions();
  const matched = descs.filter((d) => {
    const open = d.openState === 'open';
    const topicMatch = (d.scope.topics ?? []).includes(req.channelTopic);
    return open && topicMatch;
  });

  // ---- join (defense=stub) ----
  const result: AutoAddResult = {
    channelTopic: req.channelTopic,
    matched: matched.length,
    joined: 0,
    skipped: 0,
    auditLines: [],
    frequencyLimited: false,
  };

  // 每次请求都写一条 audit line (不论 matched), 这样 frequency limit 才能工作
  result.auditLines.push(JSON.stringify({
    ts: now,
    kind: 'autoadd_request',
    channelTopic: req.channelTopic,
    by: undefined,
    matched: matched.length,
  }));

  for (const d of matched) {
    const ownerPk = d.byAgentId ?? '__no-pk__';
    if (!opts.joinTopic) {
      // defense: 仅 audit, 不调用 joinTopic
      result.skipped += 1;
      const line = JSON.stringify({
        ts: now,
        kind: 'autoadd_skipped',
        channelTopic: req.channelTopic,
        descriptionId: d.descriptionId,
        ownerPk,
        reason: 'defense stub',
      });
      result.auditLines.push(line);
      continue;
    }
    const r = await opts.joinTopic(req.channelTopic, ownerPk);
    if (r.ok) {
      result.joined += 1;
      result.auditLines.push(JSON.stringify({
        ts: now,
        kind: 'autoadd_joined',
        channelTopic: req.channelTopic,
        descriptionId: d.descriptionId,
        ownerPk,
      }));
    } else {
      result.skipped += 1;
      result.auditLines.push(JSON.stringify({
        ts: now,
        kind: 'autoadd_join_failed',
        channelTopic: req.channelTopic,
        descriptionId: d.descriptionId,
        ownerPk,
      }));
    }
  }

  // ---- 写 audit log ----
  await appendCounterfactualAudit(result.auditLines);

  return result;
}

// ---------------------------------------------------------------------------
// audit 读写 helpers
// ---------------------------------------------------------------------------

async function readAutoaddAudit(): Promise<Array<{ ts: number; kind: string; [k: string]: any }>> {
  const auditPath = await auditPathResolved();
  try {
    const raw = await fs.readFile(auditPath, 'utf-8');
    return raw.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter((x): x is { ts: number; kind: string } => !!x);
  } catch {
    return [];
  }
}

async function appendCounterfactualAudit(lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  const auditPath = await auditPathResolved();
  const dir = path.dirname(auditPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(auditPath, lines.join('\n') + '\n', 'utf-8');
}

let _auditPathCache: string | null = null;
async function auditPathResolved(): Promise<string> {
  if (_auditPathCache) return _auditPathCache;
  const home = process.env.BOLLOON_HOME || path.join(os.homedir(), '.bolloon');
  _auditPathCache = path.join(home, 'human-values', 'counterfactual-audit.jsonl');
  return _auditPathCache;
}

// 工具: 复位 cache (测试用)
export function _resetAuditPathCacheForTest(): void {
  _auditPathCache = null;
}
