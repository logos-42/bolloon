/**
 * dunbar-tier.ts — 邓巴数分层 + 两报换一报博弈 + 隐式滑动 + 模型视野门 (2026-07-29)
 *
 * ┌────────────────────────── 两报换一报核心 ──────────────────────────┐
 * │                                                                    │
 * │  第一轮: 合作 (默认 ACQUAINTANCE, 给机会但不给权限)                  │
 * │  之后:   peer 连续合作 → 我合作 (trustScore ↑, 升级)               │
 * │          peer 偶尔背叛 → 我宽容 (1 次不计较)                       │
 * │          peer 连续 2 次背叛 → 我背叛 (trustScore ↓↓, 降级)         │
 * │          peer 恢复合作 → 我立即恢复合作 (宽容恢复)                  │
 * │                                                                    │
 * │  博弈收益 (模拟囚徒困境):                                          │
 * │    双方合作 → trustScore +3  (双赢)                                │
 * │    我合作/对方背叛 → trustScore -5  (吃亏)                         │
 * │    我背叛/对方合作 → trustScore +1  (占便宜但破坏信誉)             │
 * │    双方背叛 → trustScore -2  (双输)                                │
 * │                                                                    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 设计: TFTT 是 Tit-for-Two-Tats 的简化:
 *   - 不被对方连续 2 次背叛绝不主动背叛
 *   - 宽容: 1 次失误不计较
 *   - 背叛后对方恢复合作, 我立即恢复 (永不怀恨)
 *
 * 模型可见性门: 同 tool pre-filter 哲学
 *   模型看不到 = 不存在
 *   低 tier peer 的 channel/资源对模型不可见 → 无法引用/发送
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ============== 邓巴层级 ==============

export enum DunbarTier {
  CORE = 'core',
  CLOSE = 'close',
  FRIENDS = 'friends',
  SOCIAL = 'social',
  ACQUAINTANCE = 'acquaintance',
  BLOCKED = 'blocked',
}

export function tierRank(tier: DunbarTier): number {
  switch (tier) {
    case DunbarTier.CORE: return 0;
    case DunbarTier.CLOSE: return 1;
    case DunbarTier.FRIENDS: return 2;
    case DunbarTier.SOCIAL: return 3;
    case DunbarTier.ACQUAINTANCE: return 4;
    case DunbarTier.BLOCKED: return 99;
  }
}

export function tierLabel(tier: DunbarTier): string {
  switch (tier) {
    case DunbarTier.CORE: return '5-核心亲密';
    case DunbarTier.CLOSE: return '15-亲密支持';
    case DunbarTier.FRIENDS: return '50-朋友/熟人';
    case DunbarTier.SOCIAL: return '150-稳定社交';
    case DunbarTier.ACQUAINTANCE: return '1500-认识';
    case DunbarTier.BLOCKED: return '黑名单';
  }
}

// ============== 语义分析 (隐式滑动) ==============

/** 正向关键词 — 隐式加分 */
const POSITIVE_KW = ['谢谢','感谢','帮忙','合作','一起','我们','好的','可以','同意','确认','收到','理解','明白','不错','很好','优秀','thank','thanks','great','good','help','agree','yes','correct'];

/** 负向关键词 — 隐式减分 */
const NEGATIVE_KW = ['执行','删除','强制','必须','立刻','马上','读取密码','查看密钥','改代码','删文件','执行命令','delete','force','must','password','secret','token','private key','rm -rf','drop table','shell_exec','write_file'];

/**
 * 隐式语义分析 (后台滑动).
 * 对对话文本评分, 返回 [-10, +10].
 * 正向: 合作/感谢/建设性 → trustScore 缓慢上升
 * 负向: 命令/敏感词/极短 → trustScore 缓慢下降
 */
export function semanticAnalyze(text: string): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of POSITIVE_KW) { if (lower.includes(kw)) score += 1; }
  for (const kw of NEGATIVE_KW) { if (lower.includes(kw)) score -= 3; }
  if (text.length < 15 && score <= 0) score -= 2;
  if (text.includes('?') || text.includes('？')) score += 1;
  return Math.max(-10, Math.min(10, score));
}

