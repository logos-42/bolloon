/**
 * Storage Layer Integration Test
 * 测试消息存储、离线队列和响应持久化
 *
 * 运行: npx tsx src/test/storage-integration.test.ts
 */

import { config } from 'dotenv';
import * as fs from 'fs/promises';
import * as path from 'path';

config();

const TEST_DIR = path.join(process.env.HOME || '/tmp', '.bolloon', 'test-messages');
const TEST_CLEANUP = true;

async function runStorageTest() {
  console.log('\n========================================');
  console.log('  Storage Layer Integration Test');
  console.log('========================================\n');

  // 清理测试目录
  if (TEST_CLEANUP) {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
      console.log('✓ Cleaned test directory');
    } catch {}
  }

  // 导入存储层
  console.log('━━━ 导入存储层 ━━━\n');

  const { JsonMessageStore } = await import('../network/storage/adapters/json-adapter.js');
  const { createMessageStore, createInMemoryStore } = await import('../network/storage/index.js');

  // 测试 1: JSON 存储初始化
  console.log('━━━ 测试 1: JSON 存储初始化 ━━━\n');

  const jsonStore = new JsonMessageStore({ baseDir: TEST_DIR });
  await jsonStore.initialize();

  console.log('✓ JsonMessageStore initialized');
  console.log(`  Base dir: ${TEST_DIR}`);

  // 测试 2: 保存消息
  console.log('\n━━━ 测试 2: 保存消息 ━━━\n');

  const msg1 = await jsonStore.saveMessage({
    direction: 'sent',
    type: 'task',
    payload: Buffer.from('Hello World').toString('base64'),
    from: 'node-A',
    to: 'node-B',
    timestamp: Date.now(),
    status: 'delivered',
    retryCount: 0,
  });

  console.log('✓ Saved message');
  console.log(`  ID: ${msg1.id}`);
  console.log(`  Type: ${msg1.type}`);
  console.log(`  Status: ${msg1.status}`);

  // 测试 3: 查询消息
  console.log('\n━━━ 测试 3: 查询消息 ━━━\n');

  const allMessages = await jsonStore.getMessages();
  console.log(`✓ Found ${allMessages.length} messages`);

  const sentMessages = await jsonStore.getMessages({ direction: 'sent' });
  console.log(`✓ Found ${sentMessages.length} sent messages`);

  const taskMessages = await jsonStore.getMessages({ type: 'task' });
  console.log(`✓ Found ${taskMessages.length} task messages`);

  // 测试 4: 离线消息队列
  console.log('\n━━━ 测试 4: 离线消息队列 ━━━\n');

  const offline1 = await jsonStore.enqueueOfflineMessage({
    targetNodeId: 'node-B',
    type: 'urgent-task',
    payload: Buffer.from('Urgent message').toString('base64'),
    createdAt: Date.now(),
    transport: 'libp2p',
    retryCount: 0,
  });

  console.log('✓ Enqueued offline message');
  console.log(`  ID: ${offline1.id}`);
  console.log(`  Target: ${offline1.targetNodeId}`);

  const pendingCount = await jsonStore.getPendingOfflineCount();
  console.log(`✓ Pending offline count: ${pendingCount}`);

  const nodeBMessages = await jsonStore.getOfflineMessages('node-B');
  console.log(`✓ Messages for node-B: ${nodeBMessages.length}`);

  // 测试 5: 待响应请求
  console.log('\n━━━ 测试 5: 待响应请求 ━━━\n');

  const pending = await jsonStore.savePendingResponse({
    requestId: 'req-123',
    type: 'task-request',
    payload: 'Request payload',
    fromNodeId: 'node-A',
    timestamp: Date.now(),
    timeout: 30000,
  });

  console.log('✓ Saved pending response');
  console.log(`  ID: ${pending.id}`);
  console.log(`  Request ID: ${pending.requestId}`);

  const retrieved = await jsonStore.getPendingResponse('req-123');
  console.log(`✓ Retrieved pending: ${retrieved ? 'found' : 'not found'}`);

  await jsonStore.removePendingResponse('req-123');
  console.log('✓ Removed pending response');

  // 测试 6: 内存存储
  console.log('\n━━━ 测试 6: 内存存储 ━━━\n');

  const memStore = createInMemoryStore();
  await memStore.initialize();

  const memMsg = await memStore.saveMessage({
    direction: 'received',
    type: 'chat',
    payload: 'In-memory message',
    from: 'peer-X',
    to: 'me',
    timestamp: Date.now(),
    status: 'pending',
    retryCount: 0,
  });

  console.log('✓ Saved to in-memory store');
  console.log(`  ID: ${memMsg.id}`);

  await memStore.shutdown();
  console.log('✓ In-memory store shutdown');

  // 测试 7: 统计和清理
  console.log('\n━━━ 测试 7: 统计和清理 ━━━\n');

  const msgCount = await jsonStore.getMessageCount();
  console.log(`✓ Total messages: ${msgCount}`);

  const oldMessages = await jsonStore.getMessages({
    endTime: Date.now() - 1000, // 1秒前
  });
  console.log(`✓ Old messages (< 1s): ${oldMessages.length}`);

  // 测试 8: 工厂函数
  console.log('\n━━━ 测试 8: 工厂函数 ━━━\n');

  const store = await createMessageStore('libp2p', { baseDir: TEST_DIR });
  console.log('✓ Created store via factory');

  await store.shutdown();
  console.log('✓ Store shutdown');

  // 验证文件已创建
  console.log('\n━━━ 验证存储文件 ━━━\n');

  try {
    const files = await fs.readdir(TEST_DIR);
    console.log(`✓ Storage files created: ${files.length}`);
    for (const file of files) {
      console.log(`  - ${file}`);
    }
  } catch (e) {
    console.log('No storage files yet (messages not persisted to disk in this session)');
  }

  // 最终清理
  await jsonStore.shutdown();
  console.log('\n✓ All stores shutdown');

  // 统计
  console.log('\n========================================');
  console.log('  测试完成');
  console.log(`  消息数: ${msgCount}`);
  console.log(`  离线消息: ${pendingCount}`);
  console.log('========================================\n');
}

runStorageTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});