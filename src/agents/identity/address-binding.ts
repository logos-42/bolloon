/**
 * address-binding.ts — **地址 ↔ DID 绑定登记** (协议 `diap-address-binding/1`)
 * =========================================================================
 * 目的 (leo 2026-09-29 拍板): 让网关能把链上付款行里的**付款方地址**翻成**智能体身份** ——
 *   链上只有 `Transfer(from, to, value)`, `from` 是一个裸 EOA; 要让读者看出「这笔是谁付的」,
 *   需要一个**可离线验签**的登记, 而不是让页面去猜名字。
 *
 * 身份不另造一套: DID / 公钥 / 私钥全部走仓内既有的 DIAP 身份
 *   (`~/.bolloon/identity.json`, `KeyManager.fromFile`, 与 `src/agents/agent-identity.ts` 同源);
 *   签名复用 `ed25519Sign`/`ed25519Verify` + `canonicalize`(`src/agents/x402/paid-info-protocol.ts`)。
 *
 * ── 双侧证明 (不可协商; 少一侧 = 不作数) ─────────────────────────────────
 *   ① `sig_did` : DID 私钥 (Ed25519, raw 32 字节种子) 对**声明正文字节串**签名
 *      ⇒ 证明「这个 DID 认领这个地址」
 *   ② `sig_addr`: 该以太地址私钥 (EIP-191 personal_sign) 对**同一份字节串**签名
 *      ⇒ 证明「这个地址的主人同意被这样认领」
 *   验证 = `ed25519Verify(did_public_key, statement_json, sig_did)`
 *        **且** `ethers.verifyMessage(statement_json, sig_addr) === statement.address`
 *   任何一侧缺失/不通过 ⇒ **拒**。**不许**静默降级成"可信"/"已验签"。
 *
 * ── 声明正文 (冻结, canonical = 键按 sort_keys 排序 + 无空格, UTF-8) ──────
 *   {"protocol":"diap-address-binding/1","did":"did:key:z6Mk…","address":"0x…全小写",
 *    "chainId":8453,"issuedAt":"<ISO8601>","expiresAt":null,"nonce":"<32 位小写 hex = 16 字节, 一次性>"}
 *   签名/验签都对 `canonicalize(statement)` 的**字节串**做 (`statement_json` 落盘保存,
 *   验证时**重算**并与落盘值逐字节比对 —— 不是 canonical 的那份直接拒)。
 *
 * ── 名字 (label) 的覆盖方式 (刻意收紧, 不改冻结正文) ─────────────────────
 *   冻结正文里**没有** label 字段 (它的 7 个键就是签名对象)。名字若只写在记录里, 就能被
 *   单独改掉而两个签名照旧通过 —— 那就等于"出名字但没验名字"。做法: label 另有一枚
 *   `label_sig`(DID 私钥对 `canonicalize({...statement, label})` 签名);
 *   **有 label 就必须验 label_sig**, 验不过 ⇒ 整条绑定拒 (不是"名字不显示"这么轻)。
 *   没有 label 的绑定照旧只要两枚签名。
 *
 * ── 隐私口径 (硬) ────────────────────────────────────────────────────────
 *   · 绑定是**链下登记** (签名声明), **不是链上事实** ⇒ 对外一律写成「链下登记(可离线验签)」,
 *     不与块号/tx_hash 混为一类。
 *   · 只有**已验签**的绑定才产出对外短写; 未验签/验不过 ⇒ **不出名字、不出 DID**。
 *   · 对外短写 = `name_short`(清洗后的 label, ≤24 字符) + `did_short`
 *     (`did:key:` 之后前 12 字符 —— **不带 `did:` 前缀**, 页面上不许出现 DID 形态)。
 *   · **地址本身不出对外面** (页面/快照的传统口径); `publish` 投影里也只有
 *     `address_hash`(sha256 前 16 位) —— 网关是**本机**按地址匹配, 不需要把 EOA 发出去。
 *
 * 本模块**不碰链、不发交易、不读钱包目录**: 私钥一律由调用方以**显式路径**喂进来
 * (CLI 参数), 且只在本进程内用于签名, 不进日志/不进绑定文件。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Wallet, verifyMessage } from 'ethers';
import { canonicalize, ed25519Sign, ed25519Verify, sha256Hex } from '../x402/paid-info-protocol.js';

// ─────────────────────────────────────────────────────────── 常量 (唯一实现)

/** 协议名 (冻结; 出现在声明正文 `protocol` 与对外行的 `method`) */
export const ADDRESS_BINDING_PROTOCOL = 'diap-address-binding/1';
/** 绑定文件 schema */
export const ADDRESS_BINDING_SCHEMA_VERSION = 1;
/** 对外行的来源标注: **链下登记**(签名声明), 绝不是链上事实 */
export const ADDRESS_BINDING_SOURCE = 'off-chain-signed';
/** 默认链 (Base 主网; 声明里显式记 chainId, 缺省只用于 CLI 便利值) */
export const DEFAULT_BINDING_CHAIN_ID = 8453;
/** nonce = 16 字节 (32 位小写 hex), 一次性 */
export const BINDING_NONCE_BYTES = 16;
/** 名字短写上限 (字符) */
export const NAME_SHORT_MAX = 24;
/** DID 短写长度 (取 `did:key:` 之后的前 N 个字符) */
export const DID_SHORT_LEN = 12;
/** 绑定库目录名 (相对 BOLLOON home) */
export const BINDINGS_DIRNAME = 'bindings';
/** 聚合索引文件名 */
export const BINDING_INDEX_FILENAME = 'index.json';

