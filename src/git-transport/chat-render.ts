// src/git-transport/chat-render.ts
// 解析 markdown 消息文件 + 去重 key + 列表/过滤, 纯函数, 不碰 git.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ChatMessage, ChatFrontmatter, CHAT_PROTOCOL_VERSION } from './chat-types.js';

function tryRead(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// 极简 frontmatter 解析: 不引 gray-matter 这种依赖
// 约定: 文件首行是 "---", 之后是 YAML-like 块 (key: value), 直到下一个 "---"
// 字段值只支持 string / number / 嵌套对象字面量; 对我们够用
function parseFrontmatter(raw: string): { fm: ChatFrontmatter | null; body: string } {
  if (!raw.startsWith('---')) return { fm: null, body: raw };
  const lines = raw.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return { fm: null, body: raw };
  const headerLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');

  const fm: any = { v: CHAT_PROTOCOL_VERSION };
  let i = 0;
  while (i < headerLines.length) {
    const line = headerLines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const m = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1];
    let val: any = m[2].trim();
    if (val === '') {
      // 嵌套对象 — 收集到下一个顶级 key 之前
      const obj: any = {};
      i++;
      while (i < headerLines.length) {
        const l2 = headerLines[i];
        if (/^[A-Za-z_][\w]*\s*:/.test(l2)) break;
        const m2 = /^(\s+)([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(l2);
        if (m2) {
          obj[m2[2]] = stripQuotes(m2[3].trim());
        }
        i++;
      }
      val = obj;
    } else {
      val = stripQuotes(val);
      // 数字字面量尽量 parse 成 number, 让 fm.v 严格比较能过
      if (/^-?\d+(\.\d+)?$/.test(val)) {
        const n = Number(val);
        if (!Number.isNaN(n)) val = n;
      }
      i++;
    }
    fm[key] = val;
  }

  // 强校验
  if (typeof fm.from !== 'string' || typeof fm.fromPk !== 'string' || typeof fm.ts !== 'string') {
    return { fm: null, body: raw };
  }
  if (fm.v !== CHAT_PROTOCOL_VERSION) {
    return { fm: null, body: raw };
  }
  return { fm: fm as ChatFrontmatter, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function parseMessageFile(filePath: string, sha: string): ChatMessage | null {
  const raw = tryRead(filePath);
  if (raw === null) return null;
  const { fm, body } = parseFrontmatter(raw);
  if (!fm) return null;
  return { filePath, frontmatter: fm, body, sha };
}

// 列出 .comm/<role>/*.md 下所有消息文件 (角色目录是按字母扫的, 不依赖 git)
export function listMessageFiles(repoDir: string): string[] {
  const comm = path.join(repoDir, '.comm');
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(comm, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_')) continue; // _state / _inbox 跳过
    const roleDir = path.join(comm, e.name);
    let files: string[] = [];
    try { files = fs.readdirSync(roleDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      out.push(path.join(roleDir, f));
    }
  }
  return out;
}

export function listMessages(repoDir: string, withRole?: string, limit?: number): ChatMessage[] {
  const files = listMessageFiles(repoDir);
  const out: ChatMessage[] = [];
  for (const f of files) {
    if (withRole && !f.includes(`${path.sep}.comm${path.sep}${withRole}${path.sep}`)) continue;
    const msg = parseMessageFile(f, '');
    if (msg) out.push(msg);
  }
  out.sort((a, b) => a.frontmatter.ts.localeCompare(b.frontmatter.ts));
  return typeof limit === 'number' ? out.slice(-limit) : out;
}

// 去重 key: (fromPk, ts, contentHash8) — 不论 P2P 还是 git 谁先到都收敛到同一键
export function dedupeKey(msg: ChatMessage): string {
  const h = crypto.createHash('sha256').update(msg.body).digest('hex').slice(0, 8);
  return `${msg.frontmatter.fromPk}:${msg.frontmatter.ts}:${h}`;
}

// 单行展示 — 给 chat-list / chat-watch 输出用
export function renderOneLine(msg: ChatMessage): string {
  const time = msg.frontmatter.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z').replace('Z', '');
  const preview = msg.body.split('\n')[0].slice(0, 80);
  return `[${time} ${msg.frontmatter.from}] ${preview}`;
}
