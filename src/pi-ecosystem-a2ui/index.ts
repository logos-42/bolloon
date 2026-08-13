/**
 * a2ui.ts — A2UI (Agent to UI) 协议集成 (2026-08-12)
 *
 * bolloon agent 生成 A2UI 消息 (createSurface / updateComponents / updateDataModel / deleteSurface),
 * 经 SSE 广播给前端 (web / 手机端 Capacitor), 前端用 @a2ui/react renderer 渲染.
 *
 * 参考: https://a2ui.org/specification/v1.0-a2ui/ + D:\AI\A2UI (本地 spec 源码)
 *
 * 机制:
 *   - agent 工具 (a2ui_create_surface 等) 生成 A2UI JSON 消息
 *   - dispatchA2uiMessage → broadcast({ type: 'a2ui', message }) 给前端
 *   - 前端 MessageProcessor 接收渲染 (A2uiSurface)
 */

/** A2UI 消息类型 (v0.9/v1.0 核心) */
export type A2uiMessageType =
  | 'createSurface'
  | 'updateComponents'
  | 'updateDataModel'
  | 'deleteSurface';

export interface A2uiMessage {
  type: A2uiMessageType;
  surfaceId: string;
  [key: string]: unknown;
}

/** broadcast 注入点 (server 调用 setA2uiBroadcast 注入, 关联 SSE /events) */
let a2uiBroadcast: ((data: { type: string; [k: string]: unknown }) => void) | null = null;

export function setA2uiBroadcast(fn: (data: { type: string; [k: string]: unknown }) => void): void {
  a2uiBroadcast = fn;
}

/** 广播一条 A2UI 消息给所有前端 */
export function broadcastA2uiMessage(message: A2uiMessage): boolean {
  if (!a2uiBroadcast) return false;
  a2uiBroadcast({ type: 'a2ui', message });
  return true;
}

/** 校验 + 广播一条 A2UI 消息 (agent 工具 execute 调用) */
export function dispatchA2uiMessage(message: Partial<A2uiMessage>): { success: boolean; output: string } {
  const type = message?.type as A2uiMessageType;
  const surfaceId = String(message?.surfaceId || '').trim();
  if (!type || !['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'].includes(type)) {
    return { success: false, output: 'type 必须是 createSurface/updateComponents/updateDataModel/deleteSurface' };
  }
  if (!surfaceId) return { success: false, output: 'surfaceId 必填' };
  const ok = broadcastA2uiMessage({ type, surfaceId, ...(message as any) });
  return { success: ok, output: ok ? `已广播 A2UI ${type} (surface=${surfaceId})` : 'A2UI 广播未连接' };
}

/**
 * agent 工具注册表 (a2ui-* 工具定义). 由 pi-sdk-tools 注册为 agent 工具.
 */
export const A2UI_TOOL_DEFS: Array<{
  name: string;
  description: string;
  params: Record<string, string>;
  build: (args: Record<string, unknown>) => Partial<A2uiMessage>;
}> = [
  {
    name: 'a2ui_create_surface',
    description: '创建 A2UI surface (前端渲染区). surfaceId: 渲染区标识. 用户想要一个动态 UI 面板/表单/卡片时先创建 surface.',
    params: { surfaceId: '渲染区 id (必填)', title: 'surface 标题 (可选)' },
    build: (a) => ({ type: 'createSurface', surfaceId: String(a.surfaceId || ''), title: String(a.title || '') }),
  },
  {
    name: 'a2ui_update_components',
    description: '向 A2UI surface 添加/更新组件 (componentTree JSON). 前端用 @a2ui/react 渲染. components: 组件树 JSON 数组 (Text/Column/Button 等 basicCatalog 组件).',
    params: { surfaceId: '渲染区 id (必填)', components: '组件树 JSON (必填, e.g. [{"type":"text","data":{"text":"你好"}}])' },
    build: (a) => {
      let components = a.components;
      if (typeof components === 'string') {
        try { components = JSON.parse(components); } catch { components = []; }
      }
      return { type: 'updateComponents', surfaceId: String(a.surfaceId || ''), components };
    },
  },
  {
    name: 'a2ui_update_data',
    description: '更新 A2UI surface 的数据模型. path: 数据路径 (如 /user/name), value: 数据值.',
    params: { surfaceId: '渲染区 id (必填)', path: '数据路径 (必填)', value: '数据值' },
    build: (a) => ({ type: 'updateDataModel', surfaceId: String(a.surfaceId || ''), path: String(a.path || ''), value: a.value }),
  },
  {
    name: 'a2ui_delete_surface',
    description: '删除 A2UI surface (移除前端渲染区). surfaceId: 渲染区 id.',
    params: { surfaceId: '渲染区 id (必填)' },
    build: (a) => ({ type: 'deleteSurface', surfaceId: String(a.surfaceId || '') }),
  },
];

/** 工具名 → build 函数 */
export function a2uiToolDef(name: string) {
  return A2UI_TOOL_DEFS.find((t) => t.name === name);
}
