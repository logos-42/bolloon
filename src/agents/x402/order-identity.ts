/**
 * order-identity.ts — x402 直付的**订单标识** (约定 v1, 非索引标签 `BOL1`)
 *
 * ── 要解决的事 ───────────────────────────────────────────────────────────────
 * 普通 USDC 转账在链上只是 `Transfer(from, to, value)` —— **没有任何"买的是哪件东西"的痕迹**。
 * 于是"公示区只认链上事实"这条口径下, 一笔转账与一件商品之间**对不上号**:
 * 事后谁也没法从链上证明这笔钱是付给哪件物品的。
 *
 * EIP-3009 (`transferWithAuthorization`) 给了一个免费的把手: 授权里的 `nonce` 是**付款方自选
 * 的 32 字节**, 且会在同一条交易的 `AuthorizationUsed(authorizer, nonce)` 事件里**原样记上链**。
 * 所以只要把"订单身份"编进这 32 字节, "谁付 · 多少 · 给谁 · 买什么" 就在**同一笔交易里自证**。
 *
 * ── 约定 v1 原文 (字节级, 不可自行发挥) ──────────────────────────────────────
 * ```
 * nonce (32 字节) =
 *   偏移 0  .. 3   : 标签  0x424f4c31  = ASCII "BOL1"      (4 字节, 大端按字节序)
 *   偏移 4  .. 7   : orderSeq, uint32 大端                (4 字节; 同一买家重复买同件时递增)
 *   偏移 8  .. 31  : hash24 = keccak256( utf8(itemId) ‖ uint256be(orderSeq) )[0..23]  (24 字节)
 * ```
 * 其中 `uint256be(orderSeq)` = orderSeq 的 32 字节大端表示; `[0..23]` = 取前 24 字节。
 *
 * **为什么不是"后 28 字节 = keccak256(itemId‖orderSeq) 截断 28 字节"** (这是本约定唯一一处
 * 与最初口头描述的差异, 必须写清而不是含糊过去): 那样编出来的 nonce 里**没有 orderSeq**,
 * 而卖方要判"自证"必须**自己复算** `keccak256(itemId‖orderSeq)` —— 没有 orderSeq 就复算不了
 * (只能对 orderSeq 做暴力枚举, 既有假阳性风险又不确定)。所以 v1 把 4 字节 orderSeq 显式编进去,
 * 哈希只占 24 字节。安全强度: 24 字节 = 192 bit 抗碰撞, 对"订单标识"这个用途远远够用。
 *
 * ── 去重语义 (必须写在实现旁边, 否则用错就是"自以为自证了") ────────────────
 * · EIP-3009 的 `(authorizer, nonce)` **只能用一次** (链上 `authorizationState` 置位, 再用必 revert)。
 *   ⇒ **同一买家重复买同一件** 必须换 `orderSeq` (否则第二笔必 revert, 不是"卖方不认"是**链不认**)。
 * · **不同买家**可以用**相同 nonce** —— 去重键是 `(authorizer, nonce)`, authorizer 不同就不冲突。
 * · 所以 `(payer, nonce)` 才是唯一键; `nonce` 单独**不是**唯一键。
 *
 * ── 零依赖红线 ──────────────────────────────────────────────────────────────
 * 本模块要能在**没有 node_modules 的服务器**上跑 (ECS 只放编译产物 `lib/x402/*.js`) ——
 * 所以 keccak-256 是**本文件内的纯 TS 实现** (node:crypto 只有 sha3-256, 与 keccak-256 的
 * padding 不同, 不能替代), **绝不 import ethers**。正确性靠测试与 ethers 对表 (见
 * `src/test/x402-order-identity.test.ts`) + 真链 DOMAIN_SEPARATOR 交叉核对。
 */

import * as crypto from 'crypto';

// ────────────────────────────────────────────────────────────── 常量 (唯一事实源)

export const ORDER_IDENTITY_PROTOCOL = 'bolloon-x402-order-identity/1';

/** 标签: ASCII "BOL1" (Bolloon order 1) */
export const ORDER_NONCE_TAG_ASCII = 'BOL1';
export const ORDER_NONCE_TAG = '0x424f4c31';
export const ORDER_TAG_BYTES = 4;
export const ORDER_SEQ_BYTES = 4;
export const ORDER_HASH_BYTES = 24;

