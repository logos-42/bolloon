/**
 * Bolloon Context Collector — 启动时一次扫描, 收集 5 类项目状态
 *
 * 设计原则:
 * - 每个收集器独立, 失败静默 (返回 null/[] 而非抛错)
 * - 整体 < 200ms (git log + 文件扫描)
 * - 结果可缓存 24h (跟类 B 自适应一致)
 *
 * 收集维度:
 * 1. 项目层: projectRoot, projectName, Bolloon.md 全文
 * 2. git 层: branch, last 5 commits, uncommitted changes count
 * 3. persona 层: ~/.bolloon/persona.json
 * 4. judgments 层: 摘要 (total / active / superseded / top values)
 * 5. skills 层: ~/.bolloon/skills/ + .bolloon/skills/
 * 6. 环境层: OS / node / llm provider
 * 7. pending 层: ~/.bolloon/goals/* + src/ 下的 TODO/FIXME
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface BolloonContext {
  // 1. 项目层
  projectRoot: string;
  projectName: string;
  bolloonMd: string | null;
  // 1b. Bolloon.md 4 级层次 (Claude Code 论文对齐, 严格 1:1)
  // managed: /etc/bolloon/Bolloon.md (企业 IT 部署)
  // user:    ~/.bolloon/Bolloon.md
  // project: <cwd>/Bolloon.md (Bolloon.md 兼容)
  // local:   <cwd>/CLAUDE.local.md
  hierarchy: {
    managed: string | null;
    user: string | null;
    project: string | null;
    local: string | null;
    merged: string;  // 已按优先级合并的 markdown 片段
  };
  // 2. git 层
  git: {
    branch: string;
    lastCommits: string[];
    uncommittedChanges: number;
  } | null;
  // 3. persona
  persona: { name: string; description: string; personality: string } | null;
  // 4. judgments 摘要
  judgmentsSummary: {
    total: number;
    active: number;
    superseded: number;
    rejected: number;
    topValues: Array<{ category: string; value: string; weight: number }>;
  };
  // 5. skills
  skills: Array<{ name: string; description: string }>;
  // 6. 环境
  env: { os: string; nodeVersion: string; llmProvider: string };
  // 7. pending
  pending: {
    goals: string[];
    todos: Array<{ file: string; line: number; text: string }>;
  };
  // 采集时间
  collectedAt: string;
}

export interface CollectOptions {
  cwd: string;
  /** Bolloon.md 全文最大字符数 (默认 2000) */
  bolloonMdMaxBytes?: number;
  /** git log 几条 (默认 5) */
  gitCommitLimit?: number;
  /** judgments Top N values (默认 10) */
  topValuesLimit?: number;
  /** 扫 TODO/FIXME 的根目录, 默认 cwd/src */
  todoScanDir?: string;
}

// ============================================================
// 单个收集器: 全部独立, 失败静默
// ============================================================

async function safeReadFile(filePath: string, maxBytes: number): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    if (content.length > maxBytes) {
      return content.substring(0, maxBytes) + '\n... (truncated)';
    }
    return content;
  } catch {
    return null;
  }
}

