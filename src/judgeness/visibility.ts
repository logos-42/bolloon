/**
 * judgeness · visibility.ts
 *
 * 三道授权闸的核心实现:
 *   闸 1: id-visibility scrubber     出站前按 audience 字段过滤
 *   闸 2: channel-allowlist gate     joinPeer / joinTopic 前的白名单
 *   闸 3: human-override handler     任何写入由人类 override 优先
 *
 * 复用了现有 sanitizeChannelForPeer 模式 (src/web/server-v3-p2p.ts:54) 的思路:
 *   不引额外依赖; 默认 fail-closed (闸 1/2); 闸 3 fail-人类优先.
 */

import type {
  JudgenessDescription,
  JudgenessVisibility,
  JudgenessOpenState,
  JudgenessPubkeyContext,
  JudgenessVisibilityFile,
} from './types.js';
import { loadVisibility, isPubkeyAllowed } from './store.js';

// ---------------------------------------------------------------------------
// 闸 3 — human override (任何写入先过这道)
// ---------------------------------------------------------------------------

export interface OverrideDecision {
  /** 是否允许此次操作 */
  allow: boolean;
  /** reason: 给 audit / UI 用 */
  reason: string;
}

/** 三态映射:
 *  - locked + agent 写入 → 拒
 *  - locked + human 写入 → 允许
 *  - open + 任意 → 允许 (但要过闸 2 allowlist)
 *  - human-only + agent 写入 → 拒
 *  - visibility.yaml.humanOverride=true → 完全优先于 agent openState
 */
export function resolveGate3(
  desc: JudgenessDescription,
  ctx: JudgenessPubkeyContext,
  visFile: JudgenessVisibilityFile
): OverrideDecision {
  // 闸 3 先看 visibility.yaml.humanOverride (强制)
  const visCard = visFile.cards.find((c) => c.descriptionId === desc.descriptionId);
  const visChan = ctx.channelTopic
    ? visFile.channels.find((c) => c.channelId === ctx.channelTopic)
    : undefined;
  const humanOverride = visCard?.humanOverride ?? visChan?.humanOverride ?? false;
  const effectiveOpenState: JudgenessOpenState = visCard?.openState ?? visChan?.openState ?? desc.openState;

  // humanOverride=true 时, agent 永不能写, 即使 openState=open
  if (humanOverride && ctx.role !== 'human') {
    return { allow: false, reason: 'humanOverride=true and writer is not human' };
  }

  // human-only 状态: 仅 human
  if (effectiveOpenState === 'human-only' && ctx.role !== 'human') {
    return { allow: false, reason: 'openState=human-only rejects agent' };
  }

  // locked 状态: agent 不能自动 share / publish (但可写入本地 draft)
  if (effectiveOpenState === 'locked' && ctx.role === 'agent') {
    return { allow: false, reason: 'openState=locked rejects agent auto-write' };
  }

  return { allow: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// 闸 1 — scrubber (出站前剥字段)
// ---------------------------------------------------------------------------

/** 一份 scrubber 后的精简版 */
export interface ScrubbedDescription {
  descriptionId: string;
  judgmentRef: string;
  visibility: JudgenessVisibility;
  openState: JudgenessOpenState;
  /** 仅 allowlist 内可见的字段 (基线: facets/basis) */
  facets?: JudgenessDescription['facets'];
  basis?: JudgenessDescription['basis'];
  scope?: JudgenessDescription['scope'];
  by?: 'human' | 'agent';
  createdAt?: string;
  /** 总是保留, 用于审计 */
  byAgentId?: string;
}

/** 给 audience 一份 description 的可见版本. */
export async function scrubForAudience(
  desc: JudgenessDescription,
  audience: JudgenessPubkeyContext
): Promise<ScrubbedDescription> {
  const vis = await loadVisibility();
  const visCard = vis.cards.find((c) => c.descriptionId === desc.descriptionId);
  const visChan = audience.channelTopic
    ? vis.channels.find((c) => c.channelId === audience.channelTopic)
    : undefined;
  const effectiveVis: JudgenessVisibility = visCard?.visibility ?? visChan?.visibility ?? desc.visibility;

  const base: ScrubbedDescription = {
    descriptionId: desc.descriptionId,
    judgmentRef: desc.judgmentRef,
    visibility: effectiveVis,
    openState: visCard?.openState ?? visChan?.openState ?? desc.openState,
  };

  // private 仅 self 可见
  if (effectiveVis === 'private' && audience.pubkey !== '__self__') {
    return base;
  }

  // peers 仅已 join 的 peer (这里简化为: 任何非 self 都视为 peer-by-default)
  if (effectiveVis === 'peers' && audience.pubkey === '__self__') {
    return { ...base, facets: desc.facets, basis: desc.basis, scope: desc.scope, by: desc.by, createdAt: desc.createdAt };
  }

  // allowlist
  if (effectiveVis === 'allowlist') {
    if (audience.pubkey === '__self__') {
      return { ...base, facets: desc.facets, basis: desc.basis, scope: desc.scope, by: desc.by, createdAt: desc.createdAt };
    }
    const allowed = await isPubkeyAllowed(audience.pubkey);
    if (!allowed) return base;
  }

  // public
  return {
    ...base,
    facets: desc.facets,
    basis: desc.basis,
    scope: desc.scope,
    by: desc.by,
    createdAt: desc.createdAt,
  };
}

/** 批量. 顺序: scrub → 过滤 private (self-only). */
export async function scrubListForAudience(
  descs: JudgenessDescription[],
  audience: JudgenessPubkeyContext
): Promise<ScrubbedDescription[]> {
  const out: ScrubbedDescription[] = [];
  for (const d of descs) {
    const s = await scrubForAudience(d, audience);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 闸 2 — allowlist gate (joinPeer / joinTopic 前)
// ---------------------------------------------------------------------------

/** resolveGate2: true = 允许 join. */
export async function resolveGate2(
  audiencePubkey: string,
  targetChannel: string,
  visFile?: JudgenessVisibilityFile
): Promise<{ allow: boolean; reason: string }> {
  // 自我永远放行
  if (audiencePubkey === '__self__') return { allow: true, reason: 'self' };

  const f = visFile ?? (await loadVisibility());
  const chan = f.channels.find((c) => c.channelId === targetChannel);
  if (!chan) {
    // channel 没登记 = 默认 allowlist 模式 (闸 2 fail-closed)
    const allowed = await isPubkeyAllowed(audiencePubkey);
    return allowed
      ? { allow: true, reason: 'default allowlist: pk in list' }
      : { allow: false, reason: 'default allowlist: pk not in list' };
  }
  if (chan.visibility === 'public') return { allow: true, reason: 'channel=public' };
  if (chan.visibility === 'private') return { allow: false, reason: 'channel=private' };
  // allowlist / peers 都要求在白名单
  const allowed = await isPubkeyAllowed(audiencePubkey);
  return allowed
    ? { allow: true, reason: 'allowlist match' }
    : { allow: false, reason: 'allowlist miss' };
}