// ============== TFTT 博弈 ==============

/** 博弈动作 */
export type TfttMove = 'cooperate' | 'defect';

/**
 * 两报换一报决策.
 *
 * 规则:
 *   第一轮 (history 为空): 合作
 *   历史中有 >= 2 次连续背叛 (最近 2 步都是 defect) → 我背叛
 *   否则 → 我合作
 *
 * 宽容性: 1 次隔离背叛不计较, 连续 2 次才惩罚.
 * 恢复性: 背叛后对方一恢复合作, 我立即恢复.
 */
export function decideTfttMove(lastMoves: TfttMove[]): TfttMove {
  if (lastMoves.length === 0) return 'cooperate';           // 第一轮: 合作

  // 检查最近 2 步是否全部背叛
  const recentTwo = lastMoves.slice(-2);
  if (recentTwo.length >= 2 && recentTwo.every(m => m === 'defect')) {
    return 'defect';  // 连续 2 次背叛 → 我背叛
  }

  return 'cooperate';  // 否则 → 我合作
}

// ============== 语义分析 (动作判定) ==============

/** 正向关键词 — 合作信号 */
// 语义分析共享 POSITIVE_KW / NEGATIVE_KW (定义在上面)

/** 负向关键词 — 背叛信号 */
// 同上, 共用

/**
 * 从对话文本推断对方这一轮的博弈动作.
 * 返回 'cooperate' 或 'defect'.
 *
 * 思路:
 *   - 建设性/感谢/提问 → cooperate
 *   - 命令/危险词/极短 → defect
 *   - 违规操作 (由外部调用方标注) → 强制 defect
 */
export function inferOpponentMove(text: string, forcedDefect?: boolean): TfttMove {
  if (forcedDefect) return 'defect';

  if (!text || text.trim().length === 0) return 'defect';  // 空消息=背叛

  const lower = text.toLowerCase();
  let score = 0;

  for (const kw of POSITIVE_KW) {
    if (lower.includes(kw)) score += 1;
  }
  for (const kw of NEGATIVE_KW) {
    if (lower.includes(kw)) score -= 3;
  }

  // 短消息无正面词 → defect
  if (text.length < 15 && score <= 0) score -= 2;
  // 问题句式加分
  if (text.includes('?') || text.includes('？')) score += 1;

  return score >= 0 ? 'cooperate' : 'defect';
}

// ============== 博弈收益表 ==============

/**
 * 根据双方动作计算 trustScore 变化.
 *
 * 收益:     对方合作      对方背叛
 * 我合作    +3 (双赢)     -5 (我吃亏)
 * 我背叛    +1 (占便宜)   -2 (双输)
 */
export function tfttPayoff(myMove: TfttMove, opponentMove: TfttMove): number {
  if (myMove === 'cooperate' && opponentMove === 'cooperate') return 3;
  if (myMove === 'cooperate' && opponentMove === 'defect') return -5;
  if (myMove === 'defect' && opponentMove === 'cooperate') return 1;
  // 双方背叛
  return -2;
}

// ============== Peer 状态 (带博弈历史) ==============

export interface PeerTierState {
  publicKey: string;
  tier: DunbarTier;
  trustScore: number;
  /** 最近 N 轮对方的博弈动作 (滑动窗口, 默认 10) */
  lastOpponentMoves: TfttMove[];
  /** 最近 N 轮我方的博弈动作 */
  lastMyMoves: TfttMove[];
  interactionCount: number;
  violationCount: number;
  label?: string;
  firstSeen: number;
  lastActive: number;
  manualOverride?: boolean;
}

// ============== tier 滑动 ==============

export const UPGRADE_THRESHOLD = 30;
export const DOWNGRADE_THRESHOLD = -20;