/**
 * EIP-3009 `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` 的 topic0。
 * ★ 与正文里那个实测值必须一致 (本文件只是抄一份常量, 不复制逻辑)。
 *   非索引参数无; 两个参数都是 indexed ⇒ authorizer 在 topics[1], nonce 在 **topics[2]**。
 */
export const EIP3009_AUTHORIZATION_USED_TOPIC0 =
  '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';

/** `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)` */
export const EIP3009_TRANSFER_WITH_AUTHORIZATION_SELECTOR = '0xe3ee160e';

/** EIP-712 域类型串 (USDC / FiatToken 家族用的是这个标准串) */
export const EIP712_DOMAIN_TYPEHASH_STR =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

/** EIP-3009 授权结构类型串 */
export const EIP3009_TYPEHASH_STR =
  'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)';

/**
 * USDC (Base) 的 EIP-712 domain。
 * ★ 实测 (2026-09-29, 两条 RPC 一致): `name()` 回 **"USD Coin"**, `version()` 回 "2",
 *   `DOMAIN_SEPARATOR()` = 0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f。
 *   ⇒ **"USDC" 是错的** (`name()` 是 ERC20 名, EIP-712 域用的是它, 不是符号)。
 *   用错的 name 签出来的授权链上必 revert (token 侧 ecrecover 结果对不上 authorizer) ——
 *   这不是"可能不兼容", 是**必失败**。买方 CLI 因此**不写死**: 见 `resolveTokenDomain()`。
 */
export const USDC_EIP712_NAME_CANDIDATES = ['USD Coin', 'USDC', 'USDC.e', 'Bridged USDC (Base)'];
export const USDC_EIP712_VERSION_CANDIDATES = ['2', '1'];

/** DOMAIN_SEPARATOR() / name() / version() 的 4 字节 selector (只读探针用) */
export const SELECTOR_DOMAIN_SEPARATOR = '0x3644e515';
export const SELECTOR_NAME = '0x06fdde03';
export const SELECTOR_VERSION = '0x54fd4d50';

// ────────────────────────────────────────────────────────────── keccak-256 (纯 TS, 零依赖)

const MASK64 = (1n << 64n) - 1n;

/** Keccak-f[1600] 轮常数 (24 轮) */
const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** ρ 旋转偏移 r[x][y] (x = 列, y = 行) */
const RHO: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl64(v: bigint, n: number): bigint {
  if (n === 0) return v & MASK64;
  const k = BigInt(n);
  return ((v << k) | (v >> (64n - k))) & MASK64;
}

function keccakF(a: bigint[]): void {
  const c = new Array<bigint>(5);
  const d = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    // θ
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d[x];
    // ρ + π: B[y][(2x+3y) mod 5] = rot(A[x][y], r[x][y])
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(a[x + 5 * y], RHO[x][y]);
      }
    }
    // χ
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[x + 5 * y] = b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y] & MASK64) & b[((x + 2) % 5) + 5 * y]);
      }
    }
    // ι
    a[0] ^= RC[round];
  }
}

const KECCAK_RATE = 136;   // 1088 bit = keccak-256 的 rate

/**
 * Keccak-256 (以太坊用的那个, padding = 0x01 … 0x80; **不是** NIST SHA3-256 的 0x06)。
 * 返回 32 字节。
 */
