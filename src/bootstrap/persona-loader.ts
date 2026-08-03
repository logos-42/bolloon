/**
 * Persona Documents Loader — ~/.bolloon/persona/<agentId>/*.md
 *
 * 失败静默: 文件不存在 → 字段 = '', 不抛错
 * 安全: agentId sanitize (防路径穿越)
 * 6 段输出顺序: identity → soul → project → user → agent → wiki
 *
 * 2026-08-03 (Context OS 融合 P1):
 *   - 支持 persona 文件 frontmatter 里的判断力声明 (judgment_style / stakes_default / revisable),
 *     与 judgeness 5 维 facets 对应 — persona 提供"这个人怎么判断"的入口.
 *   - formatPersonaForSystemPrompt 固定追加 INJECT 工作纪律段 (Context OS 读取协议),
 *     任何 channel 即使无 persona 文件也有纪律约束.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface PersonaDocs {
  agentId: string;
  soul: string;
  identity: string;
  project: string;
  user: string;
  agent: string;
  wiki: string;
}

/** 判断力声明 — persona frontmatter 里的 judgment 相关字段 (Context OS 入口层 ↔ judgeness 5 维) */
export interface PersonaJudgmentDeclaration {
  /** 判断风格描述 (如: 先列出假设再下结论 / 证据驱动 / 保守优先) */
  judgmentStyle: string;
  /** 默认风险等级 (low / medium / high / critical) */
  stakesDefault: string;
  /** 是否偏好可回滚的决策 */
  revisable: boolean;
  /** 原始 frontmatter 字段 (audit) */
  raw: Record<string, string>;
}

const FILE_KEYS = ['soul', 'identity', 'project', 'user', 'agent', 'wiki'] as const;
type FileKey = typeof FILE_KEYS[number];

/**
 * 安全转 agentId: 只保留 [a-zA-Z0-9_-], 限长 64
 * 防止路径穿越 ('/', '..', '\\\\' 都变 '_')
 */
export function sanitizeAgentId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * 读 ~/.bolloon/persona/<sanitizedAgentId>/{6 files}
 * 文件不存在 → 该字段 = ''
 */
export async function loadPersonaDocs(agentId: string, home?: string): Promise<PersonaDocs> {
  const safeId = sanitizeAgentId(agentId);
  const root = home || os.homedir();
  const baseDir = path.join(root, '.bolloon', 'persona', safeId);

  const docs: PersonaDocs = {
    agentId: safeId,
    soul: '',
    identity: '',
    project: '',
    user: '',
    agent: '',
    wiki: '',
  };

  await Promise.all(
    FILE_KEYS.map(async (key) => {
      const file = path.join(baseDir, `${key}.md`);
      try {
        const content = await fs.readFile(file, 'utf-8');
        docs[key] = content;
      } catch {
        docs[key] = '';
      }
    })
  );

  return docs;
}

/**
 * 轻量 frontmatter 解析 (不依赖 js-yaml).
 * 只认 `key: value` 单行字段; 无 frontmatter (不以 --- 开头) → 返回 {}.
 */
