/**
 * custom-provider-store.ts — 通用自定义供应商的持久化与迁移 (P3, 2026-09-26)
 *
 * ## 为什么要有这一层
 *
 * "自定义供应商"必须能**落盘、重启后还在、旧配置照样能用**。落盘位置就一个: 与内置供应商同一份
 * 配置文件 (`~/.bolloon/bolloon-config.json`, mode 0600) 里的 `customProviders` 一格 ——
 * 不另开文件, 于是"CLI/Web/子进程读到的是同一份配置"这件事不用再解释一遍。
 *
 * 读写**只**经过 `llmConfigStore` (它已经处理了: 目录变化、文件签名变化、跨进程单飞写锁、
 * 迁移旧文件名)。本层不自己 `fs.writeFile` —— 否则就是第二条写盘路径。
 *
 * ## 向后兼容 (旧 `llm-config.json` 必须原样可用)
 *
 * 旧配置有三种真实形态, 全部在**读**的时候收成规范形 (纯函数在 `provider-registry` 里, 这里只负责
 * 把它接到磁盘数据上), 而且:
 *
 *   1. **一个字都没写** `customProviders` → 空表, 内置 13 家照旧;
 *   2. **早期数组形** `customProviders: [ {...} ]` → 按 `providerId` 收成 map;
 *   3. **只有 provider 条目、没有 customProviders** (旧版本把自定义端点直接写进 `providers.<id>`) →
 *      从 `providers` 里**吸收**成自定义供应商 (协议按 base URL 主机名推), 同时**保留原键不动**。
 *
 * 读的时候**不改盘** (不"读一下就把用户文件改了"); 只有显式 `add/update/remove` 才写回, 写回时
 * 把吸收来的条目一并固化 —— 也就是"用户下一次改配置时, 迁移才落到盘上"。
 *
 * 被拒绝的条目**留名+留理由** (`loadCustomProviders().rejected`), 界面要如实报出来,
 * 不许"读一读就少了两家"。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  llmConfigStore,
} from './config-store.js';
import {
  normalizeCustomProvider,
  normalizeCustomProviders,
  absorbLegacyProviderEntries,
  ensureProviderRegistryMetadataSource,
  isValidCustomProviderId,
  isBuiltinProvider,
  setCustomProviderSnapshot,
  customProviderSnapshot,
  customProviderEntryOf,
  type CustomProviderConfig,
  type ProviderRegistryEntry,
} from './provider-registry.js';

// ============================================================
// 读 (含迁移; 不写盘)
// ============================================================

/** 一次读盘的结果: 规范形 + 走过的迁移 + 被拒绝的条目 */
export interface CustomProviderLoadResult {
  providers: Record<string, CustomProviderConfig>;
  /** 从 `providers.<未知 id>` 吸收来的 (旧版本写法) */
  absorbed: Array<{ providerId: string; protocol: CustomProviderConfig['protocol'] }>;
  /** 形态迁移 (数组 → map 之类) */
  notes: string[];
  /** 规范化时被拒的条目: 留名 + 理由 */
  rejected: Array<{ key: string; reason: string }>;
}

/**
 * 读出**当前在册**的自定义供应商 (规范形), 顺带把进程内快照刷新。
 *
 * 吸收 `providers.<未知 id>` 的那段逻辑与 `config-store.initialize()` **共用同一个纯函数**
 * (`provider-registry.absorbLegacyProviderEntries`), 不存在两处各写一份的漂移。
 */
export async function loadCustomProviders(): Promise<CustomProviderLoadResult> {
  await llmConfigStore.initialize();
  ensureProviderRegistryMetadataSource();   // 读自定义供应商 = 注册表在用 → 顺手接线 (幂等)
  const cfg: any = await llmConfigStore.getConfig();
  const notes: string[] = [];
  // 迁移报告必须对着**盘上原本的样子**做: `config-store` 读盘时已经把那一格收成 map 并丢掉了坏条目
  // (那是运行时视图), 所以这里优先看原文件; 文件读不出来才退回内存视图 (会少掉"拒绝/吸收"这份报告)。
  let rawCustom: unknown = cfg?.customProviders;
  let rawProviders: Record<string, unknown> | undefined = cfg?.providers;
  try {
    const rawFile = JSON.parse(await fs.readFile(llmConfigStore.configFilePath(), 'utf-8'));
    if (rawFile && typeof rawFile === 'object') {
      rawCustom = rawFile.customProviders;
      rawProviders = rawFile.providers;
      if (Array.isArray(rawFile.customProviders)) notes.push('customProviders 是早期数组形 → 已按 providerId 收成 map');
    }
  } catch { /* 文件不在/读不出: 这一条迁移记录就无从谈起, 不编 */ }
  const norm = normalizeCustomProviders(rawCustom);
  const { providers, absorbed } = absorbLegacyProviderEntries(rawProviders, norm.providers);
  if (absorbed.length) {
    notes.push(`从 providers 里吸收 ${absorbed.length} 个自定义端点: ${absorbed.map((a) => a.providerId).join(', ')} (协议按 base URL 主机名推)`);
  }
  setCustomProviderSnapshot(providers);
  return { providers, absorbed, notes, rejected: norm.rejected };
}

