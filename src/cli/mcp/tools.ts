/**
 * tools.ts — MCP 的 tools / resources 定义 (17 个 P4 tool + 7 个 P6 链只读 tool + 3 个 P6b 链写 tool = 27; 7 + 3 = 10 resource)
 *
 * 设计纪律 (P4 任务书 + `docs/wiki/agent-access-layer.md` §1):
 *   ① **一个 tool = 一条 P3 子命令**。这里只做两件事: 校验入参 (白名单 + 类型)、
 *      拼出等价于 CLI 的 argv。**没有任何业务判断** (不算钱、不判成败、不写盘、不发付款)。
 *   ② **客户端给的是具名参数, 不是 argv** —— 参数名走白名单, 未知参数一律 `INVALID_ARGUMENT`。
 *      由此它**不可能**注入 `--private-key` / `--mode` / `--force` 之类选项去绕过政策 (§六条禁止)。
 *   ③ 值里不许以 `-` 开头 (防"值 = 选项"注入)。
 *   ④ 没实现的 P3 子命令 (`task send|inbox|accept|reject|complete|cancel` · `network leave` ·
 *      `chain trade expire`)
 *      **不暴露成 tool**: 暴露了就得在 MCP 层假装成功, 那正好违反"失败不得变成功"。
 *      需要它们的能力时, MCP 侧应直接读 P3 的 `C_NOT_IMPLEMENTED` 说明 (见 §NOT_EXPOSED)。
 *   ⑤ ★ 链上**写** tool (`bolloon_chain_trade_create|submit_proof|release`) 是真签名 + 真移钱,
 *      所以额外有两条: **授权意图参数必须显式携带** (缺 → `NOT_AUTHORIZED`, 见 `requireWriteIntent`),
 *      以及**真签名只能由本机唯一放行闸 `authorizeWalletSignature` 产生** —— MCP 层不复制、不旁路。
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { failEnvelope, type Envelope } from '../protocol-envelope.js';
import { currentPackageRoot } from '../../utils/version-info.js';
import { callP3, type BridgeOptions } from './bridge.js';
import type { ServiceGroup } from '../commands/index.js';
// 授权意图词表**只有一份** (task-contract 的冻结口径) —— 这里 import 它, 不另抄一份
import { PAYMENT_MODES, isPaymentMode } from '../../agents/task-contract.js';

/** MCP tool 的入参 schema (JSON Schema 子集; 与 MCP spec 的 inputSchema 同形) */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: boolean;
}

export interface ToolPlan {
  group: ServiceGroup;
  argv: string[];
  opts?: BridgeOptions;
}

export type BuildResult = { ok: true; plan: ToolPlan } | { ok: false; envelope: Envelope };

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: ToolInputSchema;
  /** 入参 → P3 命令 argv (不合法时给 `INVALID_ARGUMENT`, 绝不猜) */
  build(args: Record<string, unknown>): BuildResult;
}

// ── 入参校验 (唯一入口; 客户端**不能**直接给 argv) ────────────────────────────

const MAX_LEN = 4000;

class Params {
  private seen = new Set<string>();
  private bad: string[] = [];

  constructor(private args: Record<string, unknown>, private allowed: readonly string[]) {}

  private touch(key: string): void {
    this.seen.add(key);
  }

  str(key: string, opts: { required?: boolean; maxLen?: number } = {}): string | undefined {
    this.touch(key);
    const v = this.args[key];
    if (v === undefined || v === null || v === '') {
      if (opts.required) this.bad.push(`缺少必填参数 '${key}'`);
      return undefined;
    }
    if (typeof v !== 'string') {
      this.bad.push(`参数 '${key}' 必须是字符串 (收到 ${typeof v})`);
      return undefined;
    }
    if (v.startsWith('-')) {
      this.bad.push(`参数 '${key}' 不许以 '-' 开头 (防"值当成命令选项"注入命令行)`);
      return undefined;
    }
    if (v.length > (opts.maxLen ?? MAX_LEN)) {
      this.bad.push(`参数 '${key}' 太长 (> ${opts.maxLen ?? MAX_LEN} 字符)`);
      return undefined;
    }
    return v;
  }

  /** 正数 (金额/限额这类: 只收**字符串**形式的十进制, 与 P3 的原子单位口径一致) */
  strNumber(key: string, opts: { required?: boolean } = {}): string | undefined {
    const v = this.str(key, opts);
    if (v === undefined) return undefined;
    if (!/^\d+(\.\d+)?$/.test(v)) {
      this.bad.push(`参数 '${key}' 必须是正的十进制数字串 (如 "0.05"), 收到 ${JSON.stringify(v)}`);
      return undefined;
    }
    return v;
  }

  /** 整数毫秒 (tool 超时) */
  intMs(key: string): number | undefined {
    this.touch(key);
    const v = this.args[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      this.bad.push(`参数 '${key}' 必须是正整数 (毫秒)`);
      return undefined;
    }
    return Math.floor(v);
  }

  /** 正整数 (秒/计数这类非毫秒的整数参数) */
  intPos(key: string): number | undefined {
    this.touch(key);
    const v = this.args[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      this.bad.push(`参数 '${key}' 必须是正整数`);
      return undefined;
    }
    return Math.floor(v);
  }

  bool(key: string): boolean {
    this.touch(key);
    const v = this.args[key];
    if (v === undefined || v === null) return false;
    if (typeof v !== 'boolean') {
      this.bad.push(`参数 '${key}' 必须是布尔值`);
      return false;
    }
    return v;
  }

  /** 字符串数组 (也接受逗号分隔的单串) */
  strList(key: string): string[] {
    this.touch(key);
    const v = this.args[key];
    if (v === undefined || v === null || v === '') return [];
    const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : null);
    if (!list) {
      this.bad.push(`参数 '${key}' 必须是字符串数组或逗号分隔的字符串`);
      return [];
    }
    const out: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) {
        this.bad.push(`参数 '${key}' 里每一项都必须是非空字符串`);
        continue;
      }
      const s = item.trim();
      if (s.startsWith('-')) {
        this.bad.push(`参数 '${key}' 的值不许以 '-' 开头`);
        continue;
      }
      out.push(s);
    }
    return out;
  }

  /** 任意 JSON 对象 (task run 的 --input) */
  obj(key: string): unknown {
    this.touch(key);
    const v = this.args[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'object') {
      this.bad.push(`参数 '${key}' 必须是 JSON 对象/数组`);
      return undefined;
    }
    return v;
  }

  /** 白名单之外的一律拒 (这是"不能注入选项"的机制保证) */
  finish(): Envelope | null {
    const unknown = Object.keys(this.args).filter((k) => !this.allowed.includes(k));
    if (unknown.length) this.bad.push(`不认识的参数: ${unknown.join(', ')} (只接受: ${this.allowed.join(', ')})`);
    if (!this.bad.length) return null;
    return failEnvelope(
      'INVALID_ARGUMENT',
      `MCP tool 入参不合法: ${this.bad.join('; ')}`,
      { issues: this.bad, acceptedParams: [...this.allowed] },
      [],
      'needs_human',
    );
  }

  /** 全局项 (超时 / 幂等键) —— 幂等键只在该 tool 声明了 `requestId` 时才透传 */
  opts(): BridgeOptions {
    const o: BridgeOptions = {};
    if (this.allowed.includes('requestId')) {
      const rid = this.str('requestId', { maxLen: 512 });
      if (rid) o.requestId = rid;
    }
    const t = this.intMs(TIMEOUT_KEY);
    if (t) o.timeoutMs = t;
    return o;
  }
}

