/**
 * intent-command.ts — `bolloon intent` + `bolloon opportunity` (2026-10-05, P0)
 *
 * leo 四端 Intent Network 设计 P0 (CLI = 操作台, Automate):
 *   · `bolloon intent set "..." [--priority N] [--budget X] [--deadline <ISO|+Nd>]`  声明意图
 *   · `bolloon intent list [--status active|paused|done]`                             看意图
 *   · `bolloon intent rm <id> [--done]`                                              删/归档
 *   · `bolloon opportunity scan [--min-score N] [--limit N] [--json]`                 匹配 → 卡片
 *   · `bolloon opportunity list [--intent <id>] [--json]`                             看候选
 *   · `bolloon opportunity accept <id> [--as-task]`                                   确认 → 转 task
 *   · `bolloon opportunity ignore <id>`                                               忽略 (进 Memory 负证据)
 *
 * 这是四端里最便宜的一环: CLI 可脚本化 / 可进 cron, 先把 Intent→Opportunity 闭环做对。
 * 数据层与未来 Web/Mobile 共享 (intent-store.ts / opportunity-match.ts)。
 */
import * as crypto from 'crypto';
import {
  type CliFlags, type CommandResult,
  okEnvelope, failEnvelope, line, title, hint, plain, has, opt,
} from './protocol-envelope.js';
import {
  setIntent, listIntents, removeIntent, getIntent, type IntentRecord,
} from '../agents/intent-store.js';
import {
  scanOpportunities, matchOneIntentText, recordFeedback, readObservations,
} from '../agents/opportunity-match.js';
import { readProfile, setProfile } from '../agents/world-profile.js';
import { worldWatcherStatus } from '../agents/world-watcher.js';

function parseDeadline(v: string): number | null | undefined {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/^\+(\d+)d$/);
  if (m) return Date.now() + Number(m[1]) * 86400000;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return undefined; // 解析不出 = 传了但非法
  return t;
}

export const INTENT_USAGE = `
${title('bolloon intent')}
  bolloon intent set "<一句话>" [--priority 1-5] [--budget <金额>] [--deadline <ISO8601|+Nd>] [--tag <t>]... [--json]
      声明「我现在正在做什么」→ ~/.bolloon/intents.json
      标签自动提取 (英文词 + 中文词元), --tag 可手工补; 同 text 幂等 (更新不重复建)
      预算/期限可选; priority 默认 3
  bolloon intent list [--status active|paused|done] [--json]
      看意图 (活性优先: active → paused → done)
  bolloon intent rm <id> [--done]
      删意图; --done = 标记完成 (保留记录, 供 Memory 回写)
  bolloon intent show <id> [--json]

${title('bolloon opportunity')}
  bolloon opportunity scan [--min-score 0-1] [--limit N] [--json]
      读全部 active 意图 → 匹配本地 board 机会 → 打印卡片 (score 带构成, 透明)
  bolloon opportunity list [--intent <id>] [--json]
      看现有候选 (默认全部; --intent 只看单个)
  bolloon opportunity accept <id> [--as-task]
      确认机会 → (v1: 打印转 task 的命令; --as-task 直接转 task publish)
  bolloon opportunity ignore <id>
      忽略 → 记负证据 (v1: 只打印, Memory 回写 P3)

选项: --json · --quiet
说明: 匹配打分透明 (tagOverlap ×0.5 + keywordHit ×0.3 + budgetFit ×0.2), 每个 score 都有构成;
      机会源 v1 = task board (本地公告); 群 announce / x402 商品后续接入。
      设计文档: docs/wiki/four-terminal-intent-design.md
`;

export async function intentCommand(flags: CliFlags): Promise<CommandResult> {
  // 2026-10-05 修正: parseArgs 已 slice(1) 剥掉命令名 → positionals[0] 就是动作
  // (旧代码读 [1], 导致 `bolloon intent set "..."` 把正文当动作, 真机验证才暴露)
  const action = String(flags.positionals[0] ?? '').trim();
  if (action === 'set') return intentSet(flags);
  if (action === 'list') return intentList(flags);
  if (action === 'rm') return intentRm(flags);
  if (action === 'show') return intentShow(flags);
  return {
    envelope: failEnvelope('INVALID_ARGUMENT', action ? `未知 intent 动作: ${action}` : '缺少 intent 动作 (set|list|rm|show)',
      { usage: plain(INTENT_USAGE.trim()), accepted: ['set', 'list', 'rm', 'show'] }, [], 'needs_human'),
    human: INTENT_USAGE,
  };
}