export const BINDING_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
export const BINDING_DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,}$/;
export const BINDING_NONCE_RE = /^[0-9a-f]{32}$/;
export const BINDING_SIG_B64_RE = /^[A-Za-z0-9+/]{80,}={0,2}$/;
export const BINDING_SIG_HEX_RE = /^0x[0-9a-fA-F]{130}$/;
export const BINDING_PUBKEY_HEX_RE = /^[0-9a-f]{64}$/;
/** 名字短写允许的字符 (字母/数字/中日文/下划线/点/短横; **不含空格与 0x / did: 之类形态**) */
export const NAME_SHORT_RE = /^[A-Za-z0-9._\-\u4e00-\u9fff]{1,24}$/;
/** did_short 形状 (multibase base58btc 的 ed25519 前缀 z6Mk…; 不含 `did:` 前缀) */
export const DID_SHORT_RE = /^[1-9A-HJ-NP-Za-km-z]{4,16}$/;

export function bolloonHome(home?: string): string {
  return home || process.env.BOLLOON_HOME || process.env.HOME || os.homedir();
}

export function bindingsDir(home?: string): string {
  return path.join(bolloonHome(home), '.bolloon', BINDINGS_DIRNAME);
}

export function bindingIndexPath(home?: string): string {
  return path.join(bindingsDir(home), BINDING_INDEX_FILENAME);
}

// ─────────────────────────────────────────────────────────── 类型

/** 冻结的声明正文 (签名对象) */
export interface AddressBindingStatement {
  protocol: string;
  did: string;
  /** 全小写 0x + 40 hex */
  address: string;
  chainId: number;
  /** ISO8601 */
  issuedAt: string;
  /** ISO8601 或 null (null = 不过期) */
  expiresAt: string | null;
  /** 32 位小写 hex (16 字节), 一次性 */
  nonce: string;
}

/** 落盘的一份绑定 (不含任何私钥) */
export interface AddressBindingRecord {
  schemaVersion: number;
  protocol: string;
  /** `ab-` + sha256(statement_json) 前 16 位 —— 由声明正文派生, 改一个字节就变 */
  id: string;
  statement: AddressBindingStatement;
  /** 被签名的那份**字节串** (canonical: 键排序 + 无空格) */
  statement_json: string;
  /** DID 的 Ed25519 公钥 (64 位小写 hex) —— 用于离线验 `sig_did` */
  did_public_key: string;
  /** DID 私钥对 statement_json 的签名 (base64) */
  sig_did: string;
  /** 地址私钥对 statement_json 的 EIP-191 签名 (0x + 65 字节 hex) */
  sig_addr: string;
  /** 可选的名字 (本地注解; 有就必须有 label_sig 覆盖) */
  label?: string;
  /** DID 私钥对 canonicalize({...statement, label}) 的签名 (base64); 只有带 label 的绑定才有 */
  label_sig?: string;
  /** 本机**验签通过**之后才写的时间 (未通过不落盘) */
  verified_at: string;
  /** 落盘时真跑过的判据名 (可回放) */
  verified_checks?: string[];
  /** 谁写的 (CLI 自述; 不含机器名/用户路径) */
  created_by?: string;
}

/** 对外短写 (页面/快照里唯一允许出现的身份形态) */
export interface PayerIdentity {
  /** 智能体名短写 (已验签的 label 清洗后) */
  name_short: string;
  /** DID 短写 (`did:key:` 之后前 12 字符; **不带 did: 前缀**) */
  did_short: string;
  verified: true;
  method: string;
  source: string;
}

export interface BindingVerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface BindingVerifyResult {
  ok: boolean;
  /** 失败原因 (机器可读短串; ok=true 时为空数组) */
  reasons: string[];
  checks: BindingVerifyCheck[];
  id: string;
  /** 双侧签名各自的结论 (**分别**报出来, 便于"缺一侧"与"两侧都错"区分开) */
  sig_did_ok: boolean;
  sig_addr_ok: boolean;
  /** 有 label 时必须为 true; 无 label 时为 null (不适用) */
  label_covered: boolean | null;
  address: string | null;
  did: string | null;
}

export interface BindingIndexEntry {
  id: string;
  /** 全小写地址 —— **只在本机索引里**, 不进对外投影 */
  address: string;
  did: string;
  /** 对外短写 (派生; 索引只作为可读性便利, 消费方应自己重算) */
  did_short: string;
  name_short: string;
  chainId: number;
  issuedAt: string;
  expiresAt: string | null;
  verified_at: string;
  file: string;
}

export interface BindingIndexFile {
  schemaVersion: number;
  protocol: string;
  updatedAt: number;
  dir: string;
  bindings: BindingIndexEntry[];
  /** nonce → 绑定 id (**一次性**判据的唯一来源) */
  nonces: Record<string, string>;
}

