/**
 * provider-catalog.ts — 「供应商目录」运行时 (目录驱动, 2026-09-27)
 *
 * ## 这一层解决什么
 *
 * 供应商此前是**一家一家手写**进代码的 (内置 13 家), 加一家要改表、改类型、改白名单。
 * 本层把公开模型目录收成一份**只含公共元数据**的数据, 由运行时读它 —— 于是
 * **新家只要在目录里就自动可用, 不需要改代码**。
 *
 * 数据来自公开源 `https://models.dev/api.json` (由 `scripts/gen-provider-catalog.ts` 取),
 * 有两条来路:
 *
 *   ① **构建期烘焙** (`src/llm/data/provider-catalog-baked.ts`, 编译器带进 dist)
 *      —— 离线可用, 永远有一份能用的目录;
 *   ② **运行期拉最新** (`${BOLLOON_HOME:-~/.bolloon}/provider-catalog.json`, mode 0600)
 *      —— 由 `refreshProviderCatalog()` 真取一次公开源后落盘, 记
 *      `sourceUrl` / `sourceBytes` / `sourceSha256` / `fetchedAt` / 家数。
 *
 * 两者走**同一个**规范化器 (`normalizeCatalogData`), 运行期文件合法且比烘焙数据新才覆盖它;
 * 文件坏了 → 保留烘焙数据 + 把问题如实记在 `warnings` 里 (不静默拿旧的当新的:
 * `catalogStatusLine()` 会把**这份目录是几号生成的、新不新、来自哪**打出来)。
 *
 * ## 只信目录里字面写着的东西 (铁律)
 *
 *   · **无 api 基址 → 空** (`hasBaseUrl=false` + "需自定义 baseUrl"), 不许编一个地址;
 *   · **能力字段** (`toolCalling` / `reasoning` / `contextLength`) 只填目录里字面声明过的
 *     (`tool_call` / `reasoning` / `limit.context`), 其余一律 `unknown` (不出现在填充结果里);
 *   · **鉴权形状 `special`** (AWS / Azure / GCP 服务账号 / 多变量云凭证) → **如实标"需专用鉴权
 *     (未支持)"**, `speakable=false`, 不许假装能用;
 *   · 环境变量只存**名字**, 永不取值 —— 本层不读 key 值, 不打印, 不落盘。
 *
 * ## 协议族是**少数几个**, 从目录推导 (不是 223 个分支)
 *
 * `familyOfProvider()` 按 `npm` 包名 + `api` 形状把 223 家收成四族:
 * `openai-compatible` / `anthropic` / `gemini` / `special`。判定用的信号在
 * `CatalogProviderView.familySignal` 里逐家可查 (不许只给结论不给理由)。
 *
 * ## 与其它层的关系 (依赖方向, 不许成环)
 *
 * ```
 * config-store → provider-registry → provider-catalog → model-catalog
 * model-discovery → {provider-registry, model-catalog, provider-catalog}
 * ```
 *
 * 本层**不**静态 import provider-registry / config-store (那会成环, 且历史上撞过 TDZ):
 * 运行期文件的目录路径与读写在**异步**路径里动态 import; 同步读口只吃进程内快照。
 * 「真发现的目录是否已覆盖这条模型」由发现层用 `setLiveFactsProbe()` **注入**一个判定函数
 * (方向是 discovery → catalog, 不成环), 于是 live/cached 的字面事实优先于目录快照。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { PROVIDER_CATALOG_JSON } from './data/provider-catalog-baked.js';
import {
  registerModelMetadataSource,
  listModelMetadataSources,
  type Capability,
  type ModelCapabilityFacts,
  type ModelMetadataSource,
} from './model-catalog.js';

// ============================================================
// 常量
// ============================================================

/** 公开源 (数据从这里取; 换源要显式 `--url`) */
export const CATALOG_SOURCE_URL = 'https://models.dev/api.json';

/** 运行期目录文件名 (落在配置目录, mode 0600) */
export const CATALOG_FILE_NAME = 'provider-catalog.json';

/** 数据格式版本 */
export const CATALOG_VERSION = 1;

/** 超过这么多天算陈旧 (界面要如实标, 不许静默拿旧的当新的) */
export const CATALOG_STALE_AFTER_DAYS = 30;

/** 元数据填充点 id */
export const CATALOG_METADATA_SOURCE_ID = 'provider-catalog';

/** 家数下限: 低于它认为这份数据不可信 (截断/被拦/被换成别的东西) */
export const MIN_PROVIDERS_FOR_TRUST = 100;

/** 允许出现的协议族 (少数几个; 加族要改这里并说明理由) */
export const CATALOG_FAMILIES = ['openai-compatible', 'anthropic', 'gemini', 'special'] as const;
export type CatalogFamily = (typeof CATALOG_FAMILIES)[number];

// ============================================================
// 数据形状
// ============================================================

/** 模型上**字面声明过**的能力 (没声明的键不出现) */
export interface CatalogModelFacts {
  name?: string;
  toolCalling?: boolean;
  reasoning?: boolean;
  contextLength?: number;
}

/** 目录里的一家 (只含公开元数据) */
export interface CatalogProviderRecord {
  id: string;
  name: string;
  /** 环境变量**名** (永不取值) */
  env: string[];
  npm: string;
  /** api 基址; **空串 = 目录里没给** (不许编) */
  api: string;
  doc: string;
  models: Record<string, CatalogModelFacts>;
}

/** 这份数据从哪来 / 什么时候取的 (可核事实) */
export interface CatalogProvenance {
  sourceUrl: string;
  sourceBytes: number;
  sourceSha256: string;
  fetchedAt: string;
  sourceProviderCount: number;
}

/** 目录数据文件 (烘焙与运行期同一个形状) */
export interface ProviderCatalogData {
  version: number;
  generatedAt: string;
  generatedBy: string;
  provenance: CatalogProvenance;
  providerCount: number;
  providers: Record<string, CatalogProviderRecord>;
}

/** 鉴权形状 */
export type CatalogAuthKind = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'special' | 'none';

