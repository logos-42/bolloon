/**
 * external-engines/types.ts — 外部编码智能体/工具 类型定义
 *
 * "外部引擎" = 本机已安装的其他 AI 编码工具 (codex / claude code / openclaw /
 * hermes / opencode) 以及实验里已声明的 API. Bolloon 可以:
 *   1. 发现 (discover): 扫描 CLI 是否安装 + 它们的配置文件/环境变量里已有的 API key
 *   2. 配置为供应商 (import): 把发现到的 API key/baseUrl/model 写进 Bolloon 的
 *      LLM provider 体系, 当作普通供应商启用 (用户无需重复填 key)
 *   3. 委派 (delegate): 直接调用这些工具的 CLI, 把编码任务派发给它们当子智能体跑
 */

import type { ModelProvider } from '../llm/config-store.js';

/** 已知引擎 id (实验引擎用 `experiment:<name>` 形式) */
export type EngineId = 'codex' | 'claude-code' | 'openclaw' | 'hermes' | 'opencode' | string;

/** 一次发现结果 */
export interface DiscoveredEngine {
  /** 唯一 id: codex / claude-code / openclaw / hermes / opencode / experiment:<name> */
  id: EngineId;
  /** 展示名 */
  displayName: string;
  /** CLI 二进制是否在 PATH 上 (安装) */
  installed: boolean;
  /** 是否解析到了 apiKey / baseUrl (已配置) */
  configured: boolean;
  /** installed && configured */
  available: boolean;
  /** 检测到的 CLI 绝对路径 */
  cliPath?: string;
  /** 检测到的配置文件路径 */
  configPath?: string;
  /** 映射到的 Bolloon provider (用于 import 成供应商) */
  provider?: ModelProvider;
  /** 解析到的 apiKey (脱敏后对外暴露, 内部保存明文) */
  apiKey?: string;
  /** 解析到的 baseUrl */
  baseUrl?: string;
  /** 解析到的 model */
  model?: string;
  /** 该引擎可用的模型候选列表 (用于 API 配置 UI 的模型筛选下拉) */
  models?: string[];
  /** API 信息来源: env / config / none */
  source: 'env' | 'config' | 'none';
  /** 委派用的非交互式参数模板说明 / 备注 */
  notes?: string;
}

/** 把已发现引擎导入为 Bolloon provider 时产出的 patch */
export interface ProviderImportPatch {
  provider: ModelProvider;
  patch: {
    enabled: boolean;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
}

/** 委派执行结果 */
export interface DelegateResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number | null;
  /** 引擎未安装 / 不可用, 不应重试 */
  unavailable?: boolean;
  /** HMAC 签名委派句柄 (ownerDid 传入时生成; 可验证记录真实性) */
  handle?: import('./delegate-handle.js').DelegateHandle;
}
