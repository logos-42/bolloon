/**
 * ui-tools.ts — MCP 驱动的前端 UI 控制工具 (2026-08-12)
 *
 * 目标: bolloon 作为 MCP server 暴露 UI 控制工具, agent 理解用户意图后
 * 通过 MCP 调用这些工具, 驱动前端 (web / 手机端 Capacitor) 的 UI 组件.
 *
 * 机制:
 *   - 注册一组 UI 控制工具到 MCP 系统 (registerTool), 供 agent 用 mcp_tool 调用
 *   - 工具 execute 时通过注入的 broadcast 回调, 广播 { type: 'ui', action, data } 给前端 (SSE /events)
 *   - 前端订阅 /events, 收到 ui 指令执行对应组件 (switchTab/openChat/openSettings 等)
 *
 * 设计: UI 工具不走外部 MCP server (executeTool 硬依赖 server), 而是本地 handler + broadcast.
 */

import { registerTool, listTools } from './index.js';

export type UiAction =
  | 'switchTab'          // 切换底部 tab: { tab: 'wechat'|'contacts'|'discover'|'me' }
  | 'openChat'           // 打开某个聊天: { channelId }
  | 'openSettings'       // 打开设置页
  | 'openWallet'         // 打开钱包
  | 'openAddFriend'      // 打开添加好友
  | 'sendMessage'        // 发送消息: { channelId, text }
  | 'showToast'          // 顶部提示: { message }
  | 'goBack';            // 返回上一页

export interface UiToolCall {
  action: UiAction;
  data?: Record<string, unknown>;
}

/** broadcast 注入点 (由 server 调用 setUiBroadcast 注入, 广播给前端 SSE) */
let uiBroadcast: ((data: { type: string; [k: string]: unknown }) => void) | null = null;

/** 注入广播函数 (server 启动时调用, 关联到 SSE /events) */
export function setUiBroadcast(fn: (data: { type: string; [k: string]: unknown }) => void): void {
  uiBroadcast = fn;
}

/** 广播一条 UI 控制指令给所有前端 */
export function broadcastUiAction(action: UiAction, data?: Record<string, unknown>): boolean {
  if (!uiBroadcast) return false;
  uiBroadcast({ type: 'ui', action, data: data ?? {} });
  return true;
}

/** 把一次 UI 工具调用 (agent 意图理解后发起) 广播给前端 */
export function dispatchUiAction(call: UiToolCall): { success: boolean; output: string } {
  const { action, data } = call || {};
  if (!action) return { success: false, output: 'action 必填 (switchTab/openChat/openSettings 等)' };
  const ok = broadcastUiAction(action as UiAction, data);
  return { success: ok, output: ok ? `已驱动前端: ${action}` : 'UI 广播未连接' };
}

/** 注册 UI 控制工具到 MCP 系统 (供 agent mcp_tool 调用) */
export function registerUiControlTools(): number {
  const toolDefs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
    {
      name: 'ui_switch_tab',
      description: '驱动前端切换底部 tab. 用户想"去通讯录/去我的/去设置"时调用. tab: wechat|contacts|discover|me',
      inputSchema: { type: 'object', properties: { tab: { type: 'string' } }, required: ['tab'] },
    },
    {
      name: 'ui_open_chat',
      description: '驱动前端打开某个智能体聊天页. 用户想"打开和 X 的聊天"时调用. channelId: 目标 channel',
      inputSchema: { type: 'object', properties: { channelId: { type: 'string' } }, required: ['channelId'] },
    },
    {
      name: 'ui_open_settings',
      description: '驱动前端打开设置页. 用户想"打开设置/配置"时调用.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ui_open_wallet',
      description: '驱动前端打开钱包. 用户想"看钱包/支付"时调用.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ui_open_add_friend',
      description: '驱动前端打开添加好友. 用户想"添加好友"时调用.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ui_send_message',
      description: '驱动前端在当前聊天发送消息. channelId: 目标 channel, text: 要发的消息文本.',
      inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, text: { type: 'string' } }, required: ['channelId', 'text'] },
    },
    {
      name: 'ui_show_toast',
      description: '在前端顶部显示一条提示 (toast). message: 提示内容.',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    },
    {
      name: 'ui_go_back',
      description: '驱动前端返回上一页. 用户想"返回/回去"时调用.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  let count = 0;
  for (const t of toolDefs) {
    // 已注册则跳过 (幂等)
    if (listTools().some((x) => x.name === t.name)) continue;
    registerTool({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      serverName: 'ui', // 本地 UI 工具 (不走外部 server; 由 agent 调用方 dispatch)
    });
    count++;
  }
  return count;
}

/** agent 工具 (pi-sdk-tools 注册) 的 execute 适配: name → UiAction */
export function uiToolNameToAction(name: string): UiAction | null {
  switch (name) {
    case 'ui_switch_tab': return 'switchTab';
    case 'ui_open_chat': return 'openChat';
    case 'ui_open_settings': return 'openSettings';
    case 'ui_open_wallet': return 'openWallet';
    case 'ui_open_add_friend': return 'openAddFriend';
    case 'ui_send_message': return 'sendMessage';
    case 'ui_show_toast': return 'showToast';
    case 'ui_go_back': return 'goBack';
    default: return null;
  }
}
