/**
 * 验证 pi-ai callOpenAI 网络错误重试 (2026-08-04):
 * mock fetch 第一次抛 "terminated", 第二次成功 → 应重试后返回正常结果
 */
import { PiAIModel } from '../src/llm/pi-ai.js';

async function main() {
  let calls = 0;
  const origFetch = globalThis.fetch;

  // @ts-ignore 模拟 undici terminated 错误
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      const err: any = new Error('terminated');
      err.name = 'TypeError';
      throw err;
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '重试成功 ✅' }, finish_reason: 'stop' }],
      }),
    };
  };

  const model = new PiAIModel({
    provider: 'openai',
    apiKey: 'test-key',
    model: 'gpt-4.1',
    baseUrl: 'http://localhost:9999/v1',
  } as any);

  const r = await model.chat('hi', 'test system');
  console.log(`fetch 调用次数: ${calls} (期望 2, 1 次失败 + 1 次重试成功)`);
  console.log(`回复: ${r.reply}`);
  if (calls !== 2) { console.log('FAIL: 未按预期重试'); process.exit(1); }
  if (!r.reply.includes('重试成功')) { console.log('FAIL: 回复不对'); process.exit(1); }
  console.log('✅ 网络错误重试验证通过');
  globalThis.fetch = origFetch;
  process.exit(0);
}

main().catch((e) => { console.error('脚本失败:', e); process.exit(1); });
