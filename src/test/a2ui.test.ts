/**
 * a2ui.test.ts — 2026-08-12 (A2UI 集成)
 *
 * bolloon agent 生成 A2UI 消息 (createSurface/updateComponents/updateDataModel/deleteSurface),
 * 经 SSE 广播给前端 (@a2ui/react renderer 渲染).
 *   - dispatchA2uiMessage 广播 {type:'a2ui', message}
 *   - 消息类型/surfaceId 校验
 *   - A2UI_TOOL_DEFS 工具定义
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setA2uiBroadcast,
  broadcastA2uiMessage,
  dispatchA2uiMessage,
  A2UI_TOOL_DEFS,
  a2uiToolDef,
} from '../pi-ecosystem-a2ui/index.js';

describe('a2ui (Agent to UI 集成)', () => {
  beforeEach(() => { setA2uiBroadcast(null); });

  it('A2UI_TOOL_DEFS 定义 4 个工具', () => {
    const names = A2UI_TOOL_DEFS.map((t) => t.name);
    expect(names).toContain('a2ui_create_surface');
    expect(names).toContain('a2ui_update_components');
    expect(names).toContain('a2ui_update_data');
    expect(names).toContain('a2ui_delete_surface');
    expect(a2uiToolDef('a2ui_create_surface')).toBeTruthy();
  });

  it('dispatchA2uiMessage 广播 createSurface', () => {
    let received = null;
    setA2uiBroadcast((data) => { received = data; });
    const r = dispatchA2uiMessage({ type: 'createSurface', surfaceId: 'main' });
    expect(r.success).toBe(true);
    expect(received.type).toBe('a2ui');
    expect(received.message.type).toBe('createSurface');
    expect(received.message.surfaceId).toBe('main');
  });

  it('dispatchA2uiMessage 校验 type', () => {
    const r = dispatchA2uiMessage({ type: 'bogus' as any, surfaceId: 'main' });
    expect(r.success).toBe(false);
  });

  it('dispatchA2uiMessage 校验 surfaceId', () => {
    const r = dispatchA2uiMessage({ type: 'createSurface', surfaceId: '' });
    expect(r.success).toBe(false);
  });

  it('无注入时 broadcast 返回 false', () => {
    expect(broadcastA2uiMessage({ type: 'createSurface', surfaceId: 'x' })).toBe(false);
  });

  it('a2ui_update_components build 解析 components JSON 字符串', () => {
    const def = a2uiToolDef('a2ui_update_components')!;
    const msg = def.build({ surfaceId: 'main', components: '[{"type":"text","data":{"text":"hi"}}]' });
    expect(msg.type).toBe('updateComponents');
    expect(Array.isArray(msg.components)).toBe(true);
    expect((msg.components as any[])[0].type).toBe('text');
  });
});
