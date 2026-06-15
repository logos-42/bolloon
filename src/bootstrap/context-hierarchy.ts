/**
 * Context Hierarchy — 4 级 Bolloon.md 查找 + 合并优先级
 *
 * 设计: 严格对齐 Claude Code 论文 4 级层次
 *   1. Managed  — /etc/bolloon/Bolloon.md        (企业 IT 部署, 系统级)
 *   2. User     — ~/.bolloon/Bolloon.md          (用户级, 跨项目)
 *   3. Project  — <cwd>/Bolloon.md 或 .claude/rules/*.md
 *   4. Local    — <cwd>/CLAUDE.local.md         (个人覆盖, .gitignore)
 *
 * 注入约定 (论文):
 * - 拼到 system prompt 顶部 (作为 user context, 概率性遵守)
 * - 不混入 user 消息 (避免 prompt injection)
 * - 截断时反向砍 local → project → user → managed (优先保 managed, 因为是 bolloon 自身约束)
 *
 * 兼容:
 * - 同时识别 Bolloon.md 和 Bolloon.md (论文用前者, bolloon 历史用后者)
 * - 文件名按优先级: Bolloon.md > Bolloon.md
 *
 * 失败静默: 任何 IO 错误 → 返回 null, 不阻塞主流程.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// ============================================================
// 4 级路径配置
// ============================================================

export interface HierarchyPaths {
  managed: string;  // /etc/bolloon/Bolloon.md
  user: string;     // ~/.bolloon/Bolloon.md
  project: string;  // <cwd>/Bolloon.md
  projectRulesDir: string;  // <cwd>/.claude/rules/
  local: string;    // <cwd>/CLAUDE.local.md
}

export interface HierarchyChars {
  managed: number;
  user: number;
  project: number;
  local: number;
}

export interface HierarchyLimits {
  paths?: Partial<HierarchyPaths>;
  maxChars?: Partial<HierarchyChars>;
}

export const DEFAULT_PATHS: HierarchyPaths = {
  managed: '/etc/bolloon/Bolloon.md',
  user: '',  // 用 resolveUserPath 填
  project: '',  // 用 resolveProjectPaths 填
  projectRulesDir: '',
  local: '',
};

/**
 * 单层字符上限 (P-Action 4 收紧, 阶段 0 把 4 级层次控制在 ≤ 2KB).
 * 反向截断策略保证 managed 优先, 单层超限由 truncate() 截断.
 */
export const DEFAULT_MAX_CHARS: HierarchyChars = {
  managed: 700,   // 1500 → 700, 保 bolloon 自身约束
  user: 500,      // 1500 → 500, 跨项目偏好
  project: 500,   // 2500 → 500, 项目规则
  local: 300,     // 1500 → 300, 个人覆盖
};

// ============================================================
// 路径解析
// ============================================================

export function resolveUserPath(home?: string): string {
  const h = home ?? process.env.HOME ?? os.homedir() ?? '/tmp';
  return path.join(h, '.bolloon', 'Bolloon.md');
}

export function resolveProjectPaths(cwd: string): { project: string; projectRulesDir: string; local: string } {
  return {
    project: path.join(cwd, 'Bolloon.md'),
    projectRulesDir: path.join(cwd, '.claude', 'rules'),
    local: path.join(cwd, 'CLAUDE.local.md'),
  };
}

// ============================================================
// 单层读取 (优先 Bolloon.md, fallback Bolloon.md)
// ============================================================

/**
 * 读 1 个文件路径, 失败/缺失返回 null.
 * 字符上限由调用方截断 (这里只负责读全文).
 */
async function readRuleFile(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * 读 project 层: 优先 Bolloon.md, fallback Bolloon.md, 最后尝试 .claude/rules/*.md
 */
async function readProjectLayer(projectPath: string, projectRulesDir: string, maxChars: number): Promise<string | null> {
  // 1. Bolloon.md
  let content = await readRuleFile(projectPath);
  if (content) return truncate(content, maxChars);

  // 2. Bolloon.md (向后兼容)
  const bolloonMdPath = path.join(path.dirname(projectPath), 'Bolloon.md');
  content = await readRuleFile(bolloonMdPath);
  if (content) return truncate(content, maxChars);

  // 3. .claude/rules/*.md (合并所有)
  try {
    const entries = await fs.readdir(projectRulesDir, { withFileTypes: true });
    const ruleFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => path.join(projectRulesDir, e.name))
      .sort();
    if (ruleFiles.length > 0) {
      const parts: string[] = [];
      let total = 0;
      for (const f of ruleFiles) {
        const c = await readRuleFile(f);
        if (c) {
          parts.push(`### ${path.basename(f, '.md')}\n${c}`);
          total += c.length;
          if (total >= maxChars) break;
        }
      }
      if (parts.length > 0) return truncate(parts.join('\n\n'), maxChars);
    }
  } catch { /* dir 不存在 */ }

  return null;
}

// ============================================================
// 4 层收集
// ============================================================

export interface HierarchyLayers {
  managed: string | null;  // /etc/bolloon/Bolloon.md
  user: string | null;     // ~/.bolloon/Bolloon.md
  project: string | null;  // <cwd>/Bolloon.md
  local: string | null;    // <cwd>/CLAUDE.local.md
}

