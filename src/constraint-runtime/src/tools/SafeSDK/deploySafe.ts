export interface DeploySafeParams {
  owners: string[];
  threshold: number;
  saltNonce?: number;
}

export async function deploySafe(params: DeploySafeParams): Promise<{ success: boolean; message: string; safeAddress?: string }> {
  return {
    success: false,
    message: 'Safe deployment requires protocol kit with deployer wallet configured.',
  };
}