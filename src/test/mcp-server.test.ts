/**
 * mcp-server.test.ts — P4 MCP 适配层验收 (stdio JSON-RPC + 17 tools + 7 resources + 六条禁止)
 *
 * 只做**真调用**: 走 `handleMessage` / `serveStdio` (真读真写流) → 真跑 P3 命令函数。
 * 关键断言 (对应 P4 任务书):
 *   · 失败不得变成 MCP 成功 (isError = !ok, 信封 code/next_action 原样)
 *   · local-dev 绝不冒充链上 (伪造 verified 会被如实报成 LOCAL_DEV_NOT_CHAIN)
 *   · 私钥/回执类字段在 MCP 出口被剥离
 *   · 入参白名单 (客户端给的是具名参数, 不能注入命令行选项)
 *   · 超时 → code=TIMEOUT 的结构化失败
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

import {
  handleMessage, serveStdio, DEFAULT_PROTOCOL_VERSION, JSONRPC, toolResult,
} from '../cli/mcp/server.js';
import { TOOLS, RESOURCES, NOT_EXPOSED } from '../cli/mcp/tools.js';
import { mcpSafeEnvelope } from '../cli/mcp/bridge.js';
import { failEnvelope, okEnvelope } from '../cli/protocol-envelope.js';
import { GROUP_COMMANDS } from '../cli/commands/index.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-p4-mcp-${Date.now()}`);
let oldHome: string | undefined;

/** 任务书里的 17 个 tool (P4) + P6 追加的 7 个链 tool, 一个不多一个不少 */
const REQUIRED_TOOLS = [
  'bolloon_network_join', 'bolloon_network_status',
  'bolloon_agent_register', 'bolloon_agent_discover', 'bolloon_agent_manifest',
  'bolloon_task_run', 'bolloon_task_list', 'bolloon_task_status', 'bolloon_task_result', 'bolloon_task_retry',
  'bolloon_wallet_status',
  'bolloon_payment_pending', 'bolloon_payment_approve', 'bolloon_payment_reject',
  'bolloon_trade_list', 'bolloon_trade_show', 'bolloon_trade_reconcile',
  // P6: 链上能力 (全部薄包装 `bolloon chain ...`; 链上**写**操作刻意不暴露)
  'bolloon_chain_status', 'bolloon_chain_escrow_show', 'bolloon_chain_timeline',
  'bolloon_chain_index_status', 'bolloon_chain_index_stats', 'bolloon_chain_index_sync',
  'bolloon_chain_trade_recover',
];

const REQUIRED_RESOURCES = [
  'bolloon://network/status', 'bolloon://network/capabilities', 'bolloon://agent/manifest',
  'bolloon://tasks/recent', 'bolloon://trades/recent', 'bolloon://wallet/policy', 'bolloon://skill/current',
  // P6: 链上视图 (信封原样)
  'bolloon://chain/status', 'bolloon://chain/index', 'bolloon://chain/index/stats',
];

