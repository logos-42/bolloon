/**
 * client-hearth.ts — judgeness 前端模块 (占位实现)
 *
 * 防御期: 接 routes-hearth.ts, 渲染最小骨架 UI (My Hearth / Discover / Visit).
 * 真实样式与组件待相持期接入 bolloon 现有 ui 设计 (HIG 等参考).
 *
 * 这个文件会被 esbuild 打包进 dist/web/client.js (与 src/web/client.ts 一致链路).
 *
 * 部署约定: 本文件 import 的 url 都是 '/api/hearth/*', 与 server.ts 端口 54188 对齐.
 */

// 默认接受 JSON-LD (agent 头等公民); 人类用 ?view=human 切
async function fetchHearth(path: string, opts: { json?: boolean } = {}): Promise<unknown> {
  const res = await fetch(path, { headers: { Accept: opts.json ? 'application/ld+json' : '*/*' } });
  if (!res.ok) throw new Error(`hearth fetch ${path} -> ${res.status}`);
  return await res.json();
}

// 三视图 stub: 由主 client.ts 路由到 #/hearth / #/hearth/discover / #/hearth/visit/<pk>

export async function renderMyHearth(root: HTMLElement): Promise<void> {
  root.innerHTML = '<h1>My Hearth</h1><p>Loading…</p>';
  try {
    const data = await fetchHearth('/api/hearth') as any;
    root.innerHTML = `
      <h1>My Hearth</h1>
      <dl>
        <dt>Service</dt><dd>${data.service} v${data.version}</dd>
        <dt>Root</dt><dd><code>${data.rootPath}</code></dd>
        <dt>Description count</dt><dd>${data.descriptionCount}</dd>
        <dt>Visibility channels</dt><dd>${data.visibilityChannels}</dd>
        <dt>Allowlist count</dt><dd>${data.allowlistCount}</dd>
        <dt>Defense mode</dt><dd>${data.defenseMode ? 'ON (write APIs disabled)' : 'OFF (反攻期)'}</dd>
      </dl>
      <p>视图: <a href="#/hearth/discover">Discover</a> · <a href="#/hearth/visit/__self__">Visit self</a></p>`;
  } catch (e: any) {
    root.innerHTML = `<h1>My Hearth</h1><p style="color:red">Error: ${e.message}</p>`;
  }
}

export async function renderDiscover(root: HTMLElement): Promise<void> {
  root.innerHTML = '<h1>Discover</h1><p>Searching…</p>';
  try {
    const data = await fetchHearth('/api/hearth/discover') as any;
    // data 可能是 JSON-LD @graph 或 list
    const items = Array.isArray(data) ? data : (data['@graph'] ?? []);
    const cards = items.slice(0, 50).map((it: any) => {
      const id = it['@id'] ?? it.descriptionId ?? '?';
      const vis = it.visibility ?? '?';
      const state = it.openState ?? '?';
      return `<li><code>${id}</code> · <span>${vis}</span> · <span>${state}</span></li>`;
    }).join('');
    root.innerHTML = `<h1>Discover</h1><ul>${cards || '<li>(no results)</li>'}</ul>`;
  } catch (e: any) {
    root.innerHTML = `<h1>Discover</h1><p style="color:red">Error: ${e.message}</p>`;
  }
}

export async function renderVisit(root: HTMLElement, _pubkey: string): Promise<void> {
  root.innerHTML = `<h1>Visit</h1><p>Visit 视图待相持期实现 (plan §C2).</p>`;
}

// 注册 router hook — 主 client.ts 在启动时调用
export function registerHearthRoutes(
  router: { on: (path: string, handler: (...args: any[]) => void) => void },
  getRoot: () => HTMLElement
): void {
  router.on('/hearth', () => void renderMyHearth(getRoot()));
  router.on('/hearth/discover', () => void renderDiscover(getRoot()));
  router.on('/hearth/visit/:pk', (_p: unknown, params: Record<string, string>) => {
    void renderVisit(getRoot(), params['pk'] ?? '__self__');
  });
}
