/**
 * judgeness · reflect.ts
 *
 * description ↔ HumanJudgment 的双向反射:
 *   - reflectFromJudgment: 给一个 hv-id, 生成或更新对应 jd-id (5 维默认 unset, basis 空)
 *   - mergeIntoJudgment: 给一个 jd-id, 反向把 facets 写到 judgment 的 metadata (附加, 不破坏 v0)
 *
 * 关键不变量: 不动 HumanJudgment 主表 schema. 所有 facets 通过 metadata.judgeness_* 字段挂上.
 * 这样老 v0 数据可被自动视为 judgeness_v0, 零迁移.
 */

import type { HumanJudgment } from '../pi-ecosystem-judgment/human-value-store.js';
import type { JudgenessDescription, JudgenessFacets, JudgenessBasisDot } from './types.js';
import { newDescriptionId, loadDescription, saveDescription, findDescriptionByJudgmentRef } from './store.js';

export interface ReflectFromJudgmentOpts {
  judgment: HumanJudgment;
  by: 'human' | 'agent';
  byAgentId?: string;
  facets?: Partial<JudgenessFacets>;
  basis?: Partial<JudgenessBasisDot>;
  scopeDomains?: string[];
  scopeTopics?: string[];
  visibility?: JudgenessDescription['visibility'];
  openState?: JudgenessDescription['openState'];
}

/** 给定 HumanJudgment, 生成 (或更新) JudgenessDescription.
 *  若已存在同 judgmentRef 的 jd, 则 facets/basis 合并 (覆盖优先). */
export async function reflectFromJudgment(opts: ReflectFromJudgmentOpts): Promise<JudgenessDescription> {
  const existing = await findDescriptionByJudgmentRef(opts.judgment.id);
  const now = new Date().toISOString();

  if (existing) {
    const merged: JudgenessDescription = {
      ...existing,
      facets: { ...existing.facets, ...(opts.facets ?? {}) },
      basis: { ...existing.basis, ...(opts.basis ?? {}) },
      scope: {
        domains: opts.scopeDomains ?? existing.scope.domains,
        topics: opts.scopeTopics ?? existing.scope.topics,
      },
      visibility: opts.visibility ?? existing.visibility,
      openState: opts.openState ?? existing.openState,
      updatedAt: now,
      lastTransitionAt:
        opts.visibility && opts.visibility !== existing.visibility
          ? now
          : opts.openState && opts.openState !== existing.openState
            ? now
            : existing.lastTransitionAt,
    };
    await saveDescription(merged);
    return merged;
  }

  const created: JudgenessDescription = {
    descriptionId: newDescriptionId(),
    judgmentRef: opts.judgment.id,
    description_version: 1,
    facets: {
      judgment: opts.facets?.judgment,
      taste_aesthetic: opts.facets?.taste_aesthetic,
      novelty_score: opts.facets?.novelty_score,
      imaginative_score: opts.facets?.imaginative_score,
      curiosity_vector: opts.facets?.curiosity_vector,
    },
    basis: {
      taste_basis: opts.basis?.taste_basis,
      novelty_basis: opts.basis?.novelty_basis,
      imagination_basis: opts.basis?.imagination_basis,
    },
    scope: { domains: opts.scopeDomains ?? [], topics: opts.scopeTopics ?? [] },
    visibility: opts.visibility ?? 'private',
    openState: opts.openState ?? 'locked',
    by: opts.by,
    byAgentId: opts.byAgentId,
    createdAt: now,
    updatedAt: now,
    lastTransitionAt: now,
  };
  await saveDescription(created);
  return created;
}

/** 反向: 从 jd-id 合成一份 metadata 注入用的字段, 不动 HumanJudgment 主表. */
export function deriveJudgmentMetadataPatch(jdId: string, jd: JudgenessDescription): Record<string, unknown> {
  return {
    judgeness_ref: jdId,
    judgeness_card_version: jd.description_version,
    judgeness_visibility: jd.visibility,
    judgeness_open_state: jd.openState,
  };
}

/** 给一个 hv-id 拿最新 jd (用于 judgment-protocol 的 reflect 钩子).
 *  供 judgment-protocol.ts:463-537 reflect() 在写完 HumanJudgment 后异步触发. */
export async function reflectAfterJudgment(
  judgment: HumanJudgment,
  by: 'human' | 'agent',
  byAgentId?: string
): Promise<JudgenessDescription | null> {
  // 默认: scope=topics 从 context.domain 推出, facets 全 unset.
  return await reflectFromJudgment({
    judgment,
    by,
    byAgentId,
    scopeDomains: [judgment.context.domain],
    scopeTopics: [judgment.context.domain],
    visibility: 'private',
    openState: 'locked',
  });
}

/** 工具: 拿一个 jd, 返回它引用的 hv (供 audit) */
export async function descriptionToJudgmentRef(jdId: string): Promise<string | null> {
  const d = await loadDescription(jdId);
  return d?.judgmentRef ?? null;
}