/** 只要规范形 (大多数调用方只需要这一个) */
export async function readCustomProviders(): Promise<Record<string, CustomProviderConfig>> {
  return (await loadCustomProviders()).providers;
}

/** 把快照刷新到"配置里现在写的这一份" (调用方在别处改过配置后可以主动调一次) */
export async function refreshCustomProviderSnapshot(): Promise<Record<string, CustomProviderConfig>> {
  return readCustomProviders();
}

/** 进程内快照 (纯同步; 元数据填充点与注册表读口用它) */
export function currentCustomProviders(): Record<string, CustomProviderConfig> {
  return customProviderSnapshot();
}

/**
 * 自定义供应商的注册表条目清单 (同步, 用快照)。
 * 想保证"盘上最新的那一份" → 先 `await refreshCustomProviderSnapshot()`。
 */
export function customProviderEntries(): ProviderRegistryEntry[] {
  return Object.values(customProviderSnapshot()).map((spec) => customProviderEntryOf(spec));
}

// ============================================================
// 写 (显式调用才写; 写前重新读, 避免覆盖别的进程的改动)
// ============================================================

export interface CustomProviderWriteResult {
  ok: boolean;
  /** 失败原因 (人话, 可直接给用户看) */
  reason?: string;
  entry?: ProviderRegistryEntry;
}

/** 校验一条自定义供应商声明 (纯函数; 不读盘不写盘) */
export function validateCustomProvider(spec: CustomProviderConfig): { ok: true } | { ok: false; reason: string } {
  const norm = normalizeCustomProvider(spec);
  if (!norm.ok) return { ok: false, reason: norm.reason };
  if (!isValidCustomProviderId(norm.value.providerId)) {
    return { ok: false, reason: isBuiltinProvider(norm.value.providerId) ? `providerId 与内置供应商撞名: ${norm.value.providerId}` : `providerId 形状非法: ${norm.value.providerId}` };
  }
  const entry = customProviderEntryOf(norm.value);
  if (!entry.defaultBaseUrl) return { ok: false, reason: 'baseUrl 规范化后为空' };
  if (entry.auth.kind === 'custom' && !entry.auth.header) return { ok: false, reason: 'authHeader 给了却是空的' };
  return { ok: true };
}

/** 读出 map → 改 → 整份写回 (走 llmConfigStore 的写锁; 关掉它的内存缓存保证重新读盘) */
async function writeProviders(
  mutate: (providers: Record<string, CustomProviderConfig>) => { providers?: Record<string, CustomProviderConfig>; reason?: string },
): Promise<CustomProviderWriteResult> {
  await llmConfigStore.initialize();
  const loaded = await loadCustomProviders();
  // 读不出来的条目**不许**被一次写入悄悄抹掉: 先让人把配置改对 (拒绝 = 什么都没落盘)
  if (loaded.rejected.length) {
    return {
      ok: false,
      reason: `配置文件里 customProviders 有 ${loaded.rejected.length} 条读不出来 (${loaded.rejected.map((r) => `${r.key}: ${r.reason}`).join('; ')}) — 写回会把这几种写法丢掉, 先修好再改`,
    };
  }
  const out = mutate({ ...loaded.providers });
  if (out.reason) return { ok: false, reason: out.reason };
  if (!out.providers) return { ok: false, reason: '内部错误: mutate 没有给回 providers' };
  // 写盘前**重新读**一次配置, 只覆盖 customProviders 一格 —— 不拿旧快照覆盖别人的改动
  llmConfigStore.invalidate();
  await llmConfigStore.initialize();
  await llmConfigStore.setCustomProviders(out.providers);
  setCustomProviderSnapshot(out.providers);
  return { ok: true };
}

/**
 * 新增 / 覆盖一个自定义供应商。
 *
 * 与内置撞名 → **拒绝** (内置优先保障清单不许被自定义路覆盖), 理由明确返回。
 */