export interface CatalogAuthShape {
  kind: CatalogAuthKind;
  /** 从哪个环境变量名读凭据 (special/none 时可能没有) */
  envVar?: string;
  /** 人话说明 (special 时必须写清为什么) */
  note: string;
  /** 本运行时能不能按这个形状把请求发出去 */
  supported: boolean;
}

/** 运行时视图 (调用方只读这个形状) */
export interface CatalogProviderView {
  id: string;
  name: string;
  env: string[];
  npm: string;
  /** api 基址; `''` = 目录里没给 */
  api: string;
  doc: string;
  modelIds: string[];
  models: Record<string, CatalogModelFacts>;
  family: CatalogFamily;
  /** 判成这一族的信号 (逐家可查, 不许只给结论) */
  familySignal: string;
  auth: CatalogAuthShape;
  hasBaseUrl: boolean;
  /** 本运行时能不能真打这一家 (有基址 + 鉴权形状受支持) */
  speakable: boolean;
  /** 不能用的原因 (人话; 能用时 `null`) */
  unusableReason: string | null;
}

/** 一次加载的结论 */
export interface CatalogLoad {
  data: ProviderCatalogData;
  /** 这份目录从哪来 */
  source: 'bundled' | 'runtime';
  /** 运行期文件路径 (`bundled` 时 `null`) */
  path: string | null;
  provenance: CatalogProvenance;
  generatedAt: string;
  /** 数据生成时间距现在多少天 (可为小数; 未来时间 → 0) */
  ageDays: number;
  stale: boolean;
  warnings: string[];
}

export interface CatalogStats {
  providers: number;
  withApi: number;
  withoutApi: number;
  envNamed: number;
  models: number;
  /** 逐族的家数 */
  families: Record<CatalogFamily, number>;
  /** 需专用鉴权 (未支持) 的家数 */
  specialAuth: number;
  /** 无 api 基址 (需自定义 baseUrl) 的家数 */
  noBaseUrl: number;
  /** 有基址 + 鉴权受支持 (本运行时真能打) 的家数 */
  speakable: number;
}

export interface CatalogRefreshReport {
  ok: boolean;
  /** 源 URL */
  sourceUrl: string;
  /** 源字节数 (真取到的) */
  sourceBytes: number;
  sourceSha256: string;
  fetchedAt: string;
  providerCount: number;
  modelCount: number;
  /** 落盘路径 */
  path: string;
  /** 落盘文件的权限 (八进制字符串, 如 '600') */
  fileMode: string;
  /** 出错时的原因 (人话) */
  error?: string;
  notes: string[];
  stats: CatalogStats;
}

// ============================================================
// 规范化 (烘焙数据与运行期文件走**同一个**器)
// ============================================================

export type CatalogParse =
  | { ok: true; value: ProviderCatalogData }
  | { ok: false; reason: string };

function pickStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function pickNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function normalizeFacts(raw: unknown): CatalogModelFacts {
  const out: CatalogModelFacts = {};
  if (!raw || typeof raw !== 'object') return out;
  const m = raw as Record<string, unknown>;
  const name = pickStr(m.name);
  if (name) out.name = name;
  if (typeof m.toolCalling === 'boolean') out.toolCalling = m.toolCalling;
  if (typeof m.reasoning === 'boolean') out.reasoning = m.reasoning;
  if (typeof m.contextLength === 'number' && Number.isFinite(m.contextLength) && m.contextLength > 0) {
    out.contextLength = Math.floor(m.contextLength);
  }
  return out;
}

/**
 * 规范化一份目录数据 (纯函数)。**不补默认值**: 缺字段就按缺处理, 形状不对就明确拒绝。
 *
 * 运行期文件是用户可改的 (在 `~/.bolloon/` 里), 所以这里对每个字段都做形状检查;
 * 坏数据唯一的后果是"退回烘焙数据 + 一条 warning", 不是"带着半份目录继续跑"。
 */
export function normalizeCatalogData(raw: unknown): CatalogParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '不是对象 (目录数据是一个「一家一个键」的对象)' };
  }
  const r = raw as Record<string, any>;
  const version = pickNum(r.version);
  if (version !== CATALOG_VERSION) {
    return { ok: false, reason: `版本 ${String(r.version)} ≠ ${CATALOG_VERSION} (不认识的形状不当成数据)` };
  }
  const providersRaw = r.providers;
  if (!providersRaw || typeof providersRaw !== 'object' || Array.isArray(providersRaw)) {
    return { ok: false, reason: 'providers 不是对象' };
  }
  const providers: Record<string, CatalogProviderRecord> = {};
  for (const [key, val] of Object.entries(providersRaw as Record<string, unknown>)) {
    const id = String(key || '').trim();
    if (!id || !val || typeof val !== 'object') continue;
    const p = val as Record<string, any>;
    const modelsRaw = p.models && typeof p.models === 'object' && !Array.isArray(p.models) ? (p.models as Record<string, unknown>) : {};
    const models: Record<string, CatalogModelFacts> = {};
    for (const [mid, m] of Object.entries(modelsRaw)) {
      const id2 = String(mid || '').trim();
      if (!id2) continue;
      models[id2] = normalizeFacts(m);
    }
    providers[id] = {
      id: pickStr(p.id) || id,
      name: pickStr(p.name) || id,
      env: Array.isArray(p.env) ? p.env.filter((e: unknown) => typeof e === 'string' && String(e).trim()).map((e: unknown) => String(e).trim()) : [],
      npm: pickStr(p.npm),
      api: pickStr(p.api),
      doc: pickStr(p.doc),
      models,
    };
  }
  const count = Object.keys(providers).length;
  if (count === 0) return { ok: false, reason: 'providers 是空的 (空目录不当成一份目录)' };
  const prov = r.provenance && typeof r.provenance === 'object' ? (r.provenance as Record<string, any>) : {};
  return {
    ok: true,
    value: {
      version: CATALOG_VERSION,
      generatedAt: pickStr(r.generatedAt) || pickStr(prov.fetchedAt),
      generatedBy: pickStr(r.generatedBy) || 'unknown',
      provenance: {
        sourceUrl: pickStr(prov.sourceUrl),
        sourceBytes: pickNum(prov.sourceBytes),
        sourceSha256: pickStr(prov.sourceSha256),
        fetchedAt: pickStr(prov.fetchedAt),
        sourceProviderCount: pickNum(prov.sourceProviderCount),
      },
      providerCount: count,
      providers,
    },
  };
}

