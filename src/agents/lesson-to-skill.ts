/**
 * 教训 ⇒ 技能 (2026-10-01, 用户: 「skills 教训学习, bolloon 有吗
 * 查下来的事实: bolloon **三块都有** —— 回合后自审(`experience-review.ts` ✓) · 技能读写(`skill-loader`/`skill-writer` ✓) ·
 *   技能库(`~/.bolloon/skills/`, 实测 1301 个 ✓) —— **但中间没有线** ✗: 复盘产出的教训只落到
 *   `~/.bolloon/experience/<类>.md` ✗, **从不写回技能** ✗ ⇒ 教训与技能库是两座孤岛。
 * 抄来的三条纪律(来自运行时那套的回合后自审流程 ✓, 用 bolloon 自己的话写):
 *   ① **先找已有的**(umbrella)再考虑新建 —— 1301 个技能已够碎, 再自动新建只会更碎 ✗;
 *   ② **读后写**: 要改某个 SKILL.md 必须先把它读进来(读不到就**不写**, 绝不盲改 ✗);
 *   ③ **匹配不够强就不写技能**, 只留经验条目(宁缺勿碎 ✓)。
 * 纯函数为主 ⇒ 可测。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface LessonLike {
  title: string;
  body: string;
  klass?: string;
}
export interface SkillLike {
  name: string;
  description?: string;
  /** SKILL.md 的绝对路径 (有才能改写) */
  file?: string;
}

/** 匹配强度门槛: 重叠词数 ≥ 这个值才算"就是讲这件事的技能" */
export const LESSON_MATCH_MIN_SCORE = 3;

const STOP = new Set(['the', 'and', 'for', 'with', 'use', 'when', 'skill', '技能', '的', '和', '与', '在', '是', '要', '不', '有']);

/** 粗略分词: 英文按词、中文按 2 字滑窗 —— 够用且便宜(不引分词库 ✓) */
export function tokens(text: string): string[] {
  const s = String(text ?? '').toLowerCase();
  const out = new Set<string>();
  for (const w of s.match(/[a-z0-9_-]{2,}/g) || []) if (!STOP.has(w)) out.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
  // 2026-10-01 校准: 中文用 **3 字**窗口 —— 2 字窗口在 1300 个技能里误命中率太高(实测 "提交" 撞无关技能 ✗)
  for (const run of cjk.split(/\s+/)) for (let i = 0; i + 3 <= run.length; i++) out.add(run.slice(i, i + 3));
  return [...out];
}

export function scoreLessonAgainstSkill(lesson: LessonLike, skill: SkillLike): number {
  const lt = new Set(tokens(`${lesson.title} ${lesson.body} ${lesson.klass || ''}`));
  const st = new Set(tokens(`${skill.name} ${skill.description || ''}`));
  let hit = 0;
  for (const t of st) if (lt.has(t)) hit++;
  // 名字里直接出现也算强信号
  if (skill.name && String(lesson.title).toLowerCase().includes(skill.name.toLowerCase())) hit += 2;
  return hit;
}

export interface SinkDecision {
  kind: 'skill' | 'experience-only';
  skill?: SkillLike;
  score?: number;
  reason: string;
  /** 给**人/智能体**看的候选(实测: 关键词匹配不足以自动改写 ⇒ 只给候选, 不替人做决定 ✓) */
  suggestions: Array<{ name: string; score: number }>;
}

