/**
 * sidebar-footer-relocate.test.ts — 折叠态底部簇 (2026-10-24, 用户: 「个人资料/检查更新/链上浏览器
 * 不能放左下角, 都放在折叠起来的侧边栏上; 最底部是个人资料, 往上是链上浏览器, 检查更新只有有更新的时候才出现」)
 *
 * 判据 (缺一不可):
 *   A. **搬离左下角** — 展开态 .sidebar-footer 不再含 user-avatar / user-info / update-btn /
 *      chain-explorer-link (只留 agent-status);
 *   B. **折叠态底部簇顺序** — #collapsed-footer (在 #sidebar-collapsed-bar 内) DOM 序自上而下
 *      为 update → chain → avatar ⇒ 视觉自下而上: 最底个人资料 · 往上链上浏览器 · 再往上检查更新;
 *      #collapsed-channels 里不再有重复的链上浏览器图标;
 *   C. **检查更新条件可见** — CSS: 常态 display:none, 仅 .has-update 才 display:flex
 *      (窄条里文字段隐藏, 只留图标);
 *   D. ** dist 同步** — dist/web/index.html + client.js 里有新结构 (忘了 build:web 就红,
 *      同 core-traits 层的 LAYERS_DIR 纪律: 桌面/浏览器实际跑的是 dist);
 *   E. **运行时兜底** — client.ts 有周期性更新复查 (按钮常态隐藏, 只查一次 ⇒ 运行中发布的新版永远不亮)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('A. 搬离左下角 (展开态 footer)', () => {
  const html = read('src/web/index.html');

  it('sidebar-footer 不再含个人资料/检查更新/链上浏览器 (只留连接状态)', () => {
    const footerMatch = html.match(/<div class="sidebar-footer">([\s\S]*?)<\/div>/);
    expect(footerMatch, 'sidebar-footer 要存在').toBeTruthy();
    const footer = footerMatch![1];
    expect(footer).not.toMatch(/id="user-avatar"/);
    expect(footer).not.toMatch(/id="user-info"/);
    expect(footer).not.toMatch(/class="user-info"/);
    expect(footer).not.toMatch(/id="update-btn"/);
    expect(footer).not.toMatch(/id="chain-explorer-link"/);
    expect(footer).toMatch(/class="agent-status"/);
  });

  it('collapsed-channels 里删掉重复的链上浏览器图标 (已在底部簇)', () => {
    const m = html.match(/<div class="collapsed-channels" id="collapsed-channels">([\s\S]*?)<\/div>/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toMatch(/data-target="chain-explorer-link"/);
  });
});

describe('B. 折叠态底部簇 (collapsed-footer)', () => {
  const html = read('src/web/index.html');

  it('在 #sidebar-collapsed-bar 内, 含 update / chain / avatar 三个入口 (同 ID 保留, JS 不改)', () => {
    // 切片: sidebar-collapsed-bar 开 → <main> 前 (aside 在 collapsed bar 后闭合), 不用非贪婪全文匹配
    const start = html.indexOf('id="sidebar-collapsed-bar"');
    const end = html.indexOf('<main');
    expect(start, 'sidebar-collapsed-bar 要存在').toBeGreaterThan(-1);
    expect(end, 'main 要存在 (折叠 bar 在 aside 末尾)').toBeGreaterThan(start);
    const barHtml = html.slice(start, end);
    const footer = barHtml.match(/<div class="collapsed-footer" id="collapsed-footer">([\s\S]*?)<\/div>/);
    expect(footer, 'collapsed-footer 要在折叠态侧边栏里').toBeTruthy();
    const f = footer![1];
    expect(f).toMatch(/id="update-btn"/);
    expect(f).toMatch(/id="chain-explorer-link"/);
    expect(f).toMatch(/id="user-avatar"/);
  });

  it('DOM 序自上而下 update → chain → avatar ⇒ 视觉最底是个人资料', () => {
    const html2 = read('src/web/index.html');
    const iUpd = html2.indexOf('id="update-btn"');
    const iCx = html2.indexOf('id="chain-explorer-link"');
    const iAv = html2.indexOf('id="user-avatar"');
    expect(iUpd).toBeGreaterThan(-1);
    expect(iCx).toBeGreaterThan(-1);
    expect(iAv).toBeGreaterThan(-1);
    expect(iUpd, 'update 在最上').toBeLessThan(iCx);
    expect(iCx, 'chain 居中').toBeLessThan(iAv);
    expect(iAv, 'avatar 在最底 (个人资料)').toBeGreaterThan(iCx);
  });
});

describe('C. 检查更新仅有更新才出现 + 窄条只留图标 (CSS)', () => {
  const css = read('src/web/style.css');

  it('collapsed-footer 吸底 (margin-top:auto)', () => {
    expect(css).toMatch(/\.collapsed-footer\s*\{[^}]*margin-top:\s*auto/);
  });

  it('窄条 section-action 改图标按钮几何 (40x40, 隐藏文字段)', () => {
    expect(css).toMatch(/\.sidebar-collapsed \.section-action\s*\{[^}]*width:\s*40px/);
    expect(css).toMatch(/\.sidebar-collapsed \.section-action \[data-zh\][^}]*display:\s*none/);
    expect(css).toMatch(/\.sidebar-collapsed \.section-action \.update-text[^}]*display:\s*none/);
  });

  it('update-btn 常态隐藏, 仅 has-update 才显示', () => {
    expect(css).toMatch(/\.sidebar-collapsed #update-btn\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.sidebar-collapsed #update-btn\.has-update\s*\{\s*display:\s*flex/);
  });
});

describe('D. dist 同步 (忘了 build:web 就红)', () => {
  it('dist/web/index.html 含 collapsed-footer 三个入口', () => {
    const dist = read('dist/web/index.html');
    expect(dist).toMatch(/<div class="collapsed-footer" id="collapsed-footer">/);
    expect(dist).toMatch(/id="update-btn"/);
    expect(dist).toMatch(/id="chain-explorer-link"/);
    expect(dist).toMatch(/id="user-avatar"/);
    expect(dist).not.toMatch(/<div class="user-info">/);
  });

  it('dist/web/client.js 含周期性更新复查 (编译产物同步; esbuild 会把 1000 编成 1e3)', () => {
    const js = read('dist/web/client.js');
    expect(js).toMatch(/checkUpdateStatus/);
    expect(js).toMatch(/10 \* 60 \* 1e3|600000/);
  });
});

describe('E. 运行时兜底 (client.ts)', () => {
  const ts = read('src/web/client.ts');

  it('周期性复查更新 (运行中发布的新版也要能亮)', () => {
    expect(ts).toMatch(/setInterval\(\(\) => \{ void checkUpdateStatus\(false\); \}, 10 \* 60 \* 1000\)/);
  });

  it('折叠态头像 title 带名字 (窄条放不下名字, tooltip 承载)', () => {
    expect(ts).toMatch(/avatarEl\.title = identity\.name \? `个人资料 \(\$\{identity\.name\}\)` : '个人资料'/);
  });

  it('保存资料后同步刷新头像 title', () => {
    expect(ts).toMatch(/av\.title = updated\.name \? `个人资料 \(\$\{updated\.name\}\)` : '个人资料'/);
  });

  it('内联改名死代码已删 (user-name 行不在 DOM, 改名走 profile modal)', () => {
    expect(ts).not.toMatch(/nameEl\.onclick/);
    expect(ts).not.toMatch(/nameEl\.replaceWith/);
  });
});
