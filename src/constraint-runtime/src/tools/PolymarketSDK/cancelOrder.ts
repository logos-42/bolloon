export interface CancelOrderParams {
  orderId: string;
}

export async function cancelOrder(params: CancelOrderParams): Promise<{ success: boolean; message: string }> {
  return {
    success: false,
    message: 'Polymarket order cancellation requires CLOB client with authentication. Use the Polymarket web interface to cancel orders.',
  };
}