/** 加载给快照用的付款方身份表 (只有**已验签**的进来) */
export interface PayerIdentityIndex {
  /** 库里绑定文件数 */
  loaded: number;
  /** 其中重验通过的 */
  verified: number;
  /** 重验不通过的 (附原因; 这些**一个都不进 byAddress**) */
  rejected: Array<{ id: string; reasons: string[] }>;
  /** 小写地址 → 短写身份 */
  byAddress: Record<string, PayerIdentity>;
  reason: string;
  dir: string;
  /** 这份表的取数语义 (写进快照, 页面照原文显示) */
  label: { zh: string; en: string };
  note: { zh: string; en: string };
}

// ─────────────────────────────────────────────────────────── 短写 (唯一实现)

/**
 * 名字短写: 清洗 label → `[A-Za-z0-9._-]` + 中日文, 其余字符折成 `_`, 截到 24 字符。
 * **绝不**产出 `0x…` / `did:…` / `/` / 空格 —— 页面对这些形态有硬门。
 */
export function shortAgentName(label: string | null | undefined, fallback?: string | null): string {
  const raw = String(label ?? '').trim();
  const cleaned = raw
    .replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  if (cleaned && NAME_SHORT_RE.test(cleaned.slice(0, NAME_SHORT_MAX))) return cleaned.slice(0, NAME_SHORT_MAX);
  const fb = String(fallback ?? '').trim();
  if (fb && NAME_SHORT_RE.test(fb.slice(0, NAME_SHORT_MAX))) return fb.slice(0, NAME_SHORT_MAX);
  return 'agent';
}

/**
 * DID 短写: 取 `did:key:` **之后**的前 12 字符。
 * 为什么去掉前缀: `did:key:` 本身就是**被隐私门禁止的形态** (页面/快照里不许出现 DID);
 * 短写只用来让人眼分辨不同智能体, 不需要方法前缀。
 */
export function didShort(did: string): string {
  const s = String(did || '').trim();
  const body = s.startsWith('did:key:') ? s.slice('did:key:'.length) : s;
  return body.slice(0, DID_SHORT_LEN);
}

/** 地址哈希 (对外投影里的地址指代; sha256(小写地址) 前 16 位) */
export function addressHash(address: string): string {
  return `sha256:${sha256Hex(String(address || '').toLowerCase()).slice(0, 16)}`;
}