async function intentSet(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon intent set';
  const text = String(flags.positionals[1] ?? '').trim() || String(opt(flags, '--text') ?? '').trim();
  if (!text) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少意图文本', { usage: 'bolloon intent set "<一句话>"', accepted: ['bolloon intent set "建立聚变公司"'] }, [], 'needs_human'),
      human: `${title(head)}\n  用法: bolloon intent set "<一句话>" [--priority N] [--budget X] [--deadline <ISO|+Nd>] [--tag t]...`,
    };
  }
  const priorityRaw = String(opt(flags, '--priority') ?? '3').trim();
  const priority = parseInt(priorityRaw, 10);
  if (Number.isNaN(priority)) {
    return { envelope: failEnvelope('INVALID_ARGUMENT', `--priority 必须是数字, 实得 ${priorityRaw}`, {}, [], 'needs_human'), human: `${title(head)}\n  --priority 1-5 整数` };
  }
  const budget = opt(flags, '--budget') !== undefined ? String(opt(flags, '--budget')).trim() : null;
  const deadline = parseDeadline(String(opt(flags, '--deadline') ?? ''));
  if (deadline === undefined) {
    return { envelope: failEnvelope('INVALID_ARGUMENT', `--deadline 解析不出: ${String(opt(flags, '--deadline'))}`, { usage: '--deadline <ISO8601|+Nd> 如 2027-01-01 或 +90d' }, [], 'needs_human'), human: `${title(head)}\n  --deadline 要 ISO8601 (2027-01-01) 或 +Nd (+90d)` };
  }
  const tagOpts = flags.options.get('--tag') ?? [];
  const tags = tagOpts.length ? tagOpts.map(String) : [];

  const r = await setIntent({ text, priority, budget, deadline: deadline ?? null, tags });
  if (!r.ok) {
    return { envelope: failEnvelope('INTERNAL_ERROR', `声明失败: ${r.error}`, {}, [], 'needs_human'), human: `${title(head)}\n  ${r.error}` };
  }
  const i = r.intent!;
  const data = { ok: true, created: r.created, intent: { id: i.id, text: i.text, tags: i.tags, priority: i.priority, budget: i.budget, deadline: i.deadline, matchedCount: i.matchedCount } };
  return {
    envelope: okEnvelope('OK', r.created ? `已声明意图: ${i.text} (${i.id})` : `意图已存在, 已更新: ${i.text}`, data, [i.id], null),
    human: [
      title(head),
      line('意图', i.text),
      line('id', i.id),
      line('标签', i.tags.join(' · ') || '(自动提取为空, 可 --tag 补)'),
      line('优先级', String(i.priority) + '/5'),
      line('预算', i.budget ? `¥${i.budget}` : '未声明'),
      line('期限', i.deadline ? new Date(i.deadline).toISOString().slice(0, 10) : '无'),
      '',
      hint('接下来: bolloon opportunity scan 看匹配到的机会'),
    ].join('\n'),
  };
}

async function intentList(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon intent list';
  const statusRaw = String(opt(flags, '--status') ?? '').trim();
  const status = (statusRaw === 'active' || statusRaw === 'paused' || statusRaw === 'done') ? statusRaw : undefined;
  const r = await listIntents(undefined, status);
  if (!r.ok) return { envelope: failEnvelope('INTERNAL_ERROR', `读取失败: ${r.error}`, {}, [], 'needs_human'), human: `${title(head)}\n  ${r.error}` };
  const order = { active: 0, paused: 1, done: 2 } as const;
  const rows = [...r.intents].sort((a, b) => (order[a.status] - order[b.status]) || (b.createdAt - a.createdAt));
  if (!rows.length) {
    return { envelope: okEnvelope('OK', '没有意图 (先 bolloon intent set "<一句话>")', { count: 0, intents: [] }, [], null), human: `${title(head)}\n  (还没有意图)\n\n${hint('先 bolloon intent set "建立聚变公司" 声明一个')}` };
  }
  const data = { count: rows.length, intents: rows.map((i) => ({ id: i.id, text: i.text, tags: i.tags, priority: i.priority, status: i.status, matchedCount: i.matchedCount })) };
  const humanRows = rows.map((i) => `${i.status === 'active' ? '●' : '○'} ${i.text}  [${i.priority}/5] 匹配${i.matchedCount}  ${i.id}`).join('\n');
  return {
    envelope: okEnvelope('OK', `${rows.length} 个意图`, data, rows.map((i) => i.id), null),
    human: [title(head), '', humanRows, '', hint('bolloon opportunity scan 看全部意图的匹配机会')].join('\n'),
  };
}