/** 决定这条教训该进技能还是只留经验 (③ 匹配不够强就不写技能) */
export function decideLessonSink(lesson: LessonLike, skills: SkillLike[]): SinkDecision {
  let best: SkillLike | undefined; let bestScore = 0;
  for (const s of skills) {
    if (!s.file) continue;                                   // 没路径的(跨库加载)不参与改写
    const sc = scoreLessonAgainstSkill(lesson, s);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  const suggestions = skills
    .map((s) => ({ name: s.name, score: scoreLessonAgainstSkill(lesson, s) }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  // 实测校准(2026-10-01): 拿今天 4 条真实教训去撞用户真实的 1300 个技能, 最高分只有 2, 且 top 命中是**瞎的**
  //   ⇒ 说明关键词匹配**不足以可靠地自动改技能** ✗ ⇒ 规矩: 只有**强命中**(同名/描述高度重合, 分数够高)才自动写技能 ✓,
  //   否则只留经验 + 附候选, 由人/智能体决定 ✓(宁缺勿碎 ✓)。
  if (best && bestScore >= LESSON_MATCH_MIN_SCORE) {
    return { kind: 'skill', skill: best, score: bestScore, suggestions, reason: `强命中已有技能 ${best.name} (score=${bestScore})` };
  }
  return {
    kind: 'experience-only', suggestions,
    reason: `没有足够强的匹配 (最高 score=${bestScore} < ${LESSON_MATCH_MIN_SCORE}) ⇒ 只留经验, 不自动改写技能(实测自动匹配会瞎撞 ⇒ 宁缺勿碎 ✓)`,
  };
}

export const LESSON_SECTION = '## 教训 (自动沉淀)';

/**
 * 把一条教训**并进** SKILL.md 正文: 已有同名条目 ⇒ **更新那一条**(不重复堆 ✓); 否则追加。
 */
export function mergeLessonIntoBody(body: string, lesson: LessonLike): { body: string; updated: boolean } {
  const src = String(body ?? '');
  const line = `- **${lesson.title.trim()}**: ${lesson.body.trim().replace(/\s+/g, ' ')}`;
  const esc = lesson.title.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^- \\*\\*${esc}\\*\\*:[^\\n]*$`, 'm');
  if (re.test(src)) return { body: src.replace(re, line), updated: true };
  if (src.includes(LESSON_SECTION)) return { body: `${src.replace(/\s+$/, '')}\n${line}\n`, updated: false };
  return { body: `${src.replace(/\s+$/, '')}\n\n${LESSON_SECTION}\n${line}\n`, updated: false };
}

/**
 * 落盘: **读后写**(① 读不到就不写 ✓) + 同标题更新(不堆 ✓)。返回实际动作, 便于日志与测试。
 */
export function applyLessonToSkill(skill: SkillLike, lesson: LessonLike):
  { patched: false; reason: string } | { patched: true; file: string; updated: boolean } {
  const file = skill?.file;
  if (!file) return { patched: false, reason: '技能没有文件路径(只读库), 不改写' };
  if (!fs.existsSync(file)) return { patched: false, reason: `找不到 ${file} (读后写: 读不到就不写)` };
  try {
    const body = fs.readFileSync(file, 'utf-8');
    if (!body.trim()) return { patched: false, reason: '文件是空的, 不盲改' };
    const merged = mergeLessonIntoBody(body, lesson);
    fs.writeFileSync(file, merged.body, 'utf-8');
    return { patched: true, file, updated: merged.updated };
  } catch (e: any) {
    return { patched: false, reason: `写入失败: ${String(e?.message || e).slice(0, 80)}` };
  }
}


/** 从一个技能目录收 name/description/file (只读 SKILL.md 头部, 便宜 ✓) */
export function skillsFromDirs(dirs: string[]): SkillLike[] {
  const out: SkillLike[] = [];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name, 'SKILL.md');
        try {
          if (!fs.existsSync(file)) continue;
          const head = fs.readFileSync(file, 'utf-8').slice(0, 1200);
          const desc = /description:\s*(.+)/.exec(head);
          out.push({ name, description: desc ? desc[1].trim().replace(/^[>\s]+/, '').slice(0, 200) : '', file });
        } catch { /* 单个技能读失败不影响其它 */ }
      }
    } catch { /* 目录读失败跳过 */ }
  }
  return out;
}

/**
 * 把"这条教训可以沉淀进哪些技能"记到日志文件给人/智能体看
 * (实测关键词匹配不足以自动改技能 ⇒ **不替人决定** ✓; 但候选要留痕 ⇒ 写 `~/.bolloon/logs/lesson-suggestions.jsonl` ✓)。
 */
export function logLessonSuggestions(lesson: LessonLike, decision: SinkDecision, home = os.homedir()): void {
  try {
    const dir = path.join(home, '.bolloon', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'lesson-suggestions.jsonl');
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8').split('\n').length > 300) fs.writeFileSync(file, '', 'utf-8');
    } catch { /* 忽略 */ }
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(), title: lesson.title, kind: decision.kind,
      reason: decision.reason, suggestions: decision.suggestions,
    }) + '\n', 'utf-8');
  } catch { /* 观测失败绝不影响复盘 */ }
}


// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-01 (用户: 「教训…改为都进去进入技能和判断力库」):
//   原先我给"弱命中"只记候选、不写技能 ✗ —— 用户要求**都进技能库** ✓。
//   但实测(真教训撞真 1300 技能, 最高分 2 且 top 命中是瞎的)说明**瞎匹配会写错地方** ✗ ⇒ 折中:
//     · 强命中 ⇒ 写进**那个**技能 ✓;
//     · 弱命中 ⇒ 写进一个统一的沉淀技能 `lessons-learned`(按类分节 ✓ + 记下候选技能供人挑拣 ✓)
//       ⇒ **每条教训都进技能库** ✓, 且不污染无关技能 ✓, 也便于人工管理(一个文件看全 ✓)。
// ─────────────────────────────────────────────────────────────────────────────

export const SINK_SKILL_NAME = 'lessons-learned';

/** 沉淀技能的目录 (用户级技能库, 与 skill-writer 同一处) */
export function sinkSkillDir(home = os.homedir()): string {
  return path.join(home, '.bolloon', 'skills', SINK_SKILL_NAME);
}

/**
 * 确保沉淀技能存在 (**读后写**: 存在就不动它 ✓; 不存在才创建 ✓)。
 * 返回 SKILL.md 路径。
 */
export function ensureSinkSkill(home = os.homedir()): { file: string; created: boolean } {
  const dir = sinkSkillDir(home);
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file)) return { file, created: false };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, [
    '---',
    `name: ${SINK_SKILL_NAME}`,
    'description: 用于**沉淀学到的教训**: 自动把"可复用的规矩/踩过的坑"按类收在这里; 每类一节, 同标题更新不重复堆。',
    '---',
    '',
    `# ${SINK_SKILL_NAME}`,
    '',
    '自动沉淀的教训(每条: **规矩** + 为什么)。同标题 ⇒ 更新那一条, 不重复堆。',
    '若某条教训明显属于某个专门技能(见条目里"候选"), 人工把它挪过去更合适。',
    '',
  ].join('\n'), 'utf-8');
  return { file, created: true };
}

export interface RouteResult {
  /** 写到了哪 (技能名 + 文件) */
  skill: { name: string; file: string; patched: boolean; created: boolean; updated?: boolean };
  /** 为什么这么走 (写日志/给人看) */
  reason: string;
  candidates: Array<{ name: string; score: number }>;
}

/**
 * 一条教训的**唯一出口**: 强命中 ⇒ 写那个技能; 否则 ⇒ 写沉淀技能。**保证每条都进技能库** ✓。
 */
export function routeLessonToSkill(lesson: LessonLike, skills: SkillLike[], home = os.homedir()): RouteResult {
  const d = decideLessonSink(lesson, skills);
  if (d.kind === 'skill' && d.skill?.file) {
    const r = applyLessonToSkill(d.skill, lesson);
    if (r.patched) {
      return { skill: { name: d.skill.name, file: r.file, patched: true, created: false, updated: r.updated }, reason: d.reason, candidates: d.suggestions };
    }
    // 命中了但写不进去(文件读不到/空) ⇒ 退到沉淀技能, 保证"都进去" ✓
  }
  const sink = ensureSinkSkill(home);
  const body = fs.readFileSync(sink.file, 'utf-8');
  const withCandidates = d.suggestions.length
    ? { ...lesson, body: `${lesson.body} (候选技能: ${d.suggestions.map((s) => `${s.name}(${s.score})`).join(', ')})` }
    : lesson;
  const r = applyLessonToSkill({ name: SINK_SKILL_NAME, file: sink.file }, withCandidates);
  return {
    skill: { name: SINK_SKILL_NAME, file: sink.file, patched: r.patched, created: sink.created, updated: (r as any).updated },
    reason: `${d.reason} ⇒ 收进沉淀技能 ${SINK_SKILL_NAME}`,
    candidates: d.suggestions,
  };
}
