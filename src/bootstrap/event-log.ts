/**
 * event-log.ts — 项目事件日志 (Layer 2)
 *
 * 2026-07-07 新增. 解决:
 *   - 当前 judgment 是"决策规则", 项目状态/feature 生命周期没有结构化记录
 *   - 用户问"这个项目我们做了什么"时无法结构化回放
 *   - LLM prompt 缺少"最近变更"上下文
 *
 * 设计:
 *   - JSONL 格式 (append-only), 路径: ~/.bolloon/project/<safe-channelId>/events.jsonl
 *   - 5 类事件: project_created / feature_added / feature_removed / requirement_changed / task_completed
 *   - 每条带 schema_version, 便于后续演化
 *   - 不依赖 LLM, 纯文件 IO; 失败静默不阻塞主对话
 *
 * 触发:
 *   - server.ts: /message 处理后根据用户/AI 内容检测事件关键词 → appendEvent
 *   - server.ts: LLM prompt 装配 → getRecentEvents(channelId, 5)
 *   - client.ts: channel 头部 → 显示事件时间线折叠块
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ============== 类型 ==============

export const EVENT_SCHEMA_VERSION = 1 as const;

export const EVENT_TYPES = [
  'project_created',
  'feature_added',
  'feature_removed',
  'requirement_changed',
  'task_completed',
] as const;

export type EventType = typeof EVENT_TYPES[number];

export interface ProjectEvent {
  schema_version: typeof EVENT_SCHEMA_VERSION;
  type: EventType;
  ts: string;
  channelId: string;
  agentId?: string;
  /** 简短一句话摘要 (供 UI 折叠块显示) */
  summary: string;
  /** 详情字段, 按 type 不同 */
  detail: Record<string, unknown>;
  /** 来源 */
  source: 'user' | 'ai' | 'system';
}

export interface AppendEventOptions {
  channelId: string;
  agentId?: string;
  type: EventType;
  summary: string;
  detail?: Record<string, unknown>;
  source?: 'user' | 'ai' | 'system';
  home?: string;
}

export interface ListEventsOptions {
  channelId: string;
  home?: string;
  /** 倒序条数 (默认 20) */
  limit?: number;
  /** 仅返回指定 type 的事件 */
  type?: EventType;
}

// ============== 路径 ==============

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

/** ~/.bolloon/project/<safe-channelId>/events.jsonl */
export function getEventLogPath(channelId: string, home?: string): string {
  const root = path.join(home || os.homedir(), '.bolloon', 'project', sanitize(channelId));
  return path.join(root, 'events.jsonl');
}

// ============== 追加 ==============

/**
 * 追加一条事件. JSONL 格式 (1 行 1 JSON).
 * 失败抛错 — 由 caller 决定是否静默.
 */
export async function appendEvent(opts: AppendEventOptions): Promise<{ path: string; bytesWritten: number }> {
  const filePath = getEventLogPath(opts.channelId, opts.home);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const event: ProjectEvent = {
    schema_version: EVENT_SCHEMA_VERSION,
    type: opts.type,
    ts: new Date().toISOString(),
    channelId: opts.channelId,
    agentId: opts.agentId,
    summary: opts.summary,
    detail: opts.detail || {},
    source: opts.source || 'system',
  };

  const line = JSON.stringify(event) + '\n';
  await fs.appendFile(filePath, line, 'utf-8');
  return { path: filePath, bytesWritten: Buffer.byteLength(line, 'utf-8') };
}

// ============== 读取 ==============

/**
 * 列出事件. 倒序 (最新在前), 可选 limit / type 过滤.
 * 文件不存在 → 返回 []. 单行损坏 → 跳过, 不抛错.
 */
export async function listEvents(opts: ListEventsOptions): Promise<ProjectEvent[]> {
  const filePath = getEventLogPath(opts.channelId, opts.home);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const events: ProjectEvent[] = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (opts.type && ev.type !== opts.type) continue;
      if (typeof ev !== 'object' || !ev.type || !ev.ts) continue;
      events.push(ev as ProjectEvent);
    } catch {
      // 跳过损坏行
    }
  }

  // 倒序 (最新在前)
  events.reverse();

  if (opts.limit && opts.limit > 0) {
    return events.slice(0, opts.limit);
  }
  return events;
}