export function keccak256(input: Uint8Array | string): Uint8Array {
  const msg = typeof input === 'string' ? Buffer.from(input, 'utf-8') : Buffer.from(input);
  const a = new Array<bigint>(25).fill(0n);

  // 吸收: 每 136 字节一块
  const padded = (() => {
    const padLen = KECCAK_RATE - (msg.length % KECCAK_RATE);
    const pad = Buffer.alloc(padLen);
    pad[0] = 0x01;
    pad[padLen - 1] |= 0x80;
    return Buffer.concat([msg, pad]);
  })();

  for (let off = 0; off < padded.length; off += KECCAK_RATE) {
    for (let i = 0; i < KECCAK_RATE / 8; i++) {
      a[i] ^= padded.readBigUInt64LE(off + i * 8);
    }
    keccakF(a);
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(a[i] & MASK64, i * 8);
  return out;
}

/** keccak256 → 0x + 64 hex */
export function keccak256Hex(input: Uint8Array | string): string {
  return `0x${Buffer.from(keccak256(input)).toString('hex')}`;
}

// ────────────────────────────────────────────────────────────── 约定 v1: 编 / 解 nonce

function hexToBytes(hex: string): Buffer {
  const h = String(hex || '').replace(/^0x/, '');
  return Buffer.from(h.length % 2 ? `0${h}` : h, 'hex');
}
function bytesToHex(b: Uint8Array): string {
  return `0x${Buffer.from(b).toString('hex')}`;
}
function uint256be(n: number | bigint): Uint8Array {
  const b = Buffer.alloc(32);
  b.writeBigUInt64BE(BigInt(n) & MASK64, 24);
  return b;
}

/**
 * 订单哈希: keccak256( utf8(itemId) ‖ uint256be(orderSeq) ) 的前 24 字节。
 * 卖方复算的就是这一串 —— 拿自己店里的 itemId + 从 nonce 里读出的 orderSeq 算一遍比。
 */
export function orderItemHash24(itemId: string, orderSeq: number | bigint): string {
  const h = keccak256(Buffer.concat([Buffer.from(String(itemId), 'utf-8'), uint256be(orderSeq)]));
  return bytesToHex(h.subarray(0, ORDER_HASH_BYTES));
}

/** 按约定 v1 编 nonce (32 字节 hex) */
export function computeOrderNonce(itemId: string, orderSeq: number | bigint = 0): string {
  const seq = BigInt(orderSeq);
  if (seq < 0n || seq > 0xffffffffn) throw new Error(`orderSeq 超出 uint32 范围: ${seq}`);
  const tag = hexToBytes(ORDER_NONCE_TAG);
  const seqBytes = Buffer.alloc(ORDER_SEQ_BYTES);
  seqBytes.writeUInt32BE(Number(seq), 0);
  const hashBytes = hexToBytes(orderItemHash24(itemId, seq));
  if (hashBytes.length !== ORDER_HASH_BYTES) throw new Error('内部错误: 哈希长度不为 24 字节');
  return bytesToHex(Buffer.concat([tag, seqBytes, hashBytes]));
}

export type OrderNonceShape = 'ok' | 'no-tag' | 'wrong-length' | 'not-hex';

export interface DecodedOrderNonce {
  /** 原文 (小写 0x + 64 hex) */
  nonce: string;
  shape: OrderNonceShape;
  /** 前 4 字节 == "BOL1" */
  tagPresent: boolean;
  /** 标签原文 (只有 tagPresent 时才是 "BOL1") */
  tag: string | null;
  /** 从字节 4..7 读出的 orderSeq (tag 在才算) */
  orderSeq: number | null;
  /** 从字节 8..31 读出的 itemId 哈希片段 (tag 在才算) */
  itemIdHash: string | null;
  detail: string;
}

/** 解 nonce。**只负责解, 不判对错** —— 判"是不是本店 item"用 `matchOrderNonce`。 */
export function decodeOrderNonce(nonce: string): DecodedOrderNonce {
  const raw = String(nonce || '').trim().toLowerCase();
  const shell = { nonce: raw, shape: 'not-hex' as OrderNonceShape, tagPresent: false, tag: null, orderSeq: null, itemIdHash: null };
  if (!/^0x[0-9a-f]{64}$/.test(raw)) {
    return { ...shell, detail: `nonce 形状不对 (要 32 字节 hex): ${raw.slice(0, 42)}` };
  }
  const bytes = hexToBytes(raw);
  if (bytes.length !== 32) return { ...shell, shape: 'wrong-length', detail: `nonce 长度 ${bytes.length} 字节, 不是 32` };
  const tagHex = bytesToHex(bytes.subarray(0, ORDER_TAG_BYTES));
  if (tagHex !== ORDER_NONCE_TAG) {
    return {
      ...shell, shape: 'no-tag',
      detail: `nonce 前 4 字节 ${tagHex} ≠ ${ORDER_NONCE_TAG} ("BOL1") —— 这不是按约定 v1 编的订单标识`,
    };
  }
  const orderSeq = bytes.readUInt32BE(ORDER_TAG_BYTES);
  const itemIdHash = bytesToHex(bytes.subarray(ORDER_TAG_BYTES + ORDER_SEQ_BYTES));
  return {
    nonce: raw, shape: 'ok', tagPresent: true, tag: ORDER_NONCE_TAG_ASCII, orderSeq, itemIdHash,
    detail: `BOL1 订单标识: orderSeq=${orderSeq}, itemIdHash=${itemIdHash.slice(0, 18)}…`,
  };
}

/** 用**本店真实 item** 复算哈希并比对。返回命中的 itemId 列表 (正常情况下 0 或 1 个)。 */
export function matchOrderNonce(nonce: string | DecodedOrderNonce, itemIds: string[]): string[] {
  const d = typeof nonce === 'string' ? decodeOrderNonce(nonce) : nonce;
  if (d.shape !== 'ok' || d.orderSeq === null) return [];
  const hits: string[] = [];
  for (const id of itemIds) {
    if (orderItemHash24(id, d.orderSeq) === d.itemIdHash) hits.push(id);
  }
  return hits;
}

// ────────────────────────────────────────────────────────────── EIP-712 (纯 keccak, 零依赖)

/**
 * EIP-712 域分隔符: keccak256( abi.encode(typehash, keccak256(name), keccak256(version), chainId, verifyingContract) )
 * 用来跟链上 `DOMAIN_SEPARATOR()` 对比 —— **签名用的域必须与链上一致**, 一致了才敢签。
 */
export function eip712DomainSeparator(d: {
  name: string; version: string; chainId: number | bigint; verifyingContract: string;
}): string {
  const word = (b: Uint8Array) => Buffer.from(b);
  const nameHash = word(keccak256(Buffer.from(d.name, 'utf-8')));
  const versionHash = word(keccak256(Buffer.from(d.version, 'utf-8')));
  const chain = Buffer.alloc(32);
  chain.writeBigUInt64BE(BigInt(d.chainId) & MASK64, 24);
  const addr = Buffer.alloc(32);
  Buffer.from(String(d.verifyingContract).replace(/^0x/, '').toLowerCase(), 'hex').copy(addr, 12);
  const encoded = Buffer.concat([
    word(keccak256(Buffer.from(EIP712_DOMAIN_TYPEHASH_STR, 'utf-8'))),
    nameHash, versionHash, chain, addr,
  ]);
  return `0x${Buffer.from(keccak256(encoded)).toString('hex')}`;
}

/** keccak256(EIP712Domain(...)) —— 类型串哈希 (便于外部核对) */
export function eip712DomainTypehash(): string {
  return keccak256Hex(EIP712_DOMAIN_TYPEHASH_STR);
}

/** keccak256(TransferWithAuthorization(...)) —— EIP-3009 结构类型哈希 */
export function eip3009Typehash(): string {
  return keccak256Hex(EIP3009_TYPEHASH_STR);
}

// ────────────────────────────────────────────────────────────── 日志 → 订单标识 (纯函数, 只读)

export type OrderIdentityMode =
  | 'self-attested'          // 标签在 + 哈希对得上本店 item = 订单自证成功
  | 'item-mismatch'          // 标签在, 但哈希对不上本店任何 item (可能买的是别人家的)
  | 'not-bol1'               // 有 AuthorizationUsed, 但 nonce 不是 v1 约定 (别的客户端/随机 nonce)
  | 'no-authorization-used'  // 普通转账: 链上根本没有订单身份可读
  | 'malformed-nonce';       // 有事件但 nonce 形状不对 (不该发生; 出现了就是有人在构造脏数据)

export interface OrderIdentity {
  protocol: string;
  mode: OrderIdentityMode;
  /** true = 只有这一种情况才算"订单自证成功" */
  selfAttested: boolean;
  /** 降级成"直转(无订单标识)"? = !selfAttested */
  degraded: boolean;
  /** 交易里读到的 nonce (没有事件时为 null) */
  nonce: string | null;
  tagPresent: boolean;
  tag: string | null;
  orderSeq: number | null;
  /** nonce 里带的 itemId 哈希 (24 字节) */
  itemIdHash: string | null;
  /** 付款方 (AuthorizationUsed.authorizer; 无事件时取 Transfer.from 兜底) */
  payer: string | null;
  /** 本店真实 item 里哈希对上的 (正常 0 或 1 个) */
  matchedItemIds: string[];
  /** 本店参与比对的所有 itemId (审计用: "拿来比过哪些"是事实的一部分) */
  checkedItemIds: string[];
  /** 人话结论 (直接可上屏/可进回执) */
  detail: string;
}

function addrOf(topic: string): string {
  const h = String(topic || '').replace(/^0x/, '').toLowerCase();
  return h.length >= 40 ? `0x${h.slice(-40)}` : '';
}

/**
 * ★ 唯一入口 (纯函数): 给一笔交易的**日志数组**, 返回订单标识。
 *
 * 判据顺序 (缺 AuthorizationUsed 就是降级, 绝不假装自证):
 *   ① 在 `asset` 合约的日志里找 `AuthorizationUsed`, 取 (authorizer, nonce)
 *   ② nonce 解出来不是 "BOL1" → `not-bol1` (有授权事实, 但没带订单标识)
 *   ③ 是 "BOL1" → 拿本店 itemId + 解出的 orderSeq 复算哈希: 对上 → `self-attested`; 对不上 → `item-mismatch`
 *   ④ 一条都没有 → `no-authorization-used` (普通转账, 链上没有订单身份)
 *
 * 只读: 不看余额、不写盘、不发交易。
 */
export function orderIdentityFromLogs(
  logs: Array<{ address?: string; topics?: string[]; data?: string }> | undefined | null,
  opts: { itemIds: string[]; asset?: string; payerHint?: string | null },
): OrderIdentity {
  const itemIds = (opts.itemIds || []).map(String).filter(Boolean);
  const base = {
    protocol: ORDER_IDENTITY_PROTOCOL,
    nonce: null as string | null, tagPresent: false, tag: null as string | null,
    orderSeq: null as number | null, itemIdHash: null as string | null,
    payer: (opts.payerHint ? String(opts.payerHint).toLowerCase() : null) as string | null,
    matchedItemIds: [] as string[], checkedItemIds: itemIds,
  };
  const wantAsset = opts.asset ? String(opts.asset).toLowerCase() : '';
  const list = Array.isArray(logs) ? logs : [];

  let found: { payer: string; nonce: string } | null = null;
  for (const l of list) {
    if (wantAsset && String(l?.address || '').toLowerCase() !== wantAsset) continue;
    const topics: string[] = Array.isArray(l?.topics) ? l!.topics! : [];
    // 非索引参数无 ⇒ authorizer 在 topics[1], nonce 在 topics[2]
    if (String(topics[0] || '').toLowerCase() !== EIP3009_AUTHORIZATION_USED_TOPIC0) continue;
    if (topics.length < 3) continue;
    found = { payer: addrOf(topics[1]), nonce: String(topics[2] || '').toLowerCase() };
    break;
  }

  if (!found) {
    return {
      ...base, mode: 'no-authorization-used', selfAttested: false, degraded: true,
      detail: '直转(无订单标识): 这笔交易的日志里没有 EIP-3009 AuthorizationUsed 事件 ⇒ 链上只有「谁付·多少·给谁」, 读不出买的是哪件东西',
    };
  }

  const decoded = decodeOrderNonce(found.nonce);
  // 形状对但没有 BOL1 标签 = 别的客户端/随机 nonce (有授权事实, 没有订单标识) —— 这才是"降级", 不是脏数据
  if (decoded.shape === 'no-tag') {
    return {
      ...base, mode: 'not-bol1', selfAttested: false, degraded: true,
      nonce: decoded.nonce, payer: found.payer || base.payer,
      detail: `有 AuthorizationUsed (nonce=${decoded.nonce.slice(0, 18)}…) 但这个 nonce 不是约定 v1 编的 (前 4 字节不是 ${ORDER_NONCE_TAG_ASCII}/${ORDER_NONCE_TAG}) ⇒ 链上读不出订单身份, 如实降级为「直转(无订单标识)」`,
    };
  }
  if (decoded.shape !== 'ok') {
    return {
      ...base, mode: 'malformed-nonce', selfAttested: false, degraded: true,
      nonce: decoded.nonce, payer: found.payer || base.payer,
      detail: `有 AuthorizationUsed 但 nonce 不可解: ${decoded.detail}`,
    };
  }
  const matched = matchOrderNonce(decoded, itemIds);
  const common = {
    ...base, nonce: decoded.nonce, tagPresent: true, tag: decoded.tag,
    orderSeq: decoded.orderSeq, itemIdHash: decoded.itemIdHash,
    payer: found.payer || base.payer, matchedItemIds: matched,
  };
  if (matched.length === 0) {
    return {
      ...common, mode: 'item-mismatch', selfAttested: false, degraded: true,
      detail: `nonce 带了 BOL1 订单标识, 但 keccak256(itemId‖orderSeq=${decoded.orderSeq}) 与本店 item (${itemIds.join(', ') || '无'}) 都对不上 ⇒ 如实降级为「直转(无订单标识)」, 不假装自证`,
    };
  }
  return {
    ...common, mode: 'self-attested', selfAttested: true, degraded: false,
    detail: `订单自证成功: nonce = BOL1 ‖ orderSeq=${decoded.orderSeq} ‖ keccak256(itemId‖seq)[0..23] —— 与本店 item「${matched.join(', ')}」复算哈希一致`,
  };
}

// ────────────────────────────────────────────────────────────── 只读链路: 从 txHash 自读 (给索引线用)

const TXHASH_RE = /^0x[0-9a-fA-F]{64}$/;

async function rpcCall(url: string, method: string, params: unknown[], fetchImpl: typeof fetch, timeoutMs: number): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json();
    if (j?.error) throw new Error(`RPC error: ${String(j?.error?.message || 'unknown').slice(0, 120)}`);
    return j?.result;
  } finally { clearTimeout(timer); }
}