/** 统一收尾: 校验通过 → plan; 不通过 → INVALID_ARGUMENT 信封 (不抛异常, 不给半成品) */
function plan(p: Params, group: ServiceGroup, argv: string[]): BuildResult {
  const opts = p.opts();          // 先解析全局项 (类型错与其它问题一起报)
  const err = p.finish();
  if (err) return { ok: false, envelope: err };
  return { ok: true, plan: Object.keys(opts).length ? { group, argv, opts } : { group, argv } };
}

const TIMEOUT_KEY = 'timeoutMs';
const TIMEOUT_PROP = { type: 'integer', minimum: 1, description: '本次调用的硬超时 (毫秒); 超时返回 P3 信封 code=TIMEOUT (不是"打印一行错误就退出")' };

// ── ★ 链上**写** tool 的授权意图 (硬要求 ②) ──────────────────────────────────

const PAYMENT_MODE_LIST = PAYMENT_MODES.join(' | ');

/**
 * 写 tool (`bolloon_chain_trade_create|submit_proof|release`) 的**授权意图声明**校验。
 *
 * 硬要求: 调用方必须**显式**给出 `paymentMode` **与** `requestId`
 *   · 缺任何一个 → `NOT_AUTHORIZED` (fail-closed, **绝不默认放行**, 也不替调用方猜)
 *   · 给了但值非法 → `INVALID_ARGUMENT`
 *
 * ★ 为什么这不等于"在 MCP 层另开一道闸": 这里只校验"声明齐不齐 / 词表合不合法",
 *   **不判**"能不能签"。`paymentMode` 只被翻译成 CLI 的 `--payment-mode`, 真正放不放行
 *   仍由本机唯一放行闸 `authorizeWalletSignature` (fail-closed) 决定 ——
 *   它的 `modeIsAutonomous` 只认 `autonomous` / `agent-authorized`, 所以声明
 *   `manual` / `policy` 会被闸直接拒。即: 声明**只能收紧, 不可能放权**。
 */
function requireWriteIntent(args: Record<string, unknown>): { ok: true } | { ok: false; envelope: Envelope } {
  const mode = args.paymentMode;
  const rid = args.requestId;
  const missing: string[] = [];
  if (mode === undefined || mode === null || mode === '') missing.push('paymentMode');
  if (rid === undefined || rid === null || rid === '') missing.push('requestId');
  if (missing.length) {
    return {
      ok: false,
      envelope: failEnvelope(
        'NOT_AUTHORIZED',
        `链上写操作必须显式声明授权意图, 缺: ${missing.join(' + ')}。MCP 层 fail-closed —— 声明缺失不默认放行。`,
        {
          missing,
          requiresExplicitAuthorization: true,
          acceptedPaymentModes: [...PAYMENT_MODES],
          why: '链上写 = 真签名 + 真移钱: 调用方必须先自己确认本机钱包已授权按该意图签名; MCP 不代你假定已授权',
        },
        [],
        'needs_human',
      ),
    };
  }
  if (typeof mode !== 'string' || !isPaymentMode(mode.trim())) {
    return {
      ok: false,
      envelope: failEnvelope(
        'INVALID_ARGUMENT',
        `paymentMode 非法: ${JSON.stringify(mode).slice(0, 60)} (要 ${PAYMENT_MODE_LIST})`,
        { paymentMode: typeof mode === 'string' ? mode.slice(0, 60) : typeof mode, accepted: [...PAYMENT_MODES] },
        [],
        'needs_human',
      ),
    };
  }
  return { ok: true };
}

/** 3 个链上写 tool 共用的参数说明 (口径一致, 不各写一套) */
const WRITE_INTENT_PROPS = {
  paymentMode: { type: 'string', enum: [...PAYMENT_MODES], description: `★ 必填: 授权意图 —— 声明按哪种支付模式签这笔链上写 (${PAYMENT_MODE_LIST})。缺它 → NOT_AUTHORIZED (fail-closed)。manual/policy 会被本机放行闸直接拒` },
  requestId: { type: 'string', description: '★ 必填: 显式幂等/授权键 (本次声明的 id)。它参与放行闸 requestId 的确定性派生: 同一个 requestId 重复声明 → 闸按 notDuplicate 拒 (同一次意图只签一次)' },
} as const;

