#!/usr/bin/env tsx
/**
 * validate-system-prompt.ts — 护栏: system-prompt 改动验证
 *
 * 跑在 pre-commit + reviewer 后:
 *   1. 每个 layer .md 不超 maxChars
 *   2. version 字段 (HTML 注释 <!-- id@version -->) 存在
 *   3. hibsml 标签没漏 (如果出现 → 警告)
 *
 * 用法:
 *   tsx scripts/validate-system-prompt.ts
 *   tsx scripts/validate-system-prompt.ts --layer core/refusal.md
 */
import * as fs from 'fs/promises';
import * as path from 'path';

const REPO = process.cwd();
const LAYERS_DIR = path.join(REPO, 'src/llm/system-prompt/layers');

// 跟 registry 保持一致 (手维护同步; 后续可让 registry 暴露)
const MAX_CHARS: Record<string, number> = {
  'core/identity': 2500,
  'core/knowledge': 1200,
  'core/tools.thin': 400,
  'core/hibs_reminders': 800,
  'core/refusal': 1200,
  'core/tone': 1000,
  'core/wellbeing': 2500,
  'core/evenhandedness': 700,
  'core/memory_system': 600,
  'core/artifacts_storage': 1500,
  'core/network_filesystem': 900,
  'role/expert': 500,
  'role/architect': 500,
  'role/implementer': 500,
  'role/security': 500,
  'channel/local': 500,
  'channel/p2p-visitor': 700,
  'channel/p2p-agent': 700,
  'tool/bash': 900,
  'tool/web_search': 3000,
  'tool/mcp_apps': 1800,
  'tool/hibs_api': 2500,
  'tool/image_search': 1500,
  'tool/artifacts': 2500,
  'tool/manifest': 2000,
};

interface Issue {
  layer: string;
  type: 'oversize' | 'no-version' | 'leftover-hibsml';
  detail: string;
}

async function check(file: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const rel = path.relative(LAYERS_DIR, file);
  const max = MAX_CHARS[rel.replace(/\.md$/, '')];
  const content = await fs.readFile(file, 'utf-8');
  if (max && content.length > max) {
    issues.push({ layer: rel, type: 'oversize', detail: `${content.length} > ${max}` });
  }
  if (!/<!--\s*[\w.-]+@[\d.]+\s*-->/.test(content)) {
    issues.push({ layer: rel, type: 'no-version', detail: '缺 <!-- id@version --> 标记' });
  }
  if (/\{hibsml:(?!thinking_mode)[\w_]+\}/.test(content) || /\{\/hibsml:/.test(content)) {
    issues.push({ layer: rel, type: 'leftover-hibsml', detail: '检测到未脱除的 hibsml 标签' });
  }
  return issues;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  let files: string[];
  if (args.includes('--layer')) {
    const idx = args.indexOf('--layer');
    const target = path.join(LAYERS_DIR, args[idx + 1]);
    files = [target];
  } else {
    files = await walk(LAYERS_DIR);
  }
  const allIssues: Issue[] = [];
  for (const f of files) {
    const issues = await check(f);
    allIssues.push(...issues);
  }
  if (allIssues.length === 0) {
    console.log(`✅ ${files.length} 个 layer 全部通过 (字符上限, 版本标记, hibsml 脱除)`);
    return;
  }
  console.error(`❌ ${allIssues.length} 个问题:`);
  for (const i of allIssues) {
    console.error(`  [${i.type}] ${i.layer}: ${i.detail}`);
  }
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