export interface CollectHierarchyOptions {
  cwd: string;
  limits?: HierarchyLimits;
  /** 覆盖 HOME (测试用) */
  home?: string;
}

/**
 * 并行读 4 层, 任何一层失败 = null (不阻塞其他).
 */
export async function collectHierarchyLayers(opts: CollectHierarchyOptions): Promise<HierarchyLayers> {
  const limits: HierarchyLimits['maxChars'] = { ...DEFAULT_MAX_CHARS, ...(opts.limits?.maxChars ?? {}) };

  const home = opts.home ?? process.env.HOME ?? os.homedir() ?? '/tmp';
  const managedPath = opts.limits?.paths?.managed ?? DEFAULT_PATHS.managed;
  const userPath = opts.limits?.paths?.user ?? resolveUserPath(home);
  const projectPath = opts.limits?.paths?.project ?? path.join(opts.cwd, 'Bolloon.md');
  const projectRulesDir = opts.limits?.paths?.projectRulesDir ?? path.join(opts.cwd, '.claude', 'rules');
  const localPath = opts.limits?.paths?.local ?? path.join(opts.cwd, 'CLAUDE.local.md');

  const [managed, user, project, local] = await Promise.all([
    readRuleFile(managedPath).then((c) => c ? truncate(c, limits.managed!) : null),
    readRuleFile(userPath).then((c) => c ? truncate(c, limits.user!) : null),
    readProjectLayer(projectPath, projectRulesDir, limits.project!),
    readRuleFile(localPath).then((c) => c ? truncate(c, limits.local!) : null),
  ]);

  return { managed, user, project, local };
}

// ============================================================
// 合并 + 截断
// ============================================================

export interface MergeOptions {
  /** 总字符上限 (默认 8000, 之前 project-context.ts 用 4000) */
  maxChars?: number;
}

/**
 * 4 级合并总字符上限 (P-Action 4 收紧, ≤ 2KB ≈ 500 tokens).
 * 反向截断 (local → project → user → managed) 保证 managed 不丢.
 */
export const DEFAULT_MERGE_MAX_CHARS = 2000;

/**
 * 按 4 级顺序 (managed → user → project → local) 拼接为 markdown 片段.
 *
 * 截断策略: 反向砍 (local → project → user → managed), 优先保 managed.
 * - 总长 < maxChars: 不截断
 * - 总长 ≥ maxChars: 按 (local, project, user) 顺序逐步砍到 firstParagraphs=1
 * - 最后只保 managed (bolloon 自身约束不能丢)
 */
export function mergeHierarchyLayers(layers: HierarchyLayers, opts: MergeOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MERGE_MAX_CHARS;
  const parts: string[] = [];
  const labels: Array<[keyof HierarchyLayers, string]> = [
    ['managed', '管理规则 (Managed)'],
    ['user', '用户规则 (User)'],
    ['project', '项目规则 (Project)'],
    ['local', '本地规则 (Local)'],
  ];

  for (const [key, label] of labels) {
    const content = layers[key];
    if (content) {
      parts.push(`## ${label}\n\n${content}`);
    }
  }

  if (parts.length === 0) return '';
  let result = parts.join('\n\n---\n\n');
  if (result.length <= maxChars) return result;

  // 超限: 反向砍 (local → project → user), 二级回退到 firstParagraphs=1
  return truncateMerged(layers, maxChars);
}

function truncateMerged(layers: HierarchyLayers, maxChars: number): string {
  const order: Array<[keyof HierarchyLayers, string]> = [
    ['local', '本地规则 (Local)'],
    ['project', '项目规则 (Project)'],
    ['user', '用户规则 (User)'],
    ['managed', '管理规则 (Managed)'],
  ];
  const capped: HierarchyLayers = { ...layers };
  // 反复压缩, 直到总长 ≤ maxChars
  let depth = 0;  // 0=原始, 1=firstParagraphs=1, 2=砍半
  while (depth < 3) {
    const parts: string[] = [];
    for (const [key, label] of order) {
      const c = capped[key];
      if (!c) continue;
      let text = c;
      if (depth === 1) text = firstParagraphs(c, 1);
      if (depth === 2) text = firstParagraphs(c, 1, Math.floor(maxChars / 4));
      parts.push(`## ${label}\n\n${text}`);
    }
    const joined = parts.reverse().join('\n\n---\n\n');  // 恢复 managed → user → project → local
    if (joined.length <= maxChars) return joined;
    depth++;
  }
  // 最后保 managed 一行
  return `## 管理规则 (Managed)\n\n${firstParagraphs(layers.managed ?? '(无)', 1, maxChars - 50)}`;
}

// ============================================================
// 工具
// ============================================================

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.substring(0, maxChars) + '\n... (truncated)';
}

function firstParagraphs(text: string, count: number, maxLen?: number): string {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  let result = paragraphs.slice(0, count).join('\n\n');
  if (maxLen && result.length > maxLen) {
    result = result.substring(0, maxLen) + '...';
  }
  return result;
}

// ============================================================
// 测试钩子
// ============================================================

/** 重置模块级状态 (供测试). 当前无状态, 保留为占位. */
export function _resetHierarchyForTest(): void {
  // no-op (collect 是纯函数, 但保留 API 一致)
}