async function safeExecFile(cmd: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, timeout: 5000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function collectProject(cwd: string, bolloonMdMaxBytes: number) {
  let projectName = path.basename(cwd);
  try {
    const pkgRaw = await fs.readFile(path.join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    if (typeof pkg.name === 'string') projectName = pkg.name;
  } catch { /* ignore */ }
  const bolloonMd = await safeReadFile(path.join(cwd, 'Bolloon.md'), bolloonMdMaxBytes);
  return { projectName, bolloonMd };
}

async function collectHierarchy(cwd: string): Promise<BolloonContext['hierarchy']> {
  // 动态 import 避免循环依赖
  const { collectHierarchyLayers, mergeHierarchyLayers } = await import('./context-hierarchy.js');
  try {
    const layers = await collectHierarchyLayers({ cwd });
    const merged = mergeHierarchyLayers(layers, { maxChars: DEFAULT_HIERARCHY_MERGED_MAX });
    return { ...layers, merged };
  } catch (err) {
    console.warn('[context-collector] collectHierarchy failed (silent):', err);
    return { managed: null, user: null, project: null, local: null, merged: '' };
  }
}

const DEFAULT_HIERARCHY_MERGED_MAX = 2000;  // 4000 → 2000 (P-Action 4), 跟 context-hierarchy.ts DEFAULT_MERGE_MAX_CHARS 对齐

async function collectGit(cwd: string, limit: number): Promise<BolloonContext['git']> {
  const branchOut = await safeExecFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branchOut) return null;
  const logOut = await safeExecFile('git', ['log', '--oneline', `-n`, String(limit)], cwd);
  const statusOut = await safeExecFile('git', ['status', '--porcelain'], cwd);
  return {
    branch: branchOut,
    lastCommits: logOut ? logOut.split('\n').filter(Boolean) : [],
    uncommittedChanges: statusOut ? statusOut.split('\n').filter(Boolean).length : 0,
  };
}

async function collectPersona(): Promise<BolloonContext['persona']> {
  const home = process.env.HOME || os.homedir() || '/tmp';
  const raw = await safeReadFile(path.join(home, '.bolloon', 'persona.json'), 5000);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return {
      name: String(p.name || 'unknown'),
      description: String(p.description || ''),
      personality: String(p.personality || ''),
    };
  } catch {
    return null;
  }
}

async function collectJudgmentsSummary(topN: number): Promise<BolloonContext['judgmentsSummary']> {
  // 用动态 import 避免循环依赖
  const { loadAllJudgments } = await import('../pi-ecosystem-judgment/human-value-store.js');
  let all: Awaited<ReturnType<typeof loadAllJudgments>> = [];
  try {
    all = await loadAllJudgments();
  } catch {
    return { total: 0, active: 0, superseded: 0, rejected: 0, topValues: [] };
  }
  const byStatus = { active: 0, superseded: 0, rejected: 0 };
  for (const j of all) {
    const s = (j.status ?? 'active') as 'active' | 'superseded' | 'rejected';
    if (s in byStatus) byStatus[s]++;
  }
  // 借用 getRelevantValues 算 top values (已经在 store 里)
  let topValues: BolloonContext['judgmentsSummary']['topValues'] = [];
  try {
    const { getRelevantValues } = await import('../pi-ecosystem-judgment/human-value-store.js');
    const values = await getRelevantValues('安全 代码 质量 测试 文档 用户');  // 通用 query
    topValues = values.slice(0, topN).map((v) => ({
      category: v.category,
      value: v.value,
      weight: v.weight,
    }));
  } catch { /* ignore */ }
  return {
    total: all.length,
    active: byStatus.active,
    superseded: byStatus.superseded,
    rejected: byStatus.rejected,
    topValues,
  };
}

async function collectSkills(): Promise<BolloonContext['skills']> {
  const home = process.env.HOME || os.homedir() || '/tmp';
  const userSkillsDir = path.join(home, '.bolloon', 'skills');
  const projectSkillsDir = path.join(process.cwd(), '.bolloon', 'skills');
  const out: BolloonContext['skills'] = [];
  const seen = new Set<string>();
  for (const dir of [userSkillsDir, projectSkillsDir]) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || seen.has(e.name)) continue;
        seen.add(e.name);
        // 尝试读 SKILL.md 第一行作为描述
        let description = '';
        try {
          const skillMd = await fs.readFile(path.join(dir, e.name, 'SKILL.md'), 'utf-8');
          // 抓第一段非空非 frontmatter
          const lines = skillMd.split('\n');
          let inFrontmatter = false;
          for (const line of lines) {
            if (line.trim() === '---') { inFrontmatter = !inFrontmatter; continue; }
            if (inFrontmatter) continue;
            if (line.trim() && !line.startsWith('#')) {
              description = line.trim().substring(0, 120);
              break;
            }
          }
        } catch { /* ignore */ }
        out.push({ name: e.name, description });
      }
    } catch { /* dir 不存在正常 */ }
  }
  return out;
}

