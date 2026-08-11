/**
 * mcp-catalog-check.ts — 校验 manifests/mcp-catalog.json (Hermes optional-mcps 目录纪律)
 *
 * 纪律:
 *  1. manifest_version 必须存在
 *  2. 每条 entry: name/description/transport.type 必填
 *  3. transport.type ∈ {stdio, http, in-process}; stdio 必须 pin 精确版本 (npx pkg@X / uvx pkg==X / 完整 commit SHA)
 *  4. http 必须带 url; auth 必填
 * 用法: npx tsx scripts/mcp-catalog-check.ts
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'manifests', 'mcp-catalog.json');

interface Entry {
  name?: string;
  description?: string;
  source?: string;
  transport?: { type?: string; url?: string; command?: string; args?: string[] };
  auth?: { type?: string };
}

function main(): void {
  const raw = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
  const errors: string[] = [];

  if (!raw.manifest_version) errors.push('manifest_version 必填');
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) errors.push('entries 必填且非空');

  for (const [i, e] of (raw.entries ?? []).entries() as [number, Entry][]) {
    const tag = `entries[${i}] (${e.name ?? '?'})`;
    if (!e.name) errors.push(`${tag}: name 必填`);
    if (!e.description) errors.push(`${tag}: description 必填`);
    const t = e.transport?.type;
    if (!t) {
      errors.push(`${tag}: transport.type 必填`);
      continue;
    }
    if (!['stdio', 'http', 'in-process'].includes(t)) errors.push(`${tag}: transport.type=${t} 非法`);
    if (t === 'http' && !e.transport?.url) errors.push(`${tag}: http 必须带 transport.url`);
    if (t === 'stdio') {
      const cmd = e.transport?.command ?? '';
      // pin 纪律: npx pkg@X / uvx pkg==X / git 完整 SHA
      const pinned = /@[0-9][^ ]*$/.test(cmd) || /==[0-9]/.test(cmd) || /[0-9a-f]{40}/.test(cmd);
      if (!pinned) errors.push(`${tag}: stdio 命令必须精确 pin 版本 (npx pkg@X / uvx pkg==X / commit SHA)`);
    }
    if (!e.auth?.type) errors.push(`${tag}: auth 必填 (none|bearer|oauth)`);
  }

  if (errors.length > 0) {
    console.error(`❌ mcp-catalog 校验失败 (${errors.length}):`);
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  console.log(`✅ mcp-catalog 校验通过 (${raw.entries.length} 条)`);
}

main();
