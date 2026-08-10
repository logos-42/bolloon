/**
 * skill-organizer.ts — 自动整理心跳 (2026-08-10)
 *
 * 目的: 把"自动整理"变成 Bolloon 的心跳之一 (与社交心跳并列), 周期性做两件事:
 *
 *   A. 扫描 skills view (~/.bolloon/skills + <cwd>/.bolloon/skills), 找出"遗留下来的 skills 指导":
 *      - 外部智能体迁移残留 (openclaw/hermes 迁移的 skills 展平为 `<分类>-<技能>`, 如 apple-* / creative-* / autonomous-ai-agents-*)
 *      - 空 body / 无 description 的占位 skill
 *      - status: archived 的归档残留
 *      - 用户级与项目级同名重复
 *   B. 经验进化 (完整总结, 不再只是记录使用什么工具): 读 run-end 候选, 用 LLM 把
 *      "工具调用记录" 扩写成完整的经验文档 (背景/触发条件/流程/注意事项/验证), 转正为正式 skill.
 *
 * 设计原则 (compile-first / 可测):
 *   - 所有目录/LLM 可注入 (home/cwd/llm), 测试用临时 HOME + mock LLM.
 *   - runSkillOrganize 纯函数式: 输入候选 + 现有 skills, 输出进化结果 + 遗留报告, 不依赖网络.
 *   - startOrganizeHeartbeat 提供 CLI/server 统一的心跳壳: interval + 重入锁 + onStart/onEnd/onError,
 *     CLI 通过 onStart/onEnd 把显示接到颜文字行 (inkSetTransient), 结束后清空.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getUserSkillsDir, getProjectSkillsDir, sanitizeSkillName } from './skill-writer.js';

/** 迁移来源分类前缀 — 这些是外部智能体 (openclaw/hermes 等) 迁移进来的 skills, 属于"遗留"候选 */
const MIGRATED_PREFIXES = [
  'apple-',
  'autonomous-ai-agents-',
  'creative-',
  'data-science-',
  'email-',
  'github-',
  'media-',
  'mlops-',
  'note-taking-',
  'openclaw-imports-',
  'productivity-',
  'research-',
  'smart-home-',
  'social-media-',
  'software-development-',
];

export interface LeftoverSkill {
  dir: string;
  name: string;
  description: string;
  /** 判定为遗留的原因 (可多个) */
  reasons: string[];
}

export interface OrganizeResult {
  /** 扫描到的候选数 */
  scannedCandidates: number;
  /** 本次进化 (转正) 的 skill 名 */
  evolved: string[];
  /** 遗留 skills 报告 (每次扫描都有) */
  leftovers: LeftoverSkill[];
  /** 2026-08-10: 知识层整理 (Context OS/社交/智能体/judgeness/项目/画像/日志/目标) */
  knowledge?: import('./knowledge-organizer.js').KnowledgeOrganizeResult;
  /** 非致命错误 (不中断整理) */
  error?: string;
}

export interface RunSkillOrganizeOptions {
  /** LLM 包装: 给定 prompt 返回文本. 不传则跳过经验进化 (只做遗留扫描) */
  llm?: (prompt: string) => Promise<string>;
  /** 是否做 LLM 经验进化 (默认 true; 启动快速检查可关) */
  evolve?: boolean;
  /** 候选来源标记 (写入候选/报告, 如 cli:organize / server:organize) */
  source?: string;
  home?: string;
  cwd?: string;
  /** 单轮最多进化几个候选 (防烧 LLM, 默认 3) */
  maxEvolve?: number;
}

// ───────────────────────── A. 遗留 skills 扫描 ─────────────────────────

/** 判定一个 skill 是否"遗留": 返回原因列表 (空数组 = 正常) */
export function leftoverReasons(meta: {
  name: string;
  description?: string;
  status?: string;
  body?: string;
}): string[] {
  const reasons: string[] = [];
  const name = meta.name || '';
  // 1. 迁移残留: 带外部智能体分类前缀
  if (MIGRATED_PREFIXES.some((p) => name.startsWith(p))) {
    reasons.push('迁移遗留 (外部智能体分类前缀)');
  }
  // 2. 占位: 无描述或正文过短
  const desc = (meta.description || '').trim();
  const body = (meta.body || '').trim();
  if (!desc) reasons.push('无 description');
  if (body.length < 50) reasons.push('正文过短 (疑似占位)');
  // 3. 归档残留
  if (meta.status === 'archived') reasons.push('status=archived (归档残留)');
  return reasons;
}

/** 扫描一个 skill 目录, 返回遗留报告 */
export async function scanSkillDir(dir: string): Promise<LeftoverSkill[]> {
  const out: LeftoverSkill[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    let raw = '';
    try {
      raw = await fs.readFile(skillFile, 'utf-8');
    } catch {
      continue; // 没有 SKILL.md 不算 skill
    }
    const meta = parseSkillRaw(raw, entry.name);
    const reasons = leftoverReasons(meta);
    if (reasons.length > 0) {
      out.push({ dir, name: meta.name, description: meta.description || '', reasons });
    }
  }
  return out;
}

