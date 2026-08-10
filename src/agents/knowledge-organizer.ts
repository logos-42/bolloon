/**
 * knowledge-organizer.ts — 自动整理心跳 · 知识层整理 (2026-08-10)
 *
 * 目的: 自动整理不止 skills — 每次整理 tick 还维护 Bolloon 的"自我认知"知识层:
 *
 *   1. archiveContextOs      归档 Context OS 资产层 (快照 + tmp 清理)
 *   2. tidySocialRelations   整理外部社交关系 (known_peers + dunbar tier 统计/失联)
 *   3. tidyExternalAgents    整理外部智能体描述 (peers/<pk>/agents/*)
 *   4. tidyInternalAgents    整理内部智能体描述 (channels persona + persona/<agentId>/)
 *   5. maintainJudgeness     judgeness 内容维护 (descriptions 归档)
 *   6. understandProjects    其他项目目录的理解 (扫描项目 → 04-Projects 索引)
 *   7. understandUserProfile 用户画像的理解 (persona user.md + 01-Me → 画像快照)
 *   8. archiveRecentLogs     最近记录的日志归档 (goals/engine 等 jsonl)
 *   9. maintainGoals         用户长期/短期目标维护 (goals → 03-Current 摘要)
 *
 * 设计原则:
 *   - 每个整理器是纯函数: 输入 home/cwd (可注入), 输出 OrganizeSection, 全部 try/catch —
 *     单个失败不阻塞其他 (整理是尽力而为, 不抛错).
 *   - 默认无 LLM (文件统计/归档/快照); 传 llm 时增强"理解类"整理器 (项目/画像/目标摘要).
 *   - runKnowledgeOrganize 串行跑全部 (顺序稳定, 日志可读), 汇总 sections.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface OrganizeSection {
  /** 唯一 key: context-os / social / agents-ext / agents-int / judgeness / projects / user / logs / goals */
  key: string;
  /** 中文标签 (CLI 显示) */
  label: string;
  /** 处理了多少项 */
  handled: number;
  /** 一句话结果 (CLI 显示) */
  summary?: string;
  /** 该整理器错误 (非致命) */
  error?: string;
}

export interface KnowledgeOrganizeResult {
  sections: OrganizeSection[];
  totalHandled: number;
}

export interface KnowledgeOrganizeOptions {
  home?: string;
  cwd?: string;
  /** 可选 LLM 增强 (项目/画像/目标摘要) */
  llm?: (prompt: string) => Promise<string>;
}

