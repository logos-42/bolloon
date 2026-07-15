/**
 * judgeness · types.ts
 *
 * 重要设计决策 (2026-07-15 user rev):
 *   judgeness 是对 judgement 的"描述统称", 不组块.
 *   即: 不扩展 HumanJudgment 的 schema, 而是用一套独立 description vocabulary,
 *        通过 judgmentRef 外键引用 HumanJudgment.id, 0 迁移成本.
 *
 * 核心 5 维 (与传播裂变 / 乔布斯 A 方向对应):
 *   judgment / taste_aesthetic / novelty_score / imaginative_score / curiosity_vector
 * basis_* 是品味 / 创新 / 想象的依据描述 (D1 第三反转).
 *
 * 4 层隐私:
 *   public / allowlist / peers / private
 *
 * 状态机:
 *   open (agent 可 publish) | locked (默认, agent 不可) | human-only (仅人类写入)
 */

import type { HumanJudgment } from '../pi-ecosystem-judgment/human-value-store.js';

// ---------------------------------------------------------------------------
// 5 维评分类 (0..1, 缺省视为 undefined → v0)
// ---------------------------------------------------------------------------

export interface JudgenessFacets {
  /** 判断力 — 与现有 distillDissent 反方命中率挂钩 */
  judgment?: number;
  /** 品味 — 审美 / 风格选择 */
  taste_aesthetic?: number;
  /** 创新 — 是否引入新做法 */
  novelty_score?: number;
  /** 想象力 — 跨域联想 / 假设演绎 */
  imaginative_score?: number;
  /** 好奇心向量 — 在哪些 topic 上探索过 */
  curiosity_vector?: number;
}

/** basis_*: 5 维中 taste/novelty/imagination 的依据描述.
 *  judgment + curiosity 不需要 basis (前者是数字本身, 后者用 scope 表示).
 */
export interface JudgenessBasisDot {
  taste_basis?: string;
  novelty_basis?: string;
  imagination_basis?: string;
}

// ---------------------------------------------------------------------------
// 4 层隐私 + 状态机
// ---------------------------------------------------------------------------

export type JudgenessVisibility =
  | 'public'      // 任何 peer 都能看到摘要
  | 'allowlist'   // 仅 allowlist 内 peer 能看到正文
  | 'peers'       // 仅已 join 的 peer
  | 'private';    // 仅 self

export type JudgenessOpenState =
  | 'open'        // agent 可自动 share / publish
  | 'locked'      // agent 不可, human 显式 unlock 后才能
  | 'human-only'; // 只接受 human 写入

/** 写入者类型 — 闸 3 决策关键 */
export type WriterType = 'human' | 'agent';

// ---------------------------------------------------------------------------
// 核心 description 类型
// ---------------------------------------------------------------------------

export interface JudgenessDescriptionScope {
  /** domain 限定: code / architecture / product / ... */
  domains?: string[];
  /** topic 限定: 用作 channel-based auto-add 触发键 */
  topics?: string[];
}

export interface JudgenessDescription {
  descriptionId: string;             // jd-<ts>-<rand6>
  judgmentRef: string;               // 外键 → HumanJudgment.id (hv-xxx)
  description_version: 1 | 0;        // 1 = judgeness 扩展, 0 = 老 HumanJudgment 视为 v0

  // 核心 5 维 + basis
  facets: JudgenessFacets;
  basis: JudgenessBasisDot;

  // 作用范围 (channel-based auto-add 用)
  scope: JudgenessDescriptionScope;

  // 隐私 + 状态机
  visibility: JudgenessVisibility;
  openState: JudgenessOpenState;

  // 写入者
  by: WriterType;
  byAgentId?: string;                // by='agent' 时填

  // 时间
  createdAt: string;                 // ISO
  updatedAt: string;                 // ISO
  lastTransitionAt?: string;         // visibility / openState 最近一次切换
}

/** description 演化 (不破坏向后兼容; 老 v0 无此字段) */
export interface JudgenessDescriptionEvolve {
  descriptionId: string;
  supersededBy?: string;             // jd-id
  evolutionReason?: 'refined' | 'contradicted' | 'merged';
  evolvedAt: string;
}

// ---------------------------------------------------------------------------
// visibility.yaml 与 allowlist.yaml 持久化结构
// ---------------------------------------------------------------------------

export interface JudgenessVisibilityRule {
  channelId: string;                 // channel topic
  visibility: JudgenessVisibility;
  openState: JudgenessOpenState;
  humanOverride: boolean;            // true = 强制覆盖 agent openState (闸 3)
}

export interface JudgenessVisibilityFile {
  version: 1;
  defaults: {
    visibility: JudgenessVisibility;
    openState: JudgenessOpenState;
  };
  channels: JudgenessVisibilityRule[];
  /** per-card override (覆盖 channels) */
  cards: Array<{
    descriptionId: string;
    visibility: JudgenessVisibility;
    openState: JudgenessOpenState;
    humanOverride: boolean;
  }>;
}

export interface JudgenessAllowlistEntry {
  pubkey: string;                    // ed25519 hex64
  alias?: string;                    // UI 显示名, 不参与 hash
  note?: string;                     // 备注
  addedAt: string;                   // ISO
}

export interface JudgenessAllowlistFile {
  version: 1;
  peers: JudgenessAllowlistEntry[];
}

// ---------------------------------------------------------------------------
// Hearth-cache (远端用户的本地缓存, 反攻期主用)
// ---------------------------------------------------------------------------

export interface HearthCacheManifest {
  ownerName: string;
  ownerPublicKey: string;
  fetchedAt: string;
  ttl: number;                       // seconds
  descriptionCount: number;
  descriptionIds: string[];          // 索引
}

// ---------------------------------------------------------------------------
// 工具类型
// ---------------------------------------------------------------------------

export interface JudgenessPubkeyContext {
  pubkey: string;                    // 调用方 ed25519 publicKey
  name?: string;                     // 可选人类可读名
  role: WriterType;                  // 闸 3 用
  channelTopic?: string;             // 当前 channel (optional)
}

/** P2P 4 新 kind — protocol.ts 引用 */
export type HearthKind =
  | 'hearth_description_publish'
  | 'hearth_description_query'
  | 'hearth_autoadd_invite'
  | 'hearth_block';

export interface HearthFrame {
  kind: HearthKind;
  payload: any;
  ts: number;
}