export async function addCustomProvider(spec: CustomProviderConfig): Promise<CustomProviderWriteResult> {
  const norm = normalizeCustomProvider(spec);
  if (!norm.ok) return { ok: false, reason: norm.reason };
  const value = norm.value;
  const check = validateCustomProvider(value);
  if (!check.ok) return { ok: false, reason: check.reason };
  const result = await writeProviders((providers) => {
    providers[value.providerId] = { ...value, updatedAt: new Date().toISOString() };
    return { providers };
  });
  if (!result.ok) return result;
  return { ok: true, entry: customProviderEntryOf(value) };
}

/** 改一个已存在的自定义供应商 (不存在 → 拒绝, 不顺手新建) */
export async function updateCustomProvider(
  providerId: string,
  patch: Partial<CustomProviderConfig>,
): Promise<CustomProviderWriteResult> {
  const id = String(providerId || '').trim();
  const current = await readCustomProviders();
  const existing = current[id];
  if (!existing) return { ok: false, reason: `不在册的自定义供应商: ${id}` };
  const merged = normalizeCustomProvider({ ...existing, ...patch, providerId: id });
  if (!merged.ok) return { ok: false, reason: merged.reason };
  const check = validateCustomProvider(merged.value);
  if (!check.ok) return { ok: false, reason: check.reason };
  const result = await writeProviders((providers) => {
    providers[id] = { ...merged.value, updatedAt: new Date().toISOString() };
    return { providers };
  });
  if (!result.ok) return result;
  return { ok: true, entry: customProviderEntryOf(merged.value) };
}

/** 删一个自定义供应商 (不存在 → 拒绝, 让调用方知道"什么都没删") */
export async function removeCustomProvider(providerId: string): Promise<CustomProviderWriteResult> {
  const id = String(providerId || '').trim();
  const current = await readCustomProviders();
  if (!current[id]) return { ok: false, reason: `不在册的自定义供应商: ${id}` };
  return writeProviders((providers) => {
    delete providers[id];
    return { providers };
  });
}

// ============================================================
// 展示 (凭据**不进**这里)
// ============================================================

/**
 * 打印/上报用的自定义供应商行: key 只留尾 4 位, 其余 `[REDACTED]`。
 * 任何"要把配置显示给人看"的地方都走这里, 不要自己拼 JSON。
 */
export function formatCustomProviderLine(spec: CustomProviderConfig): string {
  const entry = customProviderEntryOf(spec);
  const keyState = spec.apiKey
    ? `key=已配(尾号 ${String(spec.apiKey).slice(-4)})`
    : spec.apiKeyEnvVar
      ? `key=环境变量 ${spec.apiKeyEnvVar}`
      : entry.requiresApiKey ? 'key=缺' : 'key=不需要';
  const bits = [
    `${entry.protocol}`,
    `地址=${entry.defaultBaseUrl}`,
    `模型=${entry.defaultModel || '未设'}`,
    `认证=${entry.auth.kind}${entry.auth.header ? `(${entry.auth.header})` : ''}`,
    `发现=${entry.discovery}`,
    `工具调用=${entry.toolCalling}`,
    keyState,
    entry.allowsLongRunningExecutor ? '可当长期任务执行器' : '不可当长期任务执行器',
  ];
  return `· ${entry.id}${entry.displayName && entry.displayName !== entry.id ? ` (${entry.displayName})` : ''} · ${bits.join(' · ')}`;
}

/**
 * 整份配置的脱敏副本 (给"导出配置/贴报告"用): `apiKey` 一律 `[REDACTED]`。
 * 深拷贝 + 只改凭据字段, 其他字段原样 (不许把别的字段也顺手"整理"了)。
 */
export function redactCustomProviders(map: Record<string, CustomProviderConfig>): Record<string, CustomProviderConfig> {
  const out: Record<string, CustomProviderConfig> = {};
  for (const [id, spec] of Object.entries(map)) {
    out[id] = { ...spec, ...(spec.apiKey ? { apiKey: '[REDACTED]' } : {}) };
  }
  return out;
}

/** 配置文件里 `customProviders` 一格的原始文本 (排障用; 凭据已脱敏) —— 不打印原始文件 */
export async function customProvidersFileSnippet(): Promise<string> {
  const file = llmConfigStore.configFilePath();
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
    const redacted = redactCustomProviders(parsed?.customProviders && typeof parsed.customProviders === 'object' && !Array.isArray(parsed.customProviders) ? parsed.customProviders : {});
    return JSON.stringify({ path: path.basename(file), customProviders: redacted }, null, 2);
  } catch {
    return JSON.stringify({ path: path.basename(file), customProviders: {} }, null, 2);
  }
}
