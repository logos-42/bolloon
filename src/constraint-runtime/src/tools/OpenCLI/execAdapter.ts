export interface ExecAdapterParams {
  adapter: string;
  params?: Record<string, any>;
}

export async function execAdapter(params: ExecAdapterParams): Promise<{ success: boolean; result: any; error?: string }> {
  return {
    success: false,
    result: null,
    error: `OpenCLI adapter '${params.adapter}' requires OpenCLI CLI to be installed and configured.`,
  };
}