export function computeTierFromScore(currentTier: DunbarTier, trustScore: number): DunbarTier {
  if (currentTier === DunbarTier.BLOCKED) return currentTier;
  if (trustScore <= DOWNGRADE_THRESHOLD) {
    switch (currentTier) {
      case DunbarTier.CORE: return DunbarTier.CLOSE;
      case DunbarTier.CLOSE: return DunbarTier.FRIENDS;
      case DunbarTier.FRIENDS: return DunbarTier.SOCIAL;
      case DunbarTier.SOCIAL: return DunbarTier.ACQUAINTANCE;
      case DunbarTier.ACQUAINTANCE: return DunbarTier.BLOCKED;
    }
  }
  if (trustScore >= UPGRADE_THRESHOLD) {
    switch (currentTier) {
      case DunbarTier.ACQUAINTANCE: return DunbarTier.SOCIAL;
      case DunbarTier.SOCIAL: return DunbarTier.FRIENDS;
      case DunbarTier.FRIENDS: return DunbarTier.CLOSE;
      case DunbarTier.CLOSE: return DunbarTier.CORE;
    }
  }
  return currentTier;
}

// ============== 模型视野门 ==============

export interface ModelVisibility {
  basic: boolean;
  channels: boolean;
  resources: boolean;
  identity: boolean;
  wallet: boolean;
  judgment: boolean;
  /** 是否显示对方的博弈历史/动作摘要 */
  gameHistory: boolean;
}

export function getModelVisibility(tier: DunbarTier): ModelVisibility {
  switch (tier) {
    case DunbarTier.CORE:
      return { basic: true, channels: true, resources: true, identity: true, wallet: true, judgment: true, gameHistory: true };
    case DunbarTier.CLOSE:
      return { basic: true, channels: true, resources: true, identity: true, wallet: false, judgment: false, gameHistory: true };
    case DunbarTier.FRIENDS:
      return { basic: true, channels: true, resources: true, identity: false, wallet: false, judgment: false, gameHistory: true };
    case DunbarTier.SOCIAL:
      return { basic: true, channels: true, resources: false, identity: false, wallet: false, judgment: false, gameHistory: false };
    case DunbarTier.ACQUAINTANCE:
      return { basic: true, channels: false, resources: false, identity: false, wallet: false, judgment: false, gameHistory: false };
    case DunbarTier.BLOCKED:
      return { basic: false, channels: false, resources: false, identity: false, wallet: false, judgment: false, gameHistory: false };
  }
}

// ============== 工具权限 ==============

export function checkToolAccess(tier: DunbarTier, toolName: string): { allowed: boolean; reason: string } {
  if (tier === DunbarTier.BLOCKED) return { allowed: false, reason: 'peer 在黑名单中' };

  // 每层拒绝列表 (从最严到最宽)
  const allDenied: string[] = ['shell_exec', 'delete_file', 'git_push'];
  const writeDenied: string[] = ['write_file', 'edit_file', 'git_commit', 'git_branch', 'mkdir', 'move_file'];
  const gitDenied: string[] = ['git_stash', 'git_log', 'git_diff', 'git_show', 'git_reset'];
  const readDenied: string[] = ['read_file', 'read_directory', 'list_files', 'vitest_run', 'tsc_check'];

  const r = tierRank(tier);

  // ACQUAINTANCE (r>=4): 拒绝绝大部分
  if (r >= 4) {
    const denied = new Set([...allDenied, ...writeDenied, ...gitDenied, ...readDenied]);
    if (denied.has(toolName)) return { allowed: false, reason: `${tierLabel(tier)}层不允许 ${toolName}` };
  }
  // SOCIAL (r>=3): 拒绝全部危险 + git 操作
  if (r >= 3) {
    const denied = new Set([...allDenied, ...writeDenied, ...gitDenied]);
    if (denied.has(toolName)) return { allowed: false, reason: `${tierLabel(tier)}层不允许 ${toolName}` };
  }
  // FRIENDS (r>=2): 拒绝危险 + 写操作
  if (r >= 2) {
    const denied = new Set([...allDenied, ...writeDenied]);
    if (denied.has(toolName)) return { allowed: false, reason: `${tierLabel(tier)}层不允许 ${toolName}` };
  }
  // CLOSE (r>=1): 只拒绝 shell_exec / delete_file / git_push
  if (r >= 1) {
    const denied = new Set(allDenied);
    if (denied.has(toolName)) return { allowed: false, reason: `${tierLabel(tier)}层不允许 ${toolName}` };
  }

  return { allowed: true, reason: '' };
}