export interface OrderIdentityReadResult {
  ok: boolean;
  txHash: string;
  /** 读的是哪条 RPC (主机名) */
  rpc?: string;
  blockNumber?: number;
  orderIdentity?: OrderIdentity;
  error?: string;
}

/**
 * ★ 只读: 给定一笔交易, 从**同一条交易的日志**里取 nonce → 返回 `orderIdentity`。
 * 给公示/索引那条线用 (它自己按 txHash 扫到一笔 USDC 转账后, 调这个函数判"有没有订单身份")。
 *
 * 不做任何核验/交付/写盘 —— 索引线拿到的只是**链上事实的投影**, 不是"卖方承认过"。
 * (两者含义不同: 自证成功 = 这笔付款的 nonce 声明了本店某件 item; 卖方是否真的交付过
 *  要另看卖方台账 —— `GET /api/x402/seller/summary`。)
 */
export async function readOrderIdentityFromTx(input: {
  txHash: string;
  itemIds: string[];
  asset?: string;
  rpcUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OrderIdentityReadResult> {
  const txHash = String(input.txHash || '').trim();
  if (!TXHASH_RE.test(txHash)) return { ok: false, txHash, error: `txHash 形状不对 (要 0x + 64 hex)` };
  const f = input.fetchImpl ?? fetch;
  let host = 'invalid-url';
  try { host = new URL(input.rpcUrl).host; } catch { /* 保持 invalid-url */ }
  try {
    const receipt = await rpcCall(input.rpcUrl, 'eth_getTransactionReceipt', [txHash], f, input.timeoutMs ?? 12_000);
    if (!receipt) return { ok: false, txHash, rpc: host, error: '链上还没有这个 txHash 的 receipt (未打包/不存在)' };
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    const orderIdentity = orderIdentityFromLogs(logs, { itemIds: input.itemIds, asset: input.asset });
    return {
      ok: true, txHash, rpc: host,
      blockNumber: Number(BigInt(receipt.blockNumber ?? '0x0')),
      orderIdentity,
    };
  } catch (e: any) {
    return { ok: false, txHash, rpc: host, error: `RPC 读不到: ${String(e?.message || e).slice(0, 160)}` };
  }
}

// ────────────────────────────────────────────────────────────── 其它小工具 (给买方 CLI 共用)

/** 订单标识的短写 (日志/回显用) */
export function shortOrderIdentity(o: OrderIdentity | null | undefined): string {
  if (!o) return 'none';
  if (o.mode === 'self-attested') return `BOL1/seq=${o.orderSeq}/item=${o.matchedItemIds[0] || '?'}`;
  return `${o.mode}${o.tagPresent ? `/seq=${o.orderSeq}` : ''}`;
}

/** 稳定摘要 (台账/回执里只放摘要, 不放原文也行; 这里给的是 sha256 短写) */
export function orderIdentityDigest(o: OrderIdentity | null | undefined): string {
  if (!o) return 'none';
  const s = JSON.stringify({
    mode: o.mode, nonce: o.nonce, orderSeq: o.orderSeq, itemIdHash: o.itemIdHash,
    matched: [...o.matchedItemIds].sort(), payer: o.payer,
  });
  return `sha256:${crypto.createHash('sha256').update(s).digest('hex')}`;
}