/**
 * 目录数据 → 规范 JSON 文本 (**唯一**的写出格式: 运行期落盘与构建期产物都用它)。
 *
 * 格式选择: 头字段缩进可读, 每家**一行** (带全部模型) —— 于是 `git diff` 一眼看出"哪几家变了",
 * 而文件又不会因为上万个模型各自换行而膨胀。
 */
export function renderCatalogJson(data: ProviderCatalogData): string {
  const head = {
    version: data.version,
    generatedAt: data.generatedAt,
    generatedBy: data.generatedBy,
    provenance: data.provenance,
    providerCount: data.providerCount,
  };
  const out: string[] = ['{'];
  const headLines = JSON.stringify(head, null, 2).split('\n').slice(1, -1);
  // 头字段后面还有 `providers`, 所以**最后一行必须补逗号** —— 少这个逗号就是一份坏 JSON
  // (2026-09-27 真踩过: 直接读这个文件的门会 JSON.parse 报错)。
  headLines.forEach((l, i) => out.push(i === headLines.length - 1 ? `${l},` : l));
  out.push('  "providers": {');
  const ids = Object.keys(data.providers).sort();
  ids.forEach((id, i) => {
    const rec = data.providers[id];
    out.push(`    ${JSON.stringify(id)}: ${JSON.stringify(rec)}${i === ids.length - 1 ? '' : ','}`);
  });
  out.push('  }');
  out.push('}');
  const text = out.join('\n') + '\n';
  // **自校验**: 写出去的必须是能读回来的 JSON (格式自检, 不靠"看着像")
  const back = JSON.parse(text) as ProviderCatalogData;
  if (back.providerCount !== data.providerCount || Object.keys(back.providers || {}).length !== Object.keys(data.providers).length) {
    throw new Error('renderCatalogJson 自校验失败: 读回来的家数对不上');
  }
  return text;
}

// ============================================================
// 公开源 → 目录数据 (纯函数; 构建期烘焙与运行期刷新**同一份**实现)
// ============================================================

/** 源里一条模型 → 事实 (只认字面字段; 字符串 "true"/0/负数一律不认) */
export function factsOfModelRecord(raw: unknown): CatalogModelFacts {
  const out: CatalogModelFacts = {};
  if (!raw || typeof raw !== 'object') return out;
  const m = raw as Record<string, unknown>;
  const name = pickStr(m.name);
  if (name) out.name = name;
  if (typeof m.tool_call === 'boolean') out.toolCalling = m.tool_call;
  if (typeof m.reasoning === 'boolean') out.reasoning = m.reasoning;
  const limit = m.limit && typeof m.limit === 'object' ? (m.limit as Record<string, unknown>) : null;
  const ctx = limit ? limit.context : undefined;
  if (typeof ctx === 'number' && Number.isFinite(ctx) && ctx > 0) out.contextLength = Math.floor(ctx);
  return out;
}

/** 源里一家 → 目录记录 (纯函数) */
export function toCatalogProviderRecord(id: string, raw: unknown): CatalogProviderRecord {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const env = Array.isArray(p.env)
    ? p.env.filter((e) => typeof e === 'string' && String(e).trim()).map((e) => String(e).trim())
    : [];
  const modelsRaw = p.models && typeof p.models === 'object' && !Array.isArray(p.models)
    ? (p.models as Record<string, unknown>)
    : {};
  const models: Record<string, CatalogModelFacts> = {};
  for (const [mid, m] of Object.entries(modelsRaw)) {
    const key = String(mid || '').trim();
    if (!key) continue;
    models[key] = factsOfModelRecord(m);
  }
  return {
    id: pickStr(p.id) || id,
    name: pickStr(p.name) || pickStr(p.id) || id,
    env,
    npm: pickStr(p.npm),
    // 目录里没有 api → **空串** (不许顺手补一个默认地址)
    api: pickStr(p.api),
    doc: pickStr(p.doc),
    models,
  };
}

/**
 * 整个源 → 目录数据 (纯函数; 排序稳定: 家与模型都按 id 字典序)。
 *
 * 形状不认就**抛错拒绝**, 不猜 (调用方决定是"拒绝落盘"还是"报错不采用")。
 */
export function buildCatalogData(
  raw: unknown,
  provenance: CatalogProvenance,
  generatedAt: string,
): ProviderCatalogData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('源不是「一家一个键」的对象 → 拒绝生成 (不猜形状)');
  }
  const src = raw as Record<string, unknown>;
  const ids = Object.keys(src).sort();
  const providers: Record<string, CatalogProviderRecord> = {};
  for (const id of ids) {
    const rec = toCatalogProviderRecord(id, src[id]);
    const sortedModels: Record<string, CatalogModelFacts> = {};
    for (const mid of Object.keys(rec.models).sort()) sortedModels[mid] = rec.models[mid];
    providers[id] = { ...rec, models: sortedModels };
  }
  return {
    version: CATALOG_VERSION,
    generatedAt,
    generatedBy: 'scripts/gen-provider-catalog.ts',
    provenance: { ...provenance, sourceProviderCount: ids.length },
    providerCount: ids.length,
    providers,
  };
}

// ============================================================
// 协议族 / 鉴权形状 (少数几个族, 从目录推导)
// ============================================================

/** npm 包名 → 协议族 (只列**有把握**的; 其余落到 openai-compatible 或 special, 见下) */
const FAMILY_BY_NPM: Array<{ match: RegExp; family: CatalogFamily; signal: string }> = [
  { match: /amazon-bedrock/i, family: 'special', signal: 'npm 指明是 Amazon Bedrock (AWS SigV4 / 专用凭证)' },
  { match: /@ai-sdk\/azure/i, family: 'special', signal: 'npm 指明是 Azure (端点 + api-version + api-key 组合)' },
  { match: /google-vertex/i, family: 'special', signal: 'npm 指明是 Google Vertex (GCP 服务账号 / OAuth)' },
  { match: /@ai-sdk\/anthropic/i, family: 'anthropic', signal: 'npm 指明是 Anthropic 客户端' },
  { match: /@ai-sdk\/google$/i, family: 'gemini', signal: 'npm 指明是 Google Generative AI 客户端' },
  { match: /sap-ai-provider/i, family: 'special', signal: 'npm 指明是 SAP AI Core (OAuth 换 token)' },
  { match: /watsonx/i, family: 'special', signal: 'npm 指明是 IBM watsonx (apiKey + projectId)' },
  { match: /gitlab/i, family: 'special', signal: 'npm 指明是 GitLab (instance + token 组合)' },
];

