/**
 * 验证 pi-ai callOpenAI 网络错误重试 (2026-08-04 二修, undici request 版):
 * 本地 server 第一次请求时直接关闭 socket (模拟服务端断连 → "other side closed"),
 * 后续请求正常 → 验证重试真正换连接成功.
 * 用法: npx tsx scripts/verify-llm-retry.ts
 */
import * as http from 'http';
import { PiAIModel } from '../src/llm/pi-ai.js';

async function main() {
  let requests = 0;
  let closedFirst = false;

  const server = http.createServer((req, res) => {
    requests++;
    if (requests === 1 && !closedFirst) {
      // 第一次请求: 直接关闭 socket, 模拟服务端断连 (other side closed)
      closedFirst = true;
      req.socket.destroy();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: `重试成功 ✅ (第 ${requests} 次请求)` }, finish_reason: 'stop' }],
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;

  try {
    const model = new PiAIModel({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4.1',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    } as any);

    const r = await model.chat('hi', 'test system');
    console.log(`server 收到请求次数: ${requests} (期望 ≥2, 1 次被断连 + 重试成功)`);
    console.log(`回复: ${r.reply}`);
    if (requests < 2) { console.log('FAIL: 未按预期重试'); process.exit(1); }
    if (!r.reply.includes('重试成功')) { console.log('FAIL: 回复不对'); process.exit(1); }
    console.log('✅ 断连重试验证通过 (undici request + 新连接生效)');
  } finally {
    server.close();
  }
  process.exit(0);
}

main().catch((e) => { console.error('脚本失败:', e); process.exit(1); });