/** 读取 JSON 文件, 失败返回 null (安静) */
async function readJson(p: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** 读取目录下直接子项 (文件+目录), 失败返回 [] */
async function readDir(p: string): Promise<string[]> {
  try {
    return await fs.readdir(p);
  } catch {
    return [];
  }
}

/** 目录下 *.md 文件 (一层), 带 mtime */
async function listMd(p: string): Promise<Array<{ file: string; mtime: number }>> {
  const entries = await readDir(p);
  const out: Array<{ file: string; mtime: number }> = [];
  for (const e of entries) {
    if (!e.endsWith('.md')) continue;
    try {
      const st = await fs.stat(path.join(p, e));
      out.push({ file: e, mtime: st.mtimeMs });
    } catch { /* 跳过 */ }
  }
  return out;
}

// ───────────────────────── 1. Context OS 归档 ─────────────────────────

const CONTEXT_OS_LAYERS = [
  '01-Me', '02-Network', '03-Current', '04-Projects', '05-Prompts',
  '06-Protocols', '07-Knowledge', '08-Insights', '09-Tools', '10-Skills',
  '11-Write', '12-Analysis',
];

/** 归档 Context OS: 统计各层资产 + 打快照清单 + 清理过期 tmp 草稿 */
export async function archiveContextOs(home: string): Promise<OrganizeSection> {
  const root = path.join(home, '.bolloon', 'context-os');
  const snapshotsDir = path.join(root, 'snapshots');
  let handled = 0;
  let totalAssets = 0;
  let archivedTmp = 0;
  try {
    await fs.mkdir(snapshotsDir, { recursive: true });
    // 统计各层资产 (直接子文件, 排除 README.md)
    const layerStats: Array<{ layer: string; count: number }> = [];
    for (const layer of CONTEXT_OS_LAYERS) {
      const dir = path.join(root, layer);
      const files = (await readDir(dir)).filter((f) => !f.startsWith('.') && f !== 'README.md');
      if (files.length > 0) layerStats.push({ layer, count: files.length });
      totalAssets += files.length;
    }
    // tmp/ 过期草稿 (>1 天未改) → 归档到 snapshots/trash-<ts>/
    const tmpDir = path.join(root, 'tmp');
    try {
      const tmpEntries = await fs.readdir(tmpDir);
      const now = Date.now();
      const trashDir = path.join(snapshotsDir, `trash-${Date.now()}`);
      for (const f of tmpEntries) {
        const fp = path.join(tmpDir, f);
        try {
          const st = await fs.stat(fp);
          if (now - st.mtimeMs > 24 * 3600 * 1000) {
            await fs.mkdir(trashDir, { recursive: true });
            await fs.rename(fp, path.join(trashDir, f));
            archivedTmp++;
          }
        } catch { /* 单个失败跳过 */ }
      }
    } catch { /* tmp 不存在跳过 */ }
    // 打快照清单 (轻量归档, 幂等)
    const manifest = {
      ts: new Date().toISOString(),
      layers: layerStats,
      totalAssets,
      archivedTmp,
    };
    await fs.writeFile(path.join(snapshotsDir, `manifest-${Date.now()}.json`), JSON.stringify(manifest, null, 2), 'utf-8');
    handled = totalAssets;
    return {
      key: 'context-os', label: 'Context OS 归档',
      handled,
      summary: `${layerStats.length} 层 · ${totalAssets} 个资产${archivedTmp > 0 ? ` · 归档 tmp ${archivedTmp} 个` : ''}`,
    };
  } catch (e: any) {
    return { key: 'context-os', label: 'Context OS 归档', handled, error: e?.message || String(e) };
  }
}

// ───────────────────────── 2. 外部社交关系 ─────────────────────────

/** 整理外部社交关系: known_peers 统计 (活跃/失联) + dunbar tier 分布 */
export async function tidySocialRelations(home: string): Promise<OrganizeSection> {
  try {
    const peers = (await readJson(path.join(home, '.bolloon', 'known_peers.json')))?.peers || {};
    const peerEntries = Object.entries(peers) as Array<[string, any]>;
    const now = Date.now();
    let live = 0;
    let stale = 0;
    for (const [, p] of peerEntries) {
      const last = p?.lastConnectedAt ? new Date(p.lastConnectedAt).getTime() : 0;
      if (now - last < 30 * 24 * 3600 * 1000) live++;
      else stale++;
    }
    // dunbar tier 分布
    const tierCount: Record<string, number> = {};
    const peersDir = path.join(home, '.bolloon', 'peers');
    const peerDirs = await readDir(peersDir);
    for (const pk of peerDirs) {
      const tier = await readJson(path.join(peersDir, pk, 'dunbar-tier.json'));
      const t = tier?.tier || 'unknown';
      tierCount[t] = (tierCount[t] || 0) + 1;
    }
    const tierDesc = Object.entries(tierCount)
      .map(([t, n]) => `${t}=${n}`)
      .join(' ');
    return {
      key: 'social', label: '外部社交关系',
      handled: peerEntries.length,
      summary: `${peerEntries.length} peers · 活跃 ${live} · 失联 ${stale} · tier[${tierDesc}]`,
    };
  } catch (e: any) {
    return { key: 'social', label: '外部社交关系', handled: 0, error: e?.message || String(e) };
  }
}

// ───────────────────────── 3. 外部智能体描述 ─────────────────────────

/** 整理外部智能体描述: peers/<pk>/agents/ 下的远端 manifest */
export async function tidyExternalAgents(home: string): Promise<OrganizeSection> {
  try {
    const peersDir = path.join(home, '.bolloon', 'peers');
    const peerDirs = await readDir(peersDir);
    let manifests = 0;
    let peersWithAgents = 0;
    for (const pk of peerDirs) {
      const agentDir = path.join(peersDir, pk, 'agents');
      const files = (await readDir(agentDir)).filter((f) => f.endsWith('.json') || f.endsWith('.md'));
      if (files.length > 0) {
        manifests += files.length;
        peersWithAgents++;
      }
    }
    return {
      key: 'agents-ext', label: '外部智能体描述',
      handled: manifests,
      summary: `${manifests} 个远端 agent (${peersWithAgents} 个 peer)`,
    };
  } catch (e: any) {
    return { key: 'agents-ext', label: '外部智能体描述', handled: 0, error: e?.message || String(e) };
  }
}

// ───────────────────────── 4. 内部智能体描述 ─────────────────────────

/** 整理内部智能体描述: channels.json persona + persona/<agentId>/ 6 文件 */
export async function tidyInternalAgents(home: string): Promise<OrganizeSection> {
  try {
    // channels.json 真实位置在 ~/.bolloon/sessions/channels.json (server-storage 主路径), 兼容旧 ~/.bolloon/channels.json
    const sessionsFile = path.join(home, '.bolloon', 'sessions', 'channels.json');
    const legacyFile = path.join(home, '.bolloon', 'channels.json');
    let channelsRaw = await readJson(sessionsFile);
    if (!channelsRaw) channelsRaw = await readJson(legacyFile);
    // channels.json 是纯数组 (server-storage 主格式), 兼容旧 {channels:[...]} 对象形态
    const channels = Array.isArray(channelsRaw) ? channelsRaw : channelsRaw?.channels || [];
    let withPersona = 0;
    for (const c of channels) {
      if (c?.persona?.name || c?.persona?.description) withPersona++;
    }
    const personaDir = path.join(home, '.bolloon', 'persona');
    const agentDirs = (await readDir(personaDir)).filter((d) => !d.startsWith('.'));
    let personaFiles = 0;
    for (const d of agentDirs) {
      personaFiles += (await readDir(path.join(personaDir, d))).filter((f) => f.endsWith('.md')).length;
    }
    return {
      key: 'agents-int', label: '内部智能体描述',
      handled: channels.length,
      summary: `${channels.length} channels (${withPersona} 有 persona) · ${agentDirs.length} 个 persona 目录 · ${personaFiles} 个文档`,
    };
  } catch (e: any) {
    return { key: 'agents-int', label: '内部智能体描述', handled: 0, error: e?.message || String(e) };
  }
}

// ───────────────────────── 5. judgeness 维护 ─────────────────────────

/** judgeness 内容维护: descriptions 统计 + 归档 >30 天未改的旧描述 */
export async function maintainJudgeness(home: string): Promise<OrganizeSection> {
  try {
    const descDir = path.join(home, '.bolloon', 'judgeness', 'descriptions');
    const files = await listMd(descDir);
    const now = Date.now();
    let archived = 0;
    const archiveDir = path.join(descDir, '..', 'archive');
    for (const f of files) {
      if (now - f.mtime > 30 * 24 * 3600 * 1000) {
        try {
          await fs.mkdir(archiveDir, { recursive: true });
          await fs.rename(path.join(descDir, f.file), path.join(archiveDir, f.file));
          archived++;
        } catch { /* 单个失败跳过 */ }
      }
    }
    return {
      key: 'judgeness', label: 'judgeness 维护',
      handled: files.length,
      summary: `${files.length} 条描述${archived > 0 ? ` · 归档 ${archived} 条旧描述` : ''}`,
    };
  } catch (e: any) {
    return { key: 'judgeness', label: 'judgeness 维护', handled: 0, error: e?.message || String(e) };
  }
}

// ───────────────────────── 6. 其他项目目录的理解 ─────────────────────────

const PROJECT_MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'Makefile'];
/** 扫描的候选项目根目录 (相对 home) — 覆盖用户常见项目位置 */
const PROJECT_SCAN_ROOTS = ['Downloads', 'lean', 'DIAP-TS-SDK', 'alou', 'projects', 'workspace', 'dev', 'code', 'src'];