/**
 * 取最近 N 条事件 (alias for listEvents, 默认 limit=5, 给 prompt 注入用).
 */
export async function getRecentEvents(channelId: string, limit = 5, home?: string): Promise<ProjectEvent[]> {
  return listEvents({ channelId, home, limit });
}

// ============== 删除 ==============

/**
 * 删事件日志 (channel 删除时调用). 文件不存在不报错.
 */
export async function deleteEventLog(channelId: string, home?: string): Promise<void> {
  const filePath = getEventLogPath(channelId, home);
  try {
    await fs.unlink(filePath);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
}

// ============== 简易事件检测 (heuristic) ==============

/**
 * 从用户消息中检测可能的事件 (基于关键词). 返回最多 N 条事件.
 * LLM 检测更准, 但本函数作为 fallback / 实时检测用, 不阻塞主对话.
 */
export function detectEventsFromText(opts: {
  text: string;
  channelId: string;
  agentId?: string;
  source?: 'user' | 'ai';
}): Array<Pick<ProjectEvent, 'type' | 'summary' | 'detail'>> {
  const text = opts.text.toLowerCase();
  const out: Array<Pick<ProjectEvent, 'type' | 'summary' | 'detail'>> = [];

  // project_created: "建项目" / "create project" / "new project" / "新项目"
  if (/(建项目|创建项目|新项目|create\s*project|new\s*project)/i.test(text)) {
    out.push({ type: 'project_created', summary: opts.text.slice(0, 80), detail: { raw: opts.text.slice(0, 200) } });
  }

  // feature_added: "加入" / "增加" / "添加" + 跟一个 "功能/feature" 关键字
  if (/(加入|增加|添加|添加了|加\s*一个|add\s*feature|add\s*function)/i.test(text)) {
    const m = text.match(/(加入|增加|添加|添加了|加\s*一个|add\s*feature|add\s*function)\s*[:：]?\s*([^。.!?\n]{2,40})/i);
    if (m) {
      out.push({ type: 'feature_added', summary: `+ ${m[2].trim()}`, detail: { name: m[2].trim(), raw: opts.text.slice(0, 200) } });
    }
  }

  // feature_removed: "不要" / "去掉" / "删除" + "功能"
  if (/(不要|去掉|删除|移除|remove|delete|drop)\s*(这个|该|那)?\s*(功能|特性|feature)/i.test(text)) {
    const m = text.match(/(不要|去掉|删除|移除|remove|delete|drop)\s*(?:了)?\s*[:：]?\s*([^。.!?\n]{2,40})/i);
    if (m) {
      out.push({ type: 'feature_removed', summary: `- ${m[2].trim()}`, detail: { name: m[2].trim(), raw: opts.text.slice(0, 200) } });
    }
  }

  // requirement_changed: "改成" / "修改" / "调整为"
  if (/(改成|修改|调整|需求变更|change\s*to|update\s*to|revise)/i.test(text)) {
    const m = text.match(/(改成|修改|调整|change\s*to|update\s*to|revise)\s*[:：]?\s*([^。.!?\n]{2,60})/i);
    if (m) {
      out.push({ type: 'requirement_changed', summary: `Δ ${m[2].trim()}`, detail: { target: m[2].trim(), raw: opts.text.slice(0, 200) } });
    }
  }

  // task_completed: "完成" / "搞定" / "done" / "shipped"
  if (/(完成了?|搞定了?|做完了?|done|finished|shipped|closed)/i.test(text)) {
    out.push({ type: 'task_completed', summary: opts.text.slice(0, 80), detail: { raw: opts.text.slice(0, 200) } });
  }

  return out.slice(0, 3); // 一次最多 3 条 (避免 spam)
}