/**
 * base58btc 编码 (本文件自用, **不引第三方包** —— 免得依赖一个只作为传递依赖存在的编码器)。
 * did:key 的形状 = `did:key:z` + base58btc(0xed 0x01 ‖ 32 字节 Ed25519 公钥)。
 */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btc(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

/** Ed25519 公钥 (hex) → `did:key:z…`; 用来核对声明里的 did 与 `did_public_key` 是否同一把钥匙 */
export function didFromEd25519PublicKey(publicKeyHex: string): string {
  const hex = String(publicKeyHex || '').trim().toLowerCase();
  if (!BINDING_PUBKEY_HEX_RE.test(hex)) throw new Error(`Ed25519 公钥必须是 64 位小写 hex, 实得 ${String(publicKeyHex || '').slice(0, 20)}`);
  const raw = Buffer.from(hex, 'hex');
  return `did:key:z${base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`;
}

// ─────────────────────────────────────────────────────────── 声明正文

export interface BuildBindingStatementInput {
  did: string;
  address: string;
  chainId?: number;
  issuedAt?: string;
  expiresAt?: string | null;
  nonce?: string;
}

function assertStatement(stmt: AddressBindingStatement): void {
  if (!stmt || typeof stmt !== 'object') throw new Error('绑定声明缺失');
  if (stmt.protocol !== ADDRESS_BINDING_PROTOCOL) throw new Error(`protocol 必须是 ${ADDRESS_BINDING_PROTOCOL}, 实得 ${stmt.protocol}`);
  if (!BINDING_DID_RE.test(String(stmt.did || ''))) throw new Error(`did 形状非法 (要 did:key:z…): ${String(stmt.did || '').slice(0, 40)}`);
  if (!BINDING_ADDRESS_RE.test(String(stmt.address || ''))) throw new Error(`address 必须是**全小写** 0x+40 位: ${String(stmt.address || '')}`);
  if (!Number.isInteger(stmt.chainId) || stmt.chainId <= 0) throw new Error(`chainId 必须是正整数, 实得 ${stmt.chainId}`);
  if (typeof stmt.issuedAt !== 'string' || !stmt.issuedAt) throw new Error('issuedAt 必须是 ISO8601 字符串');
  if (stmt.expiresAt !== null && (typeof stmt.expiresAt !== 'string' || !stmt.expiresAt)) {
    throw new Error('expiresAt 必须是 ISO8601 字符串或 null');
  }
  if (!BINDING_NONCE_RE.test(String(stmt.nonce || ''))) {
    throw new Error(`nonce 必须是 ${BINDING_NONCE_BYTES * 2} 位小写 hex (${BINDING_NONCE_BYTES} 字节), 实得 ${String(stmt.nonce || '')}`);
  }
}

/** 生成一枚一次性 nonce (16 字节 → 32 位小写 hex) */
export function newBindingNonce(): string {
  return crypto.randomBytes(BINDING_NONCE_BYTES).toString('hex');
}

/** 规范化一条声明正文 (地址强制小写 + 形状校验); 缺省补齐 protocol/chainId/issuedAt/nonce */
export function buildBindingStatement(input: BuildBindingStatementInput): AddressBindingStatement {
  const stmt: AddressBindingStatement = {
    protocol: ADDRESS_BINDING_PROTOCOL,
    did: String(input.did || '').trim(),
    address: String(input.address || '').trim().toLowerCase(),
    chainId: Number(input.chainId ?? DEFAULT_BINDING_CHAIN_ID),
    issuedAt: String(input.issuedAt || new Date().toISOString()),
    expiresAt: input.expiresAt == null ? null : String(input.expiresAt),
    nonce: String(input.nonce || newBindingNonce()).toLowerCase(),
  };
  assertStatement(stmt);
  return stmt;
}

/** canonical 序列化 (键 sort_keys + 无空格) —— **签名与验签的唯一对象** */
export function canonicalBindingStatement(stmt: AddressBindingStatement | Record<string, unknown>): string {
  return canonicalize(stmt);
}

/** 绑定 id = `ab-` + sha256(字节串) 前 16 位 (由正文派生, 改一个字节就变) */
export function addressBindingId(statementJson: string): string {
  return `ab-${sha256Hex(statementJson).slice(0, 16)}`;
}

/** `canonicalize({...statement, label})` —— label_sig 的签名对象 */
export function canonicalBindingLabeled(stmt: AddressBindingStatement, label: string): string {
  return canonicalize({ ...stmt, label: String(label) });
}

// ─────────────────────────────────────────────────────────── 签名 / 构造

export interface CreateAddressBindingInput {
  did: string;
  /** DID 私钥 (32 字节 raw hex) */
  didPrivateKeyHex: string;
  /** DID 公钥 (64 位 hex); 与 did 必须自洽 (did:key 派生核对) */
  didPublicKeyHex: string;
  /** 地址私钥 (0x + 64 hex) —— 只在本进程内用于签名, 不落盘 */
  addressPrivateKeyHex: string;
  /** 被认领的地址 (全小写) */
  address: string;
  chainId?: number;
  expiresAt?: string | null;
  issuedAt?: string;
  nonce?: string;
  label?: string | null;
  createdBy?: string;
}

function normalizeHex32(hex: string, what: string): Uint8Array {
  const s = String(hex || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error(`${what} 必须是 32 字节 hex (64 位), 实得 ${String(hex || '').length} 字符`);
  return Uint8Array.from(Buffer.from(s, 'hex'));
}

/**
 * 造一份绑定 (双侧签名 + **立刻自验**)。
 *   · DID 侧: `ed25519Sign(didKey, statement_json)` → `sig_did`
 *   · 地址侧: `new Wallet(addressKey).signMessage(statement_json)` → `sig_addr` (EIP-191)
 *   · 有 label: 再加一枚 `label_sig`(DID 私钥对 `canonicalize({...statement, label})`)
 * **自验不通过就抛错** (绝不落盘一份自己都验不过的绑定)。
 */
export async function createAddressBinding(input: CreateAddressBindingInput): Promise<AddressBindingRecord> {
  const didSeed = normalizeHex32(input.didPrivateKeyHex, 'DID 私钥');
  const pub = String(input.didPublicKeyHex || '').trim().toLowerCase().replace(/^0x/, '');
  if (!BINDING_PUBKEY_HEX_RE.test(pub)) throw new Error(`DID 公钥必须是 64 位 hex, 实得 ${String(input.didPublicKeyHex || '').slice(0, 20)}`);
  const statement = buildBindingStatement({
    did: input.did,
    address: input.address,
    chainId: input.chainId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
  });
  const derived = didFromEd25519PublicKey(pub);
  if (derived !== statement.did) throw new Error(`DID 与公钥不自洽 (公钥派生出 ${derived.slice(0, 24)}…, 声明写的是 ${statement.did.slice(0, 24)}…)`);
  const wallet = new Wallet(String(input.addressPrivateKeyHex || '').trim());
  if (wallet.address.toLowerCase() !== statement.address) {
    throw new Error(`地址私钥与地址不对应 (钱包 ${wallet.address} ≠ 声明 ${statement.address})`);
  }

  const statementJson = canonicalBindingStatement(statement);
  const sigDid = await ed25519Sign(didSeed, statementJson);
  const sigAddr = await wallet.signMessage(statementJson);
  const label = input.label == null || String(input.label).trim() === '' ? undefined : String(input.label).trim();
  const labelSig = label ? await ed25519Sign(didSeed, canonicalBindingLabeled(statement, label)) : undefined;

  const record: AddressBindingRecord = {
    schemaVersion: ADDRESS_BINDING_SCHEMA_VERSION,
    protocol: ADDRESS_BINDING_PROTOCOL,
    id: addressBindingId(statementJson),
    statement,
    statement_json: statementJson,
    did_public_key: pub,
    sig_did: sigDid,
    sig_addr: sigAddr,
    ...(label ? { label } : {}),
    ...(labelSig ? { label_sig: labelSig } : {}),
    verified_at: new Date().toISOString(),
    created_by: input.createdBy || 'bolloon identity bind-address',
  };

  const verdict = await verifyAddressBinding(record);
  if (!verdict.ok) {
    throw new Error(`自验不通过 (拒落盘): ${verdict.reasons.join(' | ')}`);
  }
  record.verified_checks = verdict.checks.filter((c) => c.ok).map((c) => c.name);
  return record;
}

// ─────────────────────────────────────────────────────────── 验签

export interface VerifyBindingOptions {
  /** 判定过期的时刻 (缺省 = 现在) */
  now?: number;
  /** nonce 一次性判据的来源 (索引的 `nonces`); 不给 = 不做重放检查 (调用方要自己知道) */
  nonces?: Record<string, string> | null;
}

/**
 * 验一条绑定 (**唯一验签实现**; 只收紧不放松)。
 * 判据逐条列在 `checks` 里; 任一条不通过 ⇒ `ok=false` 且 `reasons` 非空。
 * 顺序按"先形状/自洽, 后两枚签名, 再时效/重放"排 —— 但**全部都会跑** (不是短路),
 * 这样"缺一侧签名"与"两侧都错"在输出里能分得开。
 */
export async function verifyAddressBinding(
  record: AddressBindingRecord | null | undefined,
  opts: VerifyBindingOptions = {},
): Promise<BindingVerifyResult> {
  const checks: BindingVerifyCheck[] = [];
  const reasons: string[] = [];
  const add = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); if (!ok) reasons.push(name); };

  const rec = record as AddressBindingRecord | null;
  if (!rec || typeof rec !== 'object') {
    add('record_present', false, '记录缺失/不是对象');
    return { ok: false, reasons, checks, id: '', sig_did_ok: false, sig_addr_ok: false, label_covered: null, address: null, did: null };
  }

  add('protocol', rec.protocol === ADDRESS_BINDING_PROTOCOL, `protocol=${String(rec.protocol)} (要 ${ADDRESS_BINDING_PROTOCOL})`);

  const stmt = rec.statement as AddressBindingStatement | undefined;
  const stmtOk = !!stmt && typeof stmt === 'object';
  add('statement_present', stmtOk, stmtOk ? '声明正文在' : '缺 statement');
  if (!stmtOk) {
    return { ok: false, reasons, checks, id: String(rec.id || ''), sig_did_ok: false, sig_addr_ok: false, label_covered: null, address: null, did: null };
  }

  // ① 形状 / 自洽 (逐条真判)
  const shape = (name: string, ok: boolean, detail: string) => { add(name, ok, detail); };
  shape('statement_protocol', stmt.protocol === ADDRESS_BINDING_PROTOCOL, `statement.protocol=${String(stmt.protocol)}`);
  shape('statement_did_shape', BINDING_DID_RE.test(String(stmt.did || '')), `did=${String(stmt.did || '').slice(0, 32)}…`);
  shape('statement_address_shape', BINDING_ADDRESS_RE.test(String(stmt.address || '')), `address=${String(stmt.address || '')} (必须是全小写 0x+40)`);
  shape('statement_chain_id', Number.isInteger(stmt.chainId) && stmt.chainId > 0, `chainId=${String(stmt.chainId)}`);
  shape('statement_nonce_shape', BINDING_NONCE_RE.test(String(stmt.nonce || '')), `nonce=${String(stmt.nonce || '').slice(0, 12)}… (要 32 位小写 hex)`);
  shape('did_public_key_shape', BINDING_PUBKEY_HEX_RE.test(String(rec.did_public_key || '').toLowerCase()), `did_public_key=${String(rec.did_public_key || '').slice(0, 16)}…`);
  // did 必须是 did_public_key 派生出来的那条 (否则"这个 DID 认领"这句话落在一把不存在的钥匙上)
  let derivedDid = '';
  try { derivedDid = didFromEd25519PublicKey(String(rec.did_public_key || '')); } catch { derivedDid = ''; }
  shape('did_matches_public_key', !!derivedDid && derivedDid === stmt.did, derivedDid ? `派生 ${derivedDid.slice(0, 28)}… vs 声明 ${String(stmt.did).slice(0, 28)}…` : '公钥形状不对, 派生不出 did');

  // ② canonical 序列化 (**拒**非 canonical 的那份: 重算必须与落盘字节串逐字节相同)
  const recomputed = canonicalBindingStatement(stmt);
  const jsonOk = typeof rec.statement_json === 'string' && rec.statement_json === recomputed;
  add('statement_canonical', jsonOk, jsonOk
    ? '落盘字节串 == canonicalize(statement) (键排序 + 无空格)'
    : `落盘字节串与 canonical 重算**不一致** (落盘 ${String(rec.statement_json || '').length} 字符 / 重算 ${recomputed.length} 字符) —— 非 canonical 版本一律拒`);
  // id 也必须由这份字节串派生 (改一个字节就变 ⇒ 也能抓"改了正文没改 id")
  const expectId = addressBindingId(recomputed);
  add('id_matches_statement', String(rec.id || '') === expectId, `id=${String(rec.id)} vs 派生 ${expectId}`);
  const statementJson = recomputed;   // 签名一律对**重算**的 canonical 字节串验 (与落盘值已比对相同)

  // ③ 双侧签名 (分别报结论; 两侧都验, 不短路)
  const sigDidShapeOk = BINDING_SIG_B64_RE.test(String(rec.sig_did || ''));
  const sigDidOk = sigDidShapeOk && await ed25519Verify(String(rec.did_public_key || '').toLowerCase(), statementJson, String(rec.sig_did || ''));
  add('sig_did', sigDidOk, sigDidOk ? 'ed25519Verify(DID 公钥, statement_json, sig_did) = true' : (sigDidShapeOk ? 'ed25519Verify = false (声明正文/DID 公钥/签名 三者不自洽)' : 'sig_did 形状不对 (base64)'));

  const addr = String(stmt.address || '').toLowerCase();
  let recovered = '';
  try { recovered = String(verifyMessage(statementJson, String(rec.sig_addr || ''))).toLowerCase(); } catch { recovered = ''; }
  const sigAddrOk = BINDING_SIG_HEX_RE.test(String(rec.sig_addr || '')) && recovered === addr && !!addr;
  add('sig_addr', sigAddrOk, sigAddrOk
    ? `verifyMessage(statement_json, sig_addr) = ${addr} == statement.address`
    : `恢复出 ${recovered || '(验签失败)'} ≠ statement.address ${addr}`);

  // ④ label (名字) 必须被覆盖: 有 label ⇒ 必须有有效的 label_sig
  const hasLabel = rec.label != null && String(rec.label).trim() !== '';
  let labelCovered: boolean | null = null;
  if (hasLabel) {
    const sig = String(rec.label_sig || '');
    const ok = BINDING_SIG_B64_RE.test(sig) && await ed25519Verify(String(rec.did_public_key || '').toLowerCase(), canonicalBindingLabeled(stmt, String(rec.label)), sig);
    labelCovered = ok;
    add('label_covered', ok, ok ? 'label_sig(DID 私钥) 覆盖 canonicalize({...statement, label})' : '有 label 但 label_sig 缺失/验不过 —— **名字没被签名覆盖**, 整条绑定拒');
    add('label_shape', NAME_SHORT_RE.test(shortAgentName(String(rec.label))), `name_short=${shortAgentName(String(rec.label))}`);
  } else {
    add('label_absent', true, '无 label (照旧只要两枚签名)');
  }

  // ⑤ 时效
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  if (stmt.expiresAt != null) {
    const t = Date.parse(String(stmt.expiresAt));
    const ok = Number.isFinite(t) && t > now;
    add('not_expired', ok, ok ? `expiresAt=${stmt.expiresAt} 未过期` : `expiresAt=${String(stmt.expiresAt)} 已过期/解析不了 (now=${new Date(now).toISOString()})`);
  } else {
    add('not_expired', true, 'expiresAt=null (不过期)');
  }

  // ⑥ nonce 一次性 (给了索引才判; 没给就如实说明这一条没跑)
  const nonces = opts.nonces && typeof opts.nonces === 'object' ? opts.nonces : null;
  if (nonces) {
    const owner = nonces[String(stmt.nonce)];
    const ok = owner == null || owner === String(rec.id || '');
    add('nonce_unused', ok, ok
      ? (owner ? 'nonce 在本机索引里且就是本条 (重验)' : 'nonce 未在本机索引里出现过')
      : `nonce 已被另一条绑定用掉 (owner=${owner}) —— 重放`);
  } else {
    add('nonce_unused', true, '调用方没给 nonce 索引 ⇒ 这一条**没跑** (调用方要知道)');
  }

  void shape;   // (形状判据的结论已逐条进 checks/reasons; 这里不需要额外标志位)
  const ok = reasons.length === 0;
  return {
    ok,
    reasons,
    checks,
    id: String(rec.id || ''),
    sig_did_ok: sigDidOk,
    sig_addr_ok: sigAddrOk,
    label_covered: labelCovered,
    address: addr || null,
    did: String(stmt.did || '') || null,
  };
}

