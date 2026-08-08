/**
 * did-catalog-bridge.ts — 把现有落盘存储 (memory/persona/skills/channels/context_os)
 * 的读写入口接到 DID 目录 (did-catalog.ts)。(2026-08-08)
 *
 * 目标 (用户需求: "真正把现有落盘读写切换到这套目录, 而非仅 /api/on_policy 三条"):
 *   1. 写侧写穿 (write-through): 现有写入点 (memory 摘要 / skill 候选 / persona 文件)
 *      写完磁盘后同步 upsert 进 DID 目录对应表 → 生成 WAL 事件 → 可被多设备同步/OrbitDB 复制.
 *   2. 启动回填 (backfill): 扫描既有磁盘目录一次性灌入 catalog 表 (幂等: 内容 sha1 未变不重复写).
 *   3. 读侧合并 (read-through): 提供按 catalog 优先的读取辅助, 供 memory 回读 / persona 叠加.
 *
 * 失败静默: 桥是增强层, 任何一步失败都不影响原磁盘读写 (原路径永远可用).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { registryOpen, type DidCatalog, type DscTable } from './did-catalog.js';

const homeRoot = (h?: string): string => h || process.env.HOME || os.homedir() || '/tmp';

/** 从 ~/.bolloon/identity/user.json 读用户 DID (无则返回 '') */
export async function resolveUserDid(home?: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(homeRoot(home), '.bolloon', 'identity', 'user.json'), 'utf-8');
    const p = JSON.parse(raw) as { did?: string };
    return typeof p.did === 'string' && p.did ? p.did : '';
  } catch {
    return '';
  }
}

export interface CatalogUpsertOpts {
  /** ~/.bolloon 根 (测试注入) */
  home?: string;
  /** 显式 did (跳过读 user.json) */
  did?: string;
}

/**
 * 写穿: 解析 did → 打开目录 → upsert → persist.
 * 返回是否写入成功 (无 did / 任何异常 → false, 静默).
 */
export async function catalogUpsertQuiet(
  table: DscTable,
  key: string,
  data: Record<string, unknown>,
  opts: CatalogUpsertOpts = {},
): Promise<boolean> {
  try {
    const did = opts.did || (await resolveUserDid(opts.home));
    if (!did) return false;
    const cat = await registryOpen(did, opts.home ? { home: opts.home } : undefined);
    await cat.upsert(table, key, data);
    await cat.persist();
    return true;
  } catch {
    return false;
  }
}

/** 打开用户 DID 目录 (无 did → null) */
export async function openUserCatalog(opts: CatalogUpsertOpts = {}): Promise<DidCatalog | null> {
  try {
    const did = opts.did || (await resolveUserDid(opts.home));
    if (!did) return null;
    return await registryOpen(did, opts.home ? { home: opts.home } : undefined);
  } catch {
    return null;
  }
}

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** 幂等 upsert: 同 key 已有同 sha1 内容 → 跳过 (不产生新 WAL 事件) */
async function upsertIfChanged(
  cat: DidCatalog,
  table: DscTable,
  key: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const existing = cat.get(table, key);
  const digest = sha1(JSON.stringify(data));
  if (existing && (existing.data as Record<string, unknown>).sha1 === digest) return false;
  await cat.upsert(table, key, { ...data, sha1: digest });
  return true;
}

export interface BackfillSummary {
  table: DscTable;
  added: number;
  skipped: number;
}

