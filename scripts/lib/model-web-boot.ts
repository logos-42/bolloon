/**
 * model-web-boot.ts — 验收用: **真起** web 服务 (2026-09-26, P6)
 *
 * 为什么不直接跑 `src/index.ts --web`: 那条路会连带把身份/P2P/kubo 一起引导起来
 * (验收里用不着, 而且会拖长冷启动)。这里起的是同一个 `createWebServer` —— **路由是真的**
 * (它内部会 `registerLlmConfigRoutes(app)`), 只是不引导 P2P。
 *
 * 端口只认 `PORT` 环境变量 (web 模式本来就不解析 `--port`)。
 * 就绪后往 stdout 打一行 `WEB_BOOTED port=<n>`; 调用方也可以直接打健康检查等它。
 */

const port = Number(process.env.PORT || 0) || 43300;
const mod: any = await import('../../src/web/server.js');
await mod.createWebServer(port);
console.log(`WEB_BOOTED port=${port}`);
// 服务自己不结束 (由调用方 SIGTERM)
setInterval(() => {}, 1 << 30);
