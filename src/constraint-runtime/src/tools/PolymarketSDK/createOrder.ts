export interface CreateOrderParams {
  marketId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

export async function createOrder(params: CreateOrderParams): Promise<{ success: boolean; message: string }> {
  return {
    success: false,
    message: 'Polymarket order creation requires CLOB client with authentication. Use the Polymarket web interface to create orders.',
  };
}