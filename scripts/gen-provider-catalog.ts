/**
 * gen-provider-catalog.ts — 生成「供应商目录」的**构建期烘焙数据** (目录驱动, 2026-09-27)
 *
 * ## 这一层解决什么
 *
 * 此前"供应商"是**一家一家手写**进代码的 (内置 13 家)。加一家要改类型、改表、改白名单。
 * 本脚本把公开模型目录 (`https://models.dev/api.json`) 收成一份**只存公共元数据**的数据,
 * 由运行时 (`src/llm/provider-catalog.ts`) 读它 —— 于是"新家只要在目录里就自动可用",
 * 不需要改代码。
 *
 * ## 产物 (两个文件, 同一份数据, 不许漂)
 *
 *   · `src/llm/data/provider-catalog.json`         —— 规范产物 (可读, 可 diff, 给人看/给门比);
 *   · `src/llm/data/provider-catalog-baked.ts`     —— 运行时**真正 import** 的那份 (编译器认识它,
 *     于是 `tsc` 出来的 `dist/` 里也有这份数据; 直接 import JSON 在 ESM 下要 import attributes,
 *     且 `dist/` 需要额外拷贝步骤 —— 这里绕开这两个坑)。
 *
 *   两者由**同一次运行**写出; `scripts/verify-provider-catalog.ts` 会把两份逐字节比一遍,
 *   漂了就判红 (所以"两处真相"在这条链上是可核事实, 不是承诺)。
 *
 * ## 只存公共元数据 (铁律)
 *
 * 存下来的每一项都是公开目录里**字面写着**的: `id` / `name` / `env`(**变量名**, 永不取值) /
 * `npm` / `api`(基址) / `doc` / 模型 `id` 与字面声明过的能力 (`tool_call` · `reasoning` ·
 * `limit.context` · `name`)。**没有任何密钥值、没有推断出来的能力值**: 目录里没写的字段就不出现在
 * 数据里 (运行时一律按 `unknown`/空处理, 不许编)。
 *
 * ## 用法
 *
 * ```bash
 * npx tsx scripts/gen-provider-catalog.ts                 # 从公开源真取 (默认 https://models.dev/api.json)
 * npx tsx scripts/gen-provider-catalog.ts --from <file>    # 用本地已存的源文件 (离线重生成/复现)
 * npx tsx scripts/gen-provider-catalog.ts --check          # 只比不写: 盘上数据 == 源重新推导的结果?
 * npx tsx scripts/gen-provider-catalog.ts --url <url>      # 换源 (自建镜像/验收假源)
 * ```
 *
 * ## 本机网络注意 (如实记下)
 *
 * 本机开着 ClashX (fake-ip)。`curl` 取这个地址要 `--noproxy '*'`; `node fetch` (undici)
 * **默认不走代理环境变量**, 实测直连可通 —— 所以本脚本用 `fetch`, 真跑不过时再退回 `--from`。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCatalogData,
  renderCatalogJson,
  MIN_PROVIDERS_FOR_TRUST,
  CATALOG_SOURCE_URL,
  type CatalogProvenance,
  type ProviderCatalogData,
} from '../src/llm/provider-catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_JSON = path.join(ROOT, 'src', 'llm', 'data', 'provider-catalog.json');
const OUT_TS = path.join(ROOT, 'src', 'llm', 'data', 'provider-catalog-baked.ts');

/** 目录数据 → `.ts` 模块文本 (运行时 import 的那一份) */
export function renderCatalogModule(data: ProviderCatalogData): string {
  // 直接用 JSON.stringify 出来的是**合法 JS 字符串字面量** (引号/反斜杠/换行都转义好了)。
  // 这样运行时只走**一个**解析器 (与运行期拉的 provider-catalog.json 同一条路),
  // 也避免一个上百万字符的对象字面量把 tsc 的类型推断拖慢。
  const literal = JSON.stringify(JSON.stringify(data));
  return `/**
 * provider-catalog-baked.ts — 「供应商目录」的**构建期烘焙数据** (生成物, 别手改)
 *
 * 由 \`npx tsx scripts/gen-provider-catalog.ts\` 生成; 数据来自公开源
 * ${data.provenance.sourceUrl}
 * (${data.provenance.sourceBytes} 字节 · sha256 ${data.provenance.sourceSha256.slice(0, 16)}… ·
 * 取于 ${data.provenance.fetchedAt})。
 *
 * 家数 ${data.providerCount} · 生成时间 ${data.generatedAt}
 * (模型 ${Object.values(data.providers).reduce((n, p) => n + Object.keys(p.models).length, 0)} 条)。
 *
 * 为什么是 .ts 而不是直接 import .json: 本仓 dist/ 是 ESM, 直接 import JSON 需要 import
 * attributes 且要多一步拷贝到 dist; 写成模块则 tsc 自己就把它带进 dist 了。
 *
 * 内容**只含公开元数据** (id/name/env 名/npm/api 基址/doc/模型 id 与字面声明的能力),
 * 没有任何密钥值。真正读它的是 \`src/llm/provider-catalog.ts\` (那一层负责规范化与回退)。
 * 与 \`provider-catalog.json\` 的一致性由 \`scripts/verify-provider-catalog.ts\` 逐字节钉住。
 */
export const PROVIDER_CATALOG_JSON = ${literal};
`;
}

