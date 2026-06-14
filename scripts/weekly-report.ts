#!/usr/bin/env tsx
/**
 * weekly-report.ts — Bolloon 每周表现报告 (阶段 B)
 *
 * 输入:
 *   ~/.bolloon/human-values/evolution.jsonl      (接受/拒绝/回滚事件)
 *   ~/.bolloon/human-values/usage.jsonl          (judgment 使用记录)
 *   ~/.bolloon/human-values/counterfactual-audit.jsonl (反事实审计)
 *   ~/.bolloon/human-values/judgments.json       (当前 judgment 库)
 *   ~/.bolloon/self-improve-audit.log            (改源码尝试的审计, 即使被拒)
 *
 * 输出:
 *   ~/.bolloon/reports/2026-W24.md  (markdown 报告)
 *
 * 设计原则:
 *   - 纯本地计算 + 纯函数式分析 (不调 LLM, 避免幻觉)
 *   - 周范围默认 ISO 周(周一为起点), 可 --week 2026-W24 指定
 *   - 不写 judgments.json, 不动 persona, 仅追加 reports/*.md
 *   - 失败静默 + 退出码 != 0 让 cron 知道坏了
 *
 * 用法:
 *   tsx scripts/weekly-report.ts                # 生成上周
 *   tsx scripts/weekly-report.ts --week 2026-W24  # 指定周
 *   tsx scripts/weekly-report.ts --week 2026-W24 --dry-run
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const HOME = () => os.homedir() || process.env.HOME || '/tmp';
const ROOT = () => HOME() + '/.bolloon';
const REPORTS_DIR = () => ROOT() + '/reports';

const FILES = {
  evolution: () => ROOT() + '/human-values/evolution.jsonl',
  usage: () => ROOT() + '/human-values/usage.jsonl',
  counterfactual: () => ROOT() + '/human-values/counterfactual-audit.jsonl',
  judgments: () => ROOT() + '/human-values/judgments.json',
  selfImproveAudit: () => ROOT() + '/self-improve-audit.log',
};

interface EvolutionEntry {
  ts: string;
  action: 'accept' | 'reject' | 'revert';
  suggestion: { kind: string; judgmentId: string; action: string };
  appliedPatch?: Record<string, unknown>;
}
interface UsageEntry {
  ts: string;
  channelId: string | null;
  userInputPreview: string;
  usedIds: string[];
}
interface CounterfactualEntry {
  ts: string;
  trigger: { userInput: string; aiReply: string; violatedPrinciples: unknown[] };
  verdict: string;
  recomendaciones?: string[];
}

async function readJsonl<T>(p: string): Promise<T[]> {
  try {
    const content = await fs.readFile(p, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as T;
        } catch {
          return null;
        }
      })
      .filter((e): e is T => Boolean(e));
  } catch {
    return [];
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function isoWeekString(d: Date): string {
  // ISO week: 1 = 包含 1 月 4 日的那周
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7; // 周一=0
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((target.valueOf() - firstThursday.valueOf()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
    );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weekRange(iso: string): { start: Date; end: Date } {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(iso);
  if (!m) throw new Error(`bad ISO week: ${iso}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  // ISO 周 1 是包含 1 月 4 日的那周
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7; // 周一=0
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4Day);
  const start = new Date(week1Mon);
  start.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start, end };
}

function inWeek(ts: string, start: Date, end: Date): boolean {
  const t = new Date(ts).getTime();
  return t >= start.getTime() && t < end.getTime();
}

function pct(n: number, d: number): string {
  if (d === 0) return 'n/a';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function topN<T>(arr: T[], key: (x: T) => string, n: number): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const x of arr) {
    const k = key(x);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

interface Report {
  week: string;
  range: { start: string; end: string };
  generatedAt: string;
  summary: {
    totalUsage: number;
    uniqueChannels: number;
    uniqueJudgments: number;
    evolutionEvents: number;
    acceptRate: number;
    rejected: number;
    reverted: number;
    counterfactualScans: number;
  };
  topJudgments: Array<[string, number]>;
  topKinds: Array<[string, number]>;
  policyAudit: {
    selfImproveAttempts: number;
    blockedByPolicy: number;
    note: string;
  };
  openQuestions: string[];
}

async function buildReport(weekIso: string): Promise<Report> {
  const { start, end } = weekRange(weekIso);

  const [evolution, usage, counterfactual, judgments, audit] = await Promise.all([
    readJsonl<EvolutionEntry>(FILES.evolution()),
    readJsonl<UsageEntry>(FILES.usage()),
    readJsonl<CounterfactualEntry>(FILES.counterfactual()),
    readJson<unknown[]>(FILES.judgments()),
    (async () => {
      try {
        const txt = await fs.readFile(FILES.selfImproveAudit(), 'utf-8');
        return txt.split('\n').filter(Boolean);
      } catch {
        return [];
      }
    })(),
  ]);

  const evoInWeek = evolution.filter((e) => inWeek(e.ts, start, end));
  const useInWeek = usage.filter((u) => inWeek(u.ts, start, end));
  const cfInWeek = counterfactual.filter((c) => inWeek(c.ts, start, end));
  const auditInWeek = audit.filter((line) => {
    // audit 是日志行, 格式不一定, 简单按日期前缀过滤
    const d = line.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!d) return false;
    const ts = new Date(d[1] + 'T00:00:00Z').getTime();
    return ts >= start.getTime() && ts < end.getTime();
  });

  const totalUsage = useInWeek.length;
  const channels = new Set(useInWeek.map((u) => u.channelId || 'null'));
  const ids = new Set<string>();
  for (const u of useInWeek) for (const id of u.usedIds) ids.add(id);

  const accepts = evoInWeek.filter((e) => e.action === 'accept').length;
  const rejects = evoInWeek.filter((e) => e.action === 'reject').length;
  const reverts = evoInWeek.filter((e) => e.action === 'revert').length;
  const acceptRate = accepts + rejects === 0 ? 0 : accepts / (accepts + rejects);

  // 自改审计 (路径白/黑名单拦截)
  const selfImproveAttempts = auditInWeek.filter((l) => /attempt|尝试/i.test(l)).length;
  const blockedByPolicy = auditInWeek.filter((l) => /block|deny|拒绝|denylist/i.test(l)).length;

  return {
    week: weekIso,
    range: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    generatedAt: new Date().toISOString(),
    summary: {
      totalUsage,
      uniqueChannels: channels.size,
      uniqueJudgments: ids.size,
      evolutionEvents: evoInWeek.length,
      acceptRate,
      rejected: rejects,
      reverted: reverts,
      counterfactualScans: cfInWeek.length,
    },
    topJudgments: topN(useInWeek.flatMap((u) => u.usedIds.map((id) => ({ id }))), (x) => x.id, 10),
    topKinds: topN(evoInWeek, (e) => e.suggestion.kind, 5),
    policyAudit: {
      selfImproveAttempts,
      blockedByPolicy,
      note: selfImproveAttempts === 0 ? '本周无源码自改尝试(护栏未触发)' : '见 self-improve-audit.log',
    },
    openQuestions: openQuestions(evoInWeek, cfInWeek, useInWeek),
  };
}

function openQuestions(evo: EvolutionEntry[], cf: CounterfactualEntry[], use: UsageEntry[]): string[] {
  const out: string[] = [];
  if (evo.length === 0 && use.length > 0) {
    out.push('本周有使用但无自适应建议 → 可能 judgment 库太稳定, 或扫描器未触发');
  }
  if (use.length === 0) {
    out.push('本周无 judgment 使用记录 → 检查 usage.jsonl 是否在写, 或渠道是否活跃');
  }
  if (cf.length > 0) {
    const conflictCount = cf.filter((c) => /冲突|conflict|不合理/i.test(c.verdict)).length;
    if (conflictCount > 0) {
      out.push(`反事实审计发现 ${conflictCount} 条潜在冲突 → 看 counterfactual-audit.jsonl`);
    }
  }
  const reverts = evo.filter((e) => e.action === 'revert').length;
  if (reverts >= 2) {
    out.push(`本周回滚 ${reverts} 次 → 类 B 建议可能过激, 考虑收紧阈值`);
  }
  return out;
}

function toMarkdown(r: Report, totalJudgments: number): string {
  const lines: string[] = [];
  lines.push(`# 📊 Bolloon 周报 — ${r.week}`);
  lines.push('');
  lines.push(`> 范围: ${r.range.start} → ${r.range.end} · 生成于 ${r.generatedAt}`);
  lines.push('');
  lines.push('## 核心数字');
  lines.push('');
  lines.push('| 指标 | 本周 |');
  lines.push('|------|------|');
  lines.push(`| judgment 调用次数 | ${r.summary.totalUsage} |`);
  lines.push(`| 触达渠道数 | ${r.summary.uniqueChannels} |`);
  lines.push(`| 用到的不同 judgment 数 | ${r.summary.uniqueJudgments} |`);
  lines.push(`| 自适应事件数 | ${r.summary.evolutionEvents} |`);
  lines.push(`| 接受率 | ${pct(r.summary.acceptRate * 100, 100)} (${Math.round(r.summary.acceptRate * 100)}%) |`);
  lines.push(`| 拒绝数 | ${r.summary.rejected} |`);
  lines.push(`| 回滚数 | ${r.summary.reverted} |`);
  lines.push(`| 反事实审计次数 | ${r.summary.counterfactualScans} |`);
  lines.push(`| 当前 judgment 库总条数 | ${totalJudgments} |`);
  lines.push('');
  lines.push('## 最常被引用的 judgment');
  lines.push('');
  if (r.topJudgments.length === 0) {
    lines.push('_(本周无引用)_');
  } else {
    for (const [id, n] of r.topJudgments) {
      lines.push(`- \`${id}\` × ${n}`);
    }
  }
  lines.push('');
  lines.push('## 自适应建议类型分布');
  lines.push('');
  if (r.topKinds.length === 0) {
    lines.push('_(本周无自适应事件)_');
  } else {
    for (const [kind, n] of r.topKinds) {
      lines.push(`- **${kind}** × ${n}`);
    }
  }
  lines.push('');
  lines.push('## 护栏审计');
  lines.push('');
  lines.push(`- 源码自改尝试: **${r.policyAudit.selfImproveAttempts}**`);
  lines.push(`- 被策略拦截: **${r.policyAudit.blockedByPolicy}**`);
  lines.push(`- ${r.policyAudit.note}`);
  lines.push('');
  lines.push('## 关注事项');
  lines.push('');
  if (r.openQuestions.length === 0) {
    lines.push('_(本周一切正常, 无特别关注)_');
  } else {
    for (const q of r.openQuestions) {
      lines.push(`- ${q}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('> 本报告由 `scripts/weekly-report.ts` 纯本地生成, 不调 LLM. 数据源见 ~/.bolloon/human-values/');
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv: string[]): { week?: string; dryRun: boolean } {
  const out: { week?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--week' && argv[i + 1]) {
      out.week = argv[++i];
    } else if (argv[i] === '--dry-run') {
      out.dryRun = true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // 默认: 上周(更合理 — 周末才回顾)
  const now = new Date();
  const lastWeek = new Date(now);
  lastWeek.setUTCDate(now.getUTCDate() - 7);
  const week = args.week || isoWeekString(lastWeek);
  const { start, end } = weekRange(week);

  console.log(`[weekly-report] 生成 ${week} (${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)})`);

  const r = await buildReport(week);
  const judgments = (await readJson<unknown[]>(FILES.judgments())) || [];
  const md = toMarkdown(r, judgments.length);

  const outDir = REPORTS_DIR();
  const outPath = path.join(outDir, `${week}.md`);

  if (args.dryRun) {
    console.log(`[weekly-report] DRY-RUN, 不会写盘. 输出预览:`);
    console.log('---');
    console.log(md);
    console.log('---');
    return;
  }

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outPath, md, 'utf-8');
  console.log(`[weekly-report] ✅ 写入 ${outPath} (${md.length} bytes)`);
}

main().catch((err) => {
  console.error('[weekly-report] ❌ 失败:', err);
  process.exit(1);
});
