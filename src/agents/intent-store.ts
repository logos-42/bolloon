/**
 * intent-store.ts — Intent Store (2026-10-05, leo 四端 Intent Network 设计 P0)
 *
 * Intent = Goal 的**前身**: 一句话「我正在做 X」+ 标签/预算/期限, 未到可执行程度。
 * 它与 goal-flywheel 的 Goal 不冲突 (Goal 是意图的可执行投影):
 *   · intent 是轻量声明 (world/intents/ 一意图一文件)
 *   · 升级成可执行意图时 → 转 Goal (goal-flywheel)
 * 接口层不重叠, 本模块不碰 goal-store。
 *
 * 存储布局 (leo: 「intents 专门设计一个文件夹」「world 也是设计文件夹更好」):
 *   ~/.bolloon/world/               ← World 根 (六元组本体的实体根)
 *     ├── intents/                  ← Intent 实体目录 (一意图一文件, 原子写)
 *     │   └── int_<id>.json
 *     ├── opportunities/            ← (P1) Opportunity 实体目录
 *     ├── actions/                  ← (后续) Action 实体目录
 *     └── memory/                   ← (后续) Memory 实体目录
 * 每个实体独立文件 ⇒ 原子写 / 并发安全 / 可扩展, 与 task-board 的 announcement 文件模式同源。
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export interface IntentRecord {
  id: string;
  /** 意图一句话 (用户原话) */
  text: string;
  /** 标签 (匹配引擎用; 可自动从 text 提取, 可手工补) */
  tags: string[];
  /** 1-5 */
  priority: number;
  /** 字符串数值 (元); null = 未声明 */
  budget: string | null;
  /** 期限 (ms 时间戳); null = 无期限 */
  deadline: number | null;
  /** active | paused | done */
  status: 'active' | 'paused' | 'done';
  createdAt: number;
  updatedAt: number;
  matchedCount: number;
}

const homeOf = (home?: string): string => home || process.env.HOME || os.homedir();
/** World 根目录 (~/.bolloon/world/) */
export const worldDir = (home?: string): string => path.join(homeOf(home), '.bolloon', 'world');
/** Intent 实体目录 (~/.bolloon/world/intents/) */
export const intentsDir = (home?: string): string => path.join(worldDir(home), 'intents');
/** Opportunity 实体目录 (~/.bolloon/world/opportunities/, P1) */
export const opportunitiesDir = (home?: string): string => path.join(worldDir(home), 'opportunities');

/** 只允许 int_ 开头的 id 当文件名 (防路径穿越); 非法 → null */
function safeId(id: string): string | null {
  const s = String(id || '').trim();
  return /^int_[A-Za-z0-9]{6,32}$/.test(s) ? s : null;
}

/** 意图文件路径 (非法 id → null) */
export function intentFile(id: string, home?: string): string | null {
  const safe = safeId(id);
  return safe ? path.join(intentsDir(home), `${safe}.json`) : null;
}

async function ensure(dir: string): Promise<boolean> {
  try { await fs.mkdir(dir, { recursive: true }); return true; }
  catch { return false; }
}