// ── 17 个 tool ──────────────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  {
    name: 'bolloon_network_join',
    title: '加入 Bolloon 网络',
    description:
      '加入网络 (幂等)。给 link 就按链接加入 (orbitdb:// / ipns:// / https://.../registry); 不给 link 走文档驱动的全球入网。' +
      '返回 P3 信封: code=NETWORK_JOINED 才是真加入; ok:false 一律别当成功读。' +
      '硬约束: 本 tool 只调 `bolloon network join` 服务层, 不复制逻辑; 私钥永不参与, 也不返回。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        link: { type: 'string', description: '入网链接 (不给则走全球入网文档)' },
        name: { type: 'string', description: '本节点在网络里的名字' },
        url: { type: 'string', description: '覆盖入网文档地址' },
        capabilities: { type: 'array', items: { type: 'string' }, description: '要声明的能力 (如 ["research","data"])' },
        timeoutMs: TIMEOUT_PROP,
      },
    },
    build(args) {
      const p = new Params(args, ['link', 'name', 'url', 'capabilities', TIMEOUT_KEY]);
      const argv = ['join'];
      const link = p.str('link', { maxLen: 2048 });
      if (link) argv.push(link);
      const name = p.str('name', { maxLen: 200 });
      if (name) argv.push('--name', name);
      const url = p.str('url', { maxLen: 2048 });
      if (url) argv.push('--url', url);
      const caps = p.strList('capabilities');
      if (caps.length) argv.push('--capabilities', caps.join(','));
      return plan(p, 'network', argv);
    },
  },
  {
    name: 'bolloon_network_status',
    title: '本机入网态',
    description:
      '只读: DID / 已加入网络 / P2P 是否在线 / manifest / registry 状态。' +
      '本机没入网时给 code=NETWORK_NOT_JOINED + next_action=rejoin_network (不是"网络上没人")。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { timeoutMs: TIMEOUT_PROP } },
    build(args) {
      const p = new Params(args, [TIMEOUT_KEY]);
      return plan(p, 'network', ['status']);
    },
  },
  {
    name: 'bolloon_agent_register',
    title: '声明能力 (注册服务)',
    description:
      '把自己的一项能力登记进 registry (落 ~/.bolloon/agent-registry.json)。' +
      '只写**服务声明**; 不碰钱包、不发付款、不伪造信誉。成功码 AGENT_REGISTERED。' +
      '注意: manifest 是进程内结构 (agent-manifest-protocol 不落盘), register 不写 manifest。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['capability'],
      properties: {
        capability: { type: 'string', description: '要声明的能力名 (如 research)' },
        name: { type: 'string', description: '显示名 (默认 bolloon-agent)' },
        price: { type: 'string', description: '单价 (十进制串, 如 "0.05")' },
        per: { type: 'string', description: '计价单位 (默认 query)' },
        description: { type: 'string', description: '服务说明' },
        wallet: { type: 'string', description: '收款地址 (公开地址; 绝不是私钥)' },
        endpoint: { type: 'string', description: '服务端点' },
        timeoutMs: TIMEOUT_PROP,
      },
    },
    build(args) {
      const p = new Params(args, ['capability', 'name', 'price', 'per', 'description', 'wallet', 'endpoint', TIMEOUT_KEY]);
      const cap = p.str('capability', { required: true, maxLen: 200 });
      const argv = ['register'];
      if (cap) argv.push('--capability', cap);
      const name = p.str('name', { maxLen: 200 });
      if (name) argv.push('--name', name);
      const price = p.strNumber('price');
      if (price) argv.push('--price', price);
      const per = p.str('per', { maxLen: 40 });
      if (per) argv.push('--per', per);
      const desc = p.str('description', { maxLen: 500 });
      if (desc) argv.push('--description', desc);
      const wallet = p.str('wallet', { maxLen: 200 });
      if (wallet) argv.push('--wallet', wallet);
      const endpoint = p.str('endpoint', { maxLen: 512 });
      if (endpoint) argv.push('--endpoint', endpoint);
      // ★ 不接受任何私钥类入参 (钱包只收公开地址); 命中的键名一律在上面白名单外被拒
      return plan(p, 'agent', argv);
    },
  },
  {
    name: 'bolloon_agent_discover',
    title: '按能力发现服务',
    description:
      '只读: 在 registry 里按能力/关键字找服务 (OrbitDB 优先, 离线回退本地文件)。' +
      '找不到给 code=CAPABILITY_NOT_FOUND + next_action=redefine_capability; ' +
      '发现是只读的 (重试安全), **绝不因为找不到就发起付款**。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { type: 'string', description: '能力名或关键字' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['query', TIMEOUT_KEY]);
      const q = p.str('query', { required: true, maxLen: 200 });
      return plan(p, 'agent', q ? ['discover', q] : ['discover']);
    },
  },
  {
    name: 'bolloon_agent_manifest',
    title: '本进程 manifest',
    description:
      '只读: 本进程的 manifest (agents/capabilities) + 远端 manifest 缓存数。' +
      '如实标注 scope=in-process / persisted=false —— 一次性 stdio 进程里读到空是正常的, 不等于本机没注册过。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { timeoutMs: TIMEOUT_PROP } },
    build(args) {
      const p = new Params(args, [TIMEOUT_KEY]);
      return plan(p, 'agent', ['manifest']);
    },
  },
  {
    name: 'bolloon_task_run',
    title: '跑一个任务 (M1 唯一入口)',
    description:
      '买能力 + 执行 + 报告卡 (与 `bolloon task "<任务>" --budget 0.05` 同一条服务路径 task-runner.runTask)。' +
      '预算硬上限由服务层钳制 (budget ≤ 0.05 / perPurchase ≤ 0.02 / daily ≤ 0.10), MCP 层不放大也不绕过。' +
      '★ local-dev 最多给 TASK_COMPLETED + next_action=verify_result —— 链上没动钱, **绝不说成 TASK_VERIFIED**。' +
      '同一 requestId 重发是幂等的 (不会产生第二笔付款)。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        task: { type: 'string', description: '任务正文 (私有, 不进公开投影)' },
        budget: { type: 'string', description: '总预算 (十进制串, 服务层上限 0.05)' },
        perPurchase: { type: 'string', description: '单笔上限 (默认上限 0.02)' },
        daily: { type: 'string', description: '日上限 (默认上限 0.10)' },
        requestId: { type: 'string', description: '幂等键 (不给就由契约层确定性派生)' },
        input: { type: 'object', description: '任务输入 (JSON 对象)' },
        timeoutMs: TIMEOUT_PROP,
      },
    },
    build(args) {
      const p = new Params(args, ['task', 'budget', 'perPurchase', 'daily', 'requestId', 'input', TIMEOUT_KEY]);
      const task = p.str('task', { required: true, maxLen: MAX_LEN });
      const argv = ['run'];
      if (task) argv.push(task);
      const budget = p.strNumber('budget');
      if (budget) argv.push('--budget', budget);
      const per = p.strNumber('perPurchase');
      if (per) argv.push('--per-purchase', per);
      const daily = p.strNumber('daily');
      if (daily) argv.push('--daily', daily);
      const input = p.obj('input');
      if (input !== undefined) argv.push('--input', JSON.stringify(input));
      return plan(p, 'task', argv);
    },
  },
  {
    name: 'bolloon_task_list',
    title: '本地任务/交易一览',
    description:
      '只读: 本地交易记录 + Goal 一览 (只给 id/状态/结算事实, **不含任务正文**)。' +
      '每条都带 `settlement` 口径 (chain / local-dev / none) 与 `success` (§7.1 判据)。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { requestId: { type: 'string', description: '只看这个幂等键的交易' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['requestId', TIMEOUT_KEY]);
      return plan(p, 'task', ['list']);
    },
  },
  {
    name: 'bolloon_task_status',
    title: '任务/交易状态',
    description:
      '只读: 按 transactionId / requestId / goalId 查状态。成功判据 = status=verified ∧ 支付事实 ∈ {fully_settled, payment_verified}。' +
      '`paying` + 事实未定 → code=PAYMENT_PENDING + next_action=reconcile (**先对账, 绝不重付**)。' +
      'local-dev 记录出现在 verified → 如实报 LOCAL_DEV_NOT_CHAIN (不顺着说成功)。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: 'transactionId / requestId / goalId' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['id', TIMEOUT_KEY]);
      const id = p.str('id', { required: true, maxLen: 512 });
      return plan(p, 'task', id ? ['status', id] : ['status']);
    },
  },
  {
    name: 'bolloon_task_result',
    title: '交付证据 (不输出正文)',
    description:
      '只读: 交付是否在盘 / 字节数 / 各类哈希 / 验真分档。' +
      '★ **交付正文绝不出本机** (P1 §5.6 私有层): 只给哈希与在盘证明 (`bodyPrinted:false`)。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: 'transactionId (或 requestId)' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['id', TIMEOUT_KEY]);
      const id = p.str('id', { required: true, maxLen: 512 });
      return plan(p, 'task', id ? ['result', id] : ['result']);
    },
  },
  {
    name: 'bolloon_task_retry',
    title: '恢复计划 (不发付款)',
    description:
      '★ **只出计划, 绝不代付款**: 走 `x402/payment-recovery.planTransactionRecovery` (唯一决策点), 返回 `paid:false` + `mustNotRepay`。' +
      '付款不确定时 next_action=reconcile —— 顺序永远是"先对账, 再决定 retry"。' +
      '真正付款只能由**持钱包的一方**走同一 requestId 的幂等路径, MCP 层不持有也不调用支付能力。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: 'transactionId / requestId / goalId' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['id', TIMEOUT_KEY]);
      const id = p.str('id', { required: true, maxLen: 512 });
      return plan(p, 'task', id ? ['retry', id] : ['retry']);
    },
  },
  {
    name: 'bolloon_wallet_status',
    title: '钱包可用性 + 策略 (只读)',
    description:
      '只读: 钱包是否存在 (地址是公开的收款地址) / 单笔与日限额 / 白名单 / 最近签名审计摘要。' +
      '★ **绝不返回私钥、助记词、seed**; 本 tool 也不创建钱包 (不为了看一眼状态就生成新钱包)。' +
      '模型侧改策略的能力**没有**通过 MCP 暴露 (见 §NOT_EXPOSED)。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { timeoutMs: TIMEOUT_PROP } },
    build(args) {
      const p = new Params(args, [TIMEOUT_KEY]);
      return plan(p, 'wallet', ['status']);
    },
  },
  {
    name: 'bolloon_payment_pending',
    title: '待放行的付款',
    description:
      '只读: 列出在等你放行的付款请求 (~/.bolloon/payment-approvals.json)。' +
      '有 pending 时 next_action=approve_payment —— 这是**正确表达**, 不是错误也不是重试信号。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { timeoutMs: TIMEOUT_PROP } },
    build(args) {
      const p = new Params(args, [TIMEOUT_KEY]);
      return plan(p, 'payment', ['pending']);
    },
  },
  {
    name: 'bolloon_payment_approve',
    title: '批准一笔待放行付款 (不发付款)',
    description:
      '★ **只改审批状态, 不发起付款** (CLI/MCP 都不持有钱包; 真正支付由持钱包的一方/executor 执行, 返回里 `paid` 字段如实反映)。' +
      '批准**不能**绕过 payment policy: 放行闸 `authorizeWalletSignature` (9 项, fail-closed) 仍在支付路径上, 这里碰不到它。' +
      '无用户授权时 MCP **不许**切自主支付 —— 本 tool 没有"改模式/授权"的参数, 这是刻意的。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['approvalId'],
      properties: { approvalId: { type: 'string', description: '审批 id (来自 bolloon_payment_pending)' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['approvalId', TIMEOUT_KEY]);
      const id = p.str('approvalId', { required: true, maxLen: 512 });
      return plan(p, 'payment', id ? ['approve', id] : ['approve']);
    },
  },
  {
    name: 'bolloon_payment_reject',
    title: '拒绝一笔待放行付款',
    description: '只改审批状态为拒绝; 拒绝后不会付款, 同一 requestId 的幂等保护仍在。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['approvalId'],
      properties: { approvalId: { type: 'string', description: '审批 id' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['approvalId', TIMEOUT_KEY]);
      const id = p.str('approvalId', { required: true, maxLen: 512 });
      return plan(p, 'payment', id ? ['reject', id] : ['reject']);
    },
  },
  {
    name: 'bolloon_trade_list',
    title: '交易一览',
    description: '只读: 本地交易记录一览 (lifecycle + settlementFact + settlement 口径 + 事件数), 按口径分开写 (chain / local-dev / none)。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { requestId: { type: 'string', description: '只看这个幂等键的交易' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['requestId', TIMEOUT_KEY]);
      return plan(p, 'trade', ['list']);
    },
  },
  {
    name: 'bolloon_trade_show',
    title: '单笔交易原文',
    description:
      '只读: 单笔交易记录 (状态 + 结算事实 + 哈希 + 事件链 + 责任候选 + 争议), **只读不写, 绝不修改交易历史**。' +
      '付款回执原文属私有层 → 只给 `paymentReceiptPresent: boolean`, 原文不出本机。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: 'transactionId (或 requestId)' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['id', TIMEOUT_KEY]);
      const id = p.str('id', { required: true, maxLen: 512 });
      return plan(p, 'trade', id ? ['show', id] : ['show']);
    },
  },
  {
    name: 'bolloon_trade_reconcile',
    title: '单笔对账 / 恢复计划 (只读, 不发付款)',
    description:
      '给 transactionId → 单笔恢复计划 (`planTransactionRecovery`, 唯一决策点, **只读**, `paid:false`)。' +
      '★ 无 id 的**全局对账**不在 MCP 暴露: 那份实现 (`reconcilePendingTransactions`) 会钉结算事实/改状态/清死锁 —— ' +
      '那是本机运维动作 (`bolloon trade reconcile`), 不是给远端 Agent 的。' +
      '★ 顺序铁律: 先 reconcile, 再决定 retry。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['transactionId'],
      properties: { transactionId: { type: 'string', description: '要出恢复计划的那笔交易' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['transactionId', TIMEOUT_KEY]);
      const id = p.str('transactionId', { required: true, maxLen: 512 });
      return plan(p, 'trade', id ? ['reconcile', id] : ['reconcile']);
    },
  },

  // ── P6: 链上能力 (7 个只读/本地缓存 tool; 全部薄包装 `bolloon chain ...`) ──────
  {
    name: 'bolloon_chain_status',
    title: '链配置 + 可达性 + 钱包可用性 (只读)',
    description:
      '只读: chainId / RPC / escrow 与 token 地址 / 确认数门槛 (confirmed=1, finalized=12) / RPC 是否可达 / ' +
      '合约 bytecode / 钱包是否可用 (只给**公开地址**与余额, 私钥永不返回、永不打印)。' +
      '★ 链未配置 → code=CHAIN_NOT_CONFIGURED (列出缺哪些); RPC 不可达 → CHAIN_UNAVAILABLE (绝不报成 0 余额/空状态)。' +
      '★ local-dev (chainId 31337) 永不产出 fully_settled。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { timeoutMs: TIMEOUT_PROP } },
    build(args) {
      const p = new Params(args, [TIMEOUT_KEY]);
      return plan(p, 'chain', ['status']);
    },
  },
  {
    name: 'bolloon_chain_escrow_show',
    title: '读链上 escrow (只读)',
    description:
      '只读: 按 taskKey 读 `AgentEscrow` 里的 escrow 19 字段 (state = ACTIVE|RELEASED|DISPUTED|REFUNDED, 金额, buyer/agent, ' +
      '各 hash, deadline, proofVersion)。' +
      '★ 「链上没有」(ESCROW_NOT_FOUND) 与「读不到」(CHAIN_UNAVAILABLE) 是两个码 —— 读不到绝不当成不存在。' +
      '★ `state=RELEASED` 只是链上事实, 不等于本机已 verified (判据是 receipt + 事件 + 确认数)。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskKey'],
      properties: { taskKey: { type: 'string', description: '链上 taskKey (0x + 64 hex, keccak256 域标签派生)' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['taskKey', TIMEOUT_KEY]);
      const k = p.str('taskKey', { required: true, maxLen: 80 });
      return plan(p, 'chain', k ? ['escrow', 'show', k] : ['escrow', 'show']);
    },
  },
  {
    name: 'bolloon_chain_timeline',
    title: 'taskKey 链上时间线 (只读)',
    description:
      '只读: 本机索引里该 taskKey 的**链上事件时间线** (块号/logIndex 升序, 每条带 finality: ' +
      'observed(确认数 < confirmed) / confirmed(≥1) / finalized(≥12)) + 本机视角 (chain-state.json 的 create/proof/release)。' +
      '据此可重建 create → proof → release。' +
      '★ 有被回退的记录 → code=REORG_SUSPECTED (绝不报成功); 索引里没有 → ESCROW_NOT_FOUND (先 `bolloon_chain_index_sync`)。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskKey'],
      properties: { taskKey: { type: 'string', description: '链上 taskKey (0x + 64 hex)' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['taskKey', TIMEOUT_KEY]);
      const k = p.str('taskKey', { required: true, maxLen: 80 });
      return plan(p, 'chain', k ? ['timeline', k] : ['timeline']);
    },
  },
  {
    name: 'bolloon_chain_index_status',
    title: '索引高度 / 最后同步 (只读)',
    description:
      '只读: 本机链上事件索引的高度 (lastSyncedBlock)、最后同步时间、事件数/suspect 数、索引起点 (部署块与来源)、' +
      '确认数门槛、reorgDepth。**不发 RPC** (只读本机索引文件); 从未同步时 synced=false (不假装有数据)。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { timeoutMs: TIMEOUT_PROP } },
    build(args) {
      const p = new Params(args, [TIMEOUT_KEY]);
      return plan(p, 'chain', ['index', 'status']);
    },
  },
  {
    name: 'bolloon_chain_index_stats',
    title: '链上事件统计 (只读)',
    description:
      '只读: tasks / created / proof / released / refunded / disputed / expired 计数 + finality 分档 + 事件名直方图。' +
      '★ suspect (被回退) 的记录**不计入**业务计数, 单独报出 —— 统计不是链上事实, 判据永远是 receipt/事件/确认数。',
    inputSchema: { type: 'object', additionalProperties: false, properties: { timeoutMs: TIMEOUT_PROP } },
    build(args) {
      const p = new Params(args, [TIMEOUT_KEY]);
      return plan(p, 'chain', ['index', 'stats']);
    },
  },
  {
    name: 'bolloon_chain_index_sync',
    title: '增量同步链上事件到本机索引 (只写本地缓存)',
    description:
      '★ 只做一件事: 从**本机上次同步高度 +1** 到当前 head 用 `eth_getLogs` 分页扫 v2 事件, 落 `~/.bolloon/chain/index.json`。' +
      '**不动钱、不碰私钥、不改交易记录、不写结算事实** (索引是可删可重建的缓存, 不是事实源)。' +
      '起点来自部署 manifest 的 deployment block (不猜 0); 检出重组 → 记录标 suspect 且 code=REORG_SUSPECTED (不静默丢弃)。' +
      '★ 索引身份 (chainId + escrowAddress + 部署块) 与当前链不一致 (换过合约部署/anvil 重启) → **不扫不写**, ' +
      '报 `INDEX_IDENTITY_CHANGED` + next_action=needs_human (这不是重组); 修法 `bolloon chain index rebuild` (干净重建)。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { fromBlock: { type: 'string', description: '可选: 从这一块起补扫 (十进制块号, 不给=增量)' }, timeoutMs: TIMEOUT_PROP },
    },
    build(args) {
      const p = new Params(args, ['fromBlock', TIMEOUT_KEY]);
      const argv = ['index', 'sync'];
      const from = p.strNumber('fromBlock');
      if (from) argv.push('--from-block', from);
      return plan(p, 'chain', argv);
    },
  },
  {
    name: 'bolloon_chain_trade_recover',
    title: '链上交易恢复状态 (只读, 不发交易)',
    description:
      '★ **纯读盘** (~/.bolloon/chain/chain-state.json): 按 taskId / taskKey 重建本机链上事实, 给出 nextAction ' +
      '(create_escrow / submit_proof / release / verify_only / done / needs_human) 与 mustNotRepay。' +
      '**不发交易、不重付、不自动退款、不碰私钥** (链上写操作一律必须由本机持钱包的一方执行)。' +
      '★ 有被标可疑的记录 → REORG_SUSPECTED; 结论未定 → CHAIN_UNCERTAIN + next_action=reconcile (不确定绝不报成功)。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: '任务 id (与 create 时同一个; 派生 taskKey)' },
        taskKey: { type: 'string', description: '或直接给链上 taskKey (0x + 64 hex)' },
        timeoutMs: TIMEOUT_PROP,
      },
    },
    build(args) {
      const p = new Params(args, ['taskId', 'taskKey', TIMEOUT_KEY]);
      const taskId = p.str('taskId', { maxLen: 512 });
      const taskKey = p.str('taskKey', { maxLen: 80 });
      const argv = ['trade', 'recover'];
      if (taskId) argv.push('--task-id', taskId);
      else if (taskKey) argv.push('--task-key', taskKey);
      return plan(p, 'chain', argv);
    },
  },

  // ── P6b: 链上**写** tool (3 个) —— 与只读链 tool 的区别只有一个: 它们**真签名 + 真移钱** ──
  // 薄包装同一批 P3/P4 服务函数 (`chain trade create|submit-proof|release` → onchain-trade 的
  // createEscrowStep / submitProofStep / releaseStep), **不复制任何业务逻辑**;
  // 授权意图 (`paymentMode` + `requestId`) 必须显式携带 (见 requireWriteIntent), 失败按信封原样返回。
  {
    name: 'bolloon_chain_trade_create',
    title: '★ 真签名真移钱: 建链上 escrow (买方付款进托管)',
    description:
      '★★★ **这是真写操作: 会用本机钱包私钥真签名, 并把真 USDC 从买方打进链上 escrow 托管 (链上真 txHash)**。' +
      '等价于 `bolloon chain trade create --task-id <id> --agent <addr> --amount <USDC> --payment-mode <mode> --request-id <rid>`。' +
      '**调用方必须自己保证已授权** —— 本 tool 只声明意图, 不授予任何权限: 真签名只由本机唯一放行闸 ' +
      '`authorizeWalletSignature` (fail-closed, 9 项) 决定, 私钥永不返回、永不打印。' +
      '★ **必填** `paymentMode` 与 `requestId` (授权意图): 缺 → `NOT_AUTHORIZED`; 词表外的值 → `INVALID_ARGUMENT`; ' +
      '`manual`/`policy` → 被放行闸拒 (modeIsAutonomous); 同一个 `requestId` 重复声明 → 被闸按 notDuplicate 拒。' +
      '金额上限沿用 M1 硬约束 (单任务 0.05 / 单次购买 0.02 USDC, 与 economic-policy 三层取最小); 超了给 `BUDGET_EXCEEDED` 并指明哪一层, **不发交易**。' +
      '失败按 P3 信封原样返回 (`isError=true`), 绝不变成 MCP 成功; 链上结论未定 → `CHAIN_UNCERTAIN` + reconcile, 不确定绝不报成功。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'agent', 'amount', 'paymentMode', 'requestId'],
      properties: {
        taskId: { type: 'string', description: '任务 id —— 链上 taskKey 由它确定性派生 (keccak256 域标签 bolloon.task.v1)' },
        agent: { type: 'string', description: '卖方收款地址 (0x + 40 hex), escrow 释放后钱真打到它' },
        amount: { type: 'string', description: '托管金额 (十进制 USDC 串, 如 "0.02"); M1 单次购买上限 0.02' },
        deadline: { type: 'number', description: '托管截止时间 (unix 秒); 不给 = max(链上最新块时间, 本机时间) + 确认窗口' },
        confirmationWindow: { type: 'number', description: '买方确认窗口 (秒, 默认 3600); 过后卖方才能 claimAfterTimeout' },
        proofVersion: { type: 'number', description: 'proof 版本 (默认 1, 参与 proofHash 口径)' },
        ...WRITE_INTENT_PROPS,
        timeoutMs: TIMEOUT_PROP,
      },
    },
    build(args) {
      const intent = requireWriteIntent(args);
      if (!intent.ok) return { ok: false, envelope: intent.envelope };
      const p = new Params(args, ['taskId', 'agent', 'amount', 'deadline', 'confirmationWindow', 'proofVersion', 'paymentMode', 'requestId', TIMEOUT_KEY]);
      const taskId = p.str('taskId', { required: true, maxLen: 512 });
      const agent = p.str('agent', { required: true, maxLen: 80 });
      const amount = p.strNumber('amount', { required: true });
      const paymentMode = p.str('paymentMode', { required: true, maxLen: 40 });
      const argv = ['trade', 'create'];
      if (taskId) argv.push('--task-id', taskId);
      if (agent) argv.push('--agent', agent);
      if (amount) argv.push('--amount', amount);
      if (paymentMode) argv.push('--payment-mode', paymentMode);
      const deadline = p.intPos('deadline');
      if (deadline !== undefined) argv.push('--deadline', String(deadline));
      const win = p.intPos('confirmationWindow');
      if (win !== undefined) argv.push('--confirmation-window', String(win));
      const pv = p.intPos('proofVersion');
      if (pv !== undefined) argv.push('--proof-version', String(pv));
      return plan(p, 'chain', argv);
    },
  },
  {
    name: 'bolloon_chain_trade_submit_proof',
    title: '★ 真签名真上链: 提交交付证明 (seller 侧)',
    description:
      '★★★ **这是真写操作: 会用**本机钱包**私钥真签名, 把交付结果摘要 (`resultHash`) 真上链 (`submitProofV2`, 链上真 txHash)**。' +
      '等价于 `bolloon chain trade submit-proof --task-id <id> --result <正文|sha256:hex> --payment-mode <mode> --request-id <rid>`。' +
      '常由**卖方节点**执行 (合约要求 `msg.sender == escrow.agent`); 只有当调用方就是本机钱包持有人时才可能成功。' +
      '**调用方必须自己保证已授权**; 缺 `paymentMode`/`requestId` → `NOT_AUTHORIZED`, 放行闸拒 → `NOT_AUTHORIZED` 且**不发交易、不碰私钥**。' +
      '★ 这一步**不动钱** (escrow 仍在 ACTIVE) —— 别把它的成功读成"已结算"。' +
      '失败按信封原样返回 (`isError=true`); 未定 → `CHAIN_UNCERTAIN` (不确定绝不报成功)。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'result', 'paymentMode', 'requestId'],
      properties: {
        taskId: { type: 'string', description: '任务 id (与 create 时必须同一个; 派生 taskKey)' },
        result: { type: 'string', description: '交付结果正文或 "sha256:<hex>" 摘要 (链上 resultHash 的来源, 只上链摘要不含正文)' },
        manifestDigest: { type: 'string', description: '可选: manifest 摘要 (正文 或 "sha256:<hex>")' },
        ...WRITE_INTENT_PROPS,
        timeoutMs: TIMEOUT_PROP,
      },
    },
    build(args) {
      const intent = requireWriteIntent(args);
      if (!intent.ok) return { ok: false, envelope: intent.envelope };
      const p = new Params(args, ['taskId', 'result', 'manifestDigest', 'paymentMode', 'requestId', TIMEOUT_KEY]);
      const taskId = p.str('taskId', { required: true, maxLen: 512 });
      const result = p.str('result', { required: true, maxLen: MAX_LEN });
      const paymentMode = p.str('paymentMode', { required: true, maxLen: 40 });
      const argv = ['trade', 'submit-proof'];
      if (taskId) argv.push('--task-id', taskId);
      if (result) argv.push('--result', result);
      const manifest = p.str('manifestDigest', { maxLen: MAX_LEN });
      if (manifest) argv.push('--manifest-digest', manifest);
      if (paymentMode) argv.push('--payment-mode', paymentMode);
      return plan(p, 'chain', argv);
    },
  },
  {
    name: 'bolloon_chain_trade_release',
    title: '★ 真签名真移钱: 释放托管 (钱真打到 seller)',
    description:
      '★★★ **这是真写操作: 会用本机钱包私钥真签名, 把 escrow 里的 USDC 真释放给 seller (`releaseV2`, 链上真 txHash, 钱真到账)**。' +
      '等价于 `bolloon chain trade release --task-id <id> --payment-mode <mode> --request-id <rid>`。' +
      '**调用方必须自己保证已授权** —— 声明只是声明, 真签名只由本机放行闸 `authorizeWalletSignature` (fail-closed) 决定; ' +
      '缺 `paymentMode`/`requestId` → `NOT_AUTHORIZED` (不默认放行), 闸拒 → `NOT_AUTHORIZED` 且钱**没动**。' +
      '★ 只有全过 (事件对上 + 合约 RELEASED + 确认数达标) 才 `grantsVerified=true`; 没过一律 `CHAIN_UNCERTAIN` (不许标 verified)。' +
      '失败按信封原样返回 (`isError=true`), 绝不变成 MCP 成功。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'paymentMode', 'requestId'],
      properties: {
        taskId: { type: 'string', description: '任务 id (与 create 时必须同一个; 派生 taskKey)' },
        ...WRITE_INTENT_PROPS,
        timeoutMs: TIMEOUT_PROP,
      },
    },
    build(args) {
      const intent = requireWriteIntent(args);
      if (!intent.ok) return { ok: false, envelope: intent.envelope };
      const p = new Params(args, ['taskId', 'paymentMode', 'requestId', TIMEOUT_KEY]);
      const taskId = p.str('taskId', { required: true, maxLen: 512 });
      const paymentMode = p.str('paymentMode', { required: true, maxLen: 40 });
      const argv = ['trade', 'release'];
      if (taskId) argv.push('--task-id', taskId);
      if (paymentMode) argv.push('--payment-mode', paymentMode);
      return plan(p, 'chain', argv);
    },
  },
];

