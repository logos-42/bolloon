/**
 * skill-writer.ts — skill 的创建 / 更新 / 删除 (2026-08-02)
 *
 * 背景: skill-loader.ts 只读 SKILL.md, 没有写路径 → agent 无法从成功经验沉淀技能,
 *   "越用越聪明" 的闭环缺失. 本模块补齐写侧:
 *
 *   - createSkill(name, description, body, opts) → 写 ~/.bolloon/skills/<name>/SKILL.md
 *   - updateSkill(name, patch)            → 更新已有 SKILL.md (description / body 追加或替换)
 *   - listSkillCandidates(dir)            → 扫描 run-end 候选沉淀目录
 *   - loadSkillsFromPaths (复用 skill-loader)
 *
 * 安全:
 *   - 只写 ~/.bolloon/skills/ (全局) 和 <cwd>/.bolloon/skills/ (项目), 不碰其他路径
 *   - 目录名 sanitize: 只允许 [a-z0-9_-], 防路径穿越
 *   - 大小上限 50KB, 防 LLM 写爆
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 全局用户级 skills 目录 */
export function getUserSkillsDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'skills');
}

/** 项目级 skills 目录 */
export function getProjectSkillsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.bolloon', 'skills');
}

/** skill 名 sanitize: 只允许 [a-z0-9_-], 长度 ≤ 64, 去掉首尾连字符 */
export function sanitizeSkillName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export interface CreateSkillOptions {
  /** 写到项目级还是用户级 (默认用户级 ~/.bolloon/skills) */
  scope?: 'user' | 'project';
  /** 覆盖已存在的 skill (默认 true) */
  overwrite?: boolean;
  /** status: active / draft / archived */
  status?: 'active' | 'draft' | 'archived';
  /** triggers (触发条件数组, 会写进 frontmatter) */
  triggers?: string[];
}

export interface CreateSkillResult {
  ok: boolean;
  path: string;
  error?: string;
}

/**
 * 创建或覆盖一个 skill
 * @param name    skill 名 (会 sanitize)
 * @param description 一句话描述
 * @param body    Markdown 正文 (步骤 / 命令 / 注意事项)
 */
export async function createSkill(
  name: string,
  description: string,
  body: string,
  opts: CreateSkillOptions = {}
): Promise<CreateSkillResult> {
  const safeName = sanitizeSkillName(name);
  if (!safeName) return { ok: false, path: '', error: 'skill 名非法 (sanitize 后为空)' };
  if (body.length > 50_000) return { ok: false, path: '', error: `正文过长 (${body.length} > 50000 字节)` };

  const dir = opts.scope === 'project' ? getProjectSkillsDir() : getUserSkillsDir();
  const skillDir = path.join(dir, safeName);
  const file = path.join(skillDir, 'SKILL.md');

  // 覆盖保护
  if (opts.overwrite === false) {
    try {
      await fs.access(file);
      return { ok: false, path: file, error: `skill '${safeName}' 已存在 (overwrite=false)` };
    } catch { /* 不存在, 可写 */ }
  }

  const status = opts.status || 'active';
  const triggersBlock = opts.triggers && opts.triggers.length > 0
    ? `triggers:\n${opts.triggers.map(t => `  - "${t.replace(/"/g, "'")}"`).join('\n')}\n`
    : '';

  const frontmatter = `---\nname: ${safeName}\ndescription: ${String(description || '').replace(/\n/g, ' ').slice(0, 200)}\nstatus: ${status}\n${triggersBlock}---\n`;

  const content = frontmatter + '\n' + body.trim() + '\n';

  try {
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(file, content, 'utf-8');
    // 2026-08-08 (DID 目录写穿): skill 落盘同步进 DID 目录 skills 表 (失败静默)
    catalogSkillUpsert(`skill/${safeName}`, { name: safeName, kind: 'skill', description, file, size: content.length, updatedAt: Date.now() });
    return { ok: true, path: file };
  } catch (e: any) {
    return { ok: false, path: file, error: `写入失败: ${e?.message || String(e)}` };
  }
}

export interface UpdateSkillOptions {
  description?: string;
  /** append 到正文尾部 (增量沉淀) */
  appendBody?: string;
  /** 整体替换正文 */
  body?: string;
  triggers?: string[];
  status?: 'active' | 'draft' | 'archived';
}

/**
 * 更新已有 skill. 找不到则报错 (不自动创建).
 */