async function fetchSource(url: string, timeoutMs = 60_000): Promise<{ text: string; bytes: number; sha256: string; fetchedAt: string }> {
  const crypto = await import('node:crypto');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`源回 HTTP ${res.status}`);
    const text = await res.text();
    return {
      text,
      bytes: Buffer.byteLength(text, 'utf-8'),
      sha256: crypto.createHash('sha256').update(text, 'utf-8').digest('hex'),
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const crypto = await import('node:crypto');
  const args = process.argv.slice(2);
  const url = argValue(args, '--url') || CATALOG_SOURCE_URL;
  const from = argValue(args, '--from');
  const check = args.includes('--check');

  let text: string;
  let bytes: number;
  let sha256: string;
  let fetchedAt: string;
  if (from) {
    const abs = path.resolve(from);
    const raw = fs.readFileSync(abs);
    text = raw.toString('utf-8');
    bytes = raw.byteLength;
    sha256 = crypto.createHash('sha256').update(raw).digest('hex');
    fetchedAt = fs.statSync(abs).mtime.toISOString();
    console.log(`[gen-provider-catalog] 用本地源文件: ${abs}`);
  } else {
    console.log(`[gen-provider-catalog] 取公开源: ${url}`);
    const got = await fetchSource(url);
    text = got.text;
    bytes = got.bytes;
    sha256 = got.sha256;
    fetchedAt = got.fetchedAt;
    console.log(`[gen-provider-catalog] 取到 ${bytes} 字节 · sha256 ${sha256.slice(0, 16)}… · ${fetchedAt}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    console.error(`[gen-provider-catalog] 源不是合法 JSON: ${String(e?.message || e)} → 拒绝生成`);
    process.exit(2);
  }

  const provenance: CatalogProvenance = { sourceUrl: url, sourceBytes: bytes, sourceSha256: sha256, fetchedAt, sourceProviderCount: 0 };
  // 生成时间 = 取源时间 (可复现: 同一个源文件 + 同一个取源时间 → 同一份数据)
  const data = buildCatalogData(parsed, provenance, fetchedAt);

  if (data.providerCount < MIN_PROVIDERS_FOR_TRUST) {
    console.error(`[gen-provider-catalog] 只解析出 ${data.providerCount} 家 (< ${MIN_PROVIDERS_FOR_TRUST}) → 拒绝落盘 (源可能被截断/被拦/被换成别的东西)`);
    process.exit(2);
  }

  const json = renderCatalogJson(data);
  const ts = renderCatalogModule(data);

  if (check) {
    const curJson = fs.existsSync(OUT_JSON) ? fs.readFileSync(OUT_JSON, 'utf-8') : '';
    const curTs = fs.existsSync(OUT_TS) ? fs.readFileSync(OUT_TS, 'utf-8') : '';
    const same = curJson === json && curTs === ts;
    console.log(`[gen-provider-catalog] --check: ${same ? '盘上数据与源一致' : '盘上数据与源**不一致** (需要重生成)'}`);
    process.exit(same ? 0 : 1);
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, json);
  fs.writeFileSync(OUT_TS, ts);

  // 统计 (报告用; 全部从生成的数据里真算)
  const withApi = Object.values(data.providers).filter((p) => p.api).length;
  const modelCount = Object.values(data.providers).reduce((n, p) => n + Object.keys(p.models).length, 0);
  const envNamed = Object.values(data.providers).filter((p) => p.env.length > 0).length;
  console.log(`[gen-provider-catalog] ✅ 家数 ${data.providerCount} · 有 api 基址 ${withApi} · 无 api 基址 ${data.providerCount - withApi} · 有 env 名 ${envNamed} · 模型 ${modelCount}`);
  console.log(`[gen-provider-catalog] 写: ${OUT_JSON} (${Buffer.byteLength(json, 'utf-8')} 字节)`);
  console.log(`[gen-provider-catalog] 写: ${OUT_TS} (${Buffer.byteLength(ts, 'utf-8')} 字节)`);
}

// 只有直接跑这个文件才执行 (被 import 时只拿纯函数)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`[gen-provider-catalog] 失败: ${String(e?.message || e)}`);
    process.exit(2);
  });
}
