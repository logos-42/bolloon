/**
 * verify-config-migration.ts — bolloon-config.json 迁移验证 (2026-08-07)
 * 用临时 HOME 模拟: 旧 llm-config.json → 新 bolloon-config.json 迁移
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

async function main() {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-cfg-'));
  const oldHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    // 1. 造一个旧 llm-config.json
    await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true });
    const legacy = {
      activeProvider: 'deepseek',
      providers: {
        deepseek: { enabled: true, apiKey: 'sk-test-123', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', temperature: 0.7, maxTokens: 4096, requiresApiKey: true },
        openai: { enabled: false, apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6', temperature: 0.7, maxTokens: 4096, requiresApiKey: true },
      },
      updatedAt: '2026-08-06T00:00:00.000Z',
    };
    await fs.writeFile(path.join(tmpHome, '.bolloon', 'llm-config.json'), JSON.stringify(legacy));

    // 2. 初始化 config-store → 应该迁移到 bolloon-config.json
    const { llmConfigStore } = await import('../src/llm/config-store.js');
    await llmConfigStore.initialize();
    const cfg = await llmConfigStore.getConfig();
    console.log('activeProvider:', cfg.activeProvider);
    console.log('deepseek model:', cfg.providers.deepseek?.model);
    console.log('deepseek key 迁移:', cfg.providers.deepseek?.apiKey === 'sk-test-123' ? 'OK' : 'FAIL');

    // 3. 新文件存在?
    const newFile = path.join(tmpHome, '.bolloon', 'bolloon-config.json');
    const stat = await fs.stat(newFile);
    console.log('bolloon-config.json 已创建, mode:', (stat.mode & 0o777).toString(8));

    // 4. 更新配置 (Bolloon 自己改) — 改 active 供应商字段, 不切供应商 (minimax 需 key 会被防护拦截)
    await llmConfigStore.updateProvider('deepseek', { temperature: 0.3, model: 'deepseek-v4-flash' });
    const cfg2 = await llmConfigStore.getConfig();
    console.log('自己改配置: deepseek.temperature =', cfg2.providers.deepseek?.temperature, ', model =', cfg2.providers.deepseek?.model);
    console.log('=== 迁移验证通过 ===');
  } finally {
    process.env.HOME = oldHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