/** tool 名 → 定义 */
export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * **刻意不暴露**的 P3/P6 子命令 (暴露 = 必须在 MCP 层假装成功, 违反"失败不得变成功"):
 *   task complete · task cancel → P3 里如实报 `C_NOT_IMPLEMENTED` (没有可写的任务状态存储/交易层无 cancelled)
 *   task send · task inbox · task accept · task reject → **写操作** (DID 签名 + 落本机台账 + 对外发帧),
 *     不在本轮的 17 个冻结清单里; 要纳入 MCP 必须单独裁决 (它会改变本机对外承诺, 不是只读能力)
 *   network leave → 仓库里不存在 leaveNetwork
 *   network init / peers · agent inspect · trade events · wallet policy(只读) / set-policy
 *     → 前几个是"本机节点生命周期/本地诊断", 不该给远端 Agent 调;
 *       **wallet set-policy 尤其不暴露** —— 让远端 Agent 改支付策略 = 绕过 payment policy (六条禁止之一)。
 *   ★ P6 追加: `bolloon chain trade create|submit-proof|release` 曾是「不暴露」——
 *     现已改为**暴露为 MCP 写 tool (3 个)**, 但代价条件全部保留并加固 (2026-09-22 leo 拍板):
 *       · 唯一放行闸不变: 仍然只走 `sendChainTxGuarded` → `authorizeWalletSignature` (fail-closed),
 *         MCP 层**没有**任何旁路, 也不复制判钱/签发逻辑;
 *       · 每个写 tool **强制显式携带授权意图** (`paymentMode` + `requestId`): 缺 → `NOT_AUTHORIZED`,
 *         非法 → `INVALID_ARGUMENT` (绝不默认放行);
 *       · 失败一律按 P3 信封原样返回 (`isError=true`), 不洗成 MCP 成功;
 *       · 私钥/任务正文不打印、不落盘; 审计仍写 `~/.bolloon/wallet-signatures.jsonl`;
 *       · 金额上限沿用 M1 硬约束 (0.05 / 0.02 / 0.10, 与 economic-policy 三层取最小)。
 *   `bolloon chain trade expire` **不暴露**: 仓库里没有这条子命令 (合约侧有 expireV2, CLI 未接) ——
 *     暴露了就得在 MCP 层假装成功。
 *   `bolloon chain index sync` 例外地暴露: 它只读链 (eth_getLogs) 并刷新本机**可删可重建**的索引缓存,
 *     不动钱、不碰私钥、不改交易记录/结算事实 —— 不构成"本机运维写动作"。
 */
