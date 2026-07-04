/**
 * Persona Documents Loader — ~/.bolloon/persona/<agentId>/*.md
 *
 * 失败静默: 文件不存在 → 字段 = '', 不抛错
 * 安全: agentId sanitize (防路径穿越)
 * 6 段输出顺序: identity → soul → project → user → agent → wiki
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

  if (sections.length === 0) return '';

  // 预算每段 (去掉 ## 标识和换行的固定开销)
  const header = `# Persona (agentId=${docs.agentId})\n\n`;
  const fixedOverhead = header.length + (sections.length - 1) * 2;
  const perSectionBudget = Math.max(50, Math.floor((cap - fixedOverhead) / sections.length));

  const parts: string[] = [header.trim()];
  for (const sec of sections) {
    let body = sec.text;
    if (body.length > perSectionBudget) {
      body = body.substring(0, perSectionBudget) + '\n... (截断)';
    }
    parts.push(body);
  }

  let result = parts.join('\n\n');
  if (result.length > cap) {
    const truncateMarker = '\n... (截断)';
    result = result.substring(0, Math.max(0, cap - truncateMarker.length)) + truncateMarker;
  }
  return result;
}