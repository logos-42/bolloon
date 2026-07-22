/**
 * external-engines/index.ts — 外部编码智能体 模块 barrel
 *
 * 对外暴露: 发现 (discover) / 配置为供应商映射 (mapEngineToProviderConfig) /
 * 委派 (delegateToEngine) / 类型.
 */

export * from './types.js';
export {
  discoverEngines,
  getEngineSpec,
  buildDelegateArgs,
  mapEngineToProviderConfig,
  parseExperimentFile,
  resolveProvider,
  defaultDeps,
  type DiscoveryDeps,
} from './discovery.js';
export { delegateToEngine, type DelegateOptions } from './delegate.js';