/** 环境变量名里的"云凭证味道" —— 出现即判 special (要多个变量/要走云签名, 不是一个 Bearer 的事) */
const CLOUD_ENV_SIGNALS: Array<{ match: RegExp; signal: string }> = [
  { match: /^AWS_/, signal: '环境变量是 AWS 签名凭证 (AWS_*)' },
  { match: /^AZURE_/, signal: '环境变量是 Azure 资源名 + key 组合 (AZURE_*)' },
  { match: /^GOOGLE_APPLICATION_CREDENTIALS$|^GOOGLE_VERTEX_/, signal: '环境变量是 GCP 服务账号 / Vertex 项目 (GOOGLE_*)' },
  { match: /^WATSONX_/, signal: '环境变量是 watsonx 的 apiKey + projectId' },
  { match: /^DATABRICKS_/, signal: '环境变量是 Databricks host + token 组合' },
  { match: /^SNOWFLAKE_/, signal: '环境变量是 Snowflake account + PAT 组合' },
  { match: /^CLOUDFLARE_(ACCOUNT_ID|GATEWAY_ID)$/, signal: '环境变量是 Cloudflare 账号/网关 id (不止一个 key)' },
  { match: /^(.*_)?ENDPOINT$/, signal: '环境变量里有端点地址 (不是单纯的 key)' },
  { match: /_PROJECT_ID$|_PRODUCT_ID$|^INFOMANIAK_/, signal: '环境变量里有项目/产品 id (不是单纯的 key)' },
];

/**
 * 一家的协议族 (纯函数)。
 *
 * 判定顺序: ① npm 包名 (最明确); ② 环境变量形状 (云凭证味道 → special); ③ 默认 openai-compatible。
 * `special` 不是"猜不到", 而是"**本运行时不支持这种鉴权形状**" —— 界面上如实标出来, 不当可用。
 */
export function familyOfProvider(rec: CatalogProviderRecord): { family: CatalogFamily; signal: string } {
  for (const rule of FAMILY_BY_NPM) {
    if (rec.npm && rule.match.test(rec.npm)) return { family: rule.family, signal: rule.signal };
  }
  for (const sig of CLOUD_ENV_SIGNALS) {
    const hit = rec.env.find((e) => sig.match.test(e));
    if (hit) return { family: 'special', signal: `${sig.signal} (命中 ${hit})` };
  }
  if (rec.npm) return { family: 'openai-compatible', signal: `npm ${rec.npm} 走 OpenAI 兼容形状 (目录里没有别的声明)` };
  return { family: 'openai-compatible', signal: '目录里没给 npm 包名 → 按 OpenAI 兼容形状处理 (可被 --base-url 覆盖)' };
}

/**
 * 鉴权形状 (纯函数)。
 *
 * `special` 的家**没有**单一的 key 变量可用 (或需要云签名/多变量), 所以 `supported=false`,
 * 理由写在 `note` 里 —— 界面直接打这句, 不许假装能用。
 */
export function authShapeOfProvider(rec: CatalogProviderRecord, family: CatalogFamily, signal: string): CatalogAuthShape {
  const first = rec.env[0];
  if (family === 'special') {
    return {
      kind: 'special',
      ...(first ? { envVar: first } : {}),
      note: `需专用鉴权 (未支持): ${signal}`,
      supported: false,
    };
  }
  if (!rec.env.length) {
    return { kind: 'none', note: '目录里没给环境变量名 → 凭据无从读起 (需自定义凭据)', supported: false };
  }
  if (family === 'anthropic') {
    return { kind: 'x-api-key', envVar: first, note: `x-api-key 头 (读环境变量 ${first})`, supported: true };
  }
  if (family === 'gemini') {
    return { kind: 'x-goog-api-key', envVar: first, note: `x-goog-api-key 头 / ?key= (读环境变量 ${first})`, supported: true };
  }
  return { kind: 'bearer', envVar: first, note: `Authorization: Bearer (读环境变量 ${first})`, supported: true };
}

/** 目录数据 → 运行时视图 (纯函数; 逐家带上族/信号/鉴权/能不能用) */
export function buildCatalogViews(data: ProviderCatalogData): CatalogProviderView[] {
  return Object.keys(data.providers).sort().map((id) => {
    const rec = data.providers[id];
    const { family, signal } = familyOfProvider(rec);
    const auth = authShapeOfProvider(rec, family, signal);
    const hasBaseUrl = !!rec.api;
    const modelIds = Object.keys(rec.models).sort();
    const unusableReason = !auth.supported
      ? auth.note
      : (!hasBaseUrl ? '目录里这家没有 api 基址 → 需自定义 baseUrl' : null);
    return {
      id,
      name: rec.name,
      env: [...rec.env],
      npm: rec.npm,
      api: rec.api,
      doc: rec.doc,
      modelIds,
      models: rec.models,
      family,
      familySignal: signal,
      auth,
      hasBaseUrl,
      speakable: auth.supported && hasBaseUrl,
      unusableReason,
    };
  });
}

// ============================================================
// 进程内快照 (同步读口的唯一数据源)
// ============================================================

/** 烘焙数据: 模块体里只解析**一次**的形状检查 (不做任何 I/O) */
function parseBaked(): CatalogParse {
  try {
    return normalizeCatalogData(JSON.parse(PROVIDER_CATALOG_JSON));
  } catch (e: any) {
    return { ok: false, reason: `烘焙数据不是合法 JSON: ${String(e?.message || e)}` };
  }
}

const bakedParse = parseBaked();

function emptyData(reason: string): ProviderCatalogData {
  return {
    version: CATALOG_VERSION,
    generatedAt: '',
    generatedBy: 'unavailable',
    provenance: { sourceUrl: CATALOG_SOURCE_URL, sourceBytes: 0, sourceSha256: '', fetchedAt: '', sourceProviderCount: 0 },
    providerCount: 0,
    providers: {},
  };
}

