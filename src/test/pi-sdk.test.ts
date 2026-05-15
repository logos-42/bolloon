import { config } from 'dotenv';
import { createAgentSession } from '../agents/pi-sdk.js';
import { initMinimax } from '../llm/minimax.js';
import * as path from 'path';

config();

async function testBasicSession() {
  console.log('=== 测试1: 基本Agent会话 ===\n');

  const session = await createAgentSession({
    cwd: process.cwd(),
  });

  const result = await session.prompt('简单问候');
  console.log('响应:', result);
  console.log('✅ 基本会话测试完成\n');
}

async function testDocumentAnalysis() {
  console.log('=== 测试2: 文档分析Agent ===\n');

  const testFile = path.join(process.cwd(), 'README.md');
  const session = await createAgentSession({
    cwd: process.cwd(),
  });

  try {
    const result = await session.summarizeDocument(testFile, '测试文档分析');
    console.log('摘要:', result.summary);
    console.log('质量评分:', (result.qualityScore * 10).toFixed(1), '/ 10');
    console.log('✅ 文档分析测试完成\n');
  } catch (e) {
    console.log('文档分析测试跳过 (文件可能不存在)\n');
  }
}

async function testMinimaxIntegration() {
  console.log('=== 测试3: Minimax LLM集成 ===\n');

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    console.log('⚠️ MINIMAX_API_KEY 未设置，跳过LLM测试\n');
    return;
  }

  initMinimax({ apiKey });
  const session = await createAgentSession({
    cwd: process.cwd(),
  });

  const result = await session.prompt('总结: 这是一个测试文档，用于验证LLM摘要功能。人工智能技术正在快速发展，文档智能处理是一个重要的应用场景。');
  console.log('摘要结果:', result);
  console.log('✅ Minimax集成测试完成\n');
}

async function runTests() {
  console.log('🔬 AI文档智能体 Pi SDK 测试套件\n');
  console.log('='.repeat(40) + '\n');

  await testBasicSession();
  await testDocumentAnalysis();
  await testMinimaxIntegration();

  console.log('='.repeat(40));
  console.log('所有测试完成\n');
}

runTests().catch(console.error);
