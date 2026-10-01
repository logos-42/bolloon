/**
 * 回合后自审 → 沉淀可复用经验 (2026-10-01, 用户「落实」)。
 *
 * 为什么: 智能体目前只在**回合内**反应 —— 做完就完了, 经验不落库。飞轮目标里"结束后沉淀可复用经验"
 *   是唯一还没动工的一段。做法学的是运行时那套**回合后自审**的机制, 约束照搬:
 *     · 只写**沉淀库**, **绝不碰主对话 / prompt 缓存**(所以纯旁路, 不影响用户看到的内容);
 *     · **不阻塞主回合**: 调用方 fire-and-forget, 本模块自己吞掉所有异常;
 *     · **工具白名单**: v1 连工具都不用 —— 只把"本回合摘要 + 现有库目录"喂给模型, 要它回一段 JSON;
 *     · **fail-open**: 节流/配置读不出来时**放行**(宁可偶尔多审一次, 不要因配置坏掉就永久不审);
 *     · **绝不编造**: 没有值得记的就回 none, 那就什么都不写(写空是正常结果, 不是失败)。
 * 库的形态(反囤积): `~/.bolloon/experience/<类>.md`, **类级**文件 + 条目标题去重 ——
 *   「同一教训学两次 = 改那一条, 不是加一条」。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const EXPERIENCE_DIR_NAME = 'experience';
/** 同一个 agent 两次自审的最小间隔 (默认 10 分钟; 可用 BOLLOON_EXPERIENCE_REVIEW_MIN_MS 覆盖) */
export const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000;

export interface ReviewDecision {
  action: 'none' | 'write';
  /** 类级归类 (决定写进哪个文件), 如 bolloon-cli / identity / p2p */
  klass?: string;
  title?: string;
  body?: string;
  reason?: string;
}

export function experienceDir(home = os.homedir()): string {
  return path.join(home, '.bolloon', EXPERIENCE_DIR_NAME);
}

/** 类名净化 (只允许安全字符; 空 ⇒ 'general') */
export function sanitizeClass(k: unknown): string {
  const s = String(k ?? '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'general';
}

/** 条目标题净化 (空 ⇒ 拒绝写: 没有标题的沉淀无法去重, 宁可不要) */
export function sanitizeTitle(t: unknown): string {
  return String(t ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * 节流判据 (纯函数)。**fail-open**: 时间戳坏了/缺失 ⇒ 放行。
 * @param lastAtMs 上一次自审时间 (0/undefined = 从未)
 */
export function shouldReview(
  nowMs: number,
  lastAtMs: number | undefined,
  minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS,
): boolean {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return true;          // 时钟坏了 ⇒ 放行 (fail-open)
  if (!lastAtMs || !Number.isFinite(lastAtMs) || lastAtMs <= 0) return true; // 从未审过 ⇒ 放行
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) return true;    // 配置坏了 ⇒ 放行 (fail-open)
  return nowMs - lastAtMs >= minIntervalMs;
}

/** 现有库的目录 (喂给模型, 让它知道"已经有哪些类/条目", 从而倾向于改而不是加) */
export function listExperienceIndex(home = os.homedir()): string {
  const dir = experienceDir(home);
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    if (!files.length) return '(沉淀库还是空的)';
    return files.slice(0, 30).map((f) => {
      const body = fs.readFileSync(path.join(dir, f), 'utf-8');
      const titles = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 20);
      return `- ${f} (${titles.length} 条)\n${titles.map((t) => `    · ${t}`).join('\n')}`;
    }).join('\n');
  } catch {
    return '(沉淀库还是空的)';
  }
}

/**
 * 自审提示词 (纯函数)。**反囤积**规矩逐条写进去 —— 这是"库会变干净还是变垃圾堆"的分水岭。
 */
export function buildReviewPrompt(turnSummary: string, existingIndex: string): string {
  return [
    '你在做**回合后自审**: 判断上面这一回合里有没有值得沉淀成"可复用经验"的东西。',
    '',
    '已经沉淀过的(先看这里, 别重复):',
    existingIndex,
    '',
    '这一回合发生了什么:',
    '"""',
    String(turnSummary || '').slice(0, 6000),
    '"""',
    '',
    '规矩(按这个判):',
    '1. **同一教训学两次 = 一条规矩**: 若上面已有同类条目 ⇒ 用同一个 title, 表示"更新那一条"; 否则才算新条目。',
    '2. 只沉淀**可复用**的: 类级规律 · 踩过的坑与判据 · 用户对做法/风格的纠正 · 稳定的环境事实。',
    '3. **不要**沉淀: 本次事件叙述 · 版本号/日期流水 · 一次性任务进度 · 环境依赖型失败(缺二进制、首次安装报错)。',
    '4. 没有值得记的就回 none —— **写空是正常结果**, 不是失败; 编一条凑数比不写更糟。',
    '5. 内容要短: title ≤ 60 字, body ≤ 400 字, body 写"规矩 + 为什么", 不写过程。',
    '',
    '只回一个 JSON(不要别的文字):',
    '{"action":"none"} 或 {"action":"write","class":"类名(小写-连字符)","title":"一句话标题","body":"规矩与理由"}',
  ].join('\n');
}