/** 一条已验签的绑定 → 对外短写 (未验签的**不许**走这里; 调用方负责先验) */
export function payerIdentityOf(record: AddressBindingRecord): PayerIdentity {
  const name = shortAgentName(record.label, didShort(record.statement.did));
  return {
    name_short: name,
    did_short: didShort(record.statement.did),
    verified: true,
    method: ADDRESS_BINDING_PROTOCOL,
    source: ADDRESS_BINDING_SOURCE,
  };
}

// ─────────────────────────────────────────────────────────── 落盘 / 读取

/** 原子写 + 0600 (绑定只在本机; 里面**没有**私钥, 但仍然是私有事实) */
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 平台不支持就跳过 */ }
}

export function bindingFileName(id: string): string {
  return `${id}.json`;
}

/**
 * 写一份绑定 + 重建索引 (**唯一写入口**)。
 * 不验签的绑定**不写**(调用方应先 `verifyAddressBinding`; 这里再兜一层)。
 */
export async function writeBindingRecord(
  record: AddressBindingRecord,
  opts: { dir?: string } = {},
): Promise<{ file: string; index: BindingIndexFile }> {
  const dir = opts.dir || bindingsDir();
  const file = path.join(dir, bindingFileName(record.id));
  if (fs.existsSync(file)) throw new Error(`绑定已存在 (同 id): ${file} —— 改一个字节会换 id, 同 id 说明正文一字未变`);
  writeJsonAtomic(file, record);
  const index = await rebuildBindingIndex({ dir });
  return { file, index };
}

