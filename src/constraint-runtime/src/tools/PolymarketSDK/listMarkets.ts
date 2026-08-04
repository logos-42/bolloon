import { createPublicClient } from '@polymarket/client';

export interface ListMarketsParams {
  limit?: number;
  offset?: number;
  order?: string;
  ascending?: boolean;
  closed?: boolean;
}

export interface Market {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  volume: string;
  active: boolean;
  closed: boolean;
  outcomes: string;
  outcomePrices: string;
}

/**
 * 查询市场列表 (@polymarket/client 统一 SDK, 2026-08-04 迁移).
 * 返回结构与旧 polymarket-sdk 对齐 (id/question/conditionId/slug/volume/active/closed/outcomes/outcomePrices).
 */
export async function listMarkets(params: ListMarketsParams = {}): Promise<Market[]> {
  const client = createPublicClient();
  const pages = client.listMarkets({
    closed: params.closed ?? false,
    pageSize: params.limit ?? 20,
  });
  const page = await pages.firstPage();
  return (page.items || []).map((m: any) => ({
    id: m.id,
    question: m.question,
    conditionId: m.conditionId ?? m.clobTokenIds?.[0] ?? '',
    slug: m.slug,
    volume: m.volume ?? '',
    active: !m.closed,
    closed: m.closed,
    outcomes: Array.isArray(m.outcomes) ? m.outcomes.map((o: any) => o?.name ?? o).join(',') : String(m.outcomes ?? ''),
    outcomePrices: Array.isArray(m.outcomePrices) ? m.outcomePrices.join(',') : String(m.outcomePrices ?? ''),
  }));
}
