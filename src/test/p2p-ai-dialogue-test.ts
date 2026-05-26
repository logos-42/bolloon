/**
 * P2P AI 对话测试 - 结合判断力注入的智能体对话
 *
 * 功能:
 * 1. 通过 iroh P2P 接收消息
 * 2. 调用 AI 生成回复（带判断力注入）
 * 3. 通过 iroh 发送回复
 *
 * 流程:
 *   电脑 A: npx tsx src/test/p2p-ai-dialogue-test.ts --publish
 *   电脑 B: npx tsx src/test/p2p-ai-dialogue-test.ts --cid=<A的CID>
 */

import { irohTransport } from '../network/iroh-transport.js';
import { KeyManager, AgentAuthManager } from '@diap/sdk';
import { createAgentSession, type AgentSession } from '../agents/pi-sdk.js';
import { generateValueInjection, generateSituationalValueInjection } from '../pi-ecosystem-judgment/value-injection.js';
import { storeHumanJudgment, initializeValueStore } from '../pi-ecosystem-judgment/human-value-store.js';

const IPFS_ENDPOINT = 'http://127.0.0.1:5001';

interface DialogueMessage {
  from: string;
  content: string;
  type: 'user' | 'ai' | 'judgment';
  timestamp: number;
}

// 全局状态
let agentSession: AgentSession | null = null;
let messageHistory: DialogueMessage[] = [];
let ownNodeId: string = '';

// ============================================================
// AI 对话核心
// ============================================================
async function initAgentSession(): Promise<AgentSession> {
  console.log('\n[AI] 初始化 Agent Session...');

  const session = await createAgentSession({
    cwd: process.cwd()
  });

  console.log('  ✅ Agent Session 就绪');
  return session;
}

async function generateAIResponse(userInput: string, context?: string): Promise<string> {
  if (!agentSession) {
    agentSession = await initAgentSession();
  }

  console.log('\n[AI] 处理输入...');
  console.log(`  📥 用户: ${userInput.substring(0, 50)}...`);

  // 1. 生成判断力注入
  console.log('\n[Judgment] 生成价值观注入...');
  let valueInjection = '';
  try {
    const injection = await generateValueInjection(context || userInput, {
      mode: 'standard',
      maxTokens: 500,
      includeExamples: true,
      includeRules: true
    });
    valueInjection = injection;
    if (injection) {
      console.log('  ✅ 价值观注入已生成');
    } else {
      console.log('  ℹ️  无历史价值观数据');
    }
  } catch (e) {
    console.log(`  ⚠️  价值观注入失败: ${(e as Error).message}`);
  }

  // 2. 构建带判断力的 prompt
  const fullPrompt = buildPromptWithJudgments(userInput, valueInjection);

  // 3. 调用 AI
  console.log('\n[AI] 调用语言模型...');
  try {
    const response = await agentSession.prompt(fullPrompt);
    console.log('  ✅ AI 回复已生成');

    // 保存对话历史
    messageHistory.push({
      from: 'user',
      content: userInput,
      type: 'user',
      timestamp: Date.now()
    });
    messageHistory.push({
      from: 'ai',
      content: response,
      type: 'ai',
      timestamp: Date.now()
    });

    return response;
  } catch (e) {
    console.error('  ❌ AI 调用失败:', e);
    return `抱歉，AI 服务暂时不可用: ${(e as Error).message}`;
  }
}

function buildPromptWithJudgments(userInput: string, valueInjection: string): string {
  // 构建包含判断力注入的 prompt
  let prompt = '';

  if (valueInjection) {
    prompt = `${valueInjection}

---

【当前对话】
用户: ${userInput}

请基于以上价值观和上下文回复用户。`;
  } else {
    prompt = `你是一个有帮助的 AI 助手。

【当前对话】
用户: ${userInput}

请回复用户。`;
  }

  return prompt;
}

