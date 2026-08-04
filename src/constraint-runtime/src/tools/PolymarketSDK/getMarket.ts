import { createPublicClient } from '@polymarket/client';

export interface Market {
  id: string;
  question: string;
  slug: string;
  volume: string;
  active: boolean;
  closed: boolean;
}

/** 按市场 id 查询单个市场 (@polymarket/client 统一 SDK, 2026-08-04 迁移). */
export async function getMarket(id: string): Promise<Market | null> {
  const client = createPublicClient();
  const m: any = await client.fetchMarket({ id });
  if (!m) return null;
  return {
    id: m.id,
    question: m.question,
    slug: m.slug,
    volume: m.volume ?? '',
    active: !m.closed,
    closed: m.closed,
  };
}
