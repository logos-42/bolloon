/**
 * 链上自读复核 (不经过卖方): 直接从两条 RPC 拉这笔交易的原始日志, 逐字核对
 *   · 收据 status / 块号 / 确认数
 *   · USDC Transfer: from(买方) / to(payTo) / value
 *   · AuthorizationUsed: authorizer / nonce (逐字节与约定 v1 对上)
 *   · 用本店 itemId 复算 keccak256(itemId‖seq)[0..23] == nonce 里的哈希
 * 再调仓内只读函数 readOrderIdentityFromTx (给索引线的那个入口) 对一次。
 */
import { orderIdentityFromLogs, decodeOrderNonce, orderItemHash24, keccak256Hex, readOrderIdentityFromTx, ORDER_NONCE_TAG } from '../dist/agents/x402/order-identity.js';

const TX = process.argv[2];
const ITEM = 'info_efficode_spec_pack';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0xb4e9dCF79055A8232670ebb1c8c664Dff4E70066';
const BUYER = '0x6A3f797592BEd028F6AfD6DA82339C8e815480eb';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const AUTH_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
const RPCS = ['https://mainnet.base.org', 'https://base.drpc.org'];

const call = async (url, method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const topicAddr = (t) => '0x' + String(t).replace(/^0x/, '').slice(-40);

let latest = 0;
for (const url of RPCS) {
  const host = new URL(url).host;
  const [rc, bn] = await Promise.all([call(url, 'eth_getTransactionReceipt', [TX]), call(url, 'eth_blockNumber', [])]);
  latest = Number(BigInt(bn));
  if (!rc) { console.log(`${host}: 没有这笔交易的收据`); continue; }
  const conf = latest - Number(BigInt(rc.blockNumber)) + 1;
  console.log(`\n===== ${host} =====`);
  console.log(`status=${rc.status} (0x1=成功) block=${Number(BigInt(rc.blockNumber))} 确认数=${conf} logs=${rc.logs.length}`);

  const transfers = rc.logs.filter((l) => String(l.address).toLowerCase() === USDC.toLowerCase() && String(l.topics[0]).toLowerCase() === TRANSFER);
  const auths = rc.logs.filter((l) => String(l.address).toLowerCase() === USDC.toLowerCase() && String(l.topics[0]).toLowerCase() === AUTH_USED);
  console.log(`USDC Transfer 日志 ${transfers.length} 条 · AuthorizationUsed 日志 ${auths.length} 条`);
  for (const l of transfers) {
    const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]), val = BigInt(l.data).toString();
    console.log(`  Transfer from=${from} to=${to} value=${val}`);
    console.log(`    ${from.toLowerCase() === BUYER.toLowerCase() ? '✅' : '❌'} from == 买方钱包 ${BUYER}`);
    console.log(`    ${to.toLowerCase() === PAY_TO.toLowerCase() ? '✅' : '❌'} to == payTo ${PAY_TO}`);
  }
  for (const l of auths) {
    const authorizer = topicAddr(l.topics[1]);
    const nonce = String(l.topics[2]).toLowerCase();
    console.log(`  AuthorizationUsed authorizer=${authorizer}`);
    console.log(`                    nonce=${nonce}`);
    console.log(`    ${authorizer.toLowerCase() === BUYER.toLowerCase() ? '✅' : '❌'} authorizer == 买方钱包`);
    console.log(`    ${nonce.startsWith(ORDER_NONCE_TAG) ? '✅' : '❌'} nonce 前 4 字节 == ${ORDER_NONCE_TAG} ("BOL1")`);
    const d = decodeOrderNonce(nonce);
    console.log(`    解出: orderSeq=${d.orderSeq} itemIdHash=${d.itemIdHash}`);
    const mine = orderItemHash24(ITEM, d.orderSeq);
    console.log(`    独立复算 keccak256("${ITEM}"‖${d.orderSeq})[0..23] = ${mine}`);
    console.log(`    ${mine === d.itemIdHash ? '✅ 哈希逐字对得上 ⇒ 订单自证成立' : '❌ 哈希对不上'}`);
  }

  // 仓内只读入口 (索引线要用的那个)
  const r = await readOrderIdentityFromTx({ txHash: TX, itemIds: [ITEM], asset: USDC, rpcUrl: url });
  console.log(`  readOrderIdentityFromTx → ok=${r.ok} rpc=${r.rpc} block=${r.blockNumber} mode=${r.orderIdentity?.mode} selfAttested=${r.orderIdentity?.selfAttested}`);
  console.log(`  （纯函数同源复核: ${orderIdentityFromLogs(rc.logs, { itemIds: [ITEM], asset: USDC }).mode}）`);
}

console.log('\nkeccak256("") 自检 =', keccak256Hex(''), '(应为 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470)');
