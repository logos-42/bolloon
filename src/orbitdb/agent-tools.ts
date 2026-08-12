/**
 * agent-tools.ts — OrbitDB/CID 数据层的 agent 工具注册 (2026-08-06)
 *
 * 注册 10 个工具 (懒加载: 首次调用才拉起 helia, 不阻塞启动):
 *   cid_save / cid_load / cid_update / cid_version / cid_list / cid_share
 *   context_save_snapshot / context_restore
 *   ui_save_component / ui_load_component
 *
 * 对应 Step 7 能力: agent.createMemory (cid_save type=memory),
 *   context.saveSnapshot (context_save_snapshot), ui.loadCID (ui_load_component),
 *   share(cid) (cid_share).
 */

interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, string>;
  execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }>;
}

interface ToolRegistryContext {
  tools: Map<string, Tool>;
}

/** 包装: 动态 import cid-database (首调拉起 helia) */
async function db(): Promise<import('./cid-database.js').CIDDatabase> {
  const { getCIDDatabase } = await import('./cid-database.js');
  return getCIDDatabase();
}

async function contextStore(): Promise<import('./context-store.js').ContextStore> {
  const { getContextStore } = await import('./context-store.js');
  return getContextStore();
}

async function uiStore(): Promise<import('./ui-cid.js').UICidStore> {
  const { getUICidStore } = await import('./ui-cid.js');
  return getUICidStore();
}

const fmt = (o: unknown): string => JSON.stringify(o, null, 2).slice(0, 3000);

/** 2026-08-12 (Task5): Kanban 看板工具 (Hermes kanban_db → OrbitDB). 见 kanban-store.ts. */
async function kanbanBoard(boardId: string): Promise<import('./kanban-store.js').KanbanBoard> {
  const { openKanbanBoard } = await import('./kanban-store.js');
  return openKanbanBoard(boardId);
}
type KanbanStatus = import('./kanban-store.js').KanbanStatus;
const fmtRows = (tasks: Array<{ id: string; title: string; status: string; assignee: string }>): string =>
  tasks.length === 0 ? '📭 无任务' : tasks.map(t => `  [${t.status}] ${t.id} ${t.title}${t.assignee ? ` (${t.assignee})` : ''}`).join('\n');