export interface ScannedProject {
  name: string;
  path: string;
  type: string;
  mtime: number;
}

/** 扫描 home 下的项目目录 (深度 1, 找 manifest), 跳过 node_modules/.git/dist */
export async function scanProjects(home: string): Promise<ScannedProject[]> {
  const out: ScannedProject[] = [];
  for (const rootName of PROJECT_SCAN_ROOTS) {
    const root = path.join(home, rootName);
    const entries = await readDir(root);
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules' || e === 'Library') continue;
      const dir = path.join(root, e);
      let type = '';
      try {
        const st = await fs.stat(dir);
        if (!st.isDirectory()) continue;
        for (const m of PROJECT_MANIFESTS) {
          try {
            await fs.access(path.join(dir, m));
            type = m;
            break;
          } catch { /* 下一个 */ }
        }
        if (!type) continue;
        out.push({ name: e, path: dir, type, mtime: st.mtimeMs });
      } catch { /* 跳过 */ }
    }
  }
  // 去重 (同一目录可能被多个 root 覆盖)
  const seen = new Set<string>();
  return out.filter((p) => {
    if (seen.has(p.path)) return false;
    seen.add(p.path);
    return true;
  });
}

/** 其他项目目录的理解: 扫描项目 → 更新 04-Projects/项目理解.md (llm 可选增强) */
export async function understandProjects(home: string, llm?: (p: string) => Promise<string>): Promise<OrganizeSection> {
  try {
    const projects = await scanProjects(home);
    const now = new Date().toISOString().slice(0, 10);
    let extra = '';
    if (llm && projects.length > 0) {
      try {
        const lines = projects.map((p) => `- ${p.name} (${p.type})`).join('\n');
        const resp = await llm(
          `以下是用户 ${os.homedir()} 下的项目清单, 请用一句话概括每个项目可能是什么 (技术栈/用途), 按原样输出每行:\n${lines}\n\n输出格式: - 项目名: 一句话理解`
        );
        extra = `\n\n## LLM 理解 (${now})\n${resp.slice(0, 2000)}`;
      } catch { /* LLM 增强失败用模板 */ }
    }
    const sorted = [...projects].sort((a, b) => b.mtime - a.mtime);
    const body =
      `# 项目理解索引 (自动整理心跳, ${now})\n\n` +
      `> 由自动整理心跳生成 — 扫描 home 下常见项目目录的 manifest (package.json / pyproject.toml / go.mod / Cargo.toml).\n\n` +
      `## 项目清单 (${projects.length})\n\n` +
      sorted.map((p) => `- **${p.name}** \`${p.type}\` — ${p.path}`).join('\n') +
      extra + '\n';
    const outFile = path.join(home, '.bolloon', 'context-os', '04-Projects', '项目理解.md');
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, body, 'utf-8');
    return {
      key: 'projects', label: '项目目录理解',
      handled: projects.length,
      summary: `${projects.length} 个项目已索引 → 04-Projects/项目理解.md`,
    };
  } catch (e: any) {
    return { key: 'projects', label: '项目目录理解', handled: 0, error: e?.message || String(e) };
  }
}