export function parseSimpleFrontmatter(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (kv) out[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return out;
}

/**
 * 读 persona 6 文件 frontmatter 里的判断力声明 (Context OS 入口层 ↔ judgeness 5 维).
 * 聚合所有文件中的 judgment_style / stakes_default / revisable 字段 (后者优先).
 * 失败静默: 无 persona 文件 → 全部空值, 不抛错.
 */
export async function loadPersonaJudgmentDeclaration(
  agentId: string,
  home?: string
): Promise<PersonaJudgmentDeclaration> {
  const safeId = sanitizeAgentId(agentId);
  const root = home || os.homedir();
  const baseDir = path.join(root, '.bolloon', 'persona', safeId);

  const decl: PersonaJudgmentDeclaration = {
    judgmentStyle: '',
    stakesDefault: '',
    revisable: true,
    raw: {},
  };

  await Promise.all(
    FILE_KEYS.map(async (key) => {
      try {
        const content = await fs.readFile(path.join(baseDir, `${key}.md`), 'utf-8');
        const fm = parseSimpleFrontmatter(content);
        for (const [k, v] of Object.entries(fm)) {
          if (k.startsWith('judgment_') || k === 'stakes_default' || k === 'revisable') {
            decl.raw[k] = v;
          }
        }
      } catch {
        /* 单文件缺失/损坏跳过 */
      }
    })
  );

  decl.judgmentStyle = decl.raw['judgment_style'] || decl.raw['judgmentStyle'] || '';
  decl.stakesDefault = decl.raw['stakes_default'] || decl.raw['stakesDefault'] || '';
  decl.revisable = decl.raw['revisable'] !== 'false';
  return decl;
}

/** 把判断力声明格式化成一行段 (server contextHint 注入用) */
export function formatJudgmentDeclaration(decl: PersonaJudgmentDeclaration): string {
  if (!decl.judgmentStyle && !decl.stakesDefault && !decl.raw['revisable']) return '';
  const parts: string[] = [];
  if (decl.judgmentStyle) parts.push(`风格: ${decl.judgmentStyle}`);
  if (decl.stakesDefault) parts.push(`默认风险等级: ${decl.stakesDefault}`);
  if (decl.raw['revisable'] === 'false') parts.push('偏好不可回滚的决策 (谨慎)');
  else if (decl.raw['revisable'] === 'true') parts.push('偏好可回滚的决策');
  return `[系统上下文] 判断风格声明 (来自 persona frontmatter, 与 judgeness 判断资产对应):\n  ${parts.join(' / ')}\n\n`;
}

const DEFAULT_MAX_CHARS = 4000;
const SECTION_LABELS: Record<FileKey, string> = {
  identity: 'Identity',
  soul: 'Soul',
  project: 'Project',
  user: 'User',
  agent: 'Agent',
  wiki: 'Wiki',
};
const OUTPUT_ORDER: FileKey[] = ['identity', 'soul', 'project', 'user', 'agent', 'wiki'];

/**
 * 把 PersonaDocs 格式化成 markdown 段, 拼到 system prompt 头部.
 *
 * 超 maxChars 时按比例截断: 每个字段都保留头部,
 * 保证 6 段标识都出现, 不砍段.
 *
 * 2026-08-03: 固定追加 INJECT 工作纪律段 (Context OS 读取协议 §4/§10).
 *   纪律段不参与动态预算 — 即使没有 persona 文件也有纪律约束.
 */
export function formatPersonaForSystemPrompt(docs: PersonaDocs, maxChars?: number): string {
  const cap = maxChars ?? DEFAULT_MAX_CHARS;

  // 段: 标识 + 字段值 (空字段跳过)
  const sections: Array<{ key: FileKey; text: string }> = [];
  for (const key of OUTPUT_ORDER) {
    const v = docs[key];
    if (v && v.length > 0) {
      sections.push({ key, text: `## ${SECTION_LABELS[key]}\n${v}` });
    }
  }

  // INJECT 工作纪律 (Context OS §4 最小读取集 + §10 工作规则, 精简 4 条)
  const discipline =
    '## 工作纪律 (INJECT)\n' +
    '1. 先看动态状态 (历史记忆 / 进行中的计划), 再按任务路由读取对应文档; 不读到的内容不假装知道.\n' +
    '2. 区分: 已知事实 / 你的判断 / 需要用户确认的内容.\n' +
    '3. 重要决策前列出: 选项 (含不做)、成本、收益、风险、信息缺口、回滚条件 — 决策可追溯.\n' +
    '4. 对话收尾提取可复用的决策/知识/教训, 归档到唯一位置, 不制造重复文件.';

  const header = `# Persona (agentId=${docs.agentId})\n\n`;

  // 无 persona 文件 → 只输出纪律段
  if (sections.length === 0) {
    const solo = `${header}${discipline}`;
    return solo.length > cap ? solo.slice(0, cap) : solo;
  }

  // 预算每段 (去掉 ## 标识和换行的固定开销; 纪律段固定, 动态段让出预算)
  const fixedOverhead = header.length + discipline.length + (sections.length - 1) * 2;
  const perSectionBudget = Math.max(50, Math.floor((cap - fixedOverhead) / sections.length));

  const parts: string[] = [header.trim()];
  for (const sec of sections) {
    let body = sec.text;
    if (body.length > perSectionBudget) {
      body = body.substring(0, perSectionBudget) + '\n... (截断)';
    }
    parts.push(body);
  }

  let result = parts.join('\n\n') + '\n\n' + discipline;
  if (result.length > cap) {
    const truncateMarker = '\n... (截断)';
    result = result.substring(0, Math.max(0, cap - truncateMarker.length)) + truncateMarker;
  }
  return result;
}