export const NOT_EXPOSED: Array<{ command: string; reason: string }> = [
  { command: 'bolloon task complete|cancel', reason: 'P3 如实报 C_NOT_IMPLEMENTED (没有可写的任务状态存储 / 交易层无 cancelled); 暴露会逼 MCP 层假装成功' },
  { command: 'bolloon task send|inbox|accept|reject', reason: '写操作 (签名 + 落本机台账 + 对外发帧), 不在 P4 的 17 个冻结清单里; 纳入 MCP 需单独裁决' },
  { command: 'bolloon network leave', reason: '仓库没有 leaveNetwork; P3 报 C_NOT_IMPLEMENTED' },
  { command: 'bolloon trade reconcile (无 id 的全局对账)', reason: '会钉结算事实/改状态/清死锁 = 写交易记录; 属本机运维 (bolloon trade reconcile), MCP 只给单笔只读计划' },
  { command: 'bolloon network init|peers', reason: '本机节点生命周期 / 本进程 peer 列表, 不是给远端 Agent 的能力' },
  { command: 'bolloon wallet set-policy', reason: '远端改支付策略 = 绕过 payment policy (六条禁止); 必须由本机用户执行' },
  { command: 'bolloon agent inspect / trade events', reason: '诊断/审计视角; 等有明确外部需求再按同一薄包装方式加' },
  { command: 'bolloon chain trade expire', reason: '仓库里**没有**这条子命令 (合约侧有 permissionless expireV2, CLI 未接) —— 暴露会逼 MCP 层假装成功; 要暴露先把 CLI 子命令实现出来' },
];

