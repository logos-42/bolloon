/**
 * persona-init.ts — **确保每个 agent 名下有身份文档** (2026-10-01)
 *
 * 用户报: 「切换之后应该知道加载智能体初始化文档, 为什么目前是无, 所有回复都是一个智能体人格?」
 * 真因: `~/.bolloon/persona/<agentId>/` 下**一个文件都没有** (用户四个 agent 全缺),
 * `loadPersonaDocs(agentId)` 读回来 6 个字段全空 ⇒ 系统提示里只剩 `# Persona (agentId=…)` 这个头
 * + 所有 agent 共用的 INJECT 工作纪律 ⇒ 换谁都一样。
 * 而且仓里此前**没有任何"建身份文档"的路径** (只有读的 persona-loader + 一个模板 json + 测试助手)。
 *
 * 这里补上那条路: 按 `persona-loader` 认的 6 个文件名生成**起步文档**, 幂等 (已存在不覆盖 ——
 * 用户写过的内容绝不能被模板盖掉)。
 *
 * 拿的是"能立刻用"的起步稿, 不是空壳: 每份都带该 agent 的名字与 agentId, 并**明确标注是模板**,
 * 提示用户去编辑; 不同 agent 生成的正文必然不同 (有名字/agentId), 所以"所有人格一个样"从结构上就不成立。
 */
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 与 `persona-loader.ts` 的 FILE_KEYS 对齐 (读侧是唯一权威, 这里只复述文件名) */
export const PERSONA_DOC_FILES = ['soul', 'identity', 'project', 'user', 'agent', 'wiki'] as const;
export type PersonaDocFile = (typeof PERSONA_DOC_FILES)[number];

