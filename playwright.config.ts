import { defineConfig } from '@playwright/test';

/**
 * 真机 UI E2E（2026-11-15）
 *
 * - 走**系统 Chrome**（channel: 'chrome'）：Playwright 自带的 chromium 构建不支持 macOS 13，
 *   而本机已装 Chrome 157，直接复用，无需 `playwright install`。
 * - 测试自己 spawn 原生 web 服务（两个独立 BOLLOON_HOME），不依赖外部已起的进程。
 * - 运行：`npm run test:ui`（需先 `node scripts/build-native.mjs` 生成 bin/ 下的原生二进制）。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    actionTimeout: 20_000,
    ignoreHTTPSErrors: true,
  },
});