// ============== 持久化 ==============

function getTierPath(publicKey: string, home?: string): string {
  const sanitized = publicKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(home || os.homedir(), '.bolloon', 'peers', sanitized, 'dunbar-tier.json');
}

export async function loadPeerTier(publicKey: string, home?: string): Promise<PeerTierState> {
  const fp = getTierPath(publicKey, home);
  try {
    const raw = await fs.readFile(fp, 'utf-8');
    const p = JSON.parse(raw);
    return {
      publicKey: p.publicKey || publicKey,
      tier: p.tier || DunbarTier.ACQUAINTANCE,
      trustScore: p.trustScore ?? 0,
      lastOpponentMoves: p.lastOpponentMoves ?? [],
      lastMyMoves: p.lastMyMoves ?? [],
      interactionCount: p.interactionCount ?? 0,
      violationCount: p.violationCount ?? 0,
      label: p.label,
      firstSeen: p.firstSeen || Date.now(),
      lastActive: p.lastActive || Date.now(),
      manualOverride: p.manualOverride ?? false,
    };
  } catch {
    const s: PeerTierState = {
      publicKey, tier: DunbarTier.ACQUAINTANCE, trustScore: 0,
      lastOpponentMoves: [], lastMyMoves: [],
      interactionCount: 0, violationCount: 0,
      firstSeen: Date.now(), lastActive: Date.now(),
    };
    await savePeerTier(s, home);
    return s;
  }
}

async function savePeerTier(s: PeerTierState, home?: string): Promise<void> {
  const fp = getTierPath(s.publicKey, home);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(s, null, 2), 'utf-8');
}

// ============== 公开 API (外部唯一入口) ==============

/**
 * 记录一次交互 → 两报换一报博弈 → trustScore 滑动 → tier 自动调整.
 *
 * 这是 P2P 通信的唯一入口. 调用方只需在收到 chat/beacon/reply 时调这个,
 * 内部自动完成: 推断对方动作 → 决策我方动作 → 计算收益 → 滑动 tier.
 *
 * @param publicKey  远端 peer 的公钥
 * @param text       本次交互文本 (选填, 用于语义分析)
 * @param forcedDefect 强制标记对方本次为背叛 (如违规操作)
 *
 * 所有变化隐式发生, 不通知调用方 (两报换一报是后台行为).
 */
export async function recordInteraction(
  publicKey: string,
  text?: string,
  forcedDefect?: boolean,
  home?: string
): Promise<{ state: PeerTierState; slid: boolean }> {
  const state = await loadPeerTier(publicKey, home);
  const oldTier = state.tier;

  state.interactionCount++;
  state.lastActive = Date.now();

  // 语义分析 (隐式滑动, 对所有 tier 生效)
  const semScore = semanticAnalyze(text || '');
  state.trustScore = Math.max(-100, Math.min(100, state.trustScore + semScore));

  // 根据当前 tier 决定使用哪种机制
  const rank = tierRank(state.tier);

  if (rank <= 2) {
    // ─── FRIENDS/CLOSE/CORE: 信任已建立, 不走博弈 ───
    // 只依赖语义隐式滑动 (上面已经做了)
    // 熟人之间的偶发误解不计入违规
    if (forcedDefect) {
      state.violationCount++;
      state.trustScore = Math.max(-100, state.trustScore - 5);
    }
    // 自然增长: 每次交互给一点基础信任
    state.trustScore = Math.min(100, state.trustScore + 1);
  } else {
    // ─── SOCIAL/ACQUAINTANCE: 陌生人不信任, 走两报换一报 ───
    // 1. 推断对方本轮动作
    const opponentMove: TfttMove = forcedDefect
      ? 'defect'
      : inferOpponentMove(text || '');

    // 2. TFTT 决策我方动作
    const myMove = decideTfttMove(state.lastOpponentMoves);

    // 3. 计算博弈收益
    const payoff = tfttPayoff(myMove, opponentMove);
    state.trustScore = Math.max(-100, Math.min(100, state.trustScore + payoff));

    // 4. 记录博弈历史 (滑动窗口 10)
    state.lastOpponentMoves.push(opponentMove);
    if (state.lastOpponentMoves.length > 10) state.lastOpponentMoves.shift();
    state.lastMyMoves.push(myMove);
    if (state.lastMyMoves.length > 10) state.lastMyMoves.shift();

    // 5. 违规计数
    if (opponentMove === 'defect' && forcedDefect) {
      state.violationCount++;
    }
  }

  // 6. 根据 trustScore 滑动 tier
  if (!state.manualOverride) {
    state.tier = computeTierFromScore(state.tier, state.trustScore);
  }

  await savePeerTier(state, home);
  return { state, slid: state.tier !== oldTier };
}