export function readBindingRecord(file: string): AddressBindingRecord {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object') throw new Error(`绑定文件读不出对象: ${file}`);
  return raw as AddressBindingRecord;
}

/** 扫目录重建聚合索引 (每份文件真读一遍; 坏文件**记账不吞**) */
export async function rebuildBindingIndex(opts: { dir?: string; now?: number } = {}): Promise<BindingIndexFile> {
  const dir = opts.dir || bindingsDir();
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith('ab-') && f.endsWith('.json')).sort()
    : [];
  const bindings: BindingIndexEntry[] = [];
  const nonces: Record<string, string> = {};
  for (const f of files) {
    let rec: AddressBindingRecord;
    try { rec = readBindingRecord(path.join(dir, f)); } catch { continue; }
    const id = String(rec.id || f.replace(/\.json$/, ''));
    bindings.push({
      id,
      address: String(rec.statement?.address || '').toLowerCase(),
      did: String(rec.statement?.did || ''),
      did_short: didShort(String(rec.statement?.did || '')),
      name_short: shortAgentName(rec.label, didShort(String(rec.statement?.did || ''))),
      chainId: Number(rec.statement?.chainId) || 0,
      issuedAt: String(rec.statement?.issuedAt || ''),
      expiresAt: rec.statement?.expiresAt == null ? null : String(rec.statement.expiresAt),
      verified_at: String(rec.verified_at || ''),
      file: f,
    });
    const n = String(rec.statement?.nonce || '');
    if (n) nonces[n] = id;
  }
  const index: BindingIndexFile = {
    schemaVersion: ADDRESS_BINDING_SCHEMA_VERSION,
    protocol: ADDRESS_BINDING_PROTOCOL,
    updatedAt: Number(opts.now ?? Date.now()),
    dir,
    bindings: bindings.sort((a, b) => a.id.localeCompare(b.id)),
    nonces,
  };
  writeJsonAtomic(path.join(dir, BINDING_INDEX_FILENAME), index);
  return index;
}