export function registerKanbanTools(ctx: ToolRegistryContext): void {
  ctx.tools.set('kanban_create', {
    name: 'kanban_create',
    description: '在看板上创建任务 (OrbitDB 持久化, 跨设备同步). 状态从 triage 开始.', 
    parameters: { boardId: '看板 id (必填, 默认用 agentId)', title: '任务标题 (必填)', body: '任务详情 (可选)', parentIds: '父任务 id 数组 (可选, 全部 done 才可执行)', createdBy: '创建者 (可选)', dueAt: '计划时间戳 (可选)' },
    execute: async (args) => {
      try {
        const boardId = String(args.boardId || args.agentId || '').trim() || 'default';
        const title = String(args.title || '').trim();
        if (!title) return { success: false, error: 'title 必填' };
        const parentIds = Array.isArray(args.parentIds) ? args.parentIds.map(String) : [];
        const dueAt = typeof args.dueAt === 'number' ? args.dueAt : null;
        const task = await (await kanbanBoard(boardId)).createTask({ boardId, title, body: String(args.body || '').trim(), parentIds, createdBy: String(args.createdBy || '').trim() || undefined, dueAt });
        return { success: true, output: `📌 已创建任务 (${boardId}):\n  id: ${task.id}\n  状态: ${task.status}\n  推进: kanban_claim(id="${task.id}") → kanban_complete(...)` };
      } catch (e: any) { return { success: false, error: `kanban_create 失败: ${String(e.message || e).slice(0, 200)}` }; }
    }
  });

  ctx.tools.set('kanban_list', {
    name: 'kanban_list',
    description: '列出看板任务 (可按状态过滤). 状态: triage/todo/scheduled/ready/running/blocked/review/done/archived.',
    parameters: { boardId: '看板 id (必填)', status: '可选: 按状态过滤' },
    execute: async (args) => {
      try {
        const boardId = String(args.boardId || '').trim() || 'default';
        const status = String(args.status || '').trim() as any || undefined;
        const tasks = await (await kanbanBoard(boardId)).listTasks(status);
        return { success: true, output: `🗂 ${boardId} ${status ? `[${status}]` : '全部'} ${tasks.length} 个任务:\n${fmtRows(tasks)}` };
      } catch (e: any) { return { success: false, error: `kanban_list 失败: ${String(e.message || e).slice(0, 200)}` }; }
    }
  });

  ctx.tools.set('kanban_get', {
    name: 'kanban_get',
    description: '查看单个任务详情 (含 parentIds/认领人/失败计数/createdRefs).',
    parameters: { boardId: '看板 id (必填)', id: '任务 id (必填)' },
    execute: async (args) => {
      try {
        const boardId = String(args.boardId || '').trim() || 'default';
        const id = String(args.id || '').trim();
        if (!id) return { success: false, error: 'id 必填' };
        const t = await (await kanbanBoard(boardId)).getTask(id);
        if (!t) return { success: false, error: `任务不存在: ${id}` };
        return { success: true, output: `📄 ${t.id} [${t.status}]\n  标题: ${t.title}\n  详情: ${t.body || '—'}\n  父任务: ${t.parentIds.length ? t.parentIds.join(', ') : '无'}\n  认领人: ${t.assignee || t.claimLock || '未认领'}\n  失败计数: ${t.consecutiveFailures}\n  引用: ${t.createdRefs.length ? t.createdRefs.join(', ') : '无'}\n  备注: ${t.reason || '—'}` };
      } catch (e: any) { return { success: false, error: `kanban_get 失败: ${String(e.message || e).slice(0, 200)}` }; }
    }
  });

  ctx.tools.set('kanban_claim', {
    name: 'kanban_claim',
    description: '原子认领一个 ready 任务 (CAS, 至多一个 worker 成功). 认领后状态 → running.',
    parameters: { boardId: '看板 id (必填)', id: '任务 id (必填)', worker: '认领者标识 (默认当前 agentId)' },
    execute: async (args) => {
      try {
        const boardId = String(args.boardId || '').trim() || 'default';
        const id = String(args.id || '').trim();
        const worker = String(args.worker || '').trim() || 'agent';
        if (!id) return { success: false, error: 'id 必填' };
        const r = await (await kanbanBoard(boardId)).claimTask(id, worker);
        if (!r.ok) return { success: false, error: `认领失败: ${r.reason}` };
        return { success: true, output: `✅ 已认领 ${id} (worker=${worker})\n  完成: kanban_complete(id="${id}", worker="${worker}")` };
      } catch (e: any) { return { success: false, error: `kanban_claim 失败: ${String(e.message || e).slice(0, 200)}` }; }
    }
  });

  ctx.tools.set('kanban_complete', {
    name: 'kanban_complete',
    description: '完成一个 running 任务 → done (自动释放认领锁, 父任务完成时自动解子任务). createdRefs 声称的引用会做防幻觉校验.',
    parameters: { boardId: '看板 id (必填)', id: '任务 id (必填)', worker: '认领者 (默认当前 agentId)', createdRefs: '可选: 声称创建的任务/资源引用数组' },
    execute: async (args) => {
      try {
        const boardId = String(args.boardId || '').trim() || 'default';
        const id = String(args.id || '').trim();
        const worker = String(args.worker || '').trim() || 'agent';
        if (!id) return { success: false, error: 'id 必填' };
        const refs = Array.isArray(args.createdRefs) ? args.createdRefs.map(String) : [];
        const t = await (await kanbanBoard(boardId)).completeTask(id, worker, refs);
        if (!t) return { success: false, error: `无法完成 ${id} (不存在 或 非本 worker 认领)` };
        return { success: true, output: `🏁 已完成 ${id} [done]${t.reason ? `\n  提醒: ${t.reason}` : ''}` };
      } catch (e: any) { return { success: false, error: `kanban_complete 失败: ${String(e.message || e).slice(0, 200)}` }; }
    }
  });

  ctx.tools.set('kanban_status', {
    name: 'kanban_status',
    description: '手动推进任务状态 (review/done/blocked/archived/ready 等合法迁移). blocked 需带 reason; archived 为终态.',
    parameters: { boardId: '看板 id (必填)', id: '任务 id (必填)', status: '目标状态 (必填)', reason: 'blocked/review 时必填备注' },
    execute: async (args) => {
      try {
        const boardId = String(args.boardId || '').trim() || 'default';
        const id = String(args.id || '').trim();
        const status = String(args.status || '').trim();
        if (!id || !status) return { success: false, error: 'id 和 status 必填' };
        let t: any = null;
        if (status === 'review') t = await (await kanbanBoard(boardId)).requestReview(id, String(args.reason || '').trim());
        else t = await (await kanbanBoard(boardId)).setStatus(id, status as KanbanStatus, String(args.reason || '').trim());
        if (!t) return { success: false, error: `状态迁移失败 (非法迁移或任务不存在): ${id} → ${status}` };
        return { success: true, output: `↻ ${id} → [${t.status}]${t.reason ? ` (${t.reason})` : ''}` };
      } catch (e: any) { return { success: false, error: `kanban_status 失败: ${String(e.message || e).slice(0, 200)}` }; }
    }
  });
}