// ── 10 个 resource ──────────────────────────────────────────────────────────

export interface ResourcePayload {
  uri: string;
  mimeType: string;
  text: string;
  /** 构成这份资源的 P3 信封的 `ok` (只读资源一般恒 true; 失败时客户端从文本里的信封读 code) */
  ok: boolean;
}

export interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  load(): Promise<ResourcePayload>;
}

/** 一个"信封资源": 内容 = P3 信封原样 JSON (含 ok/code/next_action, 绝不改写成 MCP 成功) */
async function envelopeResource(uri: string, group: ServiceGroup, argv: string[], timeoutMs?: number): Promise<ResourcePayload> {
  const env = await callP3({ group, argv, opts: timeoutMs ? { timeoutMs } : undefined });
  return { uri, mimeType: 'application/json', text: JSON.stringify(env, null, 2), ok: env.ok };
}

/** `bolloon://network/capabilities`: 由**两份 P3 信封**拼成的投影 (组合, 不是重实现) */
async function capabilitiesPayload(): Promise<ResourcePayload> {
  const [status, manifest] = await Promise.all([
    callP3({ group: 'network', argv: ['status'] }),
    callP3({ group: 'agent', argv: ['manifest'] }),
  ]);
  const data = (status.data || {}) as Record<string, any>;
  const mdata = (manifest.data || {}) as Record<string, any>;
  const gatewayCaps: string[] = Array.isArray(data.gatewayJoin?.capabilities) ? data.gatewayJoin.capabilities : [];
  const localCaps: string[] = Array.isArray(mdata.agents)
    ? Array.from(new Set((mdata.agents as any[]).flatMap((a) => (a.capabilities || []).map(String))))
    : [];
  const env: Envelope = {
    ok: status.ok && manifest.ok,
    code: status.ok && manifest.ok ? 'OK' : (status.code === 'NETWORK_NOT_JOINED' ? 'NETWORK_NOT_JOINED' : status.code),
    message: `本机能力投影: 本地 manifest ${localCaps.length} 项, 网络声明 ${gatewayCaps.length} 项 (registry ${data.registry?.ready ? '就绪' : '未就绪'}, ${data.registry?.services ?? 0} 条服务)`,
    data: {
      composed: true,
      localCapabilities: localCaps,
      gatewayCapabilities: gatewayCaps,
      registry: data.registry || null,
      joinedNetworks: Array.isArray(data.joinedNetworks) ? data.joinedNetworks.map((n: any) => ({ name: n.name, networkId: n.networkId, serviceCount: n.serviceCount })) : [],
      sources: ['bolloon network status', 'bolloon agent manifest'],
      note: '这是两份 P3 信封的投影 (只做组合, 没有重算任何业务事实); 具体服务声明请用 bolloon_agent_discover',
    },
    evidence: Array.from(new Set([...(status.evidence || []), ...(manifest.evidence || [])].map(String))),
    next_action: status.next_action ?? null,
  };
  return { uri: 'bolloon://network/capabilities', mimeType: 'application/json', text: JSON.stringify(env, null, 2), ok: env.ok };
}