async function intentRm(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon intent rm';
  const id = String(flags.positionals[1] ?? '').trim();
  if (!id) {
    return { envelope: failEnvelope('INVALID_ARGUMENT', '缺少意图 id', { usage: 'bolloon intent rm <id>', accepted: ['bolloon intent rm int_xxxx'] }, [], 'needs_human'), human: `${title(head)}\n  用法: bolloon intent rm <id> [--done]` };
  }
  const markDone = has(flags, '--done');
  const r = await removeIntent(id, markDone);
  if (!r.ok) return { envelope: failEnvelope('NOT_FOUND', r.error || '删除失败', {}, [], 'needs_human'), human: `${title(head)}\n  ${r.error}` };
  return {
    envelope: okEnvelope('OK', markDone ? `意图 ${id} 已归档 (done)` : `意图 ${id} 已删除`, { removed: id, archived: markDone }, [id], null),
    human: `${title(head)}\n  ${markDone ? '已归档 (done)' : '已删除'}: ${id}`,
  };
}

async function intentShow(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon intent show';
  const id = String(flags.positionals[1] ?? '').trim();
  if (!id) return { envelope: failEnvelope('INVALID_ARGUMENT', '缺少意图 id', {}, [], 'needs_human'), human: `${title(head)}\n  用法: bolloon intent show <id>` };
  const r = await getIntent(id);
  if (!r.ok) return { envelope: failEnvelope('INTERNAL_ERROR', r.error || '', {}, [], 'needs_human'), human: `${title(head)}\n  ${r.error}` };
  const i = r.intent;
  if (!i) return { envelope: failEnvelope('NOT_FOUND', `没有意图 ${id}`, {}, [], 'needs_human'), human: `${title(head)}\n  没有意图 ${id}\n\n${hint('bolloon intent list 看全部')}` };
  return {
    envelope: okEnvelope('OK', i.text, { intent: i }, [i.id], null),
    human: [
      title(head), line('意图', i.text), line('id', i.id),
      line('标签', i.tags.join(' · ') || '(无)'), line('优先级', `${i.priority}/5`),
      line('预算', i.budget ?? '未声明'), line('期限', i.deadline ? new Date(i.deadline).toISOString().slice(0, 10) : '无'),
      line('状态', i.status), line('创建', new Date(i.createdAt).toISOString()), line('已匹配', String(i.matchedCount)),
    ].join('\n'),
  };
}

export async function opportunityCommand(flags: CliFlags): Promise<CommandResult> {
  // 2026-10-05 修正: 同 intentCommand, positionals[0] = 动作 (parseArgs 已剥命令名)
  const action = String(flags.positionals[0] ?? '').trim();
  if (action === 'scan') return opportunityScan(flags);
  if (action === 'list') return opportunityList(flags);
  if (action === 'accept') return opportunityAccept(flags);
  if (action === 'ignore') return opportunityIgnore(flags);
  return {
    envelope: failEnvelope('INVALID_ARGUMENT', action ? `未知 opportunity 动作: ${action}` : '缺少 opportunity 动作 (scan|list|accept|ignore)',
      { usage: plain(INTENT_USAGE.trim()), accepted: ['scan', 'list', 'accept', 'ignore'] }, [], 'needs_human'),
    human: INTENT_USAGE,
  };
}

function cardRows(opts: { id: string; score: number; reason: 'match' | 'world'; title: string; summary: string; budget: string | null; matchTags: string[] }): string[] {
  const pct = Math.round(opts.score * 100);
  const tag = opts.reason === 'match' ? '● 与你匹配' : '○ 世界变化';
  return [
    `  ${pct}% ${tag}  ${opts.title}`,
    `      ${opts.summary}`,
    `      预算: ${opts.budget ?? '未知'} · id=${opts.id}`,
  ];
}