/** 一笔 fixture 交易 (可注入 privateKey 之类"绝不该出现"的字段, 验出口剥离) */
function writeTx(over: Record<string, unknown>) {
  const dir = path.join(tmpHome, '.bolloon', 'transactions');
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    transactionId: 'tx-p4test-0001',
    requestId: 'treq-p4test0001',
    itemId: 'item-1',
    buyerDid: 'did:diap:buyer',
    providerDid: 'did:diap:provider',
    paymentMode: 'local-dev',
    chainSettled: false,
    status: 'delivered',
    settlementFact: 'payment_submitted',
    schemaVersion: 2,
    amount: '1000',
    currency: 'USDC',
    network: 'base-sepolia',
    startedAt: new Date().toISOString(),
    events: [{ at: new Date().toISOString(), kind: 'delivered' }],
    ...over,
  };
  fs.writeFileSync(path.join(dir, `${rec.transactionId}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const resp: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(resp.error, `tool ${name} 不该是 JSON-RPC 错误`).toBeUndefined();
  const text = resp.result.content[0].text as string;
  return { result: resp.result, envelope: JSON.parse(text), text };
}

beforeAll(() => {
  oldHome = process.env.HOME;
  process.env.HOME = tmpHome;
  fs.mkdirSync(tmpHome, { recursive: true });
  delete process.env.BOLLOON_MCP_TIMEOUT_MS;
});

afterAll(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('P4 MCP — 协议握手与清单', () => {
  it('initialize: 回客户端请求的协议版本 + serverInfo + tools/resources 能力', async () => {
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'probe', version: '0' } } });
    expect(resp.result.protocolVersion).toBe('2024-11-05');
    expect(resp.result.serverInfo.name).toBe('bolloon');
    expect(resp.result.capabilities.tools).toBeTruthy();
    expect(resp.result.capabilities.resources).toBeTruthy();
    expect(typeof resp.result.serverInfo.version).toBe('string');
  });

  it('initialize: 不认识的协议版本 → 返回本 server 支持的版本 (不假装支持未知版本)', async () => {
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(resp.result.protocolVersion).toBe(DEFAULT_PROTOCOL_VERSION);
  });

  it('tools/list: 恰好 24 个 (17 P4 + 7 链), 名字与任务书一致', async () => {
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const names = resp.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([...REQUIRED_TOOLS].sort());
    expect(names.length).toBe(24);
    // 每个 tool 都有 inputSchema (MCP 客户端要靠它生成调用)
    for (const t of resp.result.tools) expect(t.inputSchema?.type).toBe('object');
  });

  it('未实现的子命令**不暴露**成 tool (暴露就得在 MCP 层假装成功)', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const bad of ['bolloon_task_send', 'bolloon_task_inbox', 'bolloon_task_accept', 'bolloon_task_reject', 'bolloon_task_complete', 'bolloon_task_cancel', 'bolloon_network_leave', 'bolloon_wallet_set_policy']) {
      expect(names.has(bad), `${bad} 不该被暴露`).toBe(false);
    }
    expect(NOT_EXPOSED.length).toBeGreaterThan(0);
  });

  it('resources/list: 恰好 10 个 (7 P4 + 3 链), uri 与任务书一致', async () => {
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    expect(resp.result.resources.map((r: any) => r.uri).sort()).toEqual([...REQUIRED_RESOURCES].sort());
    expect(RESOURCES.length).toBe(10);
  });

  it('notification 不回响应; 未知 method 给 -32601 (不静默)', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'no/such/method' });
    expect(resp.error.code).toBe(JSONRPC.METHOD_NOT_FOUND);
  });
});

describe('P4 MCP — 真调用 P3 命令层 (只读工具)', () => {
  it('bolloon_agent_manifest: 成功 → ok:true, isError:false (信封原样)', async () => {
    const { result, envelope } = await call('bolloon_agent_manifest');
    expect(envelope.ok).toBe(true);
    expect(envelope.code).toBe('OK');
    expect(envelope.data.scope).toBe('in-process');
    expect(result.isError).toBe(false);
    expect(result.structuredContent.ok).toBe(true);
  });

  it('bolloon_network_status: 本机未入网 → ok:false + NETWORK_NOT_JOINED + isError:true (失败不是成功)', async () => {
    // 不给 timeoutMs: 这条命令要动态加载 p2p 模块 (首次可达数秒), 让它跑完
    const { result, envelope } = await call('bolloon_network_status');
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('NETWORK_NOT_JOINED');
    expect(envelope.next_action).toBe('rejoin_network');
    expect(result.isError).toBe(true);
  });

  it('bolloon_payment_pending: 无待放行付款也是真成功 (count=0, ok:true)', async () => {
    const { envelope } = await call('bolloon_payment_pending');
    expect(envelope.ok).toBe(true);
    expect(envelope.data.count).toBe(0);
  });

  it('bolloon_wallet_status: 没钱包 → WALLET_UNAVAILABLE, 输出里没有私钥值', async () => {
    const { result, envelope, text } = await call('bolloon_wallet_status');
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('WALLET_UNAVAILABLE');
    expect(result.isError).toBe(true);
    // 注意: `privateKeyPrinted: false` 是**布尔标志**, 不是私钥; 判据是"没有私钥值"
    expect(envelope.data.privateKeyPrinted).toBe(false);
    expect(envelope.data.address).toBeNull();
    expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/);   // 私钥是 32 字节 hex; 出现即漏
    expect(text).not.toMatch(/mnemonic"|"seed"|"secret"/);
  });

  it('bolloon_agent_discover: 不存在的能力 → CAPABILITY_NOT_FOUND + redefine_capability (只重查, 绝不因此付款)', async () => {
    // 不给 timeoutMs: 发现要先 warm registry (OrbitDB 离线时按平台默认 8s 兜底),
    // 外层超时给太小会把"找不到能力"误判成 TIMEOUT (那才是假阳性)
    const { result, envelope } = await call('bolloon_agent_discover', { query: 'no-such-capability-p4' });
    expect(result.isError).toBe(true);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('CAPABILITY_NOT_FOUND');
    expect(envelope.next_action).toBe('redefine_capability');
  });

  it('未知 tool 名 → JSON-RPC -32602 并列出已知 tool', async () => {
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'bolloon_task_send', arguments: {} } });
    expect(resp.error.code).toBe(JSONRPC.INVALID_PARAMS);
    expect(resp.error.data.knownTools).toContain('bolloon_task_status');
  });

  it('未知 resource URI → JSON-RPC -32602 并列出已知 uri', async () => {
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'bolloon://nope' } });
    expect(resp.error.code).toBe(JSONRPC.INVALID_PARAMS);
    expect(resp.error.data.knownResources).toContain('bolloon://skill/current');
  });
});

describe('P4 MCP — 红线: local-dev 永不冒充链上 / 不伪造 verified', () => {
  it('local-dev 记录出现 verified → 如实报 LOCAL_DEV_NOT_CHAIN, ok:false', async () => {
    const rec = writeTx({ status: 'verified', paymentMode: 'local-dev', settlementFact: 'payment_submitted', verificationTrust: 'self-attested' });
    const { result, envelope } = await call('bolloon_task_status', { id: rec.transactionId });
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('LOCAL_DEV_NOT_CHAIN');
    expect(result.isError).toBe(true);
    // 也不许在别处顺手说成功
    expect(JSON.stringify(envelope)).not.toContain('TASK_VERIFIED');
  });

  it('delivered + local-dev → code=TASK_COMPLETED, success:false, next_action=verify_result (交付 ≠ 成功)', async () => {
    const rec = writeTx({ transactionId: 'tx-p4test-0002', requestId: 'treq-p4test0002', status: 'delivered', settlementFact: 'payment_submitted' });
    const { envelope } = await call('bolloon_task_status', { id: rec.transactionId });
    expect(envelope.code).toBe('TASK_COMPLETED');
    expect(envelope.data.success).toBe(false);
    expect(envelope.data.settlement).toBe('local-dev');
    expect(envelope.next_action).toBe('verify_result');
  });

  it('local-dev + paying + 事实未定 → PAYMENT_PENDING + reconcile (先对账, 绝不重付)', async () => {
    const rec = writeTx({ transactionId: 'tx-p4test-0003', requestId: 'treq-p4test0003', status: 'paying', settlementFact: 'unknown' });
    const { envelope } = await call('bolloon_task_status', { id: rec.transactionId });
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('PAYMENT_PENDING');
    expect(envelope.next_action).toBe('reconcile');
  });

  it('仅链上口径 (chainSettled + fully_settled + verified) 才算成功: TASK_VERIFIED + success:true', async () => {
    const rec = writeTx({ transactionId: 'tx-p4test-0004', requestId: 'treq-p4test0004', status: 'verified', paymentMode: 'facilitator', chainSettled: true, settlementFact: 'fully_settled', txHash: '0xabc' });
    const { envelope } = await call('bolloon_task_status', { id: rec.transactionId });
    expect(envelope.ok).toBe(true);
    expect(envelope.code).toBe('TASK_VERIFIED');
    expect(envelope.data.success).toBe(true);
    expect(envelope.data.settlement).toBe('chain');
    expect(envelope.next_action).toBeNull();
  });
});

describe('P4 MCP — 私钥 / 回执 / 参数注入', () => {
  it('出口剥离: 信封里出现 privateKey/mnemonic/seed/paymentReceipt → 全部替换并留痕', () => {
    const env = okEnvelope('OK', 'x', {
      address: '0xPUBLIC',
      privateKey: '0xDEADBEEF',
      nested: { mnemonic: 'a b c', paymentReceipt: 'RAW-RECEIPT-BLOB' },
      list: [{ seed: 'seed-words', taskText: '私有任务正文' }],
    });
    const safe = mcpSafeEnvelope(env);
    const text = JSON.stringify(safe);
    expect(text).not.toContain('0xDEADBEEF');
    expect(text).not.toContain('a b c');
    expect(text).not.toContain('RAW-RECEIPT-BLOB');
    expect(text).not.toContain('seed-words');
    expect(text).not.toContain('私有任务正文');
    expect(safe.data.redacted_fields.length).toBeGreaterThan(0);
    expect(safe.data.receipt_stripped).toBe(true);
    // ★ 剥离只删减输出, 从不改判据
    expect(safe.ok).toBe(true);
    expect(safe.code).toBe('OK');
  });

  it('出口剥离不改失败判据 (ok:false 不因剥离变 true)', () => {
    const env = failEnvelope('POLICY_DENIED', '策略拒绝', { privateKey: '0xSECRET' }, [], 'needs_human');
    const safe = mcpSafeEnvelope(env);
    expect(safe.ok).toBe(false);
    expect(safe.code).toBe('POLICY_DENIED');
    expect(safe.next_action).toBe('needs_human');
    expect(JSON.stringify(safe)).not.toContain('0xSECRET');
  });

  it('交易记录里的私钥类字段不会出现在 tool 输出里', async () => {
    const rec = writeTx({ transactionId: 'tx-p4test-0005', requestId: 'treq-p4test0005', privateKey: '0xCANARY-PRIVATE', mnemonic: 'canary words here' });
    const { text } = await call('bolloon_trade_show', { id: rec.transactionId });
    expect(text).not.toContain('0xCANARY-PRIVATE');
    expect(text).not.toContain('canary words here');
  });

  it('入参白名单: 客户端不能塞私钥/未知参数', async () => {
    const { result, envelope } = await call('bolloon_task_run', { task: '随便跑一下', privateKey: '0xNOPE' });
    expect(result.isError).toBe(true);
    expect(envelope.code).toBe('INVALID_ARGUMENT');
    expect(envelope.data.issues.join(' ')).toContain('privateKey');
  });

  it('bolloon_trade_reconcile 必须给 id (无 id 的全局对账会写交易记录, 不在 MCP 暴露)', async () => {
    const missing = await call('bolloon_trade_reconcile', {});
    expect(missing.result.isError).toBe(true);
    expect(missing.envelope.code).toBe('INVALID_ARGUMENT');
  });

  it('bolloon_trade_reconcile <id>: 单笔只读恢复计划 (paid:false, 不发付款)', async () => {
    const rec = writeTx({ transactionId: 'tx-p4test-0007', requestId: 'treq-p4test0007', status: 'delivered', settlementFact: 'payment_submitted' });
    const { envelope } = await call('bolloon_trade_reconcile', { transactionId: rec.transactionId });
    expect(envelope.data.paid).toBe(false);
    expect(envelope.data.transactionId).toBe(rec.transactionId);
    expect(envelope.data.decisionSource).toContain('planTransactionRecovery');
  });

  it('值不许以 "-" 开头 (防"值当选项"注入命令行)', async () => {
    const { envelope } = await call('bolloon_agent_discover', { query: '--capability research' });
    expect(envelope.code).toBe('INVALID_ARGUMENT');
    expect(envelope.data.issues.join(' ')).toContain("不许以 '-' 开头");
  });

  it('缺必填参数 / 类型错 → INVALID_ARGUMENT (绝不猜默认值去执行)', async () => {
    const a = await call('bolloon_agent_register', {});
    expect(a.envelope.code).toBe('INVALID_ARGUMENT');
    const b = await call('bolloon_task_status', { id: 123 as unknown as string });
    expect(b.envelope.code).toBe('INVALID_ARGUMENT');
  });

  it('arguments 不是对象 → INVALID_ARGUMENT 信封 (不是 JSON-RPC 崩)', async () => {
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'bolloon_task_list', arguments: 'oops' } });
    expect(resp.error).toBeUndefined();
    expect(JSON.parse(resp.result.content[0].text).code).toBe('INVALID_ARGUMENT');
    expect(resp.result.isError).toBe(true);
  });
});

describe('P4 MCP — 超时映射', () => {
  it('timeoutMs → code=TIMEOUT 的结构化失败 (不是把错误吞掉后回成功)', async () => {
    // 用一个"永不返回"的命令函数替换命令组 (只为稳定触发超时; 不碰磁盘, 不改任何状态),
    // 以此证明 MCP 是把 P3 的超时兜底当**结构化失败**往外给, 而不是静默回落成成功。
    const original = GROUP_COMMANDS.network;
    GROUP_COMMANDS.network = () => new Promise<never>(() => { /* 永挂起 */ });
    try {
      const { result, envelope } = await call('bolloon_network_status', { timeoutMs: 20 });
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe('TIMEOUT');
      expect(envelope.next_action).toBe('retry_same_request');
      expect(result.isError).toBe(true);
    } finally {
      GROUP_COMMANDS.network = original;
    }
  });

  it('环境变量 BOLLOON_MCP_TIMEOUT_MS 作为默认超时 (客户端不给 timeoutMs 时也生效)', async () => {
    const original = GROUP_COMMANDS.agent;
    process.env.BOLLOON_MCP_TIMEOUT_MS = '20';
    GROUP_COMMANDS.agent = () => new Promise<never>(() => { /* 永挂起 */ });
    try {
      const { envelope } = await call('bolloon_agent_manifest');
      expect(envelope.code).toBe('TIMEOUT');
    } finally {
      GROUP_COMMANDS.agent = original;
      delete process.env.BOLLOON_MCP_TIMEOUT_MS;
    }
  });
});

describe('P4 MCP — 7 个 resource 真读', () => {
  it('bolloon://wallet/policy: 读到的是策略信封 (只读, 无私钥字段)', async () => {
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 20, method: 'resources/read', params: { uri: 'bolloon://wallet/policy' } });
    const env = JSON.parse(resp.result.contents[0].text);
    expect(resp.result.contents[0].mimeType).toBe('application/json');
    expect(env.ok).toBe(true);
    expect(typeof env.data.perTransactionLimit).toBe('number');
    expect(JSON.stringify(env)).not.toMatch(/privateKey|mnemonic/);
  });

  it('bolloon://network/status: 未入网时信封里就是 ok:false (资源也不把失败读成成功)', async () => {
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 21, method: 'resources/read', params: { uri: 'bolloon://network/status' } });
    const env = JSON.parse(resp.result.contents[0].text);
    expect(env.ok).toBe(false);
    expect(env.code).toBe('NETWORK_NOT_JOINED');
  });

  it('bolloon://network/capabilities: 两份 P3 信封的投影 (标注 sources/composed)', async () => {
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 22, method: 'resources/read', params: { uri: 'bolloon://network/capabilities' } });
    const env = JSON.parse(resp.result.contents[0].text);
    expect(env.data.composed).toBe(true);
    expect(env.data.sources).toContain('bolloon agent manifest');
    expect(Array.isArray(env.data.localCapabilities)).toBe(true);
  });

  it('bolloon://tasks/recent + bolloon://trades/recent: 真读到本地交易 (含结算口径)', async () => {
    writeTx({ transactionId: 'tx-p4test-0006', requestId: 'treq-p4test0006' });
    const t: any = await handleMessage({ jsonrpc: '2.0', id: 23, method: 'resources/read', params: { uri: 'bolloon://trades/recent' } });
    const env = JSON.parse(t.result.contents[0].text);
    expect(env.ok).toBe(true);
    expect(env.data.count).toBeGreaterThan(0);
    expect(env.data.trades[0].settlement).toBe('local-dev');
    expect(env.data.trades[0].success).toBe(false);
  });

  it('bolloon://skill/current: 读到 skills/bolloon-network/SKILL.md 原文 (markdown)', async () => {
    const resp: any = await handleMessage({ jsonrpc: '2.0', id: 24, method: 'resources/read', params: { uri: 'bolloon://skill/current' } });
    expect(resp.result.contents[0].mimeType).toBe('text/markdown');
    expect(resp.result.contents[0].text).toContain('bolloon-network');
    expect(resp.result.contents[0].text).toContain('bolloon-task/1');
  });
});

describe('P4 MCP — stdio 事件循环 (真读真写流)', () => {
  it('一行一条 JSON-RPC: 握手 → tools/list → 真调用 → 失败调用; 解析坏行给 -32700 且继续跑', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let buf = '';
    output.on('data', (d) => { buf += String(d); });

    const running = serveStdio({ input, output, announce: false });
    const send = (o: unknown) => input.write(`${JSON.stringify(o)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    input.write('这不是 JSON\n');
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bolloon_agent_manifest', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bolloon_agent_discover', arguments: { query: 'no-such-capability-p4' } } });
    input.end();

    const code = await running;
    expect(code).toBe(0);

    const lines = buf.trim().split('\n').map((l) => JSON.parse(l));
    // 通知不回响应; 坏行回 -32700; 其余 4 条按请求顺序
    expect(lines.map((l) => l.id)).toEqual([1, null, 2, 3, 4]);
    expect(lines[0].result.protocolVersion).toBe('2025-06-18');
    expect(lines[1].error.code).toBe(JSONRPC.PARSE_ERROR);
    expect(lines[2].result.tools.length).toBe(24);
    expect(lines[3].result.isError).toBe(false);
    // ★ 失败调用: JSON-RPC 层成功返回 result, 但 isError=true + 信封 ok:false + code
    const failing = JSON.parse(lines[4].result.content[0].text);
    expect(lines[4].error).toBeUndefined();
    expect(lines[4].result.isError).toBe(true);
    expect(failing.ok).toBe(false);
    expect(failing.code).toBe('CAPABILITY_NOT_FOUND');
  });

  it('toolResult: isError 严格等于信封 ok 的取反 (无中间态)', () => {
    expect(toolResult(okEnvelope('OK', 'ok')).isError).toBe(false);
    expect(toolResult(failEnvelope('NOT_FOUND', '没找到')).isError).toBe(true);
  });
});
