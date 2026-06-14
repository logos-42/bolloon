#!/usr/bin/env tsx
/**
 * auto-evolve-loop.ts — 阶段 D 主循环
 *
 * 流程 (per iteration):
 *   1. 跑 vitest, 拿 fail 信息
 *   2. 把 fail 信息喂给 LLM, 让它生成 diff
 *   3. 写 diff 到 staging/auto-evolve/iter-<N>/
 *   4. 跑 detect-schema-changes + diff-reviewer
 *   5a. reviewer PASS → git commit (护栏 1 拦)
 *   5b. reviewer FAIL → log, 累计连续失败
 *   6. 连续 3 次 FAIL → 自动回滚 baseline + 通知
 *
 * 退出条件 (任一即停):
 *   - 全部测试 PASS (loop 成功)
 *   - 连续 3 次 FAIL (loop 认输)
 *   - max-iter 达到 (默认 10)
 *   - 人类 SIGINT (Ctrl-C)
 *
 * 用法:
 *   tsx scripts/auto-evolve-loop.ts
 *   tsx scripts/auto-evolve-loop.ts --max-iter 5
 *   tsx scripts/auto-evolve-loop.ts --target src/utils/foo.ts
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import { promisify } from 'util';
import * as path from 'path';

const pExec = promisify(execFile);
const REPO = process.cwd();

interface VitestResult {
  failed: number;
  passed: number;
  totalFiles: string[];
  failingTests: { file: string; name: string; message: string }[];
}

async function runVitest(targetFile?: string): Promise<VitestResult> {
  // 用 JSON reporter 拿结构化结果
  const args = ['vitest', 'run', '--reporter=json', '--no-color'];
  if (targetFile) args.push(targetFile);
  try {
    const { stdout } = await pExec('npx', args, { cwd: REPO, maxBuffer: 50 * 1024 * 1024 });
    const json = JSON.parse(stdout);
    return parseVitestJson(json);
  } catch (err: any) {
    // vitest 失败时仍输出 JSON
    if (err.stdout) {
      try {
        const json = JSON.parse(err.stdout);
        return parseVitestJson(json);
      } catch {
        // 解析失败
      }
    }
    return { failed: 1, passed: 0, totalFiles: [], failingTests: [{ file: 'unknown', name: 'vitest crashed', message: err.message?.slice(0, 500) || '' }] };
  }
}

function parseVitestJson(j: any): VitestResult {
  const failingTests: VitestResult['failingTests'] = [];
  const totalFiles: string[] = [];
  let failed = 0;
  let passed = 0;
  for (const f of j.testResults || []) {
    totalFiles.push(f.name || '');
    failed += f.assertionResults?.filter((a: any) => a.status === 'failed').length || 0;
    passed += f.assertionResults?.filter((a: any) => a.status === 'passed').length || 0;
    for (const a of f.assertionResults || []) {
      if (a.status === 'failed') {
        failingTests.push({
          file: f.name,
          name: a.fullName || a.title,
          message: (a.failureMessages || []).join('\n').slice(0, 1500),
        });
      }
    }
  }
  return { failed, passed, totalFiles, failingTests };
}

async function callLLM(prompt: string): Promise<string> {
  // Lazy import SDK
  const { Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: process.env.AUTO_EVOLVE_LLM_MODEL || 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  // 累计 LLM 调用计数
  await bumpCallCount();
  return resp.content[0].type === 'text' ? resp.content[0].text : '';
}

async function bumpCallCount(): Promise<void> {
  const f = path.join(REPO, '.auto-evolve-calls');
  const today = new Date().toISOString().slice(0, 10);
  let count = 0;
  try {
    const lines = (await fs.readFile(f, 'utf-8')).trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];
    if (lastLine?.startsWith(today)) count = parseInt(lastLine.split(':')[1] || '0', 10);
  } catch { /* no file yet */ }
  await fs.writeFile(f, `${today}:${count + 1}\n`, 'utf-8');
}