/** `bolloon://skill/current`: 指向 `skills/bolloon-network/SKILL.md` (对外唯一入口说明) */
function skillCandidatePaths(): string[] {
  const here = fileURLToPath(import.meta.url);
  const out: string[] = [];
  if (process.env.BOLLOON_SKILL_PATH) out.push(process.env.BOLLOON_SKILL_PATH);
  for (const up of [['..', '..', '..'], ['..', '..'], ['..']]) {
    out.push(path.resolve(path.dirname(here), ...up, 'skills', 'bolloon-network', 'SKILL.md'));
  }
  out.push(path.resolve(process.cwd(), 'skills', 'bolloon-network', 'SKILL.md'));
  try { out.push(path.resolve(currentPackageRoot(), 'skills', 'bolloon-network', 'SKILL.md')); } catch { /* 忽略 */ }
  return out;
}

export async function skillPayload(uri: string): Promise<ResourcePayload> {
  const p = skillCandidatePaths().find((f) => { try { return fs.existsSync(f); } catch { return false; } });
  if (!p) {
    const env = failEnvelope('NOT_FOUND', '找不到 skills/bolloon-network/SKILL.md (可用 BOLLOON_SKILL_PATH 指定)', { searched: skillCandidatePaths() }, [], 'needs_human');
    return { uri, mimeType: 'application/json', text: JSON.stringify(env, null, 2), ok: false };
  }
  const text = fs.readFileSync(p, 'utf8');
  return { uri, mimeType: 'text/markdown', text, ok: true };
}

