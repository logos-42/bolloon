#!/usr/bin/env tsx
/**
 * diff-reviewer.ts — 阶段 C 护栏 4
 *
 * 2nd LLM call 审第 1 个的 diff:
 *  - 默认用 Haiku (便宜, ~$0.001/diff)
 *  - schema 改动升级 Sonnet (护栏 6 双签)
 *
 * 输入: patch 文件 (git format-patch 风格)
 * 输出: .review-verdict 写到 staging/<patch-id>/, 含 PASS/FAIL + 原因
 *
 * 用法:
 *   tsx scripts/diff-reviewer.ts <patch-id> [--model sonnet]
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Anthropic } from '@anthropic-ai/sdk';

const STAGING_DIR = 'staging/auto-evolve';
const ENV_KEY_MODEL = 'AUTO_EVOLVE_REVIEW_MODEL';

const REVIEW_PROMPT = `你是一个严格的代码审查员. 审查以下 git diff (LLM 自动生成的源码改动).

只回答 JSON, 字段:
{
  "verdict": "PASS" | "FAIL",
  "concerns": ["concern 1", "concern 2", ...],
  "suggestions": ["suggestion 1", ...]
}

PASS 条件 (全部满足才 PASS):
  1. 改动能解决它声称要解决的问题
  2. 没引入明显 bug (空指针, 内存泄漏, 死循环, race condition)
  3. 没引入安全漏洞 (injection, XSS, 越权)
  4. 边界条件考虑 (空数组, undefined, 极值, 并发)
  5. 改动局限在它声称的范围, 不夹带私货
  6. 跟现有代码风格一致

FAIL 条件 (任一即 FAIL):
  - 满足上面任一 PASS 条件的反例
  - 引入了新依赖 (必须在 concerns 里说)
  - 删除了测试 / 注释掉失败用例
  - 用了 any / unknown / @ts-ignore 偷懒

DIFF:
{{DIFF}}
`;

async function review(patchContent: string, model: string): Promise<{ verdict: string; concerns: string[]; suggestions: string[]; raw: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    // 无 API key 时降级: 用 grep 做粗筛 (兜底, 不真审)
    console.warn('[diff-reviewer] ⚠️ 无 ANTHROPIC_API_KEY, 降级 grep 检查');
    const concerns: string[] = [];
    if (/\+.*\bany\b/.test(patchContent)) concerns.push('使用了 any');
    if (/\+.*\b@ts-ignore\b/.test(patchContent)) concerns.push('使用了 @ts-ignore');
    if (/\+.*\bconsole\.log\b/.test(patchContent)) concerns.push('留了 console.log');
    if (/\-.*test\(/.test(patchContent)) concerns.push('删除了测试');
    return {
      verdict: concerns.length > 0 ? 'FAIL' : 'PASS',
      concerns,
      suggestions: [],
      raw: '(degraded grep mode)',
    };
  }

  const client = new Anthropic();
  const prompt = REVIEW_PROMPT.replace('{{DIFF}}', patchContent.slice(0, 20000)); // 限长
  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content[0].type === 'text' ? resp.content[0].text : '';
  // 解析 JSON
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) {
    return { verdict: 'FAIL', concerns: ['LLM 没返回 JSON'], suggestions: [], raw: text };
  }
  try {
    const parsed = JSON.parse(m[0]);
    return {
      verdict: parsed.verdict === 'PASS' ? 'PASS' : 'FAIL',
      concerns: parsed.concerns || [],
      suggestions: parsed.suggestions || [],
      raw: text,
    };
  } catch {
    return { verdict: 'FAIL', concerns: ['JSON 解析失败'], suggestions: [], raw: text };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const patchId = args[0];
  if (!patchId) {
    console.error('用法: tsx diff-reviewer.ts <patch-id> [--model sonnet]');
    process.exit(1);
  }
  const forceModel = args.includes('--model') ? args[args.indexOf('--model') + 1] : null;

  const stagingDir = path.join(STAGING_DIR, patchId);
  const schemaFlag = path.join(stagingDir, '.schema-changed');
  const isSchemaChange = await fs.access(schemaFlag).then(() => true).catch(() => false);

  const defaultModel = isSchemaChange ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
  const model = forceModel || process.env[ENV_KEY_MODEL] || defaultModel;

  console.log(`[diff-reviewer] patch=${patchId} schema=${isSchemaChange} model=${model}`);

  // 合并所有 patch
  const files = await fs.readdir(stagingDir);
  const patches = files.filter((f) => f.endsWith('.patch'));
  if (patches.length === 0) {
    console.error('❌ staging 里没有 .patch 文件');
    process.exit(1);
  }

  let combined = '';
  for (const p of patches) {
    combined += `\n=== ${p} ===\n` + (await fs.readFile(path.join(stagingDir, p), 'utf-8'));
  }

  const r = await review(combined, model);

  const verdict = {
    patchId,
    model,
    schemaChange: isSchemaChange,
    verdict: r.verdict,
    concerns: r.concerns,
    suggestions: r.suggestions,
    reviewedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(stagingDir, '.review-verdict'), JSON.stringify(verdict, null, 2));

  console.log(`[diff-reviewer] verdict=${r.verdict} concerns=${r.concerns.length}`);
  if (r.verdict === 'FAIL') {
    for (const c of r.concerns) console.log(`  - ${c}`);
    process.exit(2);
  } else {
    for (const s of r.suggestions) console.log(`  💡 ${s}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