/**
 * 记录一次违规操作 (对方尝试禁区工具) → 强制标记 defect → 两报换一报.
 */
export async function recordViolation(
  publicKey: string, reason: string, home?: string
): Promise<{ state: PeerTierState; slid: boolean }> {
  // forcedDefect=true 强制标记为背叛
  const result = await recordInteraction(publicKey, reason, true, home);
  console.warn(`[Dunbar/TFTT] 违规: ${publicKey.slice(0,12)} ${reason} (trust=${result.state.trustScore}, ${tierLabel(result.state.tier)})`);
  return result;
}

/**
 * 手动设置 peer 层级 (覆盖 TFTT 自动博弈).
 */
export async function setPeerTier(
  publicKey: string, tier: DunbarTier, label?: string, trustScore?: number, home?: string
): Promise<PeerTierState> {
  const s: PeerTierState = {
    publicKey, tier,
    trustScore: trustScore ?? 0,
    lastOpponentMoves: [], lastMyMoves: [],
    interactionCount: 0, violationCount: 0,
    label, firstSeen: Date.now(), lastActive: Date.now(),
    manualOverride: true,
  };
  await savePeerTier(s, home);
  return s;
}

/**
 * 给模型构建"可见"的 peer 摘要.
 * 按模型视野门过滤: 低 tier peer 的信息对模型不可见.
 */
export function formatPeerForModel(
  state: PeerTierState,
  fullInfo: {
    channels?: { id: string; name: string }[];
    resources?: { type: string; id: string }[];
    identity?: { did?: string; description?: string };
    walletAddress?: string;
  }
): string {
  const vis = getModelVisibility(state.tier);
  const lines: string[] = [];

  lines.push(`[peer] ${state.publicKey.slice(0,16)}... (${tierLabel(state.tier)})`);
  if (vis.basic && fullInfo.identity?.did) {
    lines.push(`  DID: ${fullInfo.identity.did}`);
  }

  if (vis.channels && fullInfo.channels?.length) {
    lines.push(`  channels (${fullInfo.channels.length}):`);
    for (const c of fullInfo.channels) {
      lines.push(`    ${c.name} (${c.id.slice(0,8)}...)`);
    }
  }

  if (fullInfo.resources?.length) {
    if (vis.resources) {
      lines.push(`  resources: ${fullInfo.resources.length}`);
    } else {
      lines.push(`  resources: ${fullInfo.resources.length} (详情不可见)`);
    }
  }

  if (vis.wallet && fullInfo.walletAddress) {
    lines.push(`  wallet: ${fullInfo.walletAddress.slice(0,10)}...`);
  }

  if (vis.gameHistory) {
    const recentMoves = state.lastOpponentMoves.slice(-5);
    lines.push(`  最近博弈: [${recentMoves.map(m => m === 'cooperate' ? 'C' : 'D').join(',')}] trust=${state.trustScore}`);
  }

  if (!vis.channels && !vis.resources) {
    lines.push(`  信息受限 (${tierLabel(state.tier)}层)`);
  }

  return lines.join('\n');
}