const FIX_PROMPT = `你是一个谨慎的代码修复助手. 你的工作是修复失败的测试, **不**做无关改动.

约束 (违反任一即重做):
  1. 改动最小: 只动让测试通过必需的部分
  2. 不改测试本身 (除非 test 自身有 bug)
  3. 不引入新依赖
  4. 不删注释 / 不改注释
  5. 不动 schema (interface/type) 除非 fail 信息明确要求
  6. 不用 any / unknown / @ts-ignore 偷懒
  7. 不动 package.json / tsconfig.json

输出格式 (严格):
  先简短说明你要改什么 (3 行内)
  然后一个 unified diff (git format-patch 风格),  用 \`\`\`diff ... \`\`\` 包裹

FAIL 信息:
{{FAIL}}

相关源码 (供参考):
{{SOURCE}}

请输出 diff.`;

async function getSourceContext(file: string): Promise<string> {
  try {
    const content = await fs.readFile(file, 'utf-8');
    return content.slice(0, 8000); // 限长
  } catch {
    return '';
  }
}

function extractDiff(llmOutput: string): string | null {
  // 找 ```diff ... ``` 块
  const m = /```diff\s*([\s\S]*?)```/.exec(llmOutput);
  if (m) return m[1].trim();
  // 找 --- a/ ... +++ b/ 风格
  const m2 = /(---\s+a\/[\s\S]*?)(?=\n```|\n##|$)/.exec(llmOutput);
  if (m2) return m2[1].trim();
  return null;
}

async function writePatch(iter: number, patchContent: string): Promise<string> {
  const id = `iter-${String(iter).padStart(3, '0')}`;
  const dir = path.join(REPO, 'staging', 'auto-evolve', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.patch`), patchContent, 'utf-8');
  await fs.writeFile(path.join(dir, '.patch-id'), id, 'utf-8');
  return id;
}

async function runReviewer(patchId: string): Promise<{ verdict: 'PASS' | 'FAIL'; concerns: string[] }> {
  try {
    await pExec('bash', [path.join(REPO, 'scripts/detect-schema-changes.sh'), patchId], { cwd: REPO });
    await pExec('npx', ['tsx', 'scripts/diff-reviewer.ts', patchId, '--model', 'claude-sonnet-4-6'], { cwd: REPO });
    const verdictFile = path.join(REPO, 'staging', 'auto-evolve', patchId, '.review-verdict');
    const json = JSON.parse(await fs.readFile(verdictFile, 'utf-8'));
    return { verdict: json.verdict, concerns: json.concerns || [] };
  } catch (err: any) {
    // reviewer exit 2 = FAIL
    return { verdict: 'FAIL', concerns: [err.message?.slice(0, 200) || 'reviewer crashed'] };
  }
}

async function commitPatch(patchId: string): Promise<boolean> {
  try {
    // 用 git apply 把 staging 的 patch 应用, 然后 commit (让 lefthook 跑)
    const patchFile = path.join(REPO, 'staging', 'auto-evolve', patchId, `${patchId}.patch`);
    await pExec('git', ['apply', '--check', patchFile], { cwd: REPO });
    await pExec('git', ['apply', patchFile], { cwd: REPO });
    // 收集修改过的文件 add
    const { stdout } = await pExec('git', ['status', '--porcelain'], { cwd: REPO });
    const files = stdout.trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/).slice(1).join(' '));
    for (const f of files) {
      try {
        await pExec('git', ['add', f], { cwd: REPO });
      } catch { /* binary or removed */ }
    }
    // 提交 (lefthook 会跑 vitest + tsc)
    await pExec('git', ['commit', '-m', `auto-evolve: ${patchId} (LLM 修复)`], { cwd: REPO });
    return true;
  } catch (err: any) {
    console.error(`[loop] commit 失败: ${err.message?.slice(0, 200)}`);
    return false;
  }
}

async function rollback(baseline: string): Promise<void> {
  console.log(`[loop] ⚠️  自动回滚到 ${baseline}`);
  await pExec('git', ['reset', '--hard', baseline], { cwd: REPO });
}

async function notify(msg: string): Promise<void> {
  // 简化: 写 .auto-evolve-notify log + console
  const f = path.join(REPO, '.auto-evolve-notify');
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  await fs.appendFile(f, line, 'utf-8');
  console.log(`[notify] ${msg}`);
}