// ============================================================
// 消息处理
// ============================================================
function setupMessageHandlers() {
  console.log('\n[P2P] 设置消息处理器...');

  // 处理 chat 类型消息
  irohTransport.onMessage('chat', async (msg) => {
    const content = new TextDecoder().decode(msg.payload);
    const fromNode = msg.from.substring(0, 12);

    console.log(`\n[收到] 💬 from ${fromNode}...: ${content.substring(0, 50)}...`);

    // 生成 AI 回复
    const response = await generateAIResponse(content, 'p2p-dialogue');

    // 发送回复
    const replyPayload = JSON.stringify({
      type: 'ai-response',
      content: response,
      from: ownNodeId,
      timestamp: Date.now()
    });

    await irohTransport.sendMessage(msg.from, 'chat', new TextEncoder().encode(replyPayload));
    console.log(`[发送] ✅ 回复已发送`);
  });

  // 处理 ai-response 类型消息
  irohTransport.onMessage('ai-response', (msg) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload));
      console.log(`\n[收到] 🤖 AI 回复 from ${data.from?.substring(0, 12)}...`);
      console.log(`\n${'─'.repeat(50)}`);
      console.log(data.content);
      console.log(`${'─'.repeat(50)}\n`);
    } catch {
      console.log(`\n[收到] 原始消息: ${new TextDecoder().decode(msg.payload)}`);
    }
  });

  // 处理 feedback 类型消息（用户反馈）
  irohTransport.onMessage('feedback', async (msg) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload));
      console.log(`\n[收到] 📝 用户反馈: ${JSON.stringify(data)}`);

      // 存储反馈作为判断力学习
      if (data.judgment) {
        await storeHumanJudgment({
          decision: data.content || 'N/A',
          decision_type: data.type || 'approve',
          reasons: [data.reason || ''],
          values_derived: data.values || [],
          context: {
            domain: 'p2p-dialogue',
            complexity: 'moderate',
            stakes: 'low',
            time_pressure: 'low'
          },
          outcome: { approved: data.type === 'approve' },
          metadata: {
            source: 'p2p-feedback',
            confidence: 0.8,
            revisable: true
          }
        });
        console.log('  ✅ 反馈已存储为判断力数据');
      }
    } catch (e) {
      console.log(`  ⚠️  反馈解析失败: ${(e as Error).message}`);
    }
  });

  console.log('  ✅ 消息处理器已设置');
}

// ============================================================
// DID 发布
// ============================================================
async function publishDID(): Promise<{ did: string; cid: string; nodeId: string }> {
  console.log('\n[DID] 发布身份到 IPFS...');

  const keyPair = KeyManager.generate();
  const did = keyPair.did;
  const nodeId = irohTransport.getNodeId() || '';

  console.log(`  ✅ DID: ${did}`);
  console.log(`  ✅ iroh Node ID: ${nodeId}`);

  // 构建 DID 文档（包含 iroh 信息）
  const agentDoc = {
    id: did,
    name: `bolloon-ai-${Date.now()}`,
    version: '1.0',
    capabilities: ['chat', 'reasoning', 'judgment-injection', 'ai-dialogue'],
    interests: ['ai', 'p2p', 'judgment-system'],
    irohNodeId: nodeId,
    publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
    channels: [{ id: 'main', name: '主对话' }],
    createdAt: new Date().toISOString()
  };

  // 发布到 IPFS
  const formData = new FormData();
  const blob = new Blob([JSON.stringify(agentDoc)], { type: 'application/json' });
  formData.append('file', blob, 'agent-doc.json');

  const response = await fetch(`${IPFS_ENDPOINT}/api/v0/add`, {
    method: 'POST',
    body: formData
  });
  const result = await response.text();
  const cidMatch = result.match(/"Hash":"([^"]+)"/);
  const cid = cidMatch ? cidMatch[1] : '';

  console.log(`  ✅ IPFS CID: ${cid}`);

  return { did, cid, nodeId };
}