/** 与 persona-loader 的 sanitizeAgentId 同口径 */
export function sanitizePersonaAgentId(agentId: string): string {
  return String(agentId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function personaDirOf(agentId: string, home?: string): string {
  const root = home || os.homedir();
  return path.join(root, '.bolloon', 'persona', sanitizePersonaAgentId(agentId));
}

/** 该 agent 自己的 persona.json 里的名字 (同步读; 没有就 undefined) */
export function readPersonaNameSync(agentId: string, home?: string): string | undefined {
  try {
    const p = path.join(personaDirOf(agentId, home), 'persona.json');
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    return String(j?.name || '').trim() || undefined;
  } catch {
    return undefined;
  }
}

const TITLES: Record<PersonaDocFile, string> = {
  soul: 'soul — 我是谁 / 我认什么',
  identity: 'identity — 身份与边界',
  project: 'project — 我在做的项目',
  user: 'user — 我在服务的人',
  agent: 'agent — 我的工作方式',
  wiki: 'wiki — 我的知识索引',
};

function starter(file: PersonaDocFile, agentId: string, name: string): string {
  const head = `---\nagentId: ${sanitizePersonaAgentId(agentId)}\ntitle: ${TITLES[file]}\nstage: starter\n---\n\n`;
  const body: Record<PersonaDocFile, string> = {
    soul: `# ${name} 的 soul\n\n`
      + `> 这是**起步模板** (由 bolloon 在建/切 agent 时自动生成, 只生成一次)。请把它改成你自己的。\n\n`
      // 2026-10-01: 标题行必须与**该 agent 自己的 persona.json** 一致 ——
      //   之前用渠道名生成, 于是 soul.md 写「我是 233」而 persona.json 写「小龙」⇒ 用户看到"身份没匹配上" ✗
      + `我是 **${name}**。\n\n`
      + `- 我认什么: (待写 — 我的判断准则、我拒绝做什么)\n`
      + `- 我说话的方式: (待写 — 语气/详略/爱用的结构)\n`
      + `- 我不知道时会怎么做: (待写 — 先问 / 先查 / 先给假设并标注)\n`,
    identity: `# ${name} 的身份与边界\n\n`
      + `- agentId: \`${sanitizePersonaAgentId(agentId)}\`\n`
      + `- 名字: ${name}\n`
      + `- 归属: (待写 — 属于谁 / 代表谁)\n`
      + `- 边界: (待写 — 哪些事我不能替人决定)\n`,
    project: `# ${name} 在做的事\n\n`
      + `- 当前目标: (待写)\n`
      + `- 进行中的线: (待写)\n`
      + `- 不做的事: (待写)\n`,
    user: `# ${name} 服务的人\n\n`
      + `- 偏好: (待写 — 语言/格式/节奏)\n`
      + `- 忌讳: (待写)\n`,
    agent: `# ${name} 的工作方式\n\n`
      + `1. 先确认现状 (读真文件/真输出), 不靠记忆猜\n`
      + `2. 改动前后都给出可核验的证据 (命令、数字、路径)\n`
      + `3. 拿不准就说不确定, 并给出下一步怎么确认\n`,
    wiki: `# ${name} 的知识索引\n\n`
      + `- 稳定结论放这里; 过程留在会话/日志里\n`
      + `- (待写) 我负责的领域与其唯一出处\n`,
  };
  return head + body[file];
}

export interface EnsurePersonaResult {
  agentId: string;
  dir: string;
  created: PersonaDocFile[];
  kept: PersonaDocFile[];
}

/**
 * 确保该 agent 名下有 6 份身份文档。**已存在的一律不碰** (幂等; 用户写过的内容不可被模板覆盖)。
 * 失败不抛 —— 调用方 (getAgent 等) 不该因为写文档失败而崩; 返回已建/已保留的清单供如实汇报。
 */
export async function ensurePersonaDocs(
  agentId: string,
  opts: { name?: string; home?: string } = {},
): Promise<EnsurePersonaResult> {

  const id = String(agentId || '').trim();
  const dir = personaDirOf(id, opts.home);
  const out: EnsurePersonaResult = { agentId: sanitizePersonaAgentId(id), dir, created: [], kept: [] };
  if (!id) return out;
  const name = (opts.name || '').trim() || id;
  try {
    await fs.mkdir(dir, { recursive: true });
    for (const f of PERSONA_DOC_FILES) {
      const file = path.join(dir, `${f}.md`);
      let exists = false;
      try { await fs.access(file); exists = true; } catch { exists = false; }
      if (exists) { out.kept.push(f); continue; }
      await fs.writeFile(file, starter(f, id, name), 'utf-8');
      out.created.push(f);
    }
  } catch {
    // 静默: 写不进去不影响本次对话 (但调用方可通过 created/kept 看出没建起来)
  }
  return out;
}


/** agent 自己写的人格在文档里的标记区 (手写的部分在标记外, 永不覆盖) */
export const PERSONA_AUTO_BEGIN = '<!-- persona:auto:begin -->';
export const PERSONA_AUTO_END = '<!-- persona:auto:end -->';

/**
 * **写透**: 把 agent 自己设的 persona 落进它的身份文档 (2026-10-01)。
 *
 * 为什么必须做: 有身份文档的 agent 不再套用 persona.json ⇒ 身份由 6 份文档承担。
 * 而 `set_persona` 原先只写 persona.json ⇒ **agent 自己改的人格根本不进系统提示**,
 * 用户的感受就是"每次让智能体改, 都是同一个"(各 agent 的文档还都是同一份模板)。
 *
 * 规矩: 只重写 `<!-- persona:auto -->` 标记**之内**的内容 —— 标记外是你手写的, 一个字都不动。
 * 落在 `soul.md` (人格/基调) 与 `identity.md` (身份/边界) 两份里。
 */
export async function applyPersonaToDocs(
  agentId: string,
  persona: { name?: string; description?: string; personality?: string; capabilities?: string[]; interests?: string[]; greeting?: string },
  opts: { home?: string } = {},
): Promise<string[]> {
  const id = String(agentId || '').trim();
  if (!id) return [];
  const dir = personaDirOf(id, opts.home);
  // 目录可能还不存在 (该 agent 还没生成过身份文档) ⇒ 先建, 否则两份都写失败、静默返回空
  try { await fs.mkdir(dir, { recursive: true }); } catch { return []; }
  const block = [
    PERSONA_AUTO_BEGIN,
    `- 名字: ${persona.name || id}`,
    persona.description ? `- 定位: ${persona.description}` : '',
    persona.personality ? `- 性恪/基调: ${persona.personality}` : '',
    persona.greeting ? `- 打招呼: ${persona.greeting}` : '',
    persona.capabilities?.length ? `- 我能做: ${persona.capabilities.join(' · ')}` : '',
    persona.interests?.length ? `- 我关心: ${persona.interests.join(' · ')}` : '',
    PERSONA_AUTO_END,
  ].filter(Boolean).join('\n');
  const written: string[] = [];
  for (const name of ['soul', 'identity'] as const) {
    const file = path.join(dir, `${name}.md`);
    let cur = '';
    try { cur = await fs.readFile(file, 'utf-8'); } catch { cur = ''; }
    const wrapped = /<!-- persona:auto:begin -->[\s\S]*?<!-- persona:auto:end -->/;
    const next = wrapped.test(cur)
      ? cur.replace(wrapped, block)
      : `${cur.trimEnd()}\n\n${block}\n`;
    try { await fs.writeFile(file, next, 'utf-8'); written.push(name); } catch { /* 单份写失败不影响另一份 */ }
  }
  return written;
}