let snapshot: CatalogLoad = bakedParse.ok
  ? {
    data: bakedParse.value,
    source: 'bundled',
    path: null,
    provenance: bakedParse.value.provenance,
    generatedAt: bakedParse.value.generatedAt,
    ageDays: ageDaysOf(bakedParse.value),
    stale: ageDaysOf(bakedParse.value) > CATALOG_STALE_AFTER_DAYS,
    warnings: [],
  }
  : {
    data: emptyData(bakedParse.reason),
    source: 'bundled',
    path: null,
    provenance: { sourceUrl: CATALOG_SOURCE_URL, sourceBytes: 0, sourceSha256: '', fetchedAt: '', sourceProviderCount: 0 },
    generatedAt: '',
    ageDays: 0,
    stale: true,
    warnings: [`烘焙目录数据不可用: ${bakedParse.reason}`],
  };

let views: CatalogProviderView[] = buildCatalogViews(snapshot.data);
let viewsById: Map<string, CatalogProviderView> = new Map(views.map((v) => [v.id, v]));
let runtimePath: string | null = null;

function ageDaysOf(data: ProviderCatalogData, nowMs = Date.now()): number {
  const t = Date.parse(data.provenance.fetchedAt || data.generatedAt);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - t) / 86_400_000);
}

function applySnapshot(next: CatalogLoad): CatalogLoad {
  snapshot = next;
  views = buildCatalogViews(snapshot.data);
  viewsById = new Map(views.map((v) => [v.id, v]));
  return snapshot;
}

/** 当前这份目录的加载结论 (同步; 含来源/生成时间/陈旧标记) */
export function catalogLoad(): CatalogLoad {
  return snapshot;
}

/** 当前目录的全部家 (同步; 按 id 排序) */
export function catalogProviders(): CatalogProviderView[] {
  return views;
}

/** 当前目录的家 id (同步; 按 id 排序) */
export function catalogProviderIds(): string[] {
  return views.map((v) => v.id);
}

/** 一家的视图 (不在目录里 → `undefined`, 不编) */
export function getCatalogProvider(id: string): CatalogProviderView | undefined {
  return viewsById.get(String(id || '').trim());
}

/** 某家某模型在目录里**字面声明过**的事实 (没有 → `undefined`) */
export function catalogModelFactsOf(provider: string, model: string): CatalogModelFacts | undefined {
  return getCatalogProvider(provider)?.models[String(model || '')];
}

/** 目录统计 (全部从当前目录真算) */
export function catalogStats(): CatalogStats {
  const families: Record<CatalogFamily, number> = { 'openai-compatible': 0, anthropic: 0, gemini: 0, special: 0 };
  let withApi = 0, envNamed = 0, models = 0, specialAuth = 0, noBaseUrl = 0, speakable = 0;
  for (const v of views) {
    families[v.family] = (families[v.family] || 0) + 1;
    if (v.hasBaseUrl) withApi++; else noBaseUrl++;
    if (v.env.length) envNamed++;
    models += v.modelIds.length;
    if (!v.auth.supported) specialAuth++;
    if (v.speakable) speakable++;
  }
  return {
    providers: views.length,
    withApi,
    withoutApi: views.length - withApi,
    envNamed,
    models,
    families,
    specialAuth,
    noBaseUrl,
    speakable,
  };
}

/** 清掉进程内快照对运行期文件的记忆 (测试用; 生产路径不调用) */
export function resetProviderCatalogSnapshot(): void {
  runtimePath = null;
  applySnapshot(bakedParse.ok
    ? {
      data: bakedParse.value,
      source: 'bundled',
      path: null,
      provenance: bakedParse.value.provenance,
      generatedAt: bakedParse.value.generatedAt,
      ageDays: ageDaysOf(bakedParse.value),
      stale: ageDaysOf(bakedParse.value) > CATALOG_STALE_AFTER_DAYS,
      warnings: [],
    }
    : snapshot);
}

// ============================================================
// 运行期文件 (读: 异步 + 动态 import 配置目录; 同步读口只吃快照)
// ============================================================

/** 配置目录 (`BOLLOON_HOME` 与配置存储同一处 —— **调用时**解析, 不静态 import 它以免成环) */
async function configDirPath(): Promise<string> {
  const mod: any = await import('./config-store.js');
  return String(mod.llmConfigStore.configDirPath());
}

/** 运行期目录文件路径 (异步: 需要配置目录) */
export async function catalogFilePath(): Promise<string> {
  return path.join(await configDirPath(), CATALOG_FILE_NAME);
}

/** 已经读进来的运行期文件路径 (还没读过 → `null`; 展示用) */
export function loadedCatalogPath(): string | null {
  return runtimePath;
}

/**
 * 读一次运行期文件并（在合法且更新时）覆盖进程内快照。
 *
 * 规矩:
 *   · 文件不在 → 保持烘焙数据 (这不是错误, 是"还没拉过最新");
 *   · 文件坏了/版本不认识/家数少得不合理 → **保持烘焙数据** + warning (不许带着半份目录跑);
 *   · 文件合法但**不比现在的新** → 保持现在这份 (防止用旧文件盖掉更新的内存数据), 记 warning。
 */
