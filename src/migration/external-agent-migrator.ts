/**
 * migration/external-agent-migrator.ts — 把本机 OpenClaw / Hermes 的智能体数据
 *   按相同格式整理进 Bolloon 系统路径, 实现"无缝兼容" (性格 / 记忆 / 技能 / 文档).
 *
 * 动机 (2026-08-08, v0.3.39):
 *   - 用户在本机用 OpenClaw / Hermes 设计了智能体 (人格文档 + 技能 + 记忆 + 文档).
 *   - Bolloon 初始化加载时, 希望把这些"别人的系统"的数据按 Bolloon 的既有格式
 *     (persona 6 文件 / SKILL.md / memory sessions / context-os 资产) 迁移进来,
 *     这样 Bolloon 能直接加载同一套性格 / 记忆 / 技能, 无缝兼容.
 *   - 隐式处理: 启动时静默跑, 失败不影响主流程; 完成后通告给用户 (见 report).
 *
 * 异构布局 (2026-08-08 v0.3.40):
 *   - OpenClaw 平铺在 ~/.openclaw/workspace/ (SOUL/IDENTITY/USER/AGENTS/TOOLS/MEMORY.md +
 *     skills/<name>/ + memory/*.md)
 *   - Hermes 根在 %LOCALAPPDATA%\hermes (Windows, 兜底 ~/.hermes), persona 分布在
 *     SOUL.md(根) + memories/{USER,MEMORY}.md, skills 是 skills/<分类>/<技能>/SKILL.md
 *     两级嵌套 (235 个). 迁移时展平并以 <分类>-<技能> 命名避免重名冲突.
 *
 * 幂等: 每个源落一份 manifest (~/.bolloon/migration/<source>.json),
 *   记录已迁移的文件 hash; 未变化则跳过, 已存在则覆盖源文档 (文档允许演进),
 *   技能只复制新增/变化的 (不删除目标已存在但源已删的, 保守).
 *
 * 安全: 不读取/复制 API key 类文件 (credentials/identity/*auth*), 不碰 secret.
 *
 * 设计范式: 与 external-engines/discovery.ts 一致 — 纯函数 + 可注入 deps, 便于单测.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { sanitizeAgentId } from '../bootstrap/persona-loader.js';

// ============================================================
// 类型
// ============================================================

/** 一个迁移源 (openclaw / hermes) */
export type ExternalAgentSource = 'openclaw' | 'hermes';

export interface MigratedEntry {
  from: string;
  to: string;
  kind: 'persona' | 'skill' | 'memory' | 'docs';
}

export interface MigrationReport {
  source: ExternalAgentSource;
  /** 源根目录 (检测到才迁移, 否则 skipped) */
  sourceRoot: string;
  migratedAt: string;
  migrated: boolean;
  personaAgentId: string;
  persona: string[];
  skillsCopied: string[];
  memoryCopied: string[];
  docsCopied: string[];
  entries: MigratedEntry[];
  errors: string[];
}

/** 可注入依赖 (单测时用 tmp 目录) */
export interface MigratorDeps {
  home: string;
  /** Windows 的 %LOCALAPPDATA%; hermes 用它定位 (缺省兜底 home/.hermes) */
  localAppData?: string;
  readFile: (p: string) => Promise<string | undefined>;
  readdir: (dir: string) => Promise<string[] | undefined>;
  stat: (p: string) => Promise<{ isDirectory: boolean; isFile: boolean; mtimeMs: number } | undefined>;
  mkdir: (p: string) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
  writeFile: (p: string, data: string) => Promise<void>;
  exists: (p: string) => Promise<boolean>;
}

// ============================================================
// 默认 deps (真实 IO)
// ============================================================

function realReadFile(p: string): Promise<string | undefined> {
  return fs.readFile(p, 'utf-8').then((c) => c).catch(() => undefined);
}
function realReaddir(dir: string): Promise<string[] | undefined> {
  return fs.readdir(dir).then((c) => c).catch(() => undefined);
}
function realStat(p: string): Promise<{ isDirectory: boolean; isFile: boolean; mtimeMs: number } | undefined> {
  return fs.stat(p).then((s) => ({ isDirectory: s.isDirectory(), isFile: s.isFile(), mtimeMs: s.mtimeMs })).catch(() => undefined);
}
function realExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