export const RESOURCES: ResourceDef[] = [
  { uri: 'bolloon://network/status', name: '本机入网态', description: 'DID / 网络 / P2P / manifest / registry (bolloon network status 的信封原样)', mimeType: 'application/json', load: () => envelopeResource('bolloon://network/status', 'network', ['status']) },
  { uri: 'bolloon://network/capabilities', name: '本机能力投影', description: '本地 manifest 能力 + 网络声明能力 + registry 状态 (两份 P3 信封的投影)', mimeType: 'application/json', load: () => capabilitiesPayload() },
  { uri: 'bolloon://agent/manifest', name: '本进程 manifest', description: 'agents/capabilities (scope=in-process, persisted=false)', mimeType: 'application/json', load: () => envelopeResource('bolloon://agent/manifest', 'agent', ['manifest']) },
  { uri: 'bolloon://tasks/recent', name: '最近任务/交易', description: '本地交易 + Goal (只给 id/状态/结算口径, 不含任务正文)', mimeType: 'application/json', load: () => envelopeResource('bolloon://tasks/recent', 'task', ['list']) },
  { uri: 'bolloon://trades/recent', name: '最近交易', description: '交易一览 (chain / local-dev / none 口径分开写)', mimeType: 'application/json', load: () => envelopeResource('bolloon://trades/recent', 'trade', ['list']) },
  { uri: 'bolloon://wallet/policy', name: '支付策略', description: '单笔/日限额 + 白名单 + 速率 + 今日已用 (只读, 无私钥)', mimeType: 'application/json', load: () => envelopeResource('bolloon://wallet/policy', 'wallet', ['policy']) },
  // ── P6: 链上能力 (信封原样; 链未配置时信封里就是 CHAIN_NOT_CONFIGURED, 不当成 MCP 成功) ──
  { uri: 'bolloon://chain/status', name: '链配置 + 可达性', description: 'chainId / RPC / 合约地址 / 确认数门槛 / 钱包可用性 (只给公开地址, 无私钥)', mimeType: 'application/json', load: () => envelopeResource('bolloon://chain/status', 'chain', ['status']) },
  { uri: 'bolloon://chain/index', name: '链上索引高度', description: '索引高度 / 最后同步时间 / 事件数 / suspect 数 (只读本机索引文件, 不发 RPC)', mimeType: 'application/json', load: () => envelopeResource('bolloon://chain/index', 'chain', ['index', 'status']) },
  { uri: 'bolloon://chain/index/stats', name: '链上事件统计', description: 'tasks/created/proof/released/refunded/disputed/expired + finality 分档 (suspect 不计入)', mimeType: 'application/json', load: () => envelopeResource('bolloon://chain/index/stats', 'chain', ['index', 'stats']) },
  { uri: 'bolloon://skill/current', name: 'bolloon-network Skill', description: 'skills/bolloon-network/SKILL.md 原文 (对外唯一入口说明)', mimeType: 'text/markdown', load: () => skillPayload('bolloon://skill/current') },
];

export const RESOURCE_BY_URI = new Map(RESOURCES.map((r) => [r.uri, r]));

/** MCP `tools/list` 的返回体 (不带内部 build 函数) */
export function listToolsPayload() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: `[${t.title}] ${t.description}`,
    inputSchema: t.inputSchema,
  }));
}

/** MCP `resources/list` 的返回体 */
export function listResourcesPayload() {
  return RESOURCES.map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType }));
}