/** 容错解析模型回的那段 JSON (纯函数)。任何异常/不完整 ⇒ none (绝不半写) */
export function parseReviewDecision(text: string): ReviewDecision {
  const raw = String(text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { action: 'none', reason: '没找到 JSON' };
  try {
    const j = JSON.parse(m[0]);
    if (String(j?.action || '').toLowerCase() !== 'write') return { action: 'none' };
    const title = sanitizeTitle(j.title);
    const body = String(j?.body ?? '').trim().slice(0, 800);
    if (!title || !body) return { action: 'none', reason: 'title/body 不全' };   // 宁可丢, 不写半条
    return { action: 'write', klass: sanitizeClass(j.class), title, body };
  } catch {
    return { action: 'none', reason: 'JSON 解析失败' };
  }
}

/**
 * 落库: **同 title 就更新那一条**(hit+1, 替换正文), 否则追加。
 * @returns 实际动作, 便于测试与日志
 */
export function applyExperience(d: ReviewDecision, home = os.homedir(), nowIso = new Date().toISOString()):
  { wrote: false } | { wrote: true; file: string; updated: boolean } {
  if (d.action !== 'write' || !d.title || !d.body) return { wrote: false };
  const dir = experienceDir(home);
  const file = path.join(dir, `${sanitizeClass(d.klass)}.md`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let cur = '';
    try { cur = fs.readFileSync(file, 'utf-8'); } catch { cur = ''; }
    const header = cur.trim() ? cur : `# 可复用经验 · ${sanitizeClass(d.klass)}\n\n> 回合后自审沉淀; 同一教训只留一条(重复出现则更新) · 每条带出现次数与末次时间\n`;
    // 2026-10-01 修: 上一版用正则 `...(?=^## |\Z)` 找条目边界 —— **JS 不支持 \Z**, 它被当成字面量 Z,
    //   而条目的时间戳正好以 Z 结尾 ⇒ 从那儿截断, 更新后留下旧正文残渣(实跑看到: "Z -->" + 旧正文)✗。
    //   改成**按 `## ` 切块再拼** —— 不依赖任何正则边界语义。
    const blockOf = (t: string, body: string, hits: number): string =>
      `## ${t}\n<!-- hit:${hits} last:${nowIso} -->\n${body}\n`;
    const parts = header.split(/\n(?=## )/);
    const head = parts[0].trimEnd();
    const entries = parts.slice(1).filter((x) => x.trim().startsWith('## '));
    const titleOf = (blk: string) => (blk.split('\n')[0] || '').replace(/^##\s*/, '').trim();
    const hitsOf = (blk: string) => Number((blk.match(/<!--\s*hit:(\d+)/) || [])[1] || 0);
    const idx = entries.findIndex((blk) => titleOf(blk) === d.title);
    if (idx >= 0) {
      const n = hitsOf(entries[idx]) + 1;              // 上一次次数 + 本次 (更新 ⇒ 至少 2)
      entries[idx] = blockOf(d.title, d.body, n);
      fs.writeFileSync(file, head + '\n\n' + entries.map((x) => x.trimEnd()).join('\n\n') + '\n', 'utf-8');
      return { wrote: true, file, updated: true };
    }
    entries.push(blockOf(d.title, d.body, 1));
    fs.writeFileSync(file, head + '\n\n' + entries.map((x) => x.trimEnd()).join('\n\n') + '\n', 'utf-8');
    return { wrote: true, file, updated: false };
  } catch {
    return { wrote: false };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/**
 * 自审编排 (纯旁路, **绝不抛错**)。
 *
 * `chat` 由调用方注入 (便于门测; 生产用现成的单次补全)。整段逻辑:
 *   节流 ⇒ 取库目录 ⇒ 拼提示 ⇒ 一次补全 ⇒ 解析 ⇒ 落库。
 * 任何一步失败都只是"这次没沉淀", 不影响主回合 —— 调用方 fire-and-forget 即可。
 */
export async function runExperienceReview(opts: {
  turnSummary: string;
  chat: (prompt: string) => Promise<string>;
  home?: string;
  nowMs?: number;
  lastAtMs?: number;
  minIntervalMs?: number;
  log?: (msg: string) => void;
}): Promise<{ reviewed: boolean; applied: boolean; file?: string; updated?: boolean; reason?: string }> {
  const home = opts.home || os.homedir();
  const now = opts.nowMs ?? Date.now();
  const log = opts.log || (() => { /* 静默 */ });
  try {
    if (!shouldReview(now, opts.lastAtMs, opts.minIntervalMs)) return { reviewed: false, applied: false, reason: 'throttled' };
    const summary = String(opts.turnSummary || '').trim();
    if (summary.length < 40) return { reviewed: false, applied: false, reason: '回合太短, 不值得审' };
    const prompt = buildReviewPrompt(summary, listExperienceIndex(home));
    const raw = await opts.chat(prompt);
    const d = parseReviewDecision(raw);
    if (d.action !== 'write') return { reviewed: true, applied: false, reason: d.reason || 'none' };
    const r = applyExperience(d, home, new Date(now).toISOString());
    if (r.wrote) log(`[experience] ${r.updated ? '更新' : '新增'} ${path.basename(r.file)} · ${d.title}`);
    return { reviewed: true, applied: r.wrote, file: r.wrote ? r.file : undefined, updated: r.wrote ? r.updated : undefined };
  } catch (e: any) {
    log(`[experience] 自审跳过(非致命): ${String(e?.message || e).slice(0, 120)}`);
    return { reviewed: false, applied: false, reason: 'error' };
  }
}
