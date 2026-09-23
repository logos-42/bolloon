/**
 * network-pulse-explorer.test.ts — 「交易标签可点击跳区块浏览器」的数据层单测 (2026-09-23)
 *
 * 背景 (隐私决定**变更一处**, 同日按 leo 拍板收窄):
 *   快照 `confirmed_activity[]` 的**链上索引行**追加 ——
 *     `tx_hash`    真交易哈希 (公开链上事实, 可核验)
 *     `explorer_tx` basescan/etherscan **交易**链接 (仅当该 chainId 有已知公网浏览器)
 *     `contract`    escrow **合约**地址 —— **只给索引/诊断, 页面不渲染、不生成合约链接**
 *   老字段 `tx` (sha256 短写) **保留不删** (老消费方不受影响)。**没有** `explorer_contract` 这个键。
 *   红线: 只放开这两种 0x 字符串; EOA/钱包地址、taskKey 原文、taskId、args 里的地址、DID、
 *   peer IP/multiaddr 一个都不许出现。
 *
 * 覆盖 (验收点名项):
 *   ① 8453 的行: tx_hash / contract / explorer_tx 齐全, 交易 URL 就是 basescan 形状
 *   ② 31337 (本机开发链) 的行: **没有** explorer_tx 键 (用 `'explorer_tx' in row === false` 断言,
 *      不是 undefined 判断 —— 键必须整个不存在, 页面才不会渲染出死链)
 *   ③ 老字段 `tx` (sha256:短写) 仍在 + 老 9 字段顺序逐字不变
 *   ④ 快照 JSON 全文里**不出现**任何 EOA 地址形态 (假地址注入测试)
 *   ⑤ 未知 chainId 不出链接; 拿不到 escrow 地址 / address 不是 escrow → 不给 contract
 *   ⑥ **合约不上页面**: 任何行都没有 explorer_contract 键, 快照全文没有 `/address/` 链接,
 *      explorer.ts 也不再提供地址链接构造器 (少一个能凭空造出合约链接的入口)
 */
import { describe, it, expect } from 'vitest';
import * as NP from '../agents/network-pulse.js';
import * as EX from '../agents/chain/explorer.js';

const NOW = Date.UTC(2026, 8, 23, 4, 0, 0);              // 2026-09-23T04:00:00Z
const TASK = '0x' + 'cd'.repeat(32);
const TX = '0x' + 'ab'.repeat(32);
/** 真 Base 主网 escrow 合约地址 (小写) —— 只用作夹具, 不是私钥/EOA */
const ESCROW = '0x4e689f98b64ac5b8ea947ac2aa93708cdd30f7ae';
/** ★ 买方·卖方 EOA (假地址, 但形态=真 EOA): 绝不许出现在快照里 */
const BUYER_EOA = '0xb4e9dcf79055a8232670ebb1c8c664dff4e70066';
const SELLER_EOA = '0x5ca9fb35d795b436f0ebddde7f25020c35ea8f9e';

const entry = (over: Partial<NP.ChainActivitySourceEntry> = {}): NP.ChainActivitySourceEntry => ({
  blockNumber: 51640623, logIndex: 339, eventName: 'EscrowCreatedV2',
  taskKey: TASK, txHash: TX, address: ESCROW, confirmations: 1, suspect: false, firstSeenAt: NOW,
  ...over,
});

const oneRow = (chainId: number, over: Partial<NP.ChainActivitySourceEntry> = {}, escrow: string | null = ESCROW) =>
  NP.buildConfirmedActivityFromIndex([entry(over)], { chainId, headBlock: 51640624, escrowAddress: escrow })[0];

describe('explorer · chainId → 浏览器白名单 (认不出的链没有链接)', () => {
  it('四条已知公网链各有 base URL, 本机/未知链 → null (不猜域名)', () => {
    expect(EX.explorerBaseUrl(8453)).toBe('https://basescan.org');
    expect(EX.explorerBaseUrl(84532)).toBe('https://sepolia.basescan.org');
    expect(EX.explorerBaseUrl(1)).toBe('https://etherscan.io');
    expect(EX.explorerBaseUrl(11155111)).toBe('https://sepolia.etherscan.io');
    expect(EX.explorerBaseUrl(31337)).toBeNull();              // 本机隔离开发链: 没有公网浏览器
    expect(EX.explorerBaseUrl(999999)).toBeNull();
    expect(EX.explorerBaseUrl(Number.NaN)).toBeNull();
  });

  it('URL 构造只认精确形状 (小写 0x + 正确位数); 非法输入 → null', () => {
    expect(EX.explorerTxUrl(8453, TX)).toBe(`https://basescan.org/tx/${TX}`);
    expect(EX.explorerTxUrl(31337, TX)).toBeNull();            // 没有浏览器 → 不给链接
    expect(EX.explorerTxUrl(8453, '0x1234')).toBeNull();       // 位数不对
    expect(EX.explorerTxUrl(8453, ESCROW)).toBeNull();         // 40 位不是交易哈希
    expect(EX.isExplorerUrl(`https://basescan.org/tx/${TX}`)).toBe(true);
    expect(EX.isExplorerUrl('https://evil.example/tx/' + TX)).toBe(false);
    expect(EX.isExplorerUrl(`http://basescan.org/tx/${TX}`)).toBe(false);   // 只认 https
    expect(EX.isExplorerUrl(`https://basescan.org/address/${ESCROW}`)).toBe(false);  // 合约链接不是我们的形状
  });

  it('⑥ 模块里**没有**地址链接构造器 (合约不上页面, 少一个能造链接的入口)', () => {
    expect('explorerAddressUrl' in EX).toBe(false);
  });
});

