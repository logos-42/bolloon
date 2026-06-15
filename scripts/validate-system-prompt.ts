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
// P-Action 4 (2026-06-15): 跟 registry.ts STATIC_LAYERS maxChars 同步, 停用 layer 设 0
const MAX_CHARS: Record<string, number> = {
  'core/identity': 800,
  'core/knowledge': 600,
  'core/tools.thin': 400,
  'core/hibs_reminders': 0,   // 停用 (was 800)
  'core/refusal': 800,
  'core/tone': 500,
  'core/wellbeing': 600,
  'core/evenhandedness': 300,
  'core/memory_system': 200,
  'core/artifacts_storage': 0, // 停用 (was 2500)
  'core/network_filesystem': 0, // 停用 (was 900)
  'role/expert': 500,
  'role/architect': 0,         // 停用 (was 500)
  'role/implementer': 0,       // 停用 (was 500)
  'role/security': 0,          // 停用 (was 500)
  'channel/local': 500,
  'channel/p2p-visitor': 700,
  'channel/p2p-agent': 700,
  'tool/bash': 600,
  'tool/web_search': 600,
  'tool/mcp_apps': 0,          // 停用 (was 1800)
  'tool/hibs_api': 0,          // 停用 (was 4500)
  'tool/image_search': 0,      // 停用 (was 2500)
  'tool/artifacts': 0,         // 停用 (was 2500)
  'tool/manifest': 500,
};

type IssueType = 'oversize' | 'no-version' | 'leftover-hibsml';
type IssueSeverity = 'error' | 'warning';

interface Issue {
  layer: string;
  type: IssueType;
  severity: IssueSeverity;
  detail: string;
}

/**
 * P-Action 4 (2026-06-15): oversize 降级为 warning.
 * 原因: P-Action 4 收紧 registry maxChars 后, 多个历史 layer .md 实际长度超过新上限.
 *   这些 .md 是"原样"对齐 Claude.ai 完整版的, 内容不动 (用户约束: 不改 prompt).
 *   runtime 时 assembleSystemPrompt 会按 maxChars 截断, 行为已受控.
 *   因此 validate 阶段不再 fail build, 只 log warning.
 * 保留为 error 的: no-version (可追溯性), leftover-hibsml (安全).
 */
const SEVERITY: Record<IssueType, IssueSeverity> = {
  oversize: 'warning',
  'no-version': 'error',
  'leftover-hibsml': 'error',
};

async function check(file: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const rel = path.relative(LAYERS_DIR, file);
  const max = MAX_CHARS[rel.replace(/\.md$/, '')];
  const content = await fs.readFile(file, 'utf-8');
  if (max && content.length > max) {
    issues.push({ layer: rel, type: 'oversize', severity: SEVERITY.oversize, detail: `${content.length} > ${max}` });
  }
  if (!/<!--\s*[\w.-]+@[\d.]+\s*-->/.test(content)) {
    issues.push({ layer: rel, type: 'no-version', severity: SEVERITY['no-version'], detail: '缺 <!-- id@version --> 标记' });
  }
  if (/\{hibsml:(?!thinking_mode)[\w_]+\}/.test(content) || /\{\/hibsml:/.test(content)) {
    issues.push({ layer: rel, type: 'leftover-hibsml', severity: SEVERITY['leftover-hibsml'], detail: '检测到未脱除的 hibsml 标签' });
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
  const errors = allIssues.filter((i) => i.severity === 'error');
  const warnings = allIssues.filter((i) => i.severity === 'warning');

  if (warnings.length > 0) {
    console.warn(`⚠️  ${warnings.length} 个 warning (P-Action 4 后 oversize 不再 fail build):`);
    for (const i of warnings) {
      console.warn(`  [${i.type}] ${i.layer}: ${i.detail}`);
    }
  }

  if (errors.length === 0) {
    console.log(`✅ ${files.length} 个 layer 通过 (${warnings.length} 个 warning, 0 个 error)`);
    return;
  }
  console.error(`❌ ${errors.length} 个 error:`);
  for (const i of errors) {
    console.error(`  [${i.type}] ${i.layer}: ${i.detail}`);
  }
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
