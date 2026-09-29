/**
 * sync-transfers.ts — 关注地址集内 ERC-20 (USDC) 转账索引的**增量同步 / 补扫**入口
 *
 * 用法:
 *   npx tsx scripts/sync-transfers.ts                 # 增量 (从上次高度 +1; 每次都回扫最后 reorgDepth 块)
 *   npx tsx scripts/sync-transfers.ts --from 51640073 # 补扫 (从指定块起, 只许比已记起点更早或相等)
 *   npx tsx scripts/sync-transfers.ts --home /tmp/n   # 指定节点 home (测试/多实例)
 *   npx tsx scripts/sync-transfers.ts --quiet         # 只在出错时打印
 *
 * 起点缺省 = 链索引 (~/.bolloon/chain/index.json) 的 deploymentBlock —— 即 Bolloon 在
 * 这条链上的起点, 不是"最新块"(那会漏掉历史收款), 也不是 0(白扫几十万块)。
 * 本脚本只读链 + 只写 ~/.bolloon/chain/transfers.json, 不发交易、不碰私钥。
 */
import * as fs from 'fs';
import { syncTransfers, readTransferWatchConfig, transferIndexPath, readTransferIndex } from '../src/agents/chain/transfer-index.js';
import { chainIndexPath } from '../src/agents/chain/chain-indexer.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const home = arg('home');
  const quiet = has('quiet');
  const wantFrom = Number(arg('from'));
  const cfg = readTransferWatchConfig(home);

  if (!quiet) {
    console.error(`[transfers] 配置: ${cfg.reason}`);
    console.error(`[transfers] token=${cfg.tokenAddress} (${cfg.tokenSymbol}/${cfg.tokenDecimals}) chainId=${cfg.chainId} ${cfg.networkName} pageSize=${cfg.pageSize} reorgDepth=${cfg.reorgDepth}`);
  }
  if (!cfg.enabled) {
    console.error(`[transfers] ✗ 未启用: ${cfg.reason}`);
    process.exit(4);
  }

  // 起点: 显式 --from > 配置 > escrow 部署块 (链索引文件顶层字段)
  let fromBlock = cfg.fromBlock;
  let fromSource = cfg.fromBlockSource;
  if (Number.isInteger(wantFrom) && wantFrom > 0) {
    fromBlock = wantFrom; fromSource = '命令行 --from';
  }
  if (!fromBlock) {
    try {
      const idx: any = JSON.parse(fs.readFileSync(chainIndexPath(home), 'utf8'));
      const dep = Number(idx?.deploymentBlock);
      if (Number.isInteger(dep) && dep > 0) { fromBlock = dep; fromSource = `链索引 deploymentBlock (${chainIndexPath(home)})`; }
    } catch { /* 读不到就报错 (不猜) */ }
  }
  if (!fromBlock) {
    console.error('[transfers] ✗ 说不出扫描起点 (既没有配置 transferScanFromBlock, 也读不到链索引的 deploymentBlock) → 拒绝用 0 起扫');
    process.exit(5);
  }
  if (!quiet) console.error(`[transfers] 扫描起点 fromBlock=${fromBlock} (来源: ${fromSource})`);

  const t0 = Date.now();
  const res = await syncTransfers({ home, fromBlock, log: quiet ? undefined : (m) => console.error(`[transfers]${m}`) });
  const state = readTransferIndex(home);
  const live = state.entries.filter((e) => !e.suspect);
  const inCount = live.filter((e) => e.direction === 'in').length;
  const outCount = live.filter((e) => e.direction === 'out').length;
  const inAtomic = live.filter((e) => e.direction === 'in').reduce((n, e) => n + BigInt(e.value), 0n).toString();

  if (!quiet) {
    console.error(
      `[transfers] ${res.ok ? (res.skipped ? '跳过' : '完成') : '失败'} · ${res.skipped || `扫 [${res.scanFrom}, ${res.scanTo}] ${res.pages} 页 · 命中 ${res.logsFound} 条 (新 ${res.inserted} · 重写 ${res.rewritten} · 去重 ${res.deduped} · 标 suspect ${res.markedSuspect})`}`,
    );
  }
  // 唯一 stdout 行 = 机器可读摘要 (给 refresh 脚本 grep)
  process.stdout.write(
    `[transfers] index=${transferIndexPath(home)} entries=${live.length} in=${inCount}(${inAtomic} 原子 ${state.tokenSymbol}) out=${outCount} ` +
    `lastSyncedBlock=${state.lastSyncedBlock} head=${state.headBlock} watch=${state.watchAddresses.length} ${Date.now() - t0}ms\n`,
  );
}

main().catch((e) => { console.error('[transfers] 失败:', e?.message || e); process.exit(1); });