// ───────────────────────── 7. 用户画像的理解 ─────────────────────────

/** 用户画像的理解: 汇总 persona/<agentId>/user.md + context-os/01-Me/ → 画像快照 */
export async function understandUserProfile(home: string, llm?: (p: string) => Promise<string>): Promise<OrganizeSection> {
  try {
    const personaDir = path.join(home, '.bolloon', 'persona');
    const agentDirs = (await readDir(personaDir)).filter((d) => !d.startsWith('.'));
    const meDir = path.join(home, '.bolloon', 'context-os', '01-Me');
    const meFiles = (await listMd(meDir)).filter((f) => f.file !== 'README.md');
    let handled = agentDirs.length + meFiles.length;
    const now = new Date().toISOString().slice(0, 10);

    // 读 user.md 内容片段 (每 agent 目录)
    let profileSnippet = '';
    for (const d of agentDirs) {
      const userMd = path.join(personaDir, d, 'user.md');
      try {
        const raw = (await fs.readFile(userMd, 'utf-8')).slice(0, 800);
        if (raw.trim()) profileSnippet += `\n### ${d}/user.md\n${raw}\n`;
      } catch { /* 无 user.md */ }
    }
    let extra = '';
    if (llm && (profileSnippet || meFiles.length > 0)) {
      try {
        const resp = await llm(
          `以下是用户的画像素材 (persona user.md + 01-Me 资产). 请提炼 3-5 条"稳定的用户画像要点" (身份/偏好/目标/工作方式):\n${profileSnippet.slice(0, 3000)}\n\n输出要点列表 (每条一行, 以 - 开头)`
        );
        extra = `\n\n## LLM 画像要点 (${now})\n${resp.slice(0, 2000)}`;
      } catch { /* LLM 增强失败 */ }
    }
    const meNames = meFiles.map((f) => f.file).join('; ');
    const body =
      `# 用户画像快照 (自动整理心跳, ${now})\n\n` +
      `> 由自动整理心跳汇总 persona user.md + Context OS 01-Me. 详细档案见 01-Me/个人档案.md.\n\n` +
      `## 画像素材来源\n- persona 目录: ${agentDirs.length} 个 (${agentDirs.join(', ') || '无'})\n- 01-Me 资产: ${meFiles.length} 个 (${meNames || '无'})` +
      (profileSnippet ? `\n\n## user.md 内容片段\n${profileSnippet.slice(0, 3000)}` : '') +
      extra + '\n';
    const outFile = path.join(meDir, '用户画像快照.md');
    await fs.mkdir(meDir, { recursive: true });
    await fs.writeFile(outFile, body, 'utf-8');
    return {
      key: 'user', label: '用户画像理解',
      handled,
      summary: `${agentDirs.length} 个 persona + ${meFiles.length} 个 01-Me 资产 → 用户画像快照`,
    };
  } catch (e: any) {
    return { key: 'user', label: '用户画像理解', handled: 0, error: e?.message || String(e) };
  }
}

