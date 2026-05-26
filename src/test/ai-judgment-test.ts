/**
 * AI + 判断力注入 测试
 * 验证 AI 调用和价值观注入功能
 */

import { createAgentSession } from '../agents/pi-sdk.js';
import { generateValueInjection, generateSituationalValueInjection } from '../pi-ecosystem-judgment/value-injection.js';
import { storeHumanJudgment, initializeValueStore, getValueStats } from '../pi-ecosystem-judgment/human-value-store.js';

async function main() {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║     AI + 判断力注入测试                       ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  // 1. 初始化
  console.log('\n[1] 初始化...');
  await initializeValueStore();
  console.log('  ✅ 判断力存储就绪');

  // 2. 存储一些测试判断
  console.log('\n[2] 存储测试判断...');
  await storeHumanJudgment({
    decision: '代码安全性比性能更重要',
    decision_type: 'approve',
    reasons: ['防止被攻击', '用户数据保护'],
    values_derived: [
      { category: 'safety', value: 'security-first', weight: 0.9 }
    ],
    context: {
      domain: 'code',
      complexity: 'moderate',
      stakes: 'high',
      time_pressure: 'low'
    },
    outcome: { approved: true },
    metadata: {
      source: 'explicit',
      confidence: 0.85,
      revisable: true
    }
  });
  console.log('  ✅ 判断已存储');

  // 3. 查看统计
  console.log('\n[3] 判断力统计...');
  const stats = await getValueStats();
  console.log(`  总判断数: ${stats.total_judgments}`);
  console.log(`  顶级价值观: ${stats.top_values.slice(0, 3).map(v => v.value).join(', ')}`);

  // 4. 生成价值观注入
  console.log('\n[4] 生成价值观注入...');
  const injection = await generateValueInjection('代码安全问题', {
    mode: 'standard',
    maxTokens: 400,
    includeExamples: true,
    includeRules: true
  });
  console.log(`  注入内容长度: ${injection.length} 字符`);
  if (injection) {
    console.log('  ✅ 价值观注入已生成');
  }

  // 5. 调用 AI
  console.log('\n[5] 调用 AI...');
  const session = await createAgentSession({ cwd: process.cwd() });

  const prompt = injection
    ? `${injection}

---
【当前问题】
用户问：如何确保 API 接口的安全性？

请基于上面的价值观回复用户。`
    : '用户问：如何确保 API 接口的安全性？请给出建议。';

  console.log('\n[6] 发送请求到 AI...');
  const response = await session.prompt(prompt);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  AI 回复:');
  console.log('═══════════════════════════════════════════════════════');
  console.log(response);
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('✅ 测试完成！');
}

main().catch(e => {
  console.error('❌ 测试失败:', e);
  process.exit(1);
});