async function main() {
  const args = process.argv.slice(2);
  let maxIter = 10;
  let targetFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-iter' && args[i + 1]) maxIter = parseInt(args[++i], 10);
    if (args[i] === '--target' && args[i + 1]) targetFile = args[++i];
  }

  // 必须先有 baseline
  if (!(await fs.stat('.last-auto-evolve-baseline').catch(() => null))) {
    console.log('[loop] 没 baseline, 先打一个');
    await pExec('bash', ['scripts/auto-evolve-snapshot.sh', 'snapshot'], { cwd: REPO });
  }
  const baseline = (await fs.readFile('.last-auto-evolve-baseline', 'utf-8')).trim();
  console.log(`[loop] baseline: ${baseline}, max-iter: ${maxIter}`);

  let consecutiveFails = 0;
  for (let iter = 1; iter <= maxIter; iter++) {
    console.log(`\n========== iter ${iter}/${maxIter} ==========`);

    // 1. 跑 vitest
    const result = await runVitest(targetFile);
    console.log(`[vitest] passed=${result.passed} failed=${result.failed}`);

    if (result.failed === 0) {
      console.log('[loop] ✅ 全部测试通过, 退出');
      return;
    }

    // 2. 让 LLM 修
    const failSummary = result.failingTests
      .slice(0, 3)
      .map((f) => `FILE: ${f.file}\nTEST: ${f.name}\nERROR: ${f.message}`)
      .join('\n---\n');
    const sourceCtx = await getSourceContext(result.failingTests[0]?.file || '');
    const prompt = FIX_PROMPT
      .replace('{{FAIL}}', failSummary)
      .replace('{{SOURCE}}', sourceCtx);

    console.log('[loop] 调 LLM 修...');
    const llmOut = await callLLM(prompt);
    const diff = extractDiff(llmOut);
    if (!diff) {
      console.log('[loop] LLM 没返回有效 diff');
      console.log('--- LLM 原始输出 ---');
      console.log(llmOut.slice(0, 800));
      console.log('---');
      consecutiveFails++;
      if (consecutiveFails >= 3) {
        await notify(`连续 3 次 LLM 无 diff, 自动回滚 ${baseline}`);
        await rollback(baseline);
        return;
      }
      continue;
    }

    // 3. 写 staging
    const patchId = await writePatch(iter, diff);
    console.log(`[loop] 写到 ${patchId}`);

    // 4. 跑 reviewer
    const review = await runReviewer(patchId);
    console.log(`[reviewer] verdict=${review.verdict} concerns=${review.concerns.length}`);
    if (review.concerns.length > 0) {
      for (const c of review.concerns) console.log(`  - ${c}`);
    }

    if (review.verdict === 'FAIL') {
      consecutiveFails++;
      if (consecutiveFails >= 3) {
        await notify(`连续 3 次 reviewer FAIL, 自动回滚 ${baseline}`);
        await rollback(baseline);
        return;
      }
      continue;
    }

    // 5. 提交
    const committed = await commitPatch(patchId);
    if (!committed) {
      console.log('[loop] commit 被护栏 1 (lefthook) 拦, 算 fail');
      consecutiveFails++;
      // commit 失败时回滚未提交改动
      await pExec('git', ['reset', '--hard', 'HEAD'], { cwd: REPO }).catch(() => {});
      continue;
    }

    // 6. 跑 vitest 看 commit 后是否真过
    const after = await runVitest(targetFile);
    console.log(`[vitest after] passed=${after.passed} failed=${after.failed}`);
    if (after.failed < result.failed) {
      console.log(`[loop] 进步: ${result.failed} → ${after.failed} fail`);
      consecutiveFails = 0;
    } else {
      console.log(`[loop] 没进步, revert 这次 commit`);
      await pExec('git', ['reset', '--hard', 'HEAD~1'], { cwd: REPO });
      consecutiveFails++;
    }

    if (consecutiveFails >= 3) {
      await notify(`连续 3 次无进步, 自动回滚 ${baseline}`);
      await rollback(baseline);
      return;
    }
  }

  console.log(`[loop] 达到 max-iter=${maxIter}, 退出`);
}

main().catch((e) => { console.error('[loop] fatal:', e); process.exit(1); });