// ───────────────────────── 8. 最近记录的日志归档 ─────────────────────────

/** 最近记录的日志: 统计 + 归档 >30 天未改的 jsonl 旧文件 (排除活跃依赖: goals/event.jsonl) */
export async function archiveRecentLogs(home: string): Promise<OrganizeSection> {
  try {
    const root = path.join(home, '.bolloon');
    // 候选日志目录: goals/ engine/ trajectories/ sessions/jsonl/ sidechains/ (存在的才扫)
    const logDirs = ['goals', 'engine', 'trajectories', path.join('sessions', 'jsonl'), 'sidechains'];
    let total = 0;
    let archived = 0;
    const now = Date.now();
    // goal-resume.ts 依赖 goals/event.jsonl 恢复目标事件 — 永不归档
    const protectedFiles = new Set(['event.jsonl']);
    for (const rel of logDirs) {
      const dir = path.join(root, rel);
      const entries = await readDir(dir);
      for (const e of entries) {
        if (!e.endsWith('.jsonl') && !e.endsWith('.log')) continue;
        if (protectedFiles.has(e)) continue;
        total++;
        try {
          const st = await fs.stat(path.join(dir, e));
          if (now - st.mtimeMs > 30 * 24 * 3600 * 1000) {
            const archiveDir = path.join(dir, 'archive');
            await fs.mkdir(archiveDir, { recursive: true });
            await fs.rename(path.join(dir, e), path.join(archiveDir, e));
            archived++;
          }
        } catch { /* 单个失败跳过 */ }
      }
    }
    return {
      key: 'logs', label: '最近日志归档',
      handled: total,
      summary: `${total} 个日志文件${archived > 0 ? ` · 归档 ${archived} 个旧文件` : ''}`,
    };
  } catch (e: any) {
    return { key: 'logs', label: '最近日志归档', handled: 0, error: e?.message || String(e) };
  }
}

