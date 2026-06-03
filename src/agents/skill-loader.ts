/**
 * skill-loader.ts — 双 frontmatter 兼容的 SKILL.md 加载器
 *
 * 兼容两套 SKILL.md frontmatter：
 *   A. Anthropic Agent Skills 标准 (2025-12): name / description / license / compatibility / keywords
 *   B. bollharness 现有 frontmatter:           name / description / status / tier / triggers / outputs / truth_policy
 *
 * 字段映射规则（统一到内部 SkillMeta）：
 *   description      ← 直接取
 *   license          ← 取 A，没有则空
 *   status           ← 取 B，没有则默认 'active'
 *   tier             ← 取 B（"tier" 是 bollharness 概念）
 *   triggers / keywords ← 合并 A.keywords 和 B.triggers 数组
 *   body             ← 去掉 frontmatter 后的 Markdown 正文
 *
 * Skill 的 execute() 把 body 作为 Markdown 文档注入到 LLM context。
 * 这是 Skills 协议的核心 — "告诉 agent 怎么做"，与 MCP "能调什么"互补。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Skill } from '@bolloon/constraint-runtime';

/** 解析后的 SKILL.md 内部表示 */
export interface SkillMeta {
  /** 唯一名, 通常 = 目录名 = frontmatter.name */
  name: string;
  /** SKILL.md 绝对路径 */
  sourcePath: string;
  /** 去掉 frontmatter 后的 Markdown body */
  body: string;
  /** 原始 frontmatter 解析结果, 保留以备调用方取 license/compatibility 等 */
  frontmatter: Record<string, unknown>;
  /** 统一后的 description */
  description: string;
  /** 状态: active / archived / draft, 缺省 active */
  status: 'active' | 'archived' | 'draft';
  /** tier (bollharness 概念, 缺省 'utility') */
  tier: string;
  /** 触发条件 (合并 keywords + triggers) */
  triggers: string[];
}

/** YAML frontmatter 最小解析器 — 避免引入额外依赖, 支持双格式 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  // frontmatter 必须以 --- 开头, 紧跟换行, 再以 --- 闭合
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  const [, yamlBlock, body] = match;
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlBlock.split(/\r?\n/);
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    // 数组项: "  - value"
    const arrItem = line.match(/^\s+-\s+(.*)$/);
    if (arrItem && currentKey && currentArray) {
      currentArray.push(stripQuotes(arrItem[1]));
      continue;
    }
    // 键值对: "key: value" 或 "key:"
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) {
      const [, key, value] = kv;
      if (value === '') {
        // 可能是数组开始 (下一行 "  - xxx")
        currentKey = key;
        currentArray = [];
        frontmatter[key] = currentArray;
      } else {
        currentKey = key;
        currentArray = null;
        frontmatter[key] = stripQuotes(value);
      }
    }
  }

  return { frontmatter, body: body.replace(/^\r?\n/, '') };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** 把 frontmatter 统一到 SkillMeta */
function normalize(name: string, sourcePath: string, raw: string): SkillMeta | null {
  const { frontmatter, body } = parseFrontmatter(raw);

  // name 至少要有一个来源: frontmatter.name 或目录名
  const fmName = typeof frontmatter.name === 'string' ? frontmatter.name : name;
  const finalName = fmName || name;
  if (!finalName) return null;

  const description =
    typeof frontmatter.description === 'string'
      ? frontmatter.description
      : '';

  const statusRaw = typeof frontmatter.status === 'string' ? frontmatter.status.toLowerCase() : 'active';
  const status: SkillMeta['status'] =
    statusRaw === 'archived' || statusRaw === 'draft' ? statusRaw : 'active';

  const tier = typeof frontmatter.tier === 'string' ? frontmatter.tier : 'utility';

  // 合并两套触发字段
  const triggers: string[] = [];
  if (Array.isArray(frontmatter.triggers)) {
    for (const t of frontmatter.triggers) if (typeof t === 'string') triggers.push(t);
  }
  if (Array.isArray(frontmatter.keywords)) {
    for (const k of frontmatter.keywords) if (typeof k === 'string') triggers.push(k);
  }

  return { name: finalName, sourcePath, body, frontmatter, description, status, tier, triggers };
}

/** 解析单个 SKILL.md 文件 */
export async function parseSkillFile(filePath: string): Promise<SkillMeta | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  // 从路径推目录名作为 name 兜底
  const dirName = path.basename(path.dirname(filePath));
  return normalize(dirName, filePath, raw);
}

/** 扫描一个目录, 找所有 {name}/SKILL.md (一层嵌套结构) */
export async function loadSkillsDir(dir: string): Promise<SkillMeta[]> {
  const out: SkillMeta[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    const meta = await parseSkillFile(skillFile);
    if (meta) out.push(meta);
  }
  return out;
}

/** 默认 skill 路径优先级 (后者覆盖前者同名 skill) */
export function defaultSkillPaths(home: string = os.homedir(), cwd: string = process.cwd()): string[] {
  return [
    path.join(home, '.bolloon', 'skills'),     // 全局用户级
    path.join(cwd, '.bolloon', 'skills'),       // 项目级
    path.join(home, '.boll', 'skills'),         // 全局 (兼容 bollharness 旧用户)
  ];
}

/** 把 SkillMeta 包成 @bolloon/constraint-runtime 期望的 Skill 对象 */
export function skillFromMeta(meta: SkillMeta): Skill {
  return {
    name: meta.name,
    description: meta.description || meta.tier,
    execute: async (_params: Record<string, unknown>): Promise<string> => {
      // Skills 协议: 把 body 当 Markdown 文档返回, 由调用方注入 LLM context
      // 调用方 (use_skill tool) 拿到后会把 body 放到 tool result,
      // LLM 下一轮对话看到这份指南, 按它执行
      const header = `## Skill: ${meta.name}\n\n${meta.description ? `> ${meta.description}\n\n` : ''}`;
      const triggersBlock = meta.triggers.length
        ? `**触发条件**: ${meta.triggers.join('; ')}\n\n`
        : '';
      return `${header}${triggersBlock}${meta.body}`;
    },
  };
}

/** 加载多个目录, 同名 skill 后者覆盖前者 */
export async function loadSkillsFromPaths(paths: string[]): Promise<Skill[]> {
  const seen = new Map<string, Skill>();
  for (const p of paths) {
    const metas = await loadSkillsDir(p);
    for (const m of metas) {
      if (m.status === 'archived') continue; // 归档的跳过
      seen.set(m.name, skillFromMeta(m));
    }
  }
  return Array.from(seen.values());
}

/** 列出已加载的 skills (调试/UI 用) */
export function describeSkill(s: Skill): string {
  return `${s.name}: ${s.description}`;
}
