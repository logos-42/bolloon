import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 真机 UI E2E —— 本地联系人 / 手机号加好友 / 跨设备连接码（2026-11-15）
 *
 * 覆盖两条真实 UI 流程（不是模拟函数调用）：
 *   1) 「＋ 加好友」→ 打开通讯录搜索框并聚焦 → 搜手机号 → 结果区给出明确结论；
 *   2) 连接码：A 端「我的连接码」生成 `bolloon-connect:v1:…`（DID 签名）→
 *      B 端粘贴 → `accept-invite` 验签通过 → UI 显示「已连上」。
 *
 * 两个服务是两份独立 BOLLOON_HOME + 不同端口 ⇒ 真的是两台"设备"。
 * `BOLLOON_PUBLIC_URL` 必须显式给：连接码里的可达地址优先读它，否则会指向默认 54188。
 */

// ESM 下没有 __dirname（package.json 是 type: module）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(
  ROOT,
  'bin',
  process.arch === 'arm64' ? 'bolloon-native-darwin-arm64' : 'bolloon-native-darwin-x64',
);
const hasBin = fs.existsSync(BIN);

test.skip(process.platform !== 'darwin', '真机 UI E2E 目前只跑 macOS 原生二进制');
test.skip(!hasBin, `缺少原生二进制 ${BIN}（先跑 node scripts/build-native.mjs）`);

const PORTS = [54521, 54522];
const BASES = PORTS.map((p) => `http://127.0.0.1:${p}`);
const procs: ChildProcess[] = [];
const homes: string[] = [];

async function waitReady(base: string, timeoutMs = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(base + '/');
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`服务未就绪: ${base}`);
}

test.beforeAll(async () => {
  if (process.platform !== 'darwin' || !hasBin) return;
  for (let i = 0; i < PORTS.length; i++) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `bolloon-ui-e2e-${i}-`));
    homes.push(home);
    procs.push(
      spawn(BIN, ['web', '--port', String(PORTS[i])], {
        env: {
          ...process.env,
          BOLLOON_HOME: home,
          // 连接码里的可达基址：显式给本端口的 loopback，B 端能直接连回来
          BOLLOON_PUBLIC_URL: BASES[i],
          RUST_LOG: 'warn',
        },
        stdio: 'ignore',
      }),
    );
  }
  await Promise.all(BASES.map((b) => waitReady(b)));
});

test.afterAll(async () => {
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  for (const h of homes) {
    try {
      fs.rmSync(h, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** 进入通讯录（网页布局：左侧第二栏 sideTabs；非 Tauri 三栏） */
async function openContactsTab(page: Page, base = BASES[0]) {
  await page.goto(base + '/');
  await page.click('#sideTabs .side-tab[data-side="contacts"]');
}

test('加好友：＋加好友 → 通讯录搜索框聚焦，搜手机号给出明确结果', async ({ page }) => {
  await openContactsTab(page);

  // 「＋ 加好友」入口 → 应切到通讯录主区并聚焦搜索框
  await page.click('#addFriendBtn');
  await expect(page.locator('#ctInput')).toBeFocused();
  await expect(page.locator('#contactsView')).toBeVisible();

  await page.fill('#ctInput', '13900000000');
  await page.click('#ctGo');

  // 结果区必须给出结论（命中人数），而不是一直停在"搜索中…"
  await expect(page.locator('#ctResults')).toContainText(/找到 \d+ 人/, { timeout: 30_000 });
  await expect(page.locator('#ctResults')).not.toContainText('搜索中…');
});

test('连接码：A 生成 bolloon-connect 码 → B 粘贴后验签并连上', async ({ page, context }) => {
  // A：生成连接码
  await openContactsTab(page, BASES[0]);
  await page.click('#addFriendBtn');
  await page.click('#inviteMineBtn');
  await expect(page.locator('#inviteIn')).toHaveValue(/^bolloon-connect:v1:/, { timeout: 20_000 });
  const code = await page.inputValue('#inviteIn');
  expect(code.length).toBeGreaterThan(40);

  // B：粘贴并连接（另一份 BOLLOON_HOME ⇒ 不同 DID）
  const pageB = await context.newPage();
  await openContactsTab(pageB, BASES[1]);
  await pageB.click('#addFriendBtn');
  await pageB.fill('#inviteIn', code);
  await pageB.click('#inviteAcceptBtn');

  // 验签通过 + 登记地址 + 加好友 ⇒ 状态行显示"已连上"
  await expect(pageB.locator('#inviteStatus')).toContainText(/已连上/, { timeout: 30_000 });
  await expect(pageB.locator('#inviteStatus')).not.toContainText(/验签失败|失败/);
});