export function defaultDeps(): MigratorDeps {
  const home = os.homedir();
  return {
    home,
    localAppData:
      (typeof process !== 'undefined' && process.env && (process.env.LOCALAPPDATA || process.env.ProgramData))
        ? (process.env.LOCALAPPDATA || process.env.ProgramData) as string
        : path.join(home, 'AppData', 'Local'),
    readFile: realReadFile,
    readdir: realReaddir,
    stat: realStat,
    mkdir: async (p) => { await fs.mkdir(p, { recursive: true }); },
    copyFile: (f, t) => fs.copyFile(f, t),
    writeFile: (p, d) => fs.writeFile(p, d, 'utf-8'),
    exists: realExists,
  };
}

// ============================================================
// 纯函数: 目录布局 + hash
// ============================================================

/** 各源默认根目录: openclaw 在 home/.openclaw; hermes 兜底 home/.hermes (真实见 candidates) */
export function sourceRootPath(source: ExternalAgentSource, home: string): string {
  return source === 'openclaw'
    ? path.join(home, '.openclaw')
    : path.join(home, '.hermes');
}

/** 各源全部候选根 (按优先级). hermes 首选 %LOCALAPPDATA%\hermes. */
export function sourceRootCandidates(source: ExternalAgentSource, deps: MigratorDeps): string[] {
  if (source === 'openclaw') {
    return [sourceRootPath('openclaw', deps.home)];
  }
  const local = deps.localAppData ? path.join(deps.localAppData, 'hermes') : null;
  const candidates: string[] = [];
  if (local) candidates.push(local);
  candidates.push(sourceRootPath('hermes', deps.home));
  return candidates;
}

/** workspace 路径 (openclaw 用 workspace/, hermes 平铺在根) */
export function workspacePath(source: ExternalAgentSource, sourceRoot: string): string {
  return source === 'openclaw'
    ? path.join(sourceRoot, 'workspace')
    : sourceRoot;
}

/** 计算文件内容 hash (幂等用) */
export function sha1(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex');
}

/** bolloon 目标根 (默认 ~/.bolloon, 可注入 override) */
function bolloonRoot(home: string): string {
  return path.join(home, '.bolloon');
}

// ============================================================
// 单文件迁移 helper
// ============================================================

async function copyIfNeeded(
  deps: MigratorDeps,
  from: string,
  to: string,
  manifest: Map<string, string>,
): Promise<boolean> {
  const content = await deps.readFile(from);
  if (content === undefined) return false;
  const hash = sha1(content);
  if (manifest.get(to) === hash) return false; // 未变化, 跳过
  await deps.mkdir(path.dirname(to));
  await deps.writeFile(to, content);
  manifest.set(to, hash);
  return true;
}

async function copyDirIfNeeded(
  deps: MigratorDeps,
  srcDir: string,
  destDir: string,
  manifest: Map<string, string>,
): Promise<string[]> {
  const copied: string[] = [];
  const entries = await deps.readdir(srcDir);
  if (!entries) return copied;
  for (const name of entries) {
    const s = path.join(srcDir, name);
    const st = await deps.stat(s);
    if (!st) continue;
    if (st.isDirectory) {
      copied.push(...await copyDirIfNeeded(deps, s, path.join(destDir, name), manifest));
    } else if (st.isFile) {
      const to = path.join(destDir, name);
      if (await copyIfNeeded(deps, s, to, manifest)) copied.push(name);
    }
  }
  return copied;
}

// ============================================================
// 主迁移
// ============================================================

/** 探测某源是否安装: 返回选中的根目录 or null. */
export async function detectSource(deps: MigratorDeps, source: ExternalAgentSource): Promise<string | null> {
  for (const root of sourceRootCandidates(source, deps)) {
    const st = await deps.stat(root);
    if (st?.isDirectory) return root;
  }
  return null;
}

/** persona 源文件映射 (相对 workspace; 分组按源). */
type PersonaSpec = Array<{ src: string; toName: string }>;

