/**
 * verify-config-tools.ts — bolloon_config_get/set agent 工具验证 (2026-08-07)
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

async function main() {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-tools-'));
  const oldHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true });
    // 直接写新格式配置
    const cfg = {
      activeProvider: 'deepseek',
      providers: {
        deepseek: { enabled: true, apiKey: 'sk-test-123', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', temperature: 0.7, maxTokens: 4096, requiresApiKey: true },
        openai: { enabled: false, apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6', temperature: 0.7, maxTokens: 4096, requiresApiKey: true },
      },
      updatedAt: '2026-08-07T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpHome, '.bolloon', 'bolloon-config.json'), JSON.stringify(cfg));

    const { registerBuiltinTools } = await import('../src/agents/pi-sdk-tools.js');
    const tools = new Map();
    registerBuiltinTools({ tools } as any);

    const getTool = tools.get('bolloon_config_get');
    const setTool = tools.get('bolloon_config_set');
    console.log('bolloon_config_get 注册:', !!getTool);
    console.log('bolloon_config_set 注册:', !!setTool);
    if (!getTool || !setTool) { console.log('FAIL: 工具未注册'); return; }

    const r1 = await getTool.execute({});
    console.log('get 结果:', r1.success);
    console.log((r1.output || '').split('\n').slice(0, 4).join('\n'));
    if (r1.output.includes('sk-test-123')) { console.log('FAIL: apiKey 泄漏!'); return; }
    console.log('apiKey 脱敏: OK');

    const r2 = await setTool.execute({ provider: 'deepseek', temperature: 0.5 });
    console.log('set 结果:', r2.success, '|', r2.output);

    const r3 = await setTool.execute({ 'minimax.model': 'MiniMax-M3' });
    console.log('set minimax.model:', r3.success, '|', r3.output);

    // 未知供应商应报错
    const r4 = await setTool.execute({ provider: 'nonsense' });
    console.log('未知供应商拦截:', !r4.success, '|', r4.error?.slice(0, 60));

    console.log('=== 工具验证通过 ===');
  } finally {
    process.env.HOME = oldHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
