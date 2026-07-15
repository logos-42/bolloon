/**
 * judgeness / dual-mode.ts
 *
 * Accept 协商 + JSON-LD 生成.
 *   - 默认 `application/ld+json` 给 agent (头等公民)
 *   - `text/html` 或 `?view=human` 给人类
 *
 * 复用 bolloon 现有 src/web/util/safe-name.ts (兜底防 undefined/null/NaN 渲染).
 */

import type { ScrubbedDescription } from '../../judgeness/visibility.js';

// ---------------------------------------------------------------------------
// Audience 协商
// ---------------------------------------------------------------------------

export type Audience = 'human' | 'agent';

export interface NegotiationInput {
  accept?: string | null | undefined;
  query?: Record<string, string | string[] | undefined>;
  userAgent?: string | null | undefined;
}

const HEARTH_LD_CONTEXT = 'https://judgeness.bolloon.com/schema/v1';

/** 最简 UA 检测: 已知 agent 名 / 字符串里含 'bot'/'agent' 视为 agent.
 *  防御期 placeholder — 反攻期可接 allowlist UA detection. */
function isLikelyAgentUA(ua: string | null | undefined): boolean {
  if (!ua) return false;
  const s = ua.toLowerCase();
  return /bot|agent|crawler|spider/.test(s);
}

export function negotiateAudience(input: NegotiationInput): Audience {
  // ?view=human 显式
  const v = input.query?.['view'];
  if (typeof v === 'string' && v.toLowerCase() === 'human') return 'human';

  const accept = (input.accept ?? '').toLowerCase();
  // text/html 优先
  if (accept.includes('text/html') && !accept.includes('application/ld+json')) return 'human';

  // UA 启发式
  if (isLikelyAgentUA(input.userAgent) && !accept.includes('text/html')) return 'agent';

  // 缺省: agent (头等公民)
  return 'agent';
}

// ---------------------------------------------------------------------------
// JSON-LD 生成
// ---------------------------------------------------------------------------

export interface LdEntity {
  '@context': string;
  '@type': string;
  '@id': string;
  name: string;
  description?: string;
  facets?: ScrubbedDescription['facets'];
  scope?: ScrubbedDescription['scope'];
  visibility?: string;
  openState?: string;
  by?: string;
  createdAt?: string;
}

export function descriptionToJsonLd(d: ScrubbedDescription): LdEntity {
  return {
    '@context': HEARTH_LD_CONTEXT,
    '@type': 'JudgenessDescription',
    '@id': `urn:judgeness:description:${d.descriptionId}`,
    name: `Description ${d.descriptionId}`,
    description: `Judgment ref: ${d.judgmentRef}`,
    facets: d.facets,
    scope: d.scope,
    visibility: d.visibility,
    openState: d.openState,
    by: d.by,
    createdAt: d.createdAt,
  };
}

// ---------------------------------------------------------------------------
// HTML 渲染 (人类视图, 极简, 防 XSS escape)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderHumanHtml(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

export function descriptionToHumanHtml(d: ScrubbedDescription): string {
  const facetsLines = d.facets
    ? Object.entries(d.facets)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `<li>${escapeHtml(k)}: ${escapeHtml(String(v))}</li>`)
        .join('')
    : '<li>(no facets visible at your access level)</li>';
  const body = `<section><h2>Description ${escapeHtml(d.descriptionId)}</h2><p>Judgment ref: <code>${escapeHtml(d.judgmentRef)}</code></p><ul>${facetsLines}</ul><p>visibility: <strong>${escapeHtml(d.visibility)}</strong> · openState: <strong>${escapeHtml(d.openState)}</strong></p></section>`;
  return renderHumanHtml(`Hearth · ${d.descriptionId}`, body);
}

// ---------------------------------------------------------------------------
// 顶层 dispatch (route handler 调用)
// ---------------------------------------------------------------------------

export interface RenderResult {
  status: number;
  contentType: string;
  body: string;
}

export function dualRender(
  input: NegotiationInput,
  humanHtml: () => string,
  jsonLdProducer: () => unknown
): RenderResult {
  const aud = negotiateAudience(input);
  if (aud === 'human') {
    return { status: 200, contentType: 'text/html; charset=utf-8', body: humanHtml() };
  }
  const obj = jsonLdProducer();
  return {
    status: 200,
    contentType: 'application/ld+json; charset=utf-8',
    body: JSON.stringify(obj),
  };
}

export function dualRenderList<T>(
  input: NegotiationInput,
  humanHtmlProducer: () => string,
  jsonLdProducer: () => T[]
): RenderResult {
  return dualRender(input, humanHtmlProducer, () => jsonLdProducer());
}