export async function updateSkill(name: string, opts: UpdateSkillOptions): Promise<CreateSkillResult> {
  const safeName = sanitizeSkillName(name);
  if (!safeName) return { ok: false, path: '', error: 'skill 名非法' };

  // 先找现有文件 (用户级 + 项目级)
  const candidates = [
    path.join(getUserSkillsDir(), safeName, 'SKILL.md'),
    path.join(getProjectSkillsDir(), safeName, 'SKILL.md'),
  ];
  let file = '';
  for (const c of candidates) {
    try { await fs.access(c); file = c; break; } catch { /* 不存在 */ }
  }
  if (!file) return { ok: false, path: '', error: `skill '${safeName}' 不存在, 用 create_skill 创建` };

  try {
    let raw = await fs.readFile(file, 'utf-8');
    let body = raw.replace(/^---[\s\S]*?---\n?/, '').trim(); // 剥 frontmatter

    if (opts.body !== undefined) {
      body = opts.body.trim();
    } else if (opts.appendBody) {
      body = (body + '\n\n' + opts.appendBody.trim()).slice(0, 50_000);
    }

    // 重建 frontmatter
    const { parseSkillFile } = await import('./skill-loader.js');
    const meta = await parseSkillFile(file);
    const fm = meta?.frontmatter || {};
    const fmLines: string[] = [];
    fmLines.push(`name: ${safeName}`);
    fmLines.push(`description: ${String(opts.description ?? meta?.description ?? '').replace(/\n/g, ' ').slice(0, 200)}`);
    fmLines.push(`status: ${opts.status ?? meta?.status ?? 'active'}`);
    const triggers = opts.triggers ?? meta?.triggers ?? [];
    if (triggers.length > 0) {
      fmLines.push('triggers:');
      for (const t of triggers) fmLines.push(`  - "${String(t).replace(/"/g, "'")}"`);
    }
    const content = '---\n' + fmLines.join('\n') + '\n---\n\n' + body + '\n';

    await fs.writeFile(file, content, 'utf-8');
    // 2026-08-08 (DID 目录写穿): skill 更新同步进 DID 目录 skills 表 (失败静默)
    catalogSkillUpsert(`skill/${safeName}`, { name: safeName, kind: 'skill', description: String(opts.description || ''), file, size: content.length, updatedAt: Date.now() });
    return { ok: true, path: file };
  } catch (e: any) {
    return { ok: false, path: file, error: `更新失败: ${e?.message || String(e)}` };
  }
}

/** 删除 skill (返回删除的文件路径) */
export async function deleteSkill(name: string): Promise<CreateSkillResult> {
  const safeName = sanitizeSkillName(name);
  if (!safeName) return { ok: false, path: '', error: 'skill 名非法' };
  const candidates = [
    path.join(getUserSkillsDir(), safeName),
    path.join(getProjectSkillsDir(), safeName),
  ];
  for (const c of candidates) {
    try {
      await fs.rm(c, { recursive: true, force: true });
      return { ok: true, path: c };
    } catch { /* 尝试下一个 */ }
  }
  return { ok: false, path: '', error: `skill '${safeName}' 不存在` };
}

/**
 * run-end 候选沉淀目录扫描.
 * 设计: run-end 后台任务把"成功的工具调用模式"写成候选 JSON 到
 *   ~/.bolloon/skill-candidates/*.json, 这里扫描并返回 (供 UI / LLM 决定是否转正).
 */
export interface SkillCandidate {
  name: string;
  description: string;
  body: string;
  source: string;   // 触发来源 (e.g. channel id / tool name)
  timestamp: string;
  /** 2026-08-08: 工具签名 (去重合并依据) — 同一套工具只允许一个候选 */
  signature?: string;
  /** 已累积的运行次数 (>=2 表明可复用, 提示转正) */
  runs?: number;
  /** 落盘文件 (listSkillCandidates 回填) */
  file?: string;
}

export function getCandidateDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'skill-candidates');
}

export async function writeSkillCandidate(c: SkillCandidate): Promise<string> {
  const dir = getCandidateDir();
  await fs.mkdir(dir, { recursive: true });
  const safeName = sanitizeSkillName(c.name);
  // 2026-08-08: 有 signature 的候选用固定文件名 (合并更新同一个), 无 signature 才带时间戳
  const file = c.signature
    ? path.join(dir, `${safeName}.json`)
    : path.join(dir, `${safeName}-${Date.now()}.json`);
  // 追加式合并: 若同 signature 已存在, 累积 runs + 追加 body
  let runs = c.runs ?? 1;
  let body = c.body;
  try {
    const prev = JSON.parse(await fs.readFile(file, 'utf-8')) as SkillCandidate;
    if (prev && prev.runs) runs = prev.runs + 1;
    if (prev && prev.body && body !== prev.body && c.signature) {
      // 同一 signature 重复运行 → 追加一条经验 (去重, 避免 body 膨胀)
      const line = `- ${new Date().toISOString().slice(0, 16)} ${c.source}: ${c.description}`;
      body = `${prev.body}\n${line}`;
    }
  } catch { /* 新文件 */ }
  const merged: SkillCandidate = { ...c, runs, body, timestamp: c.timestamp || new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(merged, null, 2), 'utf-8');
  // 2026-08-08 (DID 目录写穿): 候选同步进 DID 目录 skills 表 (失败静默)
  catalogSkillUpsert(`candidate/${safeName}`, {
    name: safeName, kind: 'candidate', description: c.description,
    file, runs, signature: c.signature, size: merged.body.length, updatedAt: Date.now(),
  });
  return file;
}

