/**
 * Auto-Evolve Policy — 数据层自动进化统一网关
 *
 * 阶段 A: 数据层自动进化开关
 *
 * 单一事实源: 任何代码路径要"自动"修改 ~/.bolloon/ 下的数据层
 * (judgments.json / persona.json / skills/ / agents.json),
 * 都必须先调 isDataLayerAutoEvolveEnabled() / requireDataLayerAutoEvolve().
 *
 * 设计原则 (类 B 边界 + 8-gate 兼容):
 * - 默认关闭 (fail-closed)
 * - 3 种打开方式,任一为真即开:
 *   1. env BOLLOON_AUTO_EVOLVE_DATA=1
 *   2. ~/.bolloon/self-improve-policy.json dataLayerAutoEvolve: true
 *   3. 类 B 自适应永远只读 (不查此开关) — 它天然不写库
 * - 显式拒绝比默认拒绝多一道 log (审计 trail)
 *
 * 不变量:
 * - 开关仅影响"无用户交互的自动写"路径
 * - 用户在 UI 手动触发 / API 显式 accept 走原始路径, **不查此开关**
 *   (避免阻塞用户的正常接受操作)
 * - 写入被拒绝时, 抛 AutoEvolveDisabledError (调用方选择 catch + fallback)
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const ENV_KEY = 'BOLLOON_AUTO_EVOLVE_DATA';
const POLICY_PATH = () =>
  (os.homedir() || process.env.HOME || '/tmp') + '/.bolloon/self-improve-policy.json';

export class AutoEvolveDisabledError extends Error {
  constructor(reason: string) {
    super(`[auto-evolve] 数据层自动进化已关闭: ${reason}`);
    this.name = 'AutoEvolveDisabledError';
  }
}

interface PolicyFile {
  dataLayerAutoEvolve?: boolean;
  [k: string]: unknown;
}

let cachedPolicy: { value: boolean; checkedAt: number; parsed: PolicyFile | null } | null = null;
const POLICY_TTL_MS = 5_000; // 5s 缓存, 避免每次写都读盘

/**
 * 读 policy.json (带 5s 缓存)
 *
 * 注意: 必须保留完整 parsed 对象 — 调用方需要
 * parsed.dataLayerAutoEvolve 等其他字段做 UI 展示.
 */
async function readPolicyFile(): Promise<PolicyFile | null> {
  if (cachedPolicy && Date.now() - cachedPolicy.checkedAt < POLICY_TTL_MS && cachedPolicy.parsed) {
    return cachedPolicy.parsed;
  }
  try {
    const content = await fs.readFile(POLICY_PATH(), 'utf-8');
    const parsed = JSON.parse(content) as PolicyFile;
    cachedPolicy = {
      value: parsed.dataLayerAutoEvolve === true,
      checkedAt: Date.now(),
      parsed,
    };
    return parsed;
  } catch {
    cachedPolicy = { value: false, checkedAt: Date.now(), parsed: null };
    return null;
  }
}

/**
 * 核心查询: 数据层自动进化是否开启
 *
 * 任一为真:
 * 1. env BOLLOON_AUTO_EVOLVE_DATA=1|true|yes
 * 2. policy.json dataLayerAutoEvolve: true
 *
 * 同步读 env (env 永远先, 政策文件是补充).
 */
export function isDataLayerAutoEvolveEnabledSync(): boolean {
  const env = (process.env[ENV_KEY] || '').toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes') return true;
  return false; // policy 文件需要 async, 同步版只看 env
}

/**
 * 异步版 (含 policy.json): 自动调用方用这个
 */
export async function isDataLayerAutoEvolveEnabled(): Promise<boolean> {
  if (isDataLayerAutoEvolveEnabledSync()) return true;
  const p = await readPolicyFile();
  return p?.dataLayerAutoEvolve === true;
}

/**
 * 硬性护栏: 自动写数据层前必须调, 否则抛错
 *
 * @param caller 写操作的来源 (日志用, e.g. "adaptive-scan.deprecate")
 */
export async function requireDataLayerAutoEvolve(caller: string): Promise<void> {
  const enabled = await isDataLayerAutoEvolveEnabled();
  if (!enabled) {
    throw new AutoEvolveDisabledError(
      `${caller} 尝试自动写数据层, 但 ${ENV_KEY} 未设且 policy.dataLayerAutoEvolve !== true`
    );
  }
  console.log(`[auto-evolve] ✅ 允许自动写 (caller=${caller})`);
}

/**
 * 软性查询 + 日志: 给 UI 状态栏 / 调试用
 */
export async function getAutoEvolveStatus(): Promise<{
  enabled: boolean;
  env: string;
  policyFilePath: string;
  policyValue: boolean | null;
}> {
  const env = process.env[ENV_KEY] || '';
  const envOn = isDataLayerAutoEvolveEnabledSync();
  const p = await readPolicyFile();
  const policyOn = p?.dataLayerAutoEvolve === true;
  return {
    enabled: envOn || policyOn,
    env,
    policyFilePath: POLICY_PATH(),
    policyValue: policyOn,
  };
}

/**
 * 清除 policy 缓存 (测试用 / 实时热改 policy.json 后)
 */
export function clearAutoEvolvePolicyCache(): void {
  cachedPolicy = null;
}
