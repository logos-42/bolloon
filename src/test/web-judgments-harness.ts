/**
 * web-judgments-harness — 极简 web server 启动, 只用来跑 judgments 的闭环测试.
 *   不走 main() 里的 P2P / 身份 / 自动更新.
 *
 * 用法:
 *   PORT=3000 npx tsx src/test/web-judgments-harness.ts
 */

import { createWebServer } from '../web/server.js';

const port = parseInt(process.env.PORT || '3000', 10);
console.log(`[harness] 启动 web server on :${port}`);
await createWebServer(port);