/** 2026-08-08: skill 写入 → DID 目录 skills 表写穿 (WAL 事件 → 多设备同步/OrbitDB 复制). 失败静默. */
function catalogSkillUpsert(key: string, data: Record<string, unknown>): void {
  (async () => {
    try {
      const { catalogUpsertQuiet } = await import('../storage/did-catalog-bridge.js');
      await catalogUpsertQuiet('skills', key, data);
    } catch { /* 静默 */ }
  })();
}

export async function listSkillCandidates(home: string = os.homedir()): Promise<SkillCandidate[]> {
  const dir = getCandidateDir(home);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch { return []; }
  const out: SkillCandidate[] = [];
  for (const f of entries.filter(f => f.endsWith('.json')).sort().slice(-50)) {
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf-8');
      const c = JSON.parse(raw) as SkillCandidate;
      if (c.name && c.body) out.push({ ...c, file: path.join(dir, f) });
    } catch { /* 坏文件跳过 */ }
  }
  return out;
}

/** 按名字删除所有同名候选文件 (名可能与文件名前缀不完全一致) */
async function removeCandidateFiles(name: string, home: string): Promise<void> {
  const safe = sanitizeSkillName(name);
  const dir = getCandidateDir(home);
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8')) as SkillCandidate;
      if (sanitizeSkillName(c.name) === safe) await fs.rm(path.join(dir, f), { force: true });
    } catch { if (f.startsWith(safe)) await fs.rm(path.join(dir, f), { force: true }); }
  }
}

/** 把候选转正为正式 skill (可选: 转正后删除候选文件) */
export async function promoteCandidate(
  name: string,
  opts: CreateSkillOptions = {},
  home: string = os.homedir()
): Promise<CreateSkillResult> {
  const candidates = await listSkillCandidates(home);
  const c = candidates.find(x => x.name === name || sanitizeSkillName(x.name) === sanitizeSkillName(name));
  if (!c) return { ok: false, path: '', error: `候选 '${name}' 不存在` };
  const r = await createSkill(c.name, c.description, c.body, opts);
  if (r.ok) {
    // 清理已转正的候选文件: 同 name 的所有候选
    await removeCandidateFiles(c.name, home);
  }
  return r;
}

/**
 * run-end 经验整理 (2026-08-04): 从一轮运行的步骤里提取"连续成功的工具调用模式",
 * 写成候选 JSON 到 ~/.bolloon/skill-candidates/ (Web server 与 CLI 共用).
 * 只写候选, 不自动转正 — 由 agent 调 list_skill_candidates / promote_skill 决定.
 */
export interface RunStepLike {
  status?: string;
  name?: string;
  tool?: string;
  output?: string;
}

export interface RunEndCandidateResult {
  wrote: boolean;
  file?: string;
  count?: number;
  names?: string;
  reason?: string;
  /** 2026-08-08: 是否合并进已有候选 (同一 signature 重复运行) */
  merged?: boolean;
  runs?: number;
}

/**
 * 从一轮成功的工具调用生成稳定签名 — 同一套工具序列 (有序去重, 最多 4 个) 视为同一经验.
 * 用于跨运行合并: 第二次跑同样的工具 → 更新同一个候选, 而不是新建一个.
 */
export function toolSignature(okSteps: RunStepLike[]): string {
  const seq: string[] = [];
  for (const s of (okSteps || [])) {
    if (s.name && !seq.includes(s.name)) seq.push(s.name);
    if (seq.length >= 4) break;
  }
  return seq.join('_');
}

export async function writeRunEndSkillCandidates(
  steps: RunStepLike[],
  source: string,
  minOk = 2
): Promise<RunEndCandidateResult> {
  const okSteps = (steps || []).filter(
    (s) => s.status === 'ok' && s.name && s.name !== 'system' && s.name !== '?'
  );
  if (okSteps.length < minOk) {
    return { wrote: false, reason: `成功工具不足 (${okSteps.length} < ${minOk})` };
  }
  const toolNames = okSteps.map((s) => s.name).slice(0, 5).join(', ');
  const body =
    `## 背景\n本轮对话连续成功调用了 ${okSteps.length} 个工具: ${toolNames}.\n\n` +
    `## 流程\n${okSteps.map((s) => `1. 调用 ${s.name}${s.output ? ': ' + String(s.output).slice(0, 120) : ''}`).join('\n')}\n\n` +
    `## 注意事项\n- 工具名以 list_skills / get_operation_logs 的实际注册名为准\n- 沉淀为正式 skill 前请人工确认流程可复用\n`;

  // 2026-08-08: 稳定签名 + 固定文件名 → 同一套工具反复跑时合并更新到同一个候选 (runs++)
  const signature = toolSignature(okSteps);
  const candName = `auto-${signature}`;
  const existing = (await listSkillCandidates()).find(
    (x) => x.signature === signature || sanitizeSkillName(x.name) === sanitizeSkillName(candName)
  );
  const file = await writeSkillCandidate({
    name: candName,
    description: `自动候选: ${okSteps.length} 个工具连续成功 (${toolNames})`,
    body,
    source,
    timestamp: new Date().toISOString(),
    signature,
  });
  const merged = !!existing;
  const runs = (existing?.runs ?? 0) + 1;
  return { wrote: true, file, count: okSteps.length, names: toolNames, merged, runs };
}
