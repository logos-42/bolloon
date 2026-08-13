/**
 * a2ui-client.tsx — A2UI 前端渲染器 (2026-08-12)
 *
 * 订阅 bolloon SSE /events, 接收 {type:'a2ui', message:{...}} (createSurface/updateComponents 等),
 * 用 @a2ui/react (MessageProcessor + A2uiSurface) 渲染成 UI.
 *
 * 构建: build-web.ts 用 esbuild 打包成 dist/web/a2ui-client.js,
 *       mobile.html 加载后挂载到 #a2ui-root.
 */
import { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { A2uiSurface, basicCatalog } from '@a2ui/react/v0_9';

function A2uiApp() {
  const [processor] = useState(() => new MessageProcessor([basicCatalog]));
  const [surfaces, setSurfaces] = useState(() => Array.from(processor.model.surfacesMap.values()));

  useEffect(() => {
    const sync = () => setSurfaces(Array.from(processor.model.surfacesMap.values()));
    const createdSub = processor.onSurfaceCreated(sync);
    const deletedSub = processor.onSurfaceDeleted(sync);

    const es = new EventSource('/events');
    es.onmessage = (e) => {
      if (!e.data) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== 'a2ui' || !msg.message) return;
      try {
        processor.processMessages([msg.message]);
      } catch (err) {
        console.error('[a2ui] processMessages 失败:', err);
      }
    };
    es.onerror = () => { /* SSE 断线静默重连 */ };

    return () => {
      createdSub.unsubscribe();
      deletedSub.unsubscribe();
      es.close();
    };
  }, [processor]);

  return (
    <div style={{ padding: 12 }}>
      {surfaces.length === 0 && (
        <div style={{ color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>
          A2UI 面板 — 让智能体生成动态 UI (表单/卡片/列表)
        </div>
      )}
      {surfaces.map((surface) => (
        <A2uiSurface key={surface.id} surface={surface} />
      ))}
    </div>
  );
}

let _root: Root | null = null;
export function mountA2ui(rootEl: HTMLElement): void {
  if (!_root) _root = createRoot(rootEl);
  _root.render(<A2uiApp />);
}

// 浏览器直接加载时自动挂载
if (typeof document !== 'undefined') {
  const el = document.getElementById('a2ui-root');
  if (el) mountA2ui(el);
}