// ───────────────────────── 9. 用户目标维护 ─────────────────────────

/** 用户长期/短期目标维护: goals/queue.json + event.jsonl + 03-Current → 目标摘要 */
export async function maintainGoals(home: string, llm?: (p: string) => Promise<string>): Promise<OrganizeSection> {
  try {
    const goalsDir = path.join(home, '.bolloon', 'goals');
    const queue = (await readJson(path.join(goalsDir, 'queue.json'))) || {};
    // queue.json 结构未知, 兼容 object/array
    const queueItems = Array.isArray(queue) ? queue : Object.values(queue).filter((v: any) => v && typeof v === 'object');
    const events = await readDir(goalsDir);
    const now = new Date().toISOString().slice(0, 10);
    const currentDir = path.join(home, '.bolloon', 'context-os', '03-Current');
    const currentFiles = (await listMd(currentDir)).filter((f) => f.file !== 'README.md');

    let extra = '';
    if (llm && (queueItems.length > 0 || currentFiles.length > 0)) {
      try {
        const resp = await llm(
          `以下是用户当前目标素材 (goals queue + 03-Current 进行中的任务). 请区分长期目标与短期目标, 每条一行:\n- [长期/短期] 目标描述\n素材:\n${JSON.stringify(queueItems).slice(0, 1500)}\n${currentFiles.map((f) => f.file).join('\n')}`
        );
        extra = `\n\n## LLM 目标分层 (${now})\n${resp.slice(0, 1500)}`;
      } catch { /* LLM 增强失败 */ }
    }
    const body =
      `# 用户目标摘要 (自动整理心跳, ${now})\n\n` +
      `> 来源: goals/queue.json + goals/event.jsonl + 03-Current 进行中任务.\n\n` +
      `## 目标队列\n${queueItems.length > 0 ? queueItems.map((g: any, i: number) => `- ${g?.description || g?.target || g?.id || `目标 ${i + 1}`}`).join('\n') : '(空)'}\n` +
      `## 进行中任务 (03-Current)\n${currentFiles.length > 0 ? currentFiles.map((f) => `- ${f.file.replace(/\.md$/, '')}`).join('\n') : '(空)'}` +
      extra + '\n';
    const outFile = path.join(currentDir, '目标摘要.md');
    await fs.mkdir(currentDir, { recursive: true });
    await fs.writeFile(outFile, body, 'utf-8');
    return {
      key: 'goals', label: '用户目标维护',
      handled: queueItems.length + currentFiles.length,
      summary: `${queueItems.length} 条队列 + ${currentFiles.length} 个进行中 → 目标摘要`,
    };
  } catch (e: any) {
    return { key: 'goals', label: '用户目标维护', handled: 0, error: e?.message || String(e) };
  }
}

// ───────────────────────── 总入口 ─────────────────────────

/** 自动整理心跳 · 知识层: 串行跑全部 9 个整理器, 汇总 sections */
export async function runKnowledgeOrganize(opts: KnowledgeOrganizeOptions = {}): Promise<KnowledgeOrganizeResult> {
  const home = opts.home || os.homedir();
  const cwd = opts.cwd || process.cwd();
  const llm = opts.llm;
  const sections: OrganizeSection[] = [];
  sections.push(await archiveContextOs(home));
  sections.push(await tidySocialRelations(home));
  sections.push(await tidyExternalAgents(home));
  sections.push(await tidyInternalAgents(home));
  sections.push(await maintainJudgeness(home));
  sections.push(await understandProjects(home, llm));
  sections.push(await understandUserProfile(home, llm));
  sections.push(await archiveRecentLogs(home));
  sections.push(await maintainGoals(home, llm));
  const totalHandled = sections.reduce((acc, s) => acc + (s.error ? 0 : s.handled), 0);
  return { sections, totalHandled };
}