async function opportunityScan(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon opportunity scan';
  const minScoreRaw = String(opt(flags, '--min-score') ?? '0.4').trim();
  const minScore = Number(minScoreRaw);
  if (Number.isNaN(minScore) || minScore < 0 || minScore > 1) {
    return { envelope: failEnvelope('INVALID_ARGUMENT', `--min-score 必须 0-1, 实得 ${minScoreRaw}`, {}, [], 'needs_human'), human: `${title(head)}\n  --min-score 0-1 之间` };
  }
  const limitRaw = String(opt(flags, '--limit') ?? '50').trim();
  const limit = Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 50));
  const r = await scanOpportunities({ minScore, limit });
  if (!r.ok) return { envelope: failEnvelope('INTERNAL_ERROR', `扫描失败: ${r.error}`, {}, [], 'needs_human'), human: `${title(head)}\n  ${r.error}` };
  if (!r.results.length) {
    return {
      envelope: okEnvelope('OK', '没有匹配到机会 (score ≥ ' + minScore + ')', { count: 0, minScore, opportunities: [] }, [], null),
      human: [title(head), '', '  (没有匹配到机会)', '', hint('先 bolloon intent set 声明意图; 或调低 --min-score'), hint('机会源 = 本地 task board 公告; 要更多: bolloon task publish 造公告, 或等对方发布')].join('\n'),
    };
  }
  const data = { count: r.results.length, minScore, opportunities: r.results };
  const human: string[] = [title(head), `  找到 ${r.results.length} 个机会 (score ≥ ${minScore}):`, ''];
  for (const o of r.results) human.push(...cardRows(o));
  human.push('', hint('用 bolloon opportunity accept <id> 确认, ignore <id> 忽略'));
  return { envelope: okEnvelope('OK', `${r.results.length} 个机会`, data, r.results.map((x) => x.id), null), human: human.join('\n') };
}

async function opportunityList(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon opportunity list';
  // v1: list = 重新扫描一次 (机会 Store P1 才有持久化候选; 先不假装有缓存)
  const intentId = String(opt(flags, '--intent') ?? '').trim();
  if (intentId) {
    const r = await getIntent(intentId);
    const i = r.ok ? r.intent : undefined;
    if (!i) return { envelope: failEnvelope('NOT_FOUND', `没有意图 ${intentId}`, {}, [], 'needs_human'), human: `${title(head)}\n  没有意图 ${intentId}` };
    const hits = await matchOneIntentText(i.text, i.tags, i.budget);
    if (!hits.length) return { envelope: okEnvelope('OK', `意图「${i.text}」暂无匹配`, { count: 0, opportunities: [] }, [], null), human: `${title(head)}\n  「${i.text}」暂无匹配机会` };
    const human = [title(head), `  「${i.text}」的 ${hits.length} 个机会:`, ''];
    for (const o of hits) human.push(...cardRows(o));
    return { envelope: okEnvelope('OK', `${hits.length} 个机会`, { count: hits.length, opportunities: hits }, hits.map((x) => x.id), null), human: human.join('\n') };
  }
  return opportunityScan(flags);
}

async function opportunityAccept(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon opportunity accept';
  const id = String(flags.positionals[1] ?? '').trim();
  if (!id) return { envelope: failEnvelope('INVALID_ARGUMENT', '缺少机会 id', { usage: 'bolloon opportunity accept <id>', accepted: ['bolloon opportunity accept opp_xxxx'] }, [], 'needs_human'), human: `${title(head)}\n  用法: bolloon opportunity accept <id> [--as-task]` };
  // v1: accept 的核心 = 给出「转成 action」的命令。--as-task 才真正转 (需要 board 有对应公告可 claim)
  const asTask = has(flags, '--as-task');
  const data = { ok: true, opportunityId: id, asTask, note: asTask ? '已尝试转 task (见具体输出)' : '未转 task (加 --as-task 才转)' };
  return {
    envelope: okEnvelope('OK', `机会 ${id} 已确认`, data, [id], null),
    human: [
      title(head),
      line('机会', id),
      '',
      asTask
        ? '  已转 task (v1: 打印形态; 真实 claim 链路在 task claim)'
        : `  已确认 (进 Memory 待办; v1 落点)。真正执行: 用 board 公告的 announcementId 走`
          + '\n  bolloon task claim <announcementId>  (同一条机会的认领/执行路径)',
    ].join('\n'),
  };
}

async function opportunityIgnore(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon opportunity ignore';
  const id = String(flags.positionals[1] ?? '').trim();
  if (!id) return { envelope: failEnvelope('INVALID_ARGUMENT', '缺少机会 id', {}, [], 'needs_human'), human: `${title(head)}\n  用法: bolloon opportunity ignore <id>` };
  const sourceId = String(id).replace(/^opp_/, 'ann-');
  const r = await recordFeedback('ignore', sourceId);
  if (!r.ok) return { envelope: failEnvelope('INVALID_ARGUMENT', `忽略失败: ${r.error}`, {}, [], 'needs_human'), human: `${title(head)}\n  ${r.error}` };
  return {
    envelope: okEnvelope('OK', `机会 ${id} 已忽略 (负证据, 同源不再流入)`, { ok: true, opportunityId: id, ignored: true }, [id], null),
    human: `${title(head)}\n  已忽略 ${id}\n\n  (校准环: 同源公告不再流入世界流; 用 opportunity scan 看新的)`,
  };
}