const OPENCLAW_PERSONA: PersonaSpec = [
  { src: 'SOUL.md', toName: 'soul.md' },
  { src: 'IDENTITY.md', toName: 'identity.md' },
  { src: 'USER.md', toName: 'user.md' },
  { src: 'AGENTS.md', toName: 'agent.md' },
  { src: 'TOOLS.md', toName: 'project.md' },
  { src: 'MEMORY.md', toName: 'wiki.md' },
];

const HERMES_PERSONA: PersonaSpec = [
  { src: 'SOUL.md', toName: 'soul.md' },
  { src: 'memories/USER.md', toName: 'user.md' },
  { src: 'memories/MEMORY.md', toName: 'wiki.md' },
];

/**
 * 迁移单个源的全部数据到 Bolloon.
 * 返回 report; 源不存在 → migrated=false 且不抛错 (静默).
 */
export async function migrateExternalAgent(
  source: ExternalAgentSource,
  deps: MigratorDeps = defaultDeps(),
): Promise<MigrationReport> {
  const report: MigrationReport = {
    source,
    sourceRoot: sourceRootPath(source, deps.home),
    migratedAt: new Date().toISOString(),
    migrated: false,
    personaAgentId: '',
    persona: [],
    skillsCopied: [],
    memoryCopied: [],
    docsCopied: [],
    entries: [],
    errors: [],
  };

  try {
    const root = await detectSource(deps, source);
    if (!root) {
      report.migrated = false;
      return report; // 未安装, 静默
    }
    report.sourceRoot = root;

    const ws = workspacePath(source, root);
    const wsStat = await deps.stat(ws);
    if (!wsStat?.isDirectory) {
      report.migrated = false;
      report.errors.push(`workspace 目录不存在: ${ws}`);
      return report;
    }

    // agentId: 用源名 + 目录名 (openclaw main agent) 兜底
    const rawAgent = source === 'openclaw' ? 'main' : 'hermes-main';
    const agentId = sanitizeAgentId(`ext-${source}-${rawAgent}`);
    report.personaAgentId = agentId;

    const bRoot = bolloonRoot(deps.home);
    const personaDir = path.join(bRoot, 'persona', agentId);
    const skillsRoot = path.join(bRoot, 'skills');
    const memoryRoot = path.join(bRoot, 'memory', agentId, 'sessions');
    const docsRoot = path.join(bRoot, 'context-os', '04-Projects', `${source}-docs`);

    // manifest (幂等)
    const manifestFile = path.join(bRoot, 'migration', `${source}.json`);
    const manifest = new Map<string, string>();
    const prev = await deps.readFile(manifestFile);
    if (prev) {
      try {
        const obj = JSON.parse(prev);
        if (obj && typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) manifest.set(k, String(v));
        }
      } catch { /* 损坏忽略, 从头迁 */ }
    }

    await deps.mkdir(path.join(bRoot, 'migration'));

    // 1. persona (per-source spec)
    const personaSpec = source === 'openclaw' ? OPENCLAW_PERSONA : HERMES_PERSONA;
    for (const { src, toName } of personaSpec) {
      const from = path.join(ws, src);
      const to = path.join(personaDir, toName);
      if (await copyIfNeeded(deps, from, to, manifest)) {
        report.persona.push(toName);
        report.entries.push({ from, to, kind: 'persona' });
      }
    }

    // 2. skills → ~/.bolloon/skills/<name>/
    const skillsSrc = path.join(ws, 'skills');
    const skillDirs = await deps.readdir(skillsSrc);
    if (skillDirs) {
      // OpenClaw: skills/<name>/SKILL.md 一层, 直接落盘 <name>.
      // Hermes: skills/<分类>/<技能>/SKILL.md 两层, 逐 <技能> 递归找 SKILL.md,
      //   落盘 <分类>-<技能> 展平, 避免跨分类重名.
      for (const entryName of skillDirs) {
        if (entryName.startsWith('.')) continue;
        const entry = path.join(skillsSrc, entryName);
        const st = await deps.stat(entry);
        if (!st?.isDirectory) continue;

        if (source === 'hermes') {
          // 分类下的每个技能目录 → 目标 <分类>-<技能>
          const cat = entryName;
          const subDirs = await deps.readdir(entry);
          if (!subDirs) continue;
          for (const skillName of subDirs) {
            if (skillName.startsWith('.')) continue;
            const skillDir = path.join(entry, skillName);
            const sst = await deps.stat(skillDir);
            if (!sst?.isDirectory) continue;
            // 该分类下菊 不一定有 SKILL.md → 跳过
            const hasSkill = await deps.exists(path.join(skillDir, 'SKILL.md'));
            if (!hasSkill) continue;
            const targetName = `${cat}-${skillName}`;
            const destDir = path.join(skillsRoot, targetName);
            const copied = await copyDirIfNeeded(deps, skillDir, destDir, manifest);
            if (copied.length > 0) {
              report.skillsCopied.push(targetName);
              report.entries.push({ from: skillDir, to: destDir, kind: 'skill' });
            }
          }
        } else {
          const destDir = path.join(skillsRoot, entryName);
          const copied = await copyDirIfNeeded(deps, entry, destDir, manifest);
          if (copied.length > 0) {
            report.skillsCopied.push(entryName);
            report.entries.push({ from: entry, to: destDir, kind: 'skill' });
          }
        }
      }
    }

    // 3. memory: openclaw workspace/memory/*.md → sessions/; hermes 无独立 memory 目录
    const memSrc = path.join(ws, 'memory');
    const memFiles = await deps.readdir(memSrc);
    if (memFiles) {
      let idx = 0;
      for (const f of memFiles) {
        if (!f.endsWith('.md')) continue;
        const from = path.join(memSrc, f);
        const to = path.join(memoryRoot, `${idx + 1}-${f}`);
        if (await copyIfNeeded(deps, from, to, manifest)) {
          report.memoryCopied.push(f);
          report.entries.push({ from, to, kind: 'memory' });
        }
        idx++;
      }
    }

    // 4. docs: workspace 根其他 .md → context-os/04-Projects/<source>-docs/
    const wsFiles = await deps.readdir(ws);
    if (wsFiles) {
      const excluded = personaSpec.map((p) => p.toName);
      for (const f of wsFiles) {
        if (!f.endsWith('.md')) continue;
        if (excluded.includes(f)) continue;
        const from = path.join(ws, f);
        const st = await deps.stat(from);
        if (!st?.isFile) continue;
        const to = path.join(docsRoot, f);
        if (await copyIfNeeded(deps, from, to, manifest)) {
          report.docsCopied.push(f);
          report.entries.push({ from, to, kind: 'docs' });
        }
      }
    }

    // 写回 manifest
    await deps.writeFile(manifestFile, JSON.stringify(Object.fromEntries(manifest), null, 2));
    report.migrated = true;
    return report;
  } catch (err: any) {
    report.errors.push((err as Error).message?.slice(0, 300) || String(err));
    return report;
  }
}