export async function initializeProviderCatalog(opts: { force?: boolean } = {}): Promise<CatalogLoad> {
  if (runtimePath && !opts.force) return snapshot;
  let file: string;
  try {
    file = await catalogFilePath();
  } catch (e: any) {
    return applySnapshot({ ...snapshot, warnings: [...snapshot.warnings, `拿不到配置目录 → 用烘焙目录 (${String(e?.message || e)})`] });
  }
  runtimePath = file;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return snapshot;   // 还没拉过最新: 保持烘焙数据 (不是错误)
  }
  const warnings = [...snapshot.warnings];
  let parsed: CatalogParse;
  try {
    parsed = normalizeCatalogData(JSON.parse(text));
  } catch (e: any) {
    warnings.push(`运行期目录文件不是合法 JSON → 用烘焙目录 (${String(e?.message || e)})`);
    return applySnapshot({ ...snapshot, warnings });
  }
  if (!parsed.ok) {
    warnings.push(`运行期目录文件被忽略: ${parsed.reason} → 用烘焙目录`);
    return applySnapshot({ ...snapshot, warnings });
  }
  if (parsed.value.providerCount < MIN_PROVIDERS_FOR_TRUST) {
    warnings.push(`运行期目录只有 ${parsed.value.providerCount} 家 (< ${MIN_PROVIDERS_FOR_TRUST}) → 用烘焙目录 (不信任半份目录)`);
    return applySnapshot({ ...snapshot, warnings });
  }
  const incoming = Date.parse(parsed.value.provenance.fetchedAt || parsed.value.generatedAt);
  const current = Date.parse(snapshot.generatedAt);
  // **只有更新的那份能用**: 运行期文件比现在这份旧 (无论现在这份是烘焙数据还是上次刷的) → 保留现在这份。
  // 这条防的是"盘上躺着一份两个月前拉的目录, 却把刚更新的烘焙数据盖掉"。
  if (Number.isFinite(incoming) && (!Number.isFinite(current) || incoming <= current)) {
    warnings.push(snapshot.source === 'runtime'
      ? '运行期目录文件不比内存里这份新 → 保留内存里这份'
      : `运行期目录文件 (${parsed.value.provenance.fetchedAt || '无时间戳'}) 比构建期烘焙数据 (${snapshot.generatedAt || '无时间戳'}) 旧 → 用烘焙数据 (想用最新就 /model catalog refresh)`);
    return applySnapshot({ ...snapshot, warnings });
  }
  const age = ageDaysOf(parsed.value);
  return applySnapshot({
    data: parsed.value,
    source: 'runtime',
    path: file,
    provenance: parsed.value.provenance,
    generatedAt: parsed.value.generatedAt,
    ageDays: age,
    stale: age > CATALOG_STALE_AFTER_DAYS,
    warnings,
  });
}

// ============================================================
// 运行期拉最新 (refresh)
// ============================================================

export interface CatalogRefreshOptions {
  /** 源 URL (默认公开源; 验收/镜像可换) */
  url?: string;
  /** 直接用本地已存的源文件 (离线/复现; 与 url 二选一) */
  fromFile?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** `false` = 只解析不落盘 (干跑) */
  write?: boolean;
}

export interface CatalogFetchResult {
  text: string;
  bytes: number;
  sha256: string;
  fetchedAt: string;
}