describe('confirmed_activity · 链上索引行新增 3 个可核验字段 (合约只留数据不上页面)', () => {
  it('① 8453 的行: tx_hash / contract / explorer_tx 齐全, 且是 basescan **交易**形状', () => {
    const r = oneRow(8453);
    expect(r.tx_hash).toBe(TX);
    expect(r.contract).toBe(ESCROW);                            // 数据里有 (索引/诊断用)
    expect(r.explorer_tx).toBe(`https://basescan.org/tx/${TX}`);
    // 页面/守卫共用的形状尺子
    expect(r.explorer_tx).toMatch(/^https:\/\/[a-z.]*basescan\.org\/tx\/0x[0-9a-f]{64}$/);
    expect(EX.isExplorerUrl(r.explorer_tx)).toBe(true);
    expect(EX.TX_HASH_RE.test(r.tx_hash!)).toBe(true);
    expect(EX.ADDRESS_RE.test(r.contract!)).toBe(true);
    // ⑥ 合约链接**不存在** (键都没有, 不是空串)
    expect('explorer_contract' in (r as any)).toBe(false);
  });

  it('② 31337 的行: **没有** explorer_tx 键 (不是 undefined, 是键不存在)', () => {
    const r = oneRow(31337) as any;
    expect('explorer_tx' in r).toBe(false);
    expect(r.explorer_tx).toBeUndefined();                     // 双保险: 也不能是 null / 空串
    // 本机链的公开事实仍在: 真 txHash + escrow 合约地址 (它们不依赖浏览器)
    expect(r.tx_hash).toBe(TX);
    expect(r.contract).toBe(ESCROW);
    expect(JSON.stringify(r)).not.toContain('explorer');       // 整行里连这个键名都不该出现
  });

  it('③ 老字段 tx (sha256 短写) 仍在 + 字段顺序冻结为「老 9 + 新 3」(向后兼容)', () => {
    const r = oneRow(8453) as any;
    expect(r.tx).toBe(NP.anonShortRef(TX, 'tx'));
    expect(r.tx).toMatch(/^sha256:[0-9a-f]{8}$/);
    expect(JSON.stringify(Object.keys(r))).toBe(JSON.stringify([
      'task', 'kind', 'state', 'chain_id', 'block', 'tx', 'confirmations', 'finality', 'at',
      'tx_hash', 'contract', 'explorer_tx',
    ]));
  });

  it('④ 快照 JSON 全文不出现任何 EOA 地址形态, 也不出现任何 /address/ 链接 (合约不上页面)', () => {
    // 恶意/脏索引: address 写卖方 EOA, args 里带买方 EOA —— 导出必须把它们全丢掉
    const dirty = entry({ address: SELLER_EOA } as any);
    (dirty as any).args = { buyer: BUYER_EOA, agent: SELLER_EOA, amount: '20000' };
    const rows = NP.buildConfirmedActivityFromIndex([dirty], { chainId: 8453, headBlock: 51640624, escrowAddress: ESCROW });
    const snap = NP.computeSnapshot([], {
      now: NOW,
      confirmedActivity: { source: 'chain-index', rows, gates: { confirmed: 1, finalized: 12 } },
    });
    const json = JSON.stringify(snap);
    for (const eoa of [BUYER_EOA, SELLER_EOA, BUYER_EOA.toUpperCase(), SELLER_EOA.toUpperCase()]) {
      expect(json).not.toContain(eoa);
      expect(json.toLowerCase()).not.toContain(eoa.slice(2, 12));      // 连片段也不行
    }
    expect(json).not.toContain('args');                                 // args 整块不导出
    expect(json).not.toContain(TASK);                                   // taskKey 原文不导出
    expect(json).not.toContain('explorer_contract');                    // 合约链接这个键不存在
    expect(json).not.toContain('/address/');                            // 整份快照里没有任何合约地址链接
    // 该行的 contract 因为对不上 escrow 而**不填** (宁缺勿错), 但 tx_hash 照常给
    expect(rows[0].contract).toBeUndefined();
    expect(rows[0].tx_hash).toBe(TX);
    // 老尺子 + 新尺子都干净
    expect(NP.assertNoPrivateFields(snap)).toEqual([]);
    expect(NP.auditPublicHexLeaks(snap)).toEqual([]);
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);
  });

  it('⑤ 未知 chainId / 拿不到 escrow 地址 → 不出链接; 白名单键外的 0x 一律算泄露', () => {
    const unknown = oneRow(999999) as any;
    expect('explorer_tx' in unknown).toBe(false);
    expect(unknown.tx_hash).toBe(TX);

    const noEscrow = oneRow(8453, {}, null) as any;             // 索引文件没记 escrow 地址
    expect('contract' in noEscrow).toBe(false);
    expect(noEscrow.explorer_tx).toBe(`https://basescan.org/tx/${TX}`);   // 交易链接不依赖合约地址

    const badEscrow: any = oneRow(8453, {}, 'not-an-address');
    expect('contract' in badEscrow).toBe(false);

    // 新尺子: 白名单键下合法 → 干净; 把卖方 EOA 塞进 address 键 → 立刻报出来
    expect(NP.auditPublicHexLeaks({ confirmed_activity: [oneRow(8453)] })).toEqual([]);
    expect(NP.auditPublicHexLeaks({ address: SELLER_EOA }).join(' ')).toContain('泄露');
    expect(NP.auditPublicHexLeaks({ x: { y: SELLER_EOA } }).length).toBe(1);
    // 白名单键下形状不对 (拿短哈希冒充 tx_hash) 也算问题
    expect(NP.auditPublicHexLeaks({ tx_hash: '0x1234' }).length).toBe(1);
    expect(NP.auditPublicHexLeaks({ tx_hash: TX }).length).toBe(0);
    // explorer_contract 已不在白名单: 谁把它塞回来都算泄露
    expect(NP.auditPublicHexLeaks({ explorer_contract: `https://basescan.org/address/${ESCROW}` }).length).toBe(1);
    expect(NP.snapshotConsistencyIssues({ ...NP.computeSnapshot([], { now: NOW }), address: SELLER_EOA } as any).join(' '))
      .toContain('泄露');
  });

  it('脉冲降级行 (没有链上事实) 一个新字段都不加 —— 不带链上事实就不给链上字段', () => {
    const rows: any = NP.buildConfirmedActivityFromEvents([{
      type: 'task_posted', bucket: '1', occurredAt: NOW, sourceProof: 'node-1', taskProof: 'abcdef0123456789',
    } as any]);
    const keys = Object.keys(rows[0]);
    for (const k of ['tx_hash', 'contract', 'explorer_tx']) expect(keys).not.toContain(k);
    expect(JSON.stringify(rows)).not.toContain('explorer');
  });
});