/** 读目录下所有文件 (递归一层), 返回相对路径列表 */
async function listFilesRecursive(dir: string, depth = 0): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 2) out.push(...(await listFilesRecursive(full, depth + 1)));
      } else {
        out.push(full);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 启动回填: 扫描既有磁盘目录 → 灌入 DID 目录表 (幂等).
 *   memory     ~/.bolloon/memory/<agent>/sessions/*.summary.md  → memory 表
 *   persona    ~/.bolloon/persona/<agent>/*.md                  → persona 表
 *   skills     ~/.bolloon/skills/**\/SKILL.md                   → skills 表
 *   channels   ~/.bolloon/channels.json                         → channels 表
 *   context_os ~/.bolloon/context-os/<layer>/*                  → context_os 表
 * 返回每表 {added, skipped}. 失败静默.
 */
export async function backfillDidCatalog(
  cat: DidCatalog,
  opts: { home?: string } = {},
): Promise<BackfillSummary[]> {
  const root = path.join(homeRoot(opts.home), '.bolloon');
  const out: BackfillSummary[] = [];
  const summarize = (table: DscTable, added: number, skipped: number): BackfillSummary =>
    ({ table, added, skipped });

  // --- memory: summary 文件 ---
  try {
    let added = 0, skipped = 0;
    const memoryRoot = path.join(root, 'memory');
    const agentDirs = await fs.readdir(memoryRoot, { withFileTypes: true }).catch(() => []);
    for (const d of agentDirs.filter(x => x.isDirectory())) {
      const sessionsDir = path.join(memoryRoot, d.name, 'sessions');
      const files = await listFilesRecursive(sessionsDir);
      for (const f of files.filter(f => f.endsWith('.summary.md'))) {
        try {
          const content = await fs.readFile(f, 'utf-8');
          const st = await fs.stat(f);
          const key = `sessions/${d.name}/${path.basename(f)}`;
          if (await upsertIfChanged(cat, 'memory', key, {
            agentId: d.name, file: path.basename(f), kind: 'summary',
            summary: content.slice(0, 4000), content: content.slice(0, 4000),
            size: content.length,
            updatedAt: st.mtimeMs,
          })) added++; else skipped++;
        } catch { /* 单文件失败跳过 */ }
      }
    }
    out.push(summarize('memory', added, skipped));
  } catch { out.push(summarize('memory', 0, 0)); }

  // --- persona: 6 文件按 agent 分区 ---
  try {
    let added = 0, skipped = 0;
    const personaRoot = path.join(root, 'persona');
    const agentDirs = await fs.readdir(personaRoot, { withFileTypes: true }).catch(() => []);
    for (const d of agentDirs.filter(x => x.isDirectory())) {
      const files = await listFilesRecursive(path.join(personaRoot, d.name));
      for (const f of files.filter(f => f.endsWith('.md'))) {
        try {
          const content = await fs.readFile(f, 'utf-8');
          const st = await fs.stat(f);
          const key = `${d.name}/${path.basename(f).replace(/\.md$/, '')}`;
          if (await upsertIfChanged(cat, 'persona', key, {
            agentId: d.name, doc: path.basename(f).replace(/\.md$/, ''), kind: 'persona',
            content: content.slice(0, 4000), size: content.length,
            updatedAt: st.mtimeMs,
          })) added++; else skipped++;
        } catch { /* 单文件失败跳过 */ }
      }
    }
    out.push(summarize('persona', added, skipped));
  } catch { out.push(summarize('persona', 0, 0)); }

  // --- skills: SKILL.md (含 skills/<cat>/<name>/ 两级) ---
  try {
    let added = 0, skipped = 0;
    const skillsRoot = path.join(root, 'skills');
    const files = await listFilesRecursive(skillsRoot);
    for (const f of files.filter(f => f.endsWith('SKILL.md'))) {
      try {
        const content = await fs.readFile(f, 'utf-8');
        const st = await fs.stat(f);
        const rel = path.relative(skillsRoot, f).split(path.sep);
        const name = rel.length >= 2 ? rel.slice(0, -1).join('/') : path.basename(path.dirname(f));
        if (await upsertIfChanged(cat, 'skills', name, {
          name, kind: 'skill', file: path.relative(root, f),
          content: content.slice(0, 4000), size: content.length,
          updatedAt: st.mtimeMs,
        })) added++; else skipped++;
      } catch { /* 单文件失败跳过 */ }
    }
    out.push(summarize('skills', added, skipped));
  } catch { out.push(summarize('skills', 0, 0)); }

  // --- channels: channels.json → 每 channel 一行 ---
  try {
    let added = 0, skipped = 0;
    const raw = await fs.readFile(path.join(root, 'channels.json'), 'utf-8');
    const list = JSON.parse(raw) as any[];
    const channels = Array.isArray(list) ? list : Array.isArray((list as any).channels) ? (list as any).channels : [];
    for (const ch of channels) {
      if (!ch || typeof ch !== 'object') continue;
      const id = String(ch.id || ch.publicKey || '');
      if (!id) continue;
      const key = `channel/${id}`;
      if (await upsertIfChanged(cat, 'channels', key, {
        id, name: String(ch.name || ''), agentId: String(ch.agentId || ''),
        publicKey: String(ch.publicKey || ''), updatedAt: Number(ch.updatedAt || Date.now()),
      })) added++; else skipped++;
    }
    out.push(summarize('channels', added, skipped));
  } catch { out.push(summarize('channels', 0, 0)); }

  // --- context_os: 资产层文件清单 ---
  try {
    let added = 0, skipped = 0;
    const ctxRoot = path.join(root, 'context-os');
    const layers = await fs.readdir(ctxRoot, { withFileTypes: true }).catch(() => []);
    for (const l of layers.filter(x => x.isDirectory())) {
      const files = await listFilesRecursive(path.join(ctxRoot, l.name));
      for (const f of files) {
        try {
          const st = await fs.stat(f);
          const rel = path.relative(path.join(ctxRoot, l.name), f).split(path.sep).join('/');
          const key = `assets/${l.name}/${rel}`;
          if (await upsertIfChanged(cat, 'context_os', key, {
            layer: l.name, file: rel, kind: 'asset', size: st.size,
            updatedAt: st.mtimeMs,
          })) added++; else skipped++;
        } catch { /* 单文件失败跳过 */ }
      }
    }
    out.push(summarize('context_os', added, skipped));
  } catch { out.push(summarize('context_os', 0, 0)); }

  await cat.persist();
  return out;
}

/** 读侧: memory 表里某 agent 的摘要行 (按 updatedAt 新→旧), 供 memory 回读合并 */
export function catalogMemoryRows(cat: DidCatalog, agentId: string) {
  return cat
    .all('memory')
    .filter(({ row }) => (row.data as Record<string, unknown>).agentId === agentId)
    .map(({ key, row }) => ({ key, row }))
    .sort((a, b) => b.row.updatedAt - a.row.updatedAt);
}

/** 读侧: persona 表里某 agent 的文档行 → {doc: content} 叠加到磁盘 persona */
export function catalogPersonaRows(cat: DidCatalog, agentId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { row } of cat.all('persona')) {
    const d = row.data as Record<string, unknown>;
    if (d.agentId !== agentId) continue;
    const doc = String(d.doc || '');
    const content = String(d.content || '');
    if (doc && content) out[doc] = content;
  }
  return out;
}

/** 只列出目录表名 (供 API/调试) */
export const BRIDGE_TABLES: DscTable[] = ['memory', 'persona', 'skills', 'channels', 'context_os', 'on_policy'];
