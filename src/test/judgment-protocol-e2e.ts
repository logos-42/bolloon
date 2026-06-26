/**
 * judgment-protocol-e2e — 最小端到端验证
 *
 * 跑法:
 *   1) 先在一个终端跑:  npx tsx src/test/judgment-protocol-e2e.ts --role=nodeA
 *   2) 拿到 nodeA 打印的 publicKey
 *   3) 在另一个终端跑: npx tsx src/test/judgment-protocol-e2e.ts --role=nodeB --peer=<nodeA publicKey>
 *   4) nodeB 会自动 sendAsk 触发协议
 *   5) 两边都会打印链状态
 *
 * 验证 ask → dissent (自动) → align → reflect 整链
 */

import { judgmentProtocol, judgmentEventBus, listChains } from '../agents/judgment-protocol.js';
import { irohTransport as defaultIrohTransport } from '../network/iroh-transport.js';

// 命令行参数解析
function parseArgs() {
  const args: { role?: string; peer?: string } = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--role=')) args.role = arg.slice(7);
    else if (arg.startsWith('--peer=')) args.peer = arg.slice(7);
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const role = args.role || 'nodeA';
  const peer = args.peer;

  console.log(`\n========================================`);
  console.log(`bolloon judgment-protocol e2e`);
  console.log(`role = ${role}`);
  console.log(`peer = ${peer || '(none)'}`);
  console.log(`========================================\n`);

  // 用环境变量切换 role (P2PDirect 会按 role 加载不同 secret)
  process.env.BOLLOON_ROLE = role;

  // 初始化 iroh transport (这里需要 iroh 实际能跑; 如果不可用, 改用 mock transport)
  try {
    await defaultIrohTransport.start();
  } catch (e) {
    console.warn('[e2e] iroh transport 启动失败:', (e as Error).message);
    console.log('[e2e] 提示: iroh binding 在某些环境 (rustc < 1.93) 不可用. 此 demo 可降级到 mock transport.');
    return;
  }

  const myPubKey = defaultIrohTransport.getNodeId() || '';
  console.log(`[e2e] ${role} publicKey = ${myPubKey.slice(0, 16)}...\n`);

  // 初始化协议监听
  await judgmentProtocol.init();

  // 订阅事件, 看协议流转
  judgmentEventBus.on('judgment', (evt) => {
    console.log(`[e2e:${role}] 事件:`, JSON.stringify(evt));
  });

  // 如果有 peer, 主动发起 ask
  if (peer) {
    // 等连接握手
    console.log(`[e2e:${role}] 等待连接 ${peer.slice(0, 12)}...`);
    await new Promise((r) => setTimeout(r, 3000));

    if (role === 'nodeB') {
      // B 主动发起
      console.log(`[e2e:${role}] 发起 ask → ${peer.slice(0, 12)}...`);
      const ask = await judgmentProtocol.sendAsk(peer, '要不要跟潜在合伙人 X 签这次合作? 3 个月排他期, 利润五五开.', {
        context: '过去 1 年跟他有过 2 次非正式合作, 都按时交付. 现金流偏紧, 这笔签约能补 6 个月.',
      });
      console.log(`[e2e:${role}] ask 已发: askId = ${ask.askId}`);

      // 等 5 秒, 看自动 dissent 是否回来
      await new Promise((r) => setTimeout(r, 5000));

      // 看链状态
      const chains = await listChains(5);
      console.log(`\n[e2e:${role}] 当前 chains:`);
      for (const c of chains) {
        console.log(`  - ask: "${c.ask.decision.slice(0, 30)}..."`);
        console.log(`    status: ${c.status}`);
        console.log(`    dissents: ${c.dissents.length}`);
        c.dissents.forEach((d, i) => {
          console.log(`      [${i + 1}] from ${d.fromNodeId.slice(0, 12)}: ${d.dissents.slice(0, 3).join(' | ')}`);
        });
        console.log(`    aligns: ${c.aligns.length}`);
      }

      // 如果有对方 dissent 回来, 主动发 align
      const myChain = chains.find((c) => c.ask.proposerNodeId === myPubKey);
      if (myChain && myChain.dissents.length > 0) {
        const peerDissents = myChain.dissents.filter((d) => d.fromNodeId !== myPubKey);
        if (peerDissents.length > 0) {
          console.log(`\n[e2e:${role}] 基于对方 ${peerDissents.length} 条 dissent 发 align...`);
          const align = await judgmentProtocol.sendAlign(peer, myChain.ask.askId, '签, 但改成 1 个月排他期 + 利润 60/40 (我方 60), 试运行 1 个月再续约.', peerDissents.map((d) => d.dissentId));
          console.log(`[e2e:${role}] align 已发: alignId = ${align.alignId}`);

          await new Promise((r) => setTimeout(r, 3000));

          // reflect
          console.log(`\n[e2e:${role}] reflect...`);
          const r = await judgmentProtocol.reflect(myChain.ask.askId);
          if (r) {
            console.log(`[e2e:${role}] ✓ reflect 完成: judgmentId=${r.judgmentId}`);
            console.log(`[e2e:${role}]   yaml: ${r.yamlPath}`);
          }
        }
      }
    } else {
      // nodeA 等 10 秒接收 + 自动 dissent
      console.log(`[e2e:${role}] 等待对方 ask (10s)...`);
      await new Promise((r) => setTimeout(r, 10000));

      const chains = await listChains(5);
      console.log(`\n[e2e:${role}] 收到 ${chains.length} 条 ask 链:`);
      for (const c of chains) {
        console.log(`  - ask: "${c.ask.decision.slice(0, 30)}..." (from ${c.ask.proposerNodeId.slice(0, 12)})`);
        console.log(`    status: ${c.status}`);
        console.log(`    dissents: ${c.dissents.length}`);
        c.dissents.forEach((d, i) => {
          console.log(`      [${i + 1}] from ${d.fromNodeId.slice(0, 12)}: ${d.dissents.slice(0, 3).join(' | ')}`);
        });
      }

      // 如果有对方 align 收到, reflect
      const lastChain = chains[0];
      if (lastChain && lastChain.status === 'aligned') {
        console.log(`\n[e2e:${role}] reflect 我方参与的链...`);
        const r = await judgmentProtocol.reflect(lastChain.ask.askId);
        if (r) console.log(`[e2e:${role}] ✓ reflect 完成: ${r.yamlPath}`);
      }
    }
  } else {
    // 没传 peer, 就保持监听状态, 等对方 ask
    console.log(`[e2e:${role}] 等待对方通过 --peer 传入 publicKey 后发起 ask...`);
    console.log(`[e2e:${role}] (Ctrl+C 退出)`);
    await new Promise(() => {}); // 永久等待
  }
}

main().catch((e) => {
  console.error('[e2e] 致命错误:', e);
  process.exit(1);
});
