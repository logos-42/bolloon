/**
 * start-headless.ts — 无头模式启动完整 Bolloon Server
 */
process.env.FORCE_COLOR = '0';
console.log('[start] 🚀 启动 Bolloon...');
const { createWebServer } = await import('./src/web/server.js');
const port = Number(process.env.BOLLOON_PORT) || 54188;
const { port: actualPort } = await createWebServer(port, {});
console.log(`[start] ✅ Web: http://127.0.0.1:${actualPort}`);
console.log(`[start] 💓 社交: ${process.env.BOLLOON_AGENT_HEARTBEAT_SOCIAL !== '0'}`);
await new Promise(() => {});
