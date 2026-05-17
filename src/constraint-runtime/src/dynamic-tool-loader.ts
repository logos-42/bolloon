import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

export interface ToolExecutor {
  loadAndExecute(modulePath: string, functionName: string, params: any): Promise<ToolResult>;
}

function resolveToolPath(sourceHint: string): string {
  return path.join(__dirname, sourceHint);
}

function inferFunctionName(sourceHint: string): string {
  const basename = path.basename(sourceHint, path.extname(sourceHint));
  const nameMap: Record<string, string> = {
    listMarkets: 'listMarkets',
    getMarket: 'getMarket',
    createOrder: 'createOrder',
    cancelOrder: 'cancelOrder',
    getOrders: 'getOrders',
    createTransaction: 'createTransaction',
    proposeTransaction: 'proposeTransaction',
    confirmTransaction: 'confirmTransaction',
    executeTransaction: 'executeTransaction',
    getPendingTransactions: 'getPendingTransactions',
    getBalance: 'getBalance',
    deploySafe: 'deploySafe',
    runCommand: 'runCommand',
    listAdapters: 'listAdapters',
    execAdapter: 'execAdapter',
  };
  return nameMap[basename] || basename;
}

export async function executeToolFromSnapshot(
  sourceHint: string,
  params: any
): Promise<ToolResult> {
  try {
    const fullPath = resolveToolPath(sourceHint);
    
    if (!fs.existsSync(fullPath)) {
      return {
        success: false,
        error: `Tool file not found: ${fullPath}`,
      };
    }

    const module = await import(`file://${fullPath}?t=${Date.now()}`);
    const functionName = inferFunctionName(sourceHint);

    if (typeof module[functionName] !== 'function') {
      return {
        success: false,
        error: `Function '${functionName}' not found in ${sourceHint}`,
      };
    }

    const result = await module[functionName](params);

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export class DynamicToolExecutor implements ToolExecutor {
  async loadAndExecute(
    modulePath: string,
    functionName: string,
    params: any
  ): Promise<ToolResult> {
    try {
      const fullPath = resolveToolPath(modulePath);

      if (!fs.existsSync(fullPath)) {
        return { success: false, error: `Module not found: ${fullPath}` };
      }

      const module = await import(`file://${fullPath}?t=${Date.now()}`);

      if (typeof module[functionName] !== 'function') {
        return {
          success: false,
          error: `Function '${functionName}' not exported from ${modulePath}`,
        };
      }

      const result = await module[functionName](params);
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const defaultExecutor = new DynamicToolExecutor();