function collectEnv(): BolloonContext['env'] {
  let llmProvider = 'unknown';
  try {
    const home = process.env.HOME || os.homedir() || '/tmp';
    const cfg = require(path.join(home, '.bolloon', 'llm-config.json'));
    if (cfg && typeof cfg === 'object' && 'provider' in cfg) {
      llmProvider = String(cfg.provider);
    }
  } catch { /* ignore */ }
  return {
    os: `${os.platform()} ${os.release()}`,
    nodeVersion: process.version,
    llmProvider,
  };
}

async function collectPending(opts: CollectOptions): Promise<BolloonContext['pending']> {
  const home = process.env.HOME || os.homedir() || '/tmp';
  const goalsDir = path.join(home, '.bolloon', 'goals');
  const goals: string[] = [];
  try {
    const entries = await fs.readdir(goalsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) goals.push(e.name);
    }
  } catch { /* dir 不存在 */ }

  // 扫 TODO/FIXME (限制 20 条避免太长)
  const todoScanDir = opts.todoScanDir ?? path.join(opts.cwd, 'src');
  const todos = await scanTodos(todoScanDir, 20);

  return { goals, todos };
}

async function scanTodos(dir: string, limit: number): Promise<BolloonContext['pending']['todos']> {
  const out: BolloonContext['pending']['todos'] = [];
  try {
    await walkDir(dir, async (filePath) => {
      if (!/\.(ts|js|tsx|jsx)$/.test(filePath)) return;
      // 跳过 dist / node_modules
      if (filePath.includes('/node_modules/') || filePath.includes('/dist/')) return;
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // 匹配 TODO / FIXME / XXX 注释
          const m = line.match(/(?:\/\/|\/\*|\*|<!--)\s*(TODO|FIXME|XXX|HACK)[:：]?\s*(.+)/);
          if (m) {
            out.push({
              file: path.relative(dir, filePath),
              line: i + 1,
              text: m[2].trim().substring(0, 80),
            });
            if (out.length >= limit) return;
          }
        }
      } catch { /* ignore */ }
    });
  } catch { /* dir 不存在 */ }
  return out;
}

async function walkDir(dir: string, cb: (file: string) => Promise<void>): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      await walkDir(full, cb);
    } else if (e.isFile()) {
      await cb(full);
    }
  }
}

// ============================================================
// 主入口
// ============================================================

export async function collectBolloonContext(opts: CollectOptions): Promise<BolloonContext> {
  const {
    cwd,
    bolloonMdMaxBytes = 2000,
    gitCommitLimit = 5,
    topValuesLimit = 10,
  } = opts;
  // 并行收集 (除 judgments 因为要动态 import + 依赖其它)
  const [project, git, persona, skills, env, pending, hierarchy] = await Promise.all([
    collectProject(cwd, bolloonMdMaxBytes),
    collectGit(cwd, gitCommitLimit),
    collectPersona(),
    collectSkills(),
    Promise.resolve(collectEnv()),
    collectPending(opts),
    collectHierarchy(cwd),
  ]);
  // judgments 单独调 (内部 import)
  const judgmentsSummary = await collectJudgmentsSummary(topValuesLimit);

  return {
    projectRoot: cwd,
    projectName: project.projectName,
    bolloonMd: project.bolloonMd,
    hierarchy,
    git,
    persona,
    judgmentsSummary,
    skills,
    env,
    pending,
    collectedAt: new Date().toISOString(),
  };
}

// ============================================================
// 24h 缓存 (跟类 B 一致)
// ============================================================

let cached: { at: number; ctx: BolloonContext; cwd: string } | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function getCachedBolloonContext(opts: CollectOptions, force: boolean = false): Promise<BolloonContext> {
  if (!force && cached && cached.cwd === opts.cwd && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.ctx;
  }
  const ctx = await collectBolloonContext(opts);
  cached = { at: Date.now(), ctx, cwd: opts.cwd };
  return ctx;
}

export function clearBolloonContextCache(): void {
  cached = null;
}