async function writeJson(file: string, value: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensure(path.dirname(file));
    await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

async function readJson<T>(file: string): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as T;
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: `${path.basename(file)} 不是对象` };
    return { ok: true, value: parsed };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, error: 'ENOENT' };
    return { ok: false, error: `读 ${path.basename(file)} 失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/** 标签: 从意图正文提取简单标签 (英文词 + 中文 2 字以上词元) + 手工标签去重 */
export function extractTags(text: string, manual: string[] = []): string[] {
  const src = String(text || '').toLowerCase();
  const words = src.match(/[a-z][a-z0-9_-]{1,}/g) || [];
  const cjk = src.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const all = [...words, ...cjk, ...manual.map((t) => t.toLowerCase().trim()).filter(Boolean)];
  return Array.from(new Set(all)).slice(0, 24);
}

/** 扫描 intents 目录, 列出全部意图 (按创建时间倒序) */
export async function listIntents(home?: string, status?: 'active' | 'paused' | 'done'): Promise<{ ok: boolean; intents: IntentRecord[]; error?: string }> {
  const dir = intentsDir(home);
  let entries: string[];
  try { entries = await fs.readdir(dir); }
  catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: true, intents: [] };
    return { ok: false, intents: [], error: `读 ${dir} 失败: ${String(e?.message || e).slice(0, 120)}` };
  }
  const intents: IntentRecord[] = [];
  for (const name of entries.filter((n) => n.startsWith('int_') && n.endsWith('.json'))) {
    const r = await readJson<IntentRecord>(path.join(dir, name));
    if (!r.ok || !r.value || !r.value.id) continue; // 坏文件跳过, 不崩
    intents.push(r.value);
  }
  intents.sort((a, b) => b.createdAt - a.createdAt);
  return { ok: true, intents: status ? intents.filter((i) => i.status === status) : intents };
}

/** 单条意图按 id 读 (不存在 → ok:true 无 intent) */
export async function getIntent(id: string, home?: string): Promise<{ ok: boolean; intent?: IntentRecord; error?: string }> {
  const file = intentFile(id, home);
  if (!file) return { ok: false, error: `非法意图 id: ${String(id).slice(0, 32)}` };
  const r = await readJson<IntentRecord>(file);
  if (!r.ok) return r.error === 'ENOENT' ? { ok: true } : r;
  return { ok: true, intent: r.value };
}

export interface SetIntentInput {
  text: string;
  tags?: string[];
  priority?: number;
  budget?: string | null;
  deadline?: number | null;
  home?: string;
}

/** 声明意图 (幂等: 同 text 已存在 → 更新 tags/priority, 不重复建文件) */
export async function setIntent(input: SetIntentInput): Promise<{ ok: boolean; intent?: IntentRecord; created: boolean; error?: string }> {
  const text = String(input.text || '').trim();
  if (!text) return { ok: false, created: false, error: '意图不能为空' };
  const priority = input.priority ?? 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) return { ok: false, created: false, error: `priority 必须 1-5 整数, 实得 ${String(priority)}` };

  const loaded = await listIntents(input.home);
  if (!loaded.ok) return { ok: false, created: false, error: loaded.error };
  const now = Date.now();
  const existing = loaded.intents.find((i) => i.text === text && i.status === 'active');
  if (existing) {
    const merged: IntentRecord = {
      ...existing,
      tags: extractTags(text, [...(input.tags ?? []), ...existing.tags]),
      priority,
      budget: input.budget !== undefined ? input.budget : existing.budget,
      deadline: input.deadline !== undefined ? input.deadline : existing.deadline,
      updatedAt: now,
    };
    const file = intentFile(existing.id, input.home);
    if (!file) return { ok: false, created: false, error: '非法 id' };
    const saved = await writeJson(file, merged);
    if (!saved.ok) return { ok: false, created: false, error: saved.error };
    return { ok: true, intent: merged, created: false };
  }
  const record: IntentRecord = {
    id: `int_${crypto.randomBytes(6).toString('hex')}`,
    text, tags: extractTags(text, input.tags ?? []), priority,
    budget: input.budget ?? null, deadline: input.deadline ?? null,
    status: 'active', createdAt: now, updatedAt: now, matchedCount: 0,
  };
  const file = intentFile(record.id, input.home);
  if (!file) return { ok: false, created: false, error: '非法 id' };
  const saved = await writeJson(file, record);
  if (!saved.ok) return { ok: false, created: false, error: saved.error };
  return { ok: true, intent: record, created: true };
}

/** 删意图 (或标记 done) */
export async function removeIntent(id: string, markDone = false, home?: string): Promise<{ ok: boolean; removed?: string; error?: string }> {
  const file = intentFile(id, home);
  if (!file) return { ok: false, error: `非法意图 id: ${String(id).slice(0, 32)}` };
  if (markDone) {
    const r = await getIntent(id, home);
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.intent) return { ok: false, error: `没有意图 ${id} (看 bolloon intent list)` };
    const updated = { ...r.intent, status: 'done' as const, updatedAt: Date.now() };
    const saved = await writeJson(file, updated);
    if (!saved.ok) return { ok: false, error: saved.error };
    return { ok: true, removed: id };
  }
  try {
    await fs.unlink(file);
    return { ok: true, removed: id };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, error: `没有意图 ${id} (看 bolloon intent list)` };
    return { ok: false, error: `删 ${file} 失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/** 意图匹配数 +1 (扫描后被上层调用, 诚实计数) */
export async function bumpMatchedCount(id: string, home?: string): Promise<void> {
  const r = await getIntent(id, home);
  if (!r.ok || !r.intent) return;
  const updated = { ...r.intent, matchedCount: r.intent.matchedCount + 1, updatedAt: Date.now() };
  const file = intentFile(id, home);
  if (file) await writeJson(file, updated);
}