describe('端到端: 真索引文件形状 → 快照里的行带真 txHash 与 basescan 交易链接', () => {
  it('resolveConfirmedActivity: 索引文件的 chainId + escrowAddress 决定字段有没有 (不猜)', async () => {
    const file = {
      chainId: 8453, escrowAddress: ESCROW, headBlock: 51640624,
      confirmations: { confirmed: 1, finalized: 12 }, entries: [entry()],
    };
    const res = await NP.resolveConfirmedActivity({
      events: [], now: NOW,
      readIndex: () => file,
    });
    expect(res.source).toBe('chain-index');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].tx_hash).toBe(TX);
    expect(res.rows[0].explorer_tx).toBe(`https://basescan.org/tx/${TX}`);
    expect('explorer_contract' in (res.rows[0] as any)).toBe(false);

    // 同一批条目, 链换成 31337 → 链接消失 (行数/其它字段不变)
    const local = await NP.resolveConfirmedActivity({
      events: [], now: NOW,
      readIndex: () => ({ ...file, chainId: 31337, escrowAddress: ESCROW }),
    });
    expect(local.rows).toHaveLength(1);
    expect('explorer_tx' in (local.rows[0] as any)).toBe(false);
    expect(local.rows[0].tx_hash).toBe(TX);

    // 索引文件的 escrowAddress 被人改歪 → 合约字段整个不填 (宁缺勿错), 交易链接照旧
    const drifted = await NP.resolveConfirmedActivity({
      events: [], now: NOW,
      readIndex: () => ({ ...file, escrowAddress: SELLER_EOA }),
    });
    expect('contract' in (drifted.rows[0] as any)).toBe(false);
    expect(drifted.rows[0].explorer_tx).toBe(`https://basescan.org/tx/${TX}`);
    expect(JSON.stringify(drifted.rows)).not.toContain(SELLER_EOA);
  });
});
