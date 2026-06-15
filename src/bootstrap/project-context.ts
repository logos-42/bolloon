/**
 * Project Context Formatter — BolloonContext → system prompt 片段
 *
 * 输出 markdown 文本, 直接拼到 LLM system prompt 头部
 *
 * 字符上限默认 4000 (system prompt 不能太长).
 * 超限时按优先级砍: TODO 列表 → 压缩 Bolloon.md → 砍 judgments top values
 */

import type { BolloonContext } from './context-collector.js';

const DEFAULT_MAX_CHARS = 8000;  // 从 4000 提到 8000, 给 4 级 Bolloon.md 留空间
const BOLLOON_MD_KEEP = 500;  // 砍到这么长

export function formatContextForSystemPrompt(
  ctx: BolloonContext,
  opts: { maxChars?: number } = {}
): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const lines: string[] = [];
  lines.push(`# 你的项目上下文 (自动 bootstrap, 时间: ${ctx.collectedAt})`);
  lines.push('');

  // 1. Bolloon.md 4 级层次 (Claude Code 论文, 严格 1:1)
  //    managed → user → project → local, 已在 collector 层 merge
  if (ctx.hierarchy && ctx.hierarchy.merged && ctx.hierarchy.merged.length > 0) {
    lines.push('## 规则层次 (4 级, Claude Code 论文对齐)');
    lines.push(ctx.hierarchy.merged);
    lines.push('');
  }

  // 1b. 项目名 + Bolloon.md 摘要 (向后兼容, Bolloon.md 也算 project 层之一)
  lines.push(`## 项目: ${ctx.projectName}`);
  lines.push(`- 路径: ${ctx.projectRoot}`);
  if (ctx.bolloonMd) {
    const mdSummary = firstParagraphs(ctx.bolloonMd, 3);
    lines.push(`- Bolloon.md 摘要:`);
    lines.push(mdSummary);
  } else {
    lines.push(`- Bolloon.md: (缺失, 建议创建)`);
  }
  lines.push('');

  // 2. Git
  if (ctx.git) {
    lines.push(`## Git 状态`);
    lines.push(`- branch: ${ctx.git.branch}`);
    lines.push(`- 未提交变更: ${ctx.git.uncommittedChanges}`);
    if (ctx.git.lastCommits.length > 0) {
      lines.push(`- 最近提交:`);
      for (const c of ctx.git.lastCommits) {
        lines.push(`  - ${c}`);
      }
    }
    lines.push('');
  }

  // 3. Persona
  if (ctx.persona) {
    lines.push(`## 用户身份 (persona)`);
    lines.push(`- 名字: ${ctx.persona.name}`);
    if (ctx.persona.description) lines.push(`- 描述: ${ctx.persona.description}`);
    if (ctx.persona.personality) lines.push(`- 性格: ${ctx.persona.personality}`);
    lines.push('');
  }

  // 4. Judgments
  if (ctx.judgmentsSummary.total > 0) {
    const j = ctx.judgmentsSummary;
    lines.push(`## 已沉淀的判断力 (${j.total} 条)`);
    lines.push(`- 活跃: ${j.active}, 已过时: ${j.superseded}, 已拒绝: ${j.rejected}`);
    if (j.topValues.length > 0) {
      const topStr = j.topValues.map((v) => `${v.category}/${v.value}`).join(', ');
      lines.push(`- Top 价值偏好: [${topStr}]`);
    }
    lines.push('');
  }

  // 5. Skills
  if (ctx.skills.length > 0) {
    lines.push(`## 工具 + Skills`);
    lines.push(`- 已注册 skills (${ctx.skills.length}):`);
    for (const s of ctx.skills) {
      const desc = s.description ? ` — ${s.description}` : '';
      lines.push(`  - ${s.name}${desc}`);
    }
    lines.push('');
  }

  // 6. Pending
  if (ctx.pending.goals.length > 0 || ctx.pending.todos.length > 0) {
    lines.push(`## 未完成任务`);
    if (ctx.pending.goals.length > 0) {
      lines.push(`- ~/.bolloon/goals/: ${ctx.pending.goals.length} 条 (${ctx.pending.goals.slice(0, 3).join(', ')}${ctx.pending.goals.length > 3 ? '...' : ''})`);
    }
    if (ctx.pending.todos.length > 0) {
      lines.push(`- 代码 TODO/FIXME: ${ctx.pending.todos.length} 处`);
      for (const t of ctx.pending.todos.slice(0, 5)) {
        lines.push(`  - ${t.file}:${t.line} ${t.text}`);
      }
    }
    lines.push('');
  }

  // 7. 环境 (放最后, 信息密度低)
  lines.push(`## 环境`);
  lines.push(`- ${ctx.env.os}, Node ${ctx.env.nodeVersion}, LLM: ${ctx.env.llmProvider}`);

  // 字符截断
  let result = lines.join('\n');
  if (result.length > maxChars) {
    result = truncateContext(ctx, maxChars);
  }
  return result;
}

/**
 * 超限时按优先级砍: TODO 列表 → 压缩 Bolloon.md → 砍 top values
 */
function truncateContext(ctx: BolloonContext, maxChars: number): string {
  // 先砍 TODO 列表 (low value)
  const todoCapped = ctx.pending.todos.slice(0, 3);
  const goalsCapped = ctx.pending.goals.slice(0, 2);
  // 再砍 Bolloon.md
  const mdCapped = ctx.bolloonMd
    ? firstParagraphs(ctx.bolloonMd, 1, BOLLOON_MD_KEEP)
    : null;
  // 砍 top values
  const topValuesCapped = ctx.judgmentsSummary.topValues.slice(0, 5);

  const lines: string[] = [];
  lines.push(`# 你的项目上下文 (自动 bootstrap, 时间: ${ctx.collectedAt}, 截断模式)`);
  lines.push(`## 项目: ${ctx.projectName}`);
  if (mdCapped) {
    lines.push(`- Bolloon.md (压缩): ${mdCapped.split('\n')[0]?.substring(0, 100)}...`);
  }
  if (ctx.git) {
    lines.push(`## Git: ${ctx.git.branch} (未提交: ${ctx.git.uncommittedChanges})`);
    for (const c of ctx.git.lastCommits.slice(0, 3)) lines.push(`  - ${c}`);
  }
  if (ctx.persona) lines.push(`## Persona: ${ctx.persona.name}`);
  if (ctx.judgmentsSummary.total > 0) {
    lines.push(`## 判断力: ${ctx.judgmentsSummary.total} 条 (活跃 ${ctx.judgmentsSummary.active})`);
    if (topValuesCapped.length > 0) {
      lines.push(`- Top: ${topValuesCapped.map((v) => `${v.category}/${v.value}`).join(', ')}`);
    }
  }
  if (ctx.skills.length > 0) {
    lines.push(`## Skills (${ctx.skills.length}): ${ctx.skills.map((s) => s.name).join(', ')}`);
  }
  if (todoCapped.length > 0) {
    lines.push(`## TODO (${todoCapped.length}/${ctx.pending.todos.length})`);
    for (const t of todoCapped) lines.push(`  - ${t.file}:${t.line} ${t.text}`);
  }
  if (goalsCapped.length > 0) {
    lines.push(`## Goals: ${goalsCapped.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * 取前 N 段非空段落
 */
function firstParagraphs(text: string, count: number, maxLen?: number): string {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  let result = paragraphs.slice(0, count).join('\n\n');
  if (maxLen && result.length > maxLen) {
    result = result.substring(0, maxLen) + '...';
  }
  return result;
}