/** 轻量 frontmatter/正文解析 (不依赖 skill-loader, 避免循环依赖) */
function parseSkillRaw(raw: string, fallbackName: string): {
  name: string;
  description: string;
  status: string;
  body: string;
} {
  let name = fallbackName;
  let description = '';
  let status = '';
  let body = raw;
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    const fm = fmMatch[1];
    const nameM = fm.match(/^name:\s*(.+)$/m);
    const descM = fm.match(/^description:\s*(.+)$/m);
    const statusM = fm.match(/^status:\s*(.+)$/m);
    if (nameM) name = nameM[1].trim();
    if (descM) description = descM[1].trim();
    if (statusM) status = statusM[1].trim();
  }
  return { name, description, status, body: body.trim() };
}

/** 扫描全部 skills view (用户级 + 项目级), 找同名重复 */
export async function scanLeftoverSkills(opts: { home?: string; cwd?: string } = {}): Promise<LeftoverSkill[]> {
  const home = opts.home || os.homedir();
  const cwd = opts.cwd || process.cwd();
  const dirs = [getUserSkillsDir(home), getProjectSkillsDir(cwd)];
  const found = new Map<string, LeftoverSkill>();
  const seenNames = new Set<string>();
  for (const dir of dirs) {
    const items = await scanSkillDir(dir);
    for (const it of items) {
      found.set(`${dir}::${it.name}`, it);
    }
    // 同名重复检测 (跨目录)
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith('.'));
    for (const n of names) {
      if (seenNames.has(n)) {
        const dup: LeftoverSkill = {
          dir,
          name: n,
          description: '同名 skill 已在其他目录存在',
          reasons: ['跨目录同名重复'],
        };
        found.set(`${dir}::dup::${n}`, dup);
      }
      seenNames.add(n);
    }
  }
  return Array.from(found.values());
}

// ───────────────────────── B. 经验进化 (LLM 完整总结) ─────────────────────────

/** 把候选的工具调用记录扩写成完整经验 — LLM prompt (结构化 JSON 输出) */
export function buildEvolvePrompt(c: {
  name: string;
  description: string;
  body: string;
  runs?: number;
}): string {
  return `你是经验总结专家。下面是 Bolloon 智能体在一轮运行中连续成功调用的工具记录 (已运行 ${c.runs || 1} 次)。

工具记录:
名称: ${c.name}
描述: ${c.description}
原始记录:
${String(c.body || '').slice(0, 4000)}

请把这份"工具调用记录"扩写成一份完整的、可复用的经验文档, 要求:
1. name: 一个简短的小写英文名 (字母数字连字符, 概括这套操作)
2. description: 一句话描述 (什么场景用)
3. body: 完整经验正文, 按以下结构:
   ## 背景 — 这套操作在什么场景下用, 解决什么问题
   ## 触发条件 — 什么信号/需求出现时应该使用
   ## 流程 — 具体步骤 (保留原始工具名), 每步说明目的
   ## 注意事项 — 易错点 / 边界情况 / 已知坑
   ## 验证 — 怎么确认结果正确

只输出一个 JSON 对象, 不要任何其他文字:
{"name": "...", "description": "...", "body": "..."}`;
}

/** 解析 LLM 返回的 JSON (容错: 剥 markdown 代码块, 取第一个 {...}) */
export function parseEvolveJson(raw: string): { name?: string; description?: string; body?: string } | null {
  if (!raw) return null;
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    return {
      name: typeof obj.name === 'string' ? obj.name : undefined,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      body: typeof obj.body === 'string' ? obj.body : undefined,
    };
  } catch {
    return null;
  }
}

