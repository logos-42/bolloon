/**
 * peer-resource-bridge.ts — 4 类资源 (groups/function/exportment/science) 的
 *   本地读 + 远端落盘的统一封装.
 *
 * 设计目的 (2026-07-05):
 *   peer-fs.ts 已经有完整路径 helpers (writeGroup/writeFunction/...) + reader (listPeerResources).
 *   server.ts 三处要调 (两个 manifest.exchange.reply 落盘 + 一个 manifest.exchange 发送),
 *   每处手写 4 个 await 又啰嗦又容易漏. 这里抽出来.
 *
 *   本地读: ~/.bolloon/local-resources/<category>/<id>.md frontmatter
 *   远端落: peerFs.writeGroup/Function/Exportment/Science (atomic, 人类可读 md)
 *
 *   frontmatter 字段就是类型本身的字段 (id/name/description/...),
 *   description 从 frontmatter 后面的第一个段落拿.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as peerFs from '../network/peer-fs.js';
import type {
  ManifestGroup, ManifestFunction, ManifestExportment, ManifestScience,
} from '../agents/agent-manifest-protocol.js';

const HOME = process.env.BOLLOON_HOME || path.join(os.homedir(), '.bolloon');
export const LOCAL_RESOURCES_ROOT = path.join(HOME, 'local-resources');

type Category = 'groups' | 'functions' | 'exportments' | 'sciences';

export interface ResourceBundle {
  groups: ManifestGroup[];
  functions: ManifestFunction[];
  exportments: ManifestExportment[];
  sciences: ManifestScience[];
}

const EMPTY: ResourceBundle = { groups: [], functions: [], exportments: [], sciences: [] };

/**
 * 简单 frontmatter 解析: 只支持 key: value / key: [..] (本文件自产自销, 不引第三方).
 */
function parseFrontmatter(text: string): { fields: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let raw = kv[2].trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      try {
        fields[key] = JSON.parse(raw);
        continue;
      } catch {}
    }
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      try { fields[key] = JSON.parse(raw); continue; } catch {}
    }
    fields[key] = raw;
  }
  return { fields, body: m[2].trim() };
}

/**
 * 从 ~/.bolloon/local-resources/<category>/<id>.md 读所有本地资源.
 * 文件不存在 / 目录不存在 → 返回空数组 (不报错, 跟 peer-fs 风格一致).
 */
async function readCategoryDir(category: Category): Promise<string[]> {
  try {
    const dir = path.join(LOCAL_RESOURCES_ROOT, category);
    const entries = await fs.readdir(dir);
    return entries.filter((e) => e.endsWith('.md')).map((e) => path.join(dir, e));
  } catch {
    return [];
  }
}

async function readGroupFile(p: string): Promise<ManifestGroup | null> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const { fields, body } = parseFrontmatter(raw);
    if (!fields.id) return null;
    return {
      id: String(fields.id),
      name: String(fields.name || fields.id),
      description: body || undefined,
      visibility: fields.visibility as ManifestGroup['visibility'],
      memberCount: typeof fields.memberCount === 'number' ? fields.memberCount : undefined,
    };
  } catch { return null; }
}

async function readFunctionFile(p: string): Promise<ManifestFunction | null> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const { fields, body } = parseFrontmatter(raw);
    if (!fields.capability) return null;
    return {
      capability: String(fields.capability),
      description: body || undefined,
      mediaType: fields.mediaType as ManifestFunction['mediaType'],
      endpoint: fields.endpoint ? String(fields.endpoint) : undefined,
    };
  } catch { return null; }
}

async function readExportmentFile(p: string): Promise<ManifestExportment | null> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const { fields, body } = parseFrontmatter(raw);
    if (!fields.name) return null;
    return {
      name: String(fields.name),
      description: body || undefined,
      genre: fields.genre ? String(fields.genre) : undefined,
      minPlayers: typeof fields.minPlayers === 'number' ? fields.minPlayers : undefined,
      maxPlayers: typeof fields.maxPlayers === 'number' ? fields.maxPlayers : undefined,
    };
  } catch { return null; }
}

async function readScienceFile(p: string): Promise<ManifestScience | null> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const { fields, body } = parseFrontmatter(raw);
    if (!fields.id) return null;
    return {
      id: String(fields.id),
      title: String(fields.title || fields.id),
      description: body || undefined,
      status: fields.status as ManifestScience['status'],
      tags: Array.isArray(fields.tags) ? fields.tags.map(String) : undefined,
    };
  } catch { return null; }
}

/**
 * 读本机所有 4 类资源. 任何失败 → 该类别返回空 (不阻塞其他类别).
 */
export async function loadLocalResources(): Promise<ResourceBundle> {
  const out: ResourceBundle = { ...EMPTY };
  const [gFiles, fFiles, eFiles, sFiles] = await Promise.all([
    readCategoryDir('groups'),
    readCategoryDir('functions'),
    readCategoryDir('exportments'),
    readCategoryDir('sciences'),
  ]);
  for (const f of gFiles) { const v = await readGroupFile(f); if (v) out.groups.push(v); }
  for (const f of fFiles) { const v = await readFunctionFile(f); if (v) out.functions.push(v); }
  for (const f of eFiles) { const v = await readExportmentFile(f); if (v) out.exportments.push(v); }
  for (const f of sFiles) { const v = await readScienceFile(f); if (v) out.sciences.push(v); }
  return out;
}

/**
 * 把 manifest 里的 4 类资源落盘到 peerFs 对应目录.
 * 静默容错: 单条失败不影响其他.
 */
export async function writeRemoteResources(publicKey: string, m: AgentManifestLike): Promise<{
  groups: number; functions: number; exportments: number; sciences: number;
}> {
  let groups = 0, functions = 0, exportments = 0, sciences = 0;
  if (Array.isArray(m.groups)) {
    for (const g of m.groups) {
      try { await peerFs.writeGroup(publicKey, g); groups++; } catch {}
    }
  }
  if (Array.isArray(m.functions)) {
    for (const f of m.functions) {
      try { await peerFs.writeFunction(publicKey, f); functions++; } catch {}
    }
  }
  if (Array.isArray(m.exportments)) {
    for (const e of m.exportments) {
      try { await peerFs.writeExportment(publicKey, e); exportments++; } catch {}
    }
  }
  if (Array.isArray(m.sciences)) {
    for (const s of m.sciences) {
      try { await peerFs.writeScience(publicKey, s); sciences++; } catch {}
    }
  }
  return { groups, functions, exportments, sciences };
}

export interface AgentManifestLike {
  groups?: ManifestGroup[];
  functions?: ManifestFunction[];
  exportments?: ManifestExportment[];
  sciences?: ManifestScience[];
}