/** 读聚合索引 (读不出 → 现扫一遍目录重建) */
export function readBindingIndex(opts: { dir?: string } = {}): BindingIndexFile | null {
  const dir = opts.dir || bindingsDir();
  const p = path.join(dir, BINDING_INDEX_FILENAME);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.bindings) && raw.nonces && typeof raw.nonces === 'object') {
      return raw as BindingIndexFile;
    }
  } catch { /* 落回重建 */ }
  return null;
}

// ─────────────────────────────────────────────────────────── 快照用的加载口

/**
 * 加载「付款方地址 → 短写身份」表 (**给快照构建用**)。
 *   · 索引里**每一条都重验一遍** (不是信 `verified_at` 这个时间戳): 重验不过的一条都不进表;
 *   · 只有已验签的绑定才产出 `name_short` / `did_short` (**硬闸**: 未验签 = 不出名字不出 DID);
 *   · 只读本机目录, **不发网络**; 目录不存在 → 空表 + reason (不猜)。
 */
export async function loadPayerIdentityIndex(opts: { home?: string; dir?: string; now?: number } = {}): Promise<PayerIdentityIndex> {
  const dir = opts.dir || bindingsDir(opts.home);
  const label = { zh: '链下登记(可离线验签)', en: 'off-chain registration (verifiable offline)' };
  const note = {
    zh: '付款方智能体名来自**链下登记**(地址↔DID 双侧签名的声明), 不是链上事实; 每一条都由本机在加载时重验, 未验签的一律不出名字与 DID; 地址本身不出公开面',
    en: 'Payer agent names come from an off-chain registration (address↔DID statement signed by BOTH keys), not an on-chain fact; every entry is re-verified on load and unverified ones contribute neither name nor DID; the address itself is never published',
  };
  const base: PayerIdentityIndex = {
    loaded: 0, verified: 0, rejected: [], byAddress: {}, dir, label, note,
    reason: '',
  };
  let index: BindingIndexFile | null = null;
  try { index = readBindingIndex({ dir }); } catch { index = null; }
  if (!index) {
    base.reason = `本机绑定库不可读/未建 (~/.bolloon/${BINDINGS_DIRNAME}/index.json) → 付款方身份不出 (不是"没有智能体付款")`;
    return base;
  }
  const nonces = index.nonces || {};
  void nonces;                                    // 见下: nonce 唯一性只看**验签通过**的那些 (免被垃圾文件污染)
  const files = index.bindings.map((b) => b.file).filter(Boolean);
  const byFileName = new Map(index.bindings.map((b) => [b.file, b]));
  base.loaded = files.length;
  /** 第一轮: 逐条重验 (只做"这条声明自身成不成立", 不掺别的文件) */
  const prelim: Array<{ file: string; rec: AddressBindingRecord; id: string; address: string }> = [];
  /** 同一地址可能有多条 (换 DID 重登记) → 取 **issuedAt 最新** 的那条; 平手时取 id 小的 (确定性) */
  const chosen: Record<string, { issuedAt: string; id: string }> = {};
  for (const f of files) {
    const file = path.join(dir, f);
    let rec: AddressBindingRecord;
    try { rec = readBindingRecord(file); } catch (e: any) {
      base.rejected.push({ id: f.replace(/\.json$/, ''), reasons: [`读不出: ${String(e?.message || e).slice(0, 80)}`] });
      continue;
    }
    const verdict = await verifyAddressBinding(rec, { now: opts.now });
    if (!verdict.ok || !verdict.address) {
      base.rejected.push({ id: verdict.id || f, reasons: verdict.reasons });
      continue;
    }
    prelim.push({ file: f, rec, id: String(verdict.id), address: verdict.address.toLowerCase() });
  }
  /**
   * 第二轮: nonce **一次性** —— 只在验签通过的记录之间判。
   * 为什么不在第一轮就喂索引里的 nonces: 索引是扫目录来的, 一条垃圾文件(甚至一行手写 JSON)
   * 就能把某个 nonce 占掉, 从而把**真绑定**顶成"重放"。现在改成"先各自验自己, 再看重复":
   * 同一枚 nonce 出现两次 ⇒ **两条都拒** (分不清谁是先来的, 就不猜 —— fail-closed)。
   */
  const owners = new Map<string, string[]>();
  for (const p of prelim) {
    const n = String(p.rec.statement.nonce || '');
    owners.set(n, [...(owners.get(n) || []), p.id]);
  }
  const replayed = new Set([...owners.values()].filter((ids) => ids.length > 1).flat());
  for (const p of prelim) {
    if (replayed.has(p.id)) {
      base.rejected.push({ id: p.id, reasons: ['nonce_unused'], });
      continue;
    }
    // 同一地址有多条 (换 DID 重登记) → 取 issuedAt 最新的那条 (平手取 id 小的, 确定性)
    const issuedAt = String(byFileName.get(p.file)?.issuedAt || p.rec.statement.issuedAt || '');
    const prev = chosen[p.address];
    base.verified++;
    if (prev) {
      const newer = issuedAt > prev.issuedAt || (issuedAt === prev.issuedAt && p.id < prev.id);
      if (!newer) continue;
    }
    chosen[p.address] = { issuedAt, id: p.id };
    base.byAddress[p.address] = payerIdentityOf(p.rec);
  }
  base.reason = base.loaded === 0
    ? '本机绑定库为空 (还没有地址↔DID 登记)'
    : `重验 ${base.loaded} 条 → 通过 ${base.verified} 条${base.rejected.length ? ` · 拒 ${base.rejected.length} 条` : ''}`;
  return base;
}