/** 完整经验进化: 候选 → LLM 总结 → 正式 skill (转正 + 清理候选). 返回转正 skill 名列表 */
export async function evolveCandidates(opts: {
  llm: (prompt: string) => Promise<string>;
  source?: string;
  home?: string;
  maxEvolve?: number;
}): Promise<{ evolved: string[]; scanned: number }> {
  const { listSkillCandidates, writeSkillCandidate } = await import('./skill-writer.js');
  const home = opts.home || os.homedir();
  const cands = await listSkillCandidates(home);
  const evolved: string[] = [];
  const max = opts.maxEvolve ?? 3;
  // 优先进化 runs 多的 (更可能可复用)
  const sorted = [...cands].sort((a, b) => (b.runs ?? 1) - (a.runs ?? 1)).slice(0, max);
  for (const c of sorted) {
    try {
      const raw = await opts.llm(buildEvolvePrompt(c));
      const parsed = parseEvolveJson(raw);
      if (!parsed?.body || parsed.body.trim().length < 50) {
        // LLM 输出不可用 → 保留候选, 记录一次失败 (不转正)
        await writeSkillCandidate({
          ...c,
          body: `${c.body}\n- ${new Date().toISOString().slice(0, 16)} ${opts.source || 'organize'}: LLM 总结失败, 保留待人工`,
        }).catch(() => {});
        continue;
      }
      const { createSkill } = await import('./skill-writer.js');
      const safeName = sanitizeSkillName(parsed.name || c.name) || sanitizeSkillName(c.name);
      const r = await createSkill(safeName, parsed.description || c.description, parsed.body, {
        status: 'active',
        triggers: c.description ? [c.description.slice(0, 60)] : undefined,
      });
      if (!r.ok) continue;
      evolved.push(safeName);
      // 转正成功 → 清理候选文件
      const { listSkillCandidates: listAgain } = await import('./skill-writer.js');
      const after = await listAgain(home);
      for (const cc of after) {
        if (cc.file && (cc.name === c.name || sanitizeSkillName(cc.name) === sanitizeSkillName(c.name))) {
          await fs.rm(cc.file, { force: true }).catch(() => {});
        }
      }
    } catch {
      /* 单个候选失败不阻塞整轮 */
    }
  }
  return { evolved, scanned: cands.length };
}

/** 自动整理主流程: 遗留扫描 (必做) + 经验进化 (有 LLM 时) */
export async function runSkillOrganize(opts: RunSkillOrganizeOptions = {}): Promise<OrganizeResult> {
  const evolve = opts.evolve ?? true;
  const result: OrganizeResult = { scannedCandidates: 0, evolved: [], leftovers: [] };
  try {
    result.leftovers = await scanLeftoverSkills({ home: opts.home, cwd: opts.cwd });
  } catch (e: any) {
    result.error = `遗留扫描失败: ${e?.message || String(e)}`;
  }
  if (evolve && opts.llm) {
    try {
      const { evolved, scanned } = await evolveCandidates({
        llm: opts.llm,
        source: opts.source,
        home: opts.home,
        maxEvolve: opts.maxEvolve,
      });
      result.evolved = evolved;
      result.scannedCandidates = scanned;
    } catch (e: any) {
      result.error = `${result.error ? result.error + '; ' : ''}经验进化失败: ${e?.message || String(e)}`;
    }
  } else {
    try {
      const { listSkillCandidates } = await import('./skill-writer.js');
      result.scannedCandidates = (await listSkillCandidates(opts.home || os.homedir())).length;
    } catch {
      result.scannedCandidates = 0;
    }
  }
  return result;
}

/** 自动整理总入口 (2026-08-10): skills 整理 (遗留扫描 + 经验进化) + 知识层整理 (9 类) */
export async function runAutoOrganize(opts: RunSkillOrganizeOptions = {}): Promise<OrganizeResult> {
  const result = await runSkillOrganize(opts);
  try {
    const { runKnowledgeOrganize } = await import('./knowledge-organizer.js');
    result.knowledge = await runKnowledgeOrganize({ home: opts.home, cwd: opts.cwd, llm: opts.llm });
  } catch (e: any) {
    result.error = `${result.error ? result.error + '; ' : ''}知识层整理失败: ${e?.message || String(e)}`;
  }
  return result;
}

// ───────────────────────── C. 自动整理心跳壳 ─────────────────────────

export interface OrganizeHeartbeatOptions {
  /** 整理周期 (默认 30min) */
  intervalMs?: number;
  /** 每次 tick 执行的内容 (生产: runSkillOrganize 包装) */
  run: () => Promise<OrganizeResult>;
  /** 一轮开始 (CLI: 显示颜文字行) */
  onStart?: () => void;
  /** 一轮结束 (CLI: 清空颜文字行 → 显示为空) */
  onEnd?: (r: OrganizeResult) => void;
  /** 一轮出错 (CLI: 清空颜文字行) */
  onError?: (e: Error) => void;
}

export interface OrganizeHeartbeatHandle {
  stop(): void;
  /** 立即跑一轮 (启动时"固定看一下 skills view") */
  runOnce(): Promise<OrganizeResult | null>;
}

/** 自动整理心跳: 定时触发整理, 带重入锁 (上一轮没跑完不重复触发) */
export function startOrganizeHeartbeat(opts: OrganizeHeartbeatOptions): OrganizeHeartbeatHandle {
  const intervalMs = opts.intervalMs ?? 30 * 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running = false;

  const runOnce = async (): Promise<OrganizeResult | null> => {
    if (running || stopped) return null;
    running = true;
    try {
      opts.onStart?.();
      const r = await opts.run();
      opts.onEnd?.(r);
      return r;
    } catch (e: any) {
      opts.onError?.(e instanceof Error ? e : new Error(String(e)));
      return null;
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runOnce();
      schedule();
    }, intervalMs);
  };

  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    runOnce,
  };
}