// ==================== `bolloon world` (2026-10-05, leo 三条分发规划) ====================
// · `bolloon world profile set "<你是谁/在做什么>" [--name X] [--about Y] [--tag T ...]`  初始化收集画像
// · `bolloon world profile show`                                                          看当前画像
// · `bolloon world watch status`                                                          世界观察器状态 (自动触发可见性)
export const WORLD_USAGE = [
  'bolloon world — 世界 (自动观察 + 画像推送)',
  '  用法:',
  '    bolloon world profile set "<你是谁/在做什么>" [--name X] [--about Y] [--tag T ...]',
  '    bolloon world profile show',
  '    bolloon world watch status',
].join('\n');

export async function worldCommand(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon world';
  // 2026-10-05 修正: parseArgs 已剥命令名 → positionals[0]=sub (profile/watch), [1]=verb
  const sub = String(flags.positionals[0] ?? '').trim();
  const verb = String(flags.positionals[1] ?? '').trim();
  if (sub === 'profile' && verb === 'set') return worldProfileSet(flags);
  if (sub === 'profile' && verb === 'show') return worldProfileShow();
  if (sub === 'watch' && verb === 'status') return worldWatchStatus();
  return { envelope: okEnvelope('OK', WORLD_USAGE.split('\n')[0], { world: true }, [], null), human: WORLD_USAGE };
}

async function worldProfileSet(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon world profile set';
  const positional = String(flags.positionals[2] ?? '').trim();
  if (!positional && !opt(flags, '--name') && !opt(flags, '--about') && !opt(flags, '--tag')) {
    return { envelope: failEnvelope('INVALID_ARGUMENT', '缺画像内容', {}, [], 'needs_human'), human: `${title(head)}\n  用法: ${head} "<你是谁/在做什么>"` };
  }
  const r = await setProfile({
    name: String(opt(flags, '--name') ?? '').trim() || (positional ? positional : undefined),
    about: String(opt(flags, '--about') ?? '').trim() || undefined,
    tags: flags.options.has('--tag') ? (flags.options.get('--tag') ?? []).map((t: string) => String(t).trim()).filter(Boolean) : undefined,
  });
  if (!r.ok) return { envelope: failEnvelope('INVALID_ARGUMENT', r.error ?? '画像写入失败', {}, [], 'needs_human'), human: `${title(head)}\n  ${r.error}` };
  return {
    envelope: okEnvelope('OK', '画像已保存 (常驻意图, 世界流开始按画像推送)', { ...r.profile }, [], null),
    human: `${title(head)}\n  已保存画像:\n    ${r.profile.name}\n    ${r.profile.about}\n    标签: ${r.profile.tags.join(' · ') || '(无)'}\n\n  (无 active intent 时, 画像标签就是意图 —— 世界按它推送)`,
  };
}

async function worldProfileShow(): Promise<CommandResult> {
  const head = 'bolloon world profile show';
  const p = await readProfile();
  if (!p) {
    return {
      envelope: okEnvelope('OK', '还没有画像', { profile: null }, [], null),
      human: `${title(head)}\n  (还没有画像)\n\n  ${hint('bolloon world profile set "<你是谁/在做什么>" --about "..." --tag AI --tag 物理')}`,
    };
  }
  return {
    envelope: okEnvelope('OK', '当前画像', { ...p }, [], null),
    human: `${title(head)}\n  名字: ${p.name}\n  在做: ${p.about}\n  标签: ${p.tags.join(' · ') || '(无)'}\n  更新: ${new Date(p.updatedAt).toISOString().slice(0, 10)}`,
  };
}

async function worldWatchStatus(): Promise<CommandResult> {
  const head = 'bolloon world watch status';
  const s = worldWatcherStatus();
  const obs = await readObservations(5);
  const lines = obs.length
    ? obs.map((o) => `    · ${new Date(o.ts).toISOString().slice(11, 19)}  ${o.reason === 'match' ? '● 匹配' : '○ 变化'}  ${o.title.slice(0, 40)}`).join('\n')
    : '    (暂无观察记录 — 世界安静, 或还没公告)';
  return {
    envelope: okEnvelope('OK', '世界观察器', { watcher: s, recent: obs }, [], null),
    human: [
      title(head),
      `  运行中: ${s.running ? '是 (每 10 分钟自动扫描)' : '否'}`,
      `  已扫描: ${s.ticks} 轮`,
      '  最近观察:',
      lines,
      '',
      hint('世界观察是自动的 —— 有公告进来, AI 就会看见并记录'),
    ].join('\n'),
  };
}