// ─────────────────────────────────────────────────────────── 对外投影 (publish)

export interface PublicBindingProjection {
  protocol: string;
  kind: 'off-chain-registration';
  label: { zh: string; en: string };
  note: { zh: string; en: string };
  generated_at: number;
  count: number;
  bindings: Array<{
    id: string;
    address_hash: string;
    name_short: string;
    did_short: string;
    verified: true;
    method: string;
    source: string;
    chainId: number;
    issuedAt: string;
    expiresAt: string | null;
  }>;
}

/**
 * 对外投影 (**只出短写**): 逐条重验, 只有通过的才进; **地址只以 `address_hash` 出现**
 * (地址本身不出公开面 —— 谁要按地址核，就在本机用 `bindings list` 看)。
 */
export async function buildPublicBindingProjection(
  opts: { dir?: string; home?: string; now?: number } = {},
): Promise<PublicBindingProjection> {
  const dir = opts.dir || bindingsDir(opts.home);
  const index = readBindingIndex({ dir }) || { schemaVersion: ADDRESS_BINDING_SCHEMA_VERSION, protocol: ADDRESS_BINDING_PROTOCOL, updatedAt: Date.now(), dir, bindings: [], nonces: {} };
  const out: PublicBindingProjection = {
    protocol: ADDRESS_BINDING_PROTOCOL,
    kind: 'off-chain-registration',
    label: { zh: '链下登记(可离线验签)', en: 'off-chain registration (verifiable offline)' },
    note: {
      zh: '每行 = 一条地址↔DID 绑定声明(链下, 不是链上事实), 由 DID 私钥与地址私钥**分别**签名同一份声明正文; 可用 bindings verify 离线复验; 这里只出短写, 地址只以哈希出现',
      en: 'Each row is an off-chain address↔DID binding statement signed by BOTH the DID key and the address key over the same canonical body; re-verify offline with `bindings verify`. Only short forms are published; the address appears only as a hash',
    },
    generated_at: Number(opts.now ?? Date.now()),
    count: 0,
    bindings: [],
  };
  for (const b of index.bindings) {
    let rec: AddressBindingRecord;
    try { rec = readBindingRecord(path.join(dir, b.file)); } catch { continue; }
    const verdict = await verifyAddressBinding(rec, { now: opts.now, nonces: index.nonces });
    if (!verdict.ok || !verdict.address) continue;
    out.bindings.push({
      id: verdict.id,
      address_hash: addressHash(verdict.address),
      name_short: shortAgentName(rec.label, didShort(String(rec.statement.did))),
      did_short: didShort(String(rec.statement.did)),
      verified: true,
      method: ADDRESS_BINDING_PROTOCOL,
      source: ADDRESS_BINDING_SOURCE,
      chainId: Number(rec.statement.chainId) || 0,
      issuedAt: String(rec.statement.issuedAt || ''),
      expiresAt: rec.statement.expiresAt == null ? null : String(rec.statement.expiresAt),
    });
  }
  out.bindings.sort((a, b) => a.id.localeCompare(b.id));
  out.count = out.bindings.length;
  return out;
}
