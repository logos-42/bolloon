export interface Market {
  id: string;
  question: string;
  slug: string;
  volume: string;
  active: boolean;
  closed: boolean;
}

export async function getMarket(id: string): Promise<Market | null> {
  const { listMarkets } = await import('polymarket-sdk').catch(() => ({ listMarkets: async () => [] }));
  const markets = await listMarkets({ id });
  return markets[0] ?? null;
}