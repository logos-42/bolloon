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

export async function listMarkets(params: ListMarketsParams = {}): Promise<Market[]> {
  const { listMarkets: marketsFn } = await import('polymarket-sdk').catch(() => ({ listMarkets: async () => [] }));
  return marketsFn(params);
}