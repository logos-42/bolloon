/**
 * write-staging.ts — 写操作准备阶段适配 (2026-08-12, TaskC)
 *
 * 借鉴 hermes write_approval.py 的 staging gate: 写操作先 stage (暂存) 再 commit,
 * 保留完整 payload (可重放/回滚) 用于审计与撤销 — 但不强制人工审批 (bolloon 是自主 agent,
 * 写操作直接提交, 只是保留 stage 记录做"准备阶段"审计, 不打断自主循环).
 *
 * 设计:
 *   - 每次 write_file / edit_file 写盘前, 记录一条 stage 到 ~/.bolloon/write-log/<ts>-<rand>.json
 *   - stage 记录含: 相对路径 / 绝对路径 / action (create|overwrite|edit) / 变更前内容快照 / 变更意图 / 时间
 *   - 提供 listStagedWrites / undoLastWrite (撤销最近一次写) / getStagedWrite
 *   - 失败静默 (写日志不影响工具主路径)
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';

const home = (): string => process.env.HOME || os.homedir() || '/tmp';

export function writeLogDir(homeDir: string = home()): string {
  return path.join(homeDir, '.bolloon', 'write-log');
}

export interface WriteStageRecord {
  id: string;
  absPath: string;
  relPath: string;
  /** create | overwrite | edit */
  action: 'create' | 'overwrite' | 'edit';
  /** 变更前内容 (edit: 原文; create/overwrite: 空或旧内容快照) */
  beforeContent: string;
  /** 变更后内容 (可重放) */
  afterContent: string;
  createdAt: number;
}

/** 生成唯一 stage id */
function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * 写前暂存: 记录一次写操作 (准备阶段). 返回记录; 失败静默返回 null.
 * @param relPath 相对路径
 * @param beforeContent 变更前内容 (读盘或空)
 * @param afterContent 变更后内容
 * @param action 动作类型
 */
export async function stageWrite(
  relPath: string,
  beforeContent: string,
  afterContent: string,
  action: 'create' | 'overwrite' | 'edit',
  cwd: string = process.cwd(),
  homeDir: string = home(),
): Promise<WriteStageRecord | null> {
  try {
    const id = genId();
    const absPath = path.resolve(cwd, relPath);
    const rec: WriteStageRecord = { id, absPath, relPath, action, beforeContent, afterContent, createdAt: Date.now() };
    const dir = writeLogDir(homeDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(rec, null, 2), 'utf-8');
    return rec;
  } catch {
    return null;
  }
}

/** 列出最近的暂存写记录 (新→旧) */
export async function listStagedWrites(homeDir: string = home()): Promise<WriteStageRecord[]> {
  const dir = writeLogDir(homeDir);
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }
  const out: WriteStageRecord[] = [];
  for (const f of files.filter(f => f.endsWith('.json')).sort().reverse()) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8')) as WriteStageRecord);
    } catch { /* 坏文件跳过 */ }
  }
  return out;
}

/** 撤销最近一次写 (若文件内容仍等于 afterContent → 恢复 beforeContent). 返回是否撤销. */
export async function undoLastWrite(homeDir: string = home()): Promise<{ ok: boolean; reason?: string }> {
  const staged = await listStagedWrites(homeDir);
  if (staged.length === 0) return { ok: false, reason: '无暂存写记录' };
  const rec = staged[0];
  try {
    // 仅当文件未被后续修改 (内容仍 = afterContent) 时才安全撤销
    const current = await fs.readFile(rec.absPath, 'utf-8').catch(() => null);
    if (current === rec.afterContent) {
      await fs.writeFile(rec.absPath, rec.beforeContent, 'utf-8');
      // 清理该 stage 记录
      await fs.rm(path.join(writeLogDir(homeDir), `${rec.id}.json`), { force: true }).catch(() => {});
      return { ok: true };
    }
    return { ok: false, reason: '文件已被后续修改, 跳过撤销' };
  } catch (e: any) {
    return { ok: false, reason: `撤销失败: ${e?.message}` };
  }
}