export function registerOrbitdbTools(ctx: ToolRegistryContext): void {
  ctx.tools.set('cid_save', {
    name: 'cid_save',
    description: '保存数据到去中心化数据库 (OrbitDB), 返回内容寻址 CID. type 支持 memory/context/state/ui/knowledge. 同内容同 CID, 可用 cid_load 读回、cid_share 分享、cid_update 更新版本.',
    parameters: { agentId: '所属智能体 id (必填)', type: '记录类型: memory/context/state/ui/knowledge (必填)', content: '要保存的数据 (JSON 对象, 必填)', metadata: '可选元数据 (JSON 对象)' },
    execute: async (args) => {
      try {
        const agentId = String(args.agentId || '').trim();
        const type = String(args.type || '').trim();
        if (!agentId || !type) return { success: false, error: 'agentId 和 type 必填' };
        const content = args.content ?? {};
        const metadata = typeof args.metadata === 'object' && args.metadata ? args.metadata as Record<string, unknown> : undefined;
        const rec = await (await db()).save({ agentId, type: type as any, content, metadata });
        return { success: true, output: `✅ 已保存 (type=${type}):\n  CID: ${rec.id}\n  version: ${rec.version}\n  读回: cid_load(cid="${rec.id}")\n  分享: cid_share(cid="${rec.id}")` };
      } catch (e: any) {
        return { success: false, error: `cid_save 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('cid_load', {
    name: 'cid_load',
    description: '按 CID 从去中心化数据库加载记录 (含跨节点分享的). 返回完整记录: id/agentId/timestamp/type/content/metadata/version.',
    parameters: { cid: '记录 CID (必填)' },
    execute: async (args) => {
      try {
        const cid = String(args.cid || '').trim();
        if (!cid) return { success: false, error: 'cid 必填' };
        const rec = await (await db()).load(cid);
        if (!rec) return { success: false, error: `记录不存在: ${cid}` };
        return { success: true, output: `📄 ${cid}\n${fmt(rec)}` };
      } catch (e: any) {
        return { success: false, error: `cid_load 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('cid_update', {
    name: 'cid_update',
    description: '更新记录 → 生成新版本 (parentId 指向旧 CID). 用 cid_version 查看版本链.',
    parameters: { cid: '旧记录 CID (必填)', content: '新内容 (JSON, 必填)', metadata: '可选新元数据' },
    execute: async (args) => {
      try {
        const cid = String(args.cid || '').trim();
        if (!cid) return { success: false, error: 'cid 必填' };
        const rec = await (await db()).update(cid, args.content ?? {}, typeof args.metadata === 'object' && args.metadata ? args.metadata as Record<string, unknown> : undefined);
        if (!rec) return { success: false, error: `记录不存在: ${cid}` };
        return { success: true, output: `✅ 已更新 v${rec.version}:\n  新 CID: ${rec.id}\n  版本链: cid_version(cid="${rec.id}")` };
      } catch (e: any) {
        return { success: false, error: `cid_update 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('cid_version', {
    name: 'cid_version',
    description: '查看记录的完整版本链 (从旧到新).',
    parameters: { cid: '任意版本 CID (必填)' },
    execute: async (args) => {
      try {
        const cid = String(args.cid || '').trim();
        if (!cid) return { success: false, error: 'cid 必填' };
        const chain = await (await db()).version(cid);
        if (chain.length === 0) return { success: false, error: `记录不存在: ${cid}` };
        return { success: true, output: `📚 版本链 (${chain.length} 个版本):\n${chain.map(r => `  v${r.version} ${r.id} ${new Date(r.timestamp).toISOString()}${r.parentId ? '' : ' (根)'}`).join('\n')}` };
      } catch (e: any) {
        return { success: false, error: `cid_version 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('cid_list', {
    name: 'cid_list',
    description: '列出数据库记录 (可按 agentId / type 过滤). 适合查看某个智能体的全部记忆/状态/组件.',
    parameters: { agentId: '可选: 按智能体过滤', type: '可选: 按类型过滤 (memory/context/state/ui/knowledge)' },
    execute: async (args) => {
      try {
        const agentId = String(args.agentId || '').trim() || undefined;
        const type = String(args.type || '').trim() as any || undefined;
        const list = await (await db()).list({ agentId, type });
        if (list.length === 0) return { success: true, output: '📭 无记录' };
        return { success: true, output: `📋 ${list.length} 条记录:\n${list.slice(-20).map(r => `  v${r.version} [${r.type}] ${r.id.slice(0, 24)}… ${new Date(r.timestamp).toISOString().slice(0, 19)}`).join('\n')}` };
      } catch (e: any) {
        return { success: false, error: `cid_list 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('cid_share', {
    name: 'cid_share',
    description: '分享记录: 把记录块写入 IPFS 网络 (helia blockstore), 返回 bolloon-cid:// 引用, 其他节点可用 cid_load 拉取.',
    parameters: { cid: '记录 CID (必填)' },
    execute: async (args) => {
      try {
        const cid = String(args.cid || '').trim();
        if (!cid) return { success: false, error: 'cid 必填' };
        const ref = await (await db()).share(cid);
        return { success: true, output: `🔗 已分享: ${ref}` };
      } catch (e: any) {
        return { success: false, error: `cid_share 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('context_save_snapshot', {
    name: 'context_save_snapshot',
    description: '保存 Context OS 快照: 抓取当前资产层 + 可选记忆摘要/focus → CID 版本化. 用 context_restore 恢复.',
    parameters: { agentId: '智能体 id (必填)', memorySummary: '可选: 当前记忆摘要', focus: '可选: 当前 focus' },
    execute: async (args) => {
      try {
        const agentId = String(args.agentId || '').trim();
        if (!agentId) return { success: false, error: 'agentId 必填' };
        const store = await contextStore();
        const snap = await store.captureCurrentContext(agentId, {
          memorySummary: String(args.memorySummary || '').trim() || undefined,
          focus: String(args.focus || '').trim() || undefined,
        });
        const rec = await store.saveSnapshot(snap);
        return { success: true, output: `📸 Context 快照已保存:\n  CID: ${rec.id}\n  layers: ${Object.keys(snap.layers).filter(k => snap.layers[k].length).length} 层有资产\n  恢复: context_restore(agentId="${agentId}")` };
      } catch (e: any) {
        return { success: false, error: `context_save_snapshot 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('context_restore', {
    name: 'context_restore',
    description: '恢复某智能体最近一次 Context 快照 (含资产层/记忆摘要/focus). 用于跨会话恢复上下文.',
    parameters: { agentId: '智能体 id (必填)' },
    execute: async (args) => {
      try {
        const agentId = String(args.agentId || '').trim();
        if (!agentId) return { success: false, error: 'agentId 必填' };
        const snap = await (await contextStore()).restoreContext(agentId);
        if (!snap) return { success: false, error: `无快照: ${agentId}` };
        return { success: true, output: `♻️ 已恢复 ${agentId} 的 Context 快照 (${new Date(snap.capturedAt).toISOString()}):\n${fmt(snap).slice(0, 2500)}` };
      } catch (e: any) {
        return { success: false, error: `context_restore 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('ui_save_component', {
    name: 'ui_save_component',
    description: '保存 UI 组件到去中心化存储 (CID 化). code 是 React 函数组件源码 (function Name(props){ return React.createElement(...) }), framework 默认 react. 之后可用 ui_load_component 按 CID 动态加载渲染.',
    parameters: { agentId: '智能体 id (必填)', name: '组件名 (必填)', code: 'React 组件源码 (必填)', framework: '可选: react/vanilla', theme: '可选: 主题 JSON', description: '可选: 组件说明' },
    execute: async (args) => {
      try {
        const agentId = String(args.agentId || '').trim();
        const name = String(args.name || '').trim();
        const code = String(args.code || '').trim();
        if (!agentId || !name || !code) return { success: false, error: 'agentId/name/code 必填' };
        const rec = await (await uiStore()).saveComponent(agentId, {
          name,
          code,
          framework: args.framework === 'vanilla' ? 'vanilla' : 'react',
          theme: typeof args.theme === 'object' && args.theme ? args.theme as Record<string, string> : undefined,
          description: String(args.description || '').trim() || undefined,
        });
        return { success: true, output: `🖼️ UI 组件已保存: ${name}\n  CID: ${rec.id}\n  加载: ui_load_component(cid="${rec.id}")` };
      } catch (e: any) {
        return { success: false, error: `ui_save_component 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  ctx.tools.set('ui_load_component', {
    name: 'ui_load_component',
    description: '按 CID 加载 UI 组件定义 (代码/theme/propsSchema). 配合 React 前端可动态渲染.',
    parameters: { cid: '组件 CID (必填)' },
    execute: async (args) => {
      try {
        const cid = String(args.cid || '').trim();
        if (!cid) return { success: false, error: 'cid 必填' };
        const def = await (await uiStore()).loadComponent(cid);
        if (!def) return { success: false, error: `组件不存在: ${cid}` };
        return { success: true, output: `🖼️ ${def.name} (${def.framework})\n  CID: ${cid}\n  theme: ${def.theme ? fmt(def.theme) : '无'}\n  code:\n${String(def.code).slice(0, 1500)}` };
      } catch (e: any) {
        return { success: false, error: `ui_load_component 失败: ${String(e.message || e).slice(0, 200)}` };
      }
    }
  });

  // 2026-08-12 (Task5): Kanban 看板工具 (Hermes kanban_db → OrbitDB)
  try {
    registerKanbanTools(ctx);
  } catch (odbErr) {
    console.warn('[registerTools] Kanban 工具注册失败 (非致命):', odbErr);
  }
}
