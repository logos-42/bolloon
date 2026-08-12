/**
 * ui-tools.test.ts — 2026-08-12 (MCP 驱动前端 UI)
 *
 * bolloon 作为 MCP server 暴露 UI 控制工具, agent 理解意图后调用驱动前端.
 *   - registerUiControlTools 注册 UI 工具 (幂等)
 *   - setUiBroadcast + broadcastUiAction 广播 {type:'ui'}
 *   - uiToolNameToAction 工具名 → action 映射
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerUiControlTools,
  setUiBroadcast,
  broadcastUiAction,
  dispatchUiAction,
  uiToolNameToAction,
} from '../pi-ecosystem-mcp/ui-tools.js';
import { listTools } from '../pi-ecosystem-mcp/index.js';

describe('ui-tools (MCP 驱动前端 UI)', () => {
  beforeEach(() => {
    // 重置广播
    setUiBroadcast(null);
  });

  it('registerUiControlTools 注册 UI 工具 (幂等)', () => {
    const c1 = registerUiControlTools();
    const c2 = registerUiControlTools();
    expect(c1).toBeGreaterThan(0);
    expect(c2).toBe(0); // 第二次幂等, 不重复注册
    expect(listTools().some((t) => t.name === 'ui_switch_tab')).toBe(true);
    expect(listTools().some((t) => t.name === 'ui_open_chat')).toBe(true);
    expect(listTools().some((t) => t.name === 'ui_open_settings')).toBe(true);
  });

  it('setUiBroadcast + dispatchUiAction 广播 {type:ui}', () => {
    let received = null;
    setUiBroadcast((data) => { received = data; });
    const r = dispatchUiAction({ action: 'switchTab', data: { tab: 'contacts' } });
    expect(r.success).toBe(true);
    expect(received.type).toBe('ui');
    expect(received.action).toBe('switchTab');
    expect(received.data.tab).toBe('contacts');
  });

  it('broadcastUiAction 无注入时返回 false', () => {
    expect(broadcastUiAction('switchTab', { tab: 'me' })).toBe(false);
  });

  it('dispatchUiAction 缺 action 返回失败', () => {
    const r = dispatchUiAction({ action: null as any });
    expect(r.success).toBe(false);
  });

  it('uiToolNameToAction 映射工具名到 action', () => {
    expect(uiToolNameToAction('ui_switch_tab')).toBe('switchTab');
    expect(uiToolNameToAction('ui_open_chat')).toBe('openChat');
    expect(uiToolNameToAction('ui_show_toast')).toBe('showToast');
    expect(uiToolNameToAction('unknown')).toBeNull();
  });
});