// ============================================================
// 解析 CID
// ============================================================
async function resolveCID(cid: string): Promise<{ did: string; name: string } | null> {
  console.log('\n[IPFS] 解析 CID...');

  try {
    const response = await fetch(`${IPFS_ENDPOINT}/api/v0/cat?arg=${cid}`, {
      method: 'POST'
    });
    const content = await response.text();
    const doc = JSON.parse(content);

    console.log(`  ✅ 解析成功`);
    console.log(`     DID: ${doc.id}`);
    console.log(`     名称: ${doc.name || 'N/A'}`);

    return { did: doc.id, name: doc.name || 'Unknown' };
  } catch (e) {
    console.log(`  ❌ 解析失败: ${(e as Error).message}`);
    return null;
  }
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║     P2P AI 对话测试 - 判断力注入 + 智能体对话           ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  const args = process.argv.slice(2);
  const isPublisher = args.includes('--publish');
  const targetCid = args.find(a => a.startsWith('--cid='))?.split('=')[1];
  const targetNode = args.find(a => a.startsWith('--node='))?.split('=')[1];

  // 1. 初始化
  console.log('\n[初始化] 启动 iroh...');
  await irohTransport.start();
  ownNodeId = irohTransport.getNodeId() || '';
  console.log(`  ✅ iroh 已启动: ${ownNodeId.substring(0, 20)}...`);

  // 2. 初始化价值观存储
  try {
    await initializeValueStore();
    console.log('  ✅ 判断力存储已初始化');
  } catch (e) {
    console.log(`  ⚠️  判断力存储初始化失败: ${(e as Error).message}`);
  }

  // 3. 设置消息处理器
  setupMessageHandlers();

  // 发布模式
  if (isPublisher) {
    const { did, cid, nodeId } = await publishDID();

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  📋 连接信息（分享给另一台电脑）:');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  CID: ${cid}`);
    console.log(`  Node ID: ${nodeId}`);
    console.log('═══════════════════════════════════════════════════════════════\n');
    console.log('用法:');
    console.log(`  npx tsx src/test/p2p-ai-dialogue-test.ts --cid=${cid} --node=${nodeId}`);
    console.log('\n  等待消息...\n');

    await new Promise(() => {});
  }

  // 连接模式
  else if (targetCid && targetNode) {
    const resolved = await resolveCID(targetCid);

    if (resolved) {
      console.log(`\n  🎯 准备连接到 ${resolved.name}...`);
    }

    // 发送测试消息
    const testMessage = JSON.stringify({
      type: 'chat',
      content: '你好！这是 P2P AI 对话测试消息。请问你能处理什么任务？',
      from: ownNodeId,
      timestamp: Date.now()
    });

    console.log('\n[发送] 测试消息...');
    const success = await irohTransport.sendMessage(
      targetNode,
      'chat',
      new TextEncoder().encode(testMessage)
    );

    if (success) {
      console.log('  ✅ 消息发送成功，等待回复...\n');
    } else {
      console.log('  ⚠️  消息发送失败\n');
    }

    console.log('  等待消息... (30秒后退出)\n');
    await new Promise(resolve => setTimeout(resolve, 30000));
  }

  // 帮助信息
  else {
    console.log('\n用法:');
    console.log('');
    console.log('  电脑 A (发布方):');
    console.log('    npx tsx src/test/p2p-ai-dialogue-test.ts --publish');
    console.log('');
    console.log('  电脑 B (连接方):');
    console.log('    npx tsx src/test/p2p-ai-dialogue-test.ts --cid=<CID> --node=<NodeID>');
    console.log('');
    console.log('测试流程:');
    console.log('  1. A 运行 --publish，记录显示的 CID 和 NodeID');
    console.log('  2. B 使用 --cid 和 --node 连接 A');
    console.log('  3. A 收到消息后，调用 AI 生成回复（带判断力注入）');
    console.log('  4. 回复通过 P2P 发送回 B');
  }
}

main().catch(console.error);