/** 一次性迁移所有已安装源 (openclaw + hermes). 隐式, 静默. */
export async function migrateAllExternalAgents(deps: MigratorDeps = defaultDeps()): Promise<MigrationReport[]> {
  const sources: ExternalAgentSource[] = ['openclaw', 'hermes'];
  const out: MigrationReport[] = [];
  for (const s of sources) {
    const r = await migrateExternalAgent(s, deps);
    if (r.migrated) out.push(r);
  }
  return out;
}

/** 把迁移结果格式化成给用户看的中文通告 (纯函数, 可单测) */
export function formatMigrationNotices(reports: MigrationReport[]): string[] {
  const lines: string[] = [];
  for (const r of reports) {
    if (!r.migrated) continue;
    const parts: string[] = [];
    if (r.persona.length) parts.push(`性格 ${r.persona.length} 份`);
    if (r.skillsCopied.length) parts.push(`技能 ${r.skillsCopied.length} 个`);
    if (r.memoryCopied.length) parts.push(`记忆 ${r.memoryCopied.length} 条`);
    if (r.docsCopied.length) parts.push(`文档 ${r.docsCopied.length} 份`);
    lines.push(`[迁移:${r.source}] 外部智能体数据已并入 Bolloon (agentId=${r.personaAgentId}): ${parts.join(', ') || '已就绪'}${r.errors.length ? ` (${r.errors.length} 个错误)` : ''}`);
  }
  return lines;
}