/** 取一次源 (纯 I/O; 超时与 HTTP 状态都如实报) */
export async function fetchCatalogSource(url: string, opts: CatalogRefreshOptions = {}): Promise<CatalogFetchResult> {
  if (opts.fromFile) {
    const raw = fs.readFileSync(opts.fromFile);
    const text = raw.toString('utf-8');
    return {
      text,
      bytes: raw.byteLength,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      fetchedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    };
  }
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, opts.timeoutMs ?? 60_000));
  try {
    const res = await f(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`源回 HTTP ${res.status}`);
    const text = await res.text();
    return {
      text,
      bytes: Buffer.byteLength(text, 'utf-8'),
      sha256: crypto.createHash('sha256').update(text, 'utf-8').digest('hex'),
      fetchedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 真拉一次目录最新版 → 规范化 → 落盘 (`${BOLLOON_HOME}/provider-catalog.json`, mode 0600)
 * → 覆盖进程内快照。
 *
 * 落盘的每一份都带**来源与生成时间** (`sourceUrl` / `sourceBytes` / `sourceSha256` / `fetchedAt`),
 * 界面上打的就是这几个数 —— 于是"这份目录是几号的、是不是刚刷的"是可核事实, 不是感觉。
 */
export async function refreshProviderCatalog(opts: CatalogRefreshOptions = {}): Promise<CatalogRefreshReport> {
  const url = String(opts.url || CATALOG_SOURCE_URL);
  const now = opts.now ?? (() => Date.now());
  const notes: string[] = [];
  let file: string;
  try {
    file = await catalogFilePath();
  } catch (e: any) {
    return {
      ok: false, sourceUrl: url, sourceBytes: 0, sourceSha256: '', fetchedAt: new Date(now()).toISOString(),
      providerCount: 0, modelCount: 0, path: '', fileMode: '', error: `拿不到配置目录: ${String(e?.message || e)}`,
      notes, stats: catalogStats(),
    };
  }
  let fetched: CatalogFetchResult;
  try {
    fetched = await fetchCatalogSource(url, { ...opts, now });
  } catch (e: any) {
    return {
      ok: false, sourceUrl: url, sourceBytes: 0, sourceSha256: '', fetchedAt: new Date(now()).toISOString(),
      providerCount: 0, modelCount: 0, path: file, fileMode: '', error: `取源失败: ${String(e?.message || e)}`,
      notes: [...notes, '没有改动盘上与内存里的目录 (失败不留半成品)'], stats: catalogStats(),
    };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(fetched.text);
  } catch (e: any) {
    return {
      ok: false, sourceUrl: url, sourceBytes: fetched.bytes, sourceSha256: fetched.sha256, fetchedAt: fetched.fetchedAt,
      providerCount: 0, modelCount: 0, path: file, fileMode: '', error: `源不是合法 JSON: ${String(e?.message || e)}`,
      notes: [...notes, '没有改动盘上与内存里的目录'], stats: catalogStats(),
    };
  }
  // 源形状 → 目录数据 (与构建期**同一个**纯函数: `buildCatalogData`)
  let data: ProviderCatalogData;
  try {
    data = buildCatalogData(parsedJson, {
      sourceUrl: url,
      sourceBytes: fetched.bytes,
      sourceSha256: fetched.sha256,
      fetchedAt: fetched.fetchedAt,
      sourceProviderCount: 0,
    }, fetched.fetchedAt);
  } catch (e: any) {
    return {
      ok: false, sourceUrl: url, sourceBytes: fetched.bytes, sourceSha256: fetched.sha256, fetchedAt: fetched.fetchedAt,
      providerCount: 0, modelCount: 0, path: file, fileMode: '', error: `源形状不认: ${String(e?.message || e)}`,
      notes: [...notes, '没有改动盘上与内存里的目录'], stats: catalogStats(),
    };
  }
  if (data.providerCount < MIN_PROVIDERS_FOR_TRUST) {
    return {
      ok: false, sourceUrl: url, sourceBytes: fetched.bytes, sourceSha256: fetched.sha256, fetchedAt: fetched.fetchedAt,
      providerCount: data.providerCount, modelCount: 0, path: file, fileMode: '',
      error: `源只解析出 ${data.providerCount} 家 (< ${MIN_PROVIDERS_FOR_TRUST}) → 拒绝采用 (源可能被截断/被拦)`,
      notes: [...notes, '没有改动盘上与内存里的目录'], stats: catalogStats(),
    };
  }

  let fileMode = '';
  if (opts.write !== false) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${now()}`;
      fs.writeFileSync(tmp, renderCatalogJson(data), { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch { /* 尽力而为 */ }
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch { /* 尽力而为 */ }
      fileMode = (fs.statSync(file).mode & 0o777).toString(8);
      notes.push(`已落盘 ${file} (mode ${fileMode})`);
    } catch (e: any) {
      return {
        ok: false, sourceUrl: url, sourceBytes: fetched.bytes, sourceSha256: fetched.sha256, fetchedAt: fetched.fetchedAt,
        providerCount: data.providerCount, modelCount: 0, path: file, fileMode: '',
        error: `落盘失败: ${String(e?.message || e)}`, notes: [...notes, '内存与盘上的目录都没有改动'], stats: catalogStats(),
      };
    }
  } else {
    notes.push('干跑 (write:false): 只解析, 没落盘');
  }

  runtimePath = file;
  const age = ageDaysOf(data, now());
  applySnapshot({
    data,
    source: 'runtime',
    path: file,
    provenance: data.provenance,
    generatedAt: data.generatedAt,
    ageDays: age,
    stale: age > CATALOG_STALE_AFTER_DAYS,
    warnings: [],
  });
  const stats = catalogStats();
  const modelCount = Object.values(data.providers).reduce((n, p) => n + Object.keys(p.models).length, 0);
  notes.push(`家数 ${stats.providers} · 有 api 基址 ${stats.withApi} · 无 api 基址 ${stats.withoutApi} · 模型 ${modelCount}`);
  return {
    ok: true,
    sourceUrl: url,
    sourceBytes: fetched.bytes,
    sourceSha256: fetched.sha256,
    fetchedAt: fetched.fetchedAt,
    providerCount: stats.providers,
    modelCount,
    path: file,
    fileMode,
    notes,
    stats,
  };
}

// ============================================================
// 展示 (中文 + 英文术语; 只翻译, 不产生值)
// ============================================================

/** 目录时间戳 → `YYYY-MM-DD` (拿不到就如实说"无时间戳") */
export function catalogDateText(load: CatalogLoad = snapshot): string {
  const t = Date.parse(load.provenance.fetchedAt || load.generatedAt);
  if (!Number.isFinite(t)) return '无时间戳';
  return new Date(t).toISOString().slice(0, 10);
}

/** 新不新 (人话) */
export function catalogAgeText(load: CatalogLoad = snapshot): string {
  if (!Number.isFinite(load.ageDays)) return '生成时间未知';
  if (load.ageDays < 1 / 24) return '刚刚刷新';
  if (load.ageDays < 1) return `${Math.round(load.ageDays * 24)} 小时前`;
  return `${Math.floor(load.ageDays)} 天前`;
}

/**
 * 目录状态行 —— 界面/status 都用它 (`目录数据: <日期>` 是**必有**的一段)。
 * 陈旧 (>`CATALOG_STALE_AFTER_DAYS` 天) 时如实标 `⚠ 陈旧` + 刷新指引, 不静默拿旧的当新的。
 */
export function catalogStatusLine(load: CatalogLoad = snapshot): string {
  const s = catalogStats();
  const src = load.source === 'runtime' ? `运行期文件 ${load.path}` : '构建期烘焙数据';
  let line = `目录数据: ${catalogDateText(load)} (${catalogAgeText(load)}) · ${s.providers} 家`
    + ` · 有基址 ${s.withApi} / 无基址 ${s.withoutApi} · 模型 ${s.models} · 源 ${load.provenance.sourceUrl || CATALOG_SOURCE_URL}`
    + ` · ${src}`;
  if (load.stale) line += ` ⚠ 陈旧 (超过 ${CATALOG_STALE_AFTER_DAYS} 天) —— 用 /model catalog refresh 拉最新`;
  for (const w of load.warnings) line += `\n  ⚠ ${w}`;
  return line;
}

/** 分组/计数行 (status 里不刷 223 行噪音, 但要说清有哪些家) */
export function catalogGroupLine(): string {
  const s = catalogStats();
  return `目录分组: openai-compatible ${s.families['openai-compatible']}`
    + ` · anthropic ${s.families.anthropic}`
    + ` · gemini ${s.families.gemini}`
    + ` · special (需专用鉴权, 未支持) ${s.families.special}`
    + ` · 无 api 基址 (需自定义 baseUrl) ${s.noBaseUrl}`;
}

/** 一家目录供应商一行 (含不能用时的**如实**标注) */
export function formatCatalogProviderLine(v: CatalogProviderView, opts: { envConfigured?: boolean } = {}): string {
  const bits: string[] = [];
  bits.push(`${v.modelIds.length} models (目录)`);
  if (!v.auth.supported) bits.push(`⚠ ${v.auth.note}`);
  else if (opts.envConfigured) bits.push(`已配置凭证 (${v.auth.envVar})`);
  else bits.push(`未配置 key (${v.auth.envVar || '环境变量名缺失'})`);
  if (!v.hasBaseUrl) bits.push('⚠ 目录里无 api 基址 → 需自定义 baseUrl');
  else bits.push(`api ${v.api}`);
  bits.push(`族 ${v.family}`);
  const mark = v.auth.supported && v.hasBaseUrl && opts.envConfigured ? '●' : '○';
  return `${mark} ${v.id} · ${bits.join(' · ')}`;
}

// ============================================================
// 元数据填充点 (P2 冻结接口)
// ============================================================

/**
 * 「真目录是否已经覆盖这条模型」的探针 (由**发现层**注入, 方向 discovery → catalog)。
 *
 * 为什么用注入而不是 import: `provider-catalog → model-discovery → provider-registry → provider-catalog`
 * 会成环。注进来的判定只读发现层进程内快照 (纯同步), 于是填充点仍然是纯同步的。
 */
export type LiveFactsProbe = (provider: string, model: string) => {
  toolCalling?: Capability;
  reasoning?: Capability;
  contextLength?: number;
  displayName?: string;
  origin?: boolean;
} | undefined;

let liveFactsProbe: LiveFactsProbe | null = null;

/** 注入/撤掉探针 (发现层调用; 传 `null` = 撤掉) */
export function setLiveFactsProbe(probe: LiveFactsProbe | null): void {
  liveFactsProbe = probe;
}

/**
 * 本层**允许回答哪些家** —— 由注册表在读口注入 (方向 registry → catalog, 单向)。
 *
 * 为什么必须有这个门 (而不是"目录里有就答"):
 *   ① **内置 13 家的行为一个字都不许变** —— 它们的模型元数据口径是内置目录 + 真发现, 有门钉着
 *      ("没被覆盖的条目仍然是未知"); 目录层如果也去答内置 13 家, 就会把 `unknown` 变成目录里的值,
 *      那是**改了行为**, 不是加了数据源;
 *   ② 用户自定义的供应商 (可能 id 与目录同名) 也一样 —— 自定义说了算;
 *   ③ 于是本层只回答 `kind === 'catalog'` 的家 (目录里来的、且内置/自定义都没占用的那些)。
 *
 * 没注入 scope 时**不回答** (fail closed: 宁可少答, 也不许悄悄改行为)。
 */
export interface CatalogFillScope {
  /** 内置 id 名单 (挡掉内置 13 家) */
  builtinIds: string[];
  /** 一个 id 现在的身份 (注册表说了算; 不在册 → undefined) */
  kindOf: (provider: string) => 'builtin' | 'custom' | 'catalog' | undefined;
}

let fillScope: CatalogFillScope | null = null;

/** 注入 scope (只接一次; 后到的调用不覆盖先到的) */
export function setCatalogFillScope(scope: CatalogFillScope): void {
  if (!fillScope) fillScope = scope;
}

/** 本层现在会不会回答这一家 (排障/门用; 纯同步) */
export function catalogAnswersProvider(provider: string): boolean {
  if (!fillScope) return false;
  const id = String(provider || '').trim();
  if (!id) return false;
  if (fillScope.builtinIds.includes(id)) return false;
  return fillScope.kindOf(id) === 'catalog';
}

/**
 * 目录的元数据填充点。
 *
 * 只回答**目录里字面声明过**的项:
 *   · `origin`: 这个模型真在目录里 → `'catalog'`;
 *   · `displayName` / `toolCalling` / `reasoning` / `contextLength`: 目录里写了才填, 没写就是 `unknown`
 *     (填充点返回的字段越少, 合成出的就是 `unknown` —— 这里**绝不**替供应商猜);
 *   · 真目录层 (live/cached) 已经覆盖的字段**不填** (让发现层的真事实答, 那边更新)。
 *
 * 内置 13 家与用户自定义的家**不走这条路** (由上面的 `CatalogFillScope` 挡掉) —— 它们的行为不许变。
 */
export function providerCatalogMetadataSource(): ModelMetadataSource {
  return {
    id: CATALOG_METADATA_SOURCE_ID,
    metadataOf: ({ provider, model }: { provider: string; model: string }): ModelCapabilityFacts | undefined => {
      if (!catalogAnswersProvider(provider)) return undefined;
      const view = getCatalogProvider(provider);
      if (!view) return undefined;
      const facts = view.models[String(model || '')];
      const live = liveFactsProbe ? (liveFactsProbe(provider, model) || undefined) : undefined;
      const out: ModelCapabilityFacts = {};
      if (facts) {
        if (facts.name && !live?.displayName) out.displayName = facts.name;
        if (facts.toolCalling !== undefined && !live?.toolCalling) out.toolCalling = facts.toolCalling ? 'yes' : 'no';
        if (facts.reasoning !== undefined && !live?.reasoning) out.reasoning = facts.reasoning ? 'yes' : 'no';
        if (facts.contextLength !== undefined && typeof live?.contextLength !== 'number') out.contextLength = facts.contextLength;
        if (!live?.origin) out.origin = 'catalog';
      }
      return Object.keys(out).length ? out : undefined;
    },
  };
}

let catalogSourceWired = false;

/** 显式接线 (测试里 `resetModelMetadataSources()` 之后靠它接回去; 必须先给 scope) */
export function registerProviderCatalogMetadataSource(scope?: CatalogFillScope): void {
  if (scope) setCatalogFillScope(scope);
  if (!fillScope) return;   // 不知道范围就不接 (fail closed, 见 CatalogFillScope 注释)
  registerModelMetadataSource(providerCatalogMetadataSource());
  catalogSourceWired = true;
}

/**
 * 自动接线 (幂等; 由注册表读口在调用时拉起来, 不放在模块体避免 import 顺序问题)。
 * 必须带上 scope —— 见 `CatalogFillScope`: 不知道"哪些家归本层答"就会改到内置/自定义的行为。
 */
export function ensureProviderCatalogMetadataSource(scope: CatalogFillScope): void {
  if (catalogSourceWired) return;
  registerProviderCatalogMetadataSource(scope);
}

/** 本层填充点现在有没有接上 (排障/门用) */
export function isProviderCatalogMetadataSourceWired(): boolean {
  return listModelMetadataSources().includes(CATALOG_METADATA_SOURCE_ID);
}

/** 供排障: 当前快照的家数 (同步) */
export function catalogProviderCount(): number {
  return views.length;
}

/** 供排障: 配置目录里那个目录文件的路径 (不一定存在; 同步能算时给) */
export function defaultCatalogPathHint(): string {
  if (runtimePath) return runtimePath;
  const home = process.env.BOLLOON_HOME?.trim();
  const dir = home || path.join(process.env.HOME || os.homedir() || '/tmp', '.bolloon');
  return path.join(dir, CATALOG_FILE_NAME);
}
