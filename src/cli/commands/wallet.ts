/**
 * wallet.ts — P3 `bolloon wallet status|policy|set-policy|sign`
 *
 * 薄包装 (不重实现):
 *   status     → 读 `~/.bolloon/wallet.json` (**只读**; 绝不为了看一眼状态就创建钱包) + `economic-policy` 配置 + 签名审计账本摘要
 *   policy     → `economic-policy.LocalEconomicPolicy` (load 后读 config/dailySpent)
 *   set-policy → 同上 + `updateConfig()` + 落盘 (`~/.bolloon/economic-policy.json`)
 *   sign       → **2026-09-21 (P3 收尾)**: 用本机钱包签一段 payload; 唯一放行闸 = `task-contract.authorizeWalletSignature`
 *                (fail-closed), 每次签名写 `~/.bolloon/wallet-signatures.jsonl` 审计账本。
 *
 * 红线 (P1 §5.5 / §5.6): **私钥绝不进 stdout/日志** (本文件里私钥只活在局部变量里, 不进任何返回值/data);
 * 审计账本只记摘要字段 (payload 只记 sha256); `wallet sign` 也**不代付款** —— 它只签名, 不放钱。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  type CliFlags, type CommandResult, type Code, type NextAction,
  okEnvelope, failEnvelope,
  line, title, hint, plain, opt, optAll,
} from '../protocol-envelope.js';

export const WALLET_USAGE = `
${title('bolloon wallet')}
  bolloon wallet status [--json]               钱包可用性 + 策略 + 最近签名审计 (只读; 不创建钱包)
  bolloon wallet policy [--json]               当前支付策略 (单笔/日限额/白名单/速率)
  bolloon wallet set-policy --per-tx 1 --daily 10 [--allow-service research] [--allow-recipient 0x..] [--rate-limit 5]
  bolloon wallet sign --payload "<文本>" [--mode agent-authorized|autonomous|policy|manual] \\
      [--capability <c>] [--amount <USDC 人类单位>] [--network <net>] [--per-tx <原子>] [--daily <原子>]

选项: --json · --quiet · --request-id <id> · --timeout <ms>
说明: wallet sign 必须过放行闸 (fail-closed): 需要本机显式授权 (签名策略文件 ~/.bolloon/signing-policy.json 的
      agentAuthorized=true, 或环境变量 BOLLOON_AGENT_AUTHORIZED=1) + 自主模式 + 本机钱包 + 网络/能力/额度/不重复。
      **绝不输出私钥**; 审计写 ~/.bolloon/wallet-signatures.jsonl (只记摘要)。
`;

const walletFile = (): string => path.join(process.env.HOME || os.homedir(), '.bolloon', 'wallet.json');

/**
 * 只读探测钱包 (不创建)。存在性检查与地址读取都走文件, 不调 `loadOrCreateWallet`
 * —— 那是**写路径** (没有就生成新钱包), 不该被一条 status 查询触发。
 */
function readWallet(): { present: boolean; address: string | null; hasKey: boolean; error?: string } {
  const f = walletFile();
  if (!fs.existsSync(f)) return { present: false, address: null, hasKey: false };
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const addr = typeof j?.address === 'string' && j.address ? j.address : null;
    const hasKey = typeof j?.privateKey === 'string' && j.privateKey.length > 0;
    // ★ 私钥连读都不往外带 (它只在本机进程里用)
    return { present: !!addr, address: addr, hasKey };
  } catch (e: any) {
    return { present: false, address: null, hasKey: false, error: `wallet.json 读不出来: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/** 策略读取: 用类实例 + 显式 await load (getEconomicPolicy() 的 load 是不 await 的, 一次性 CLI 会读到默认值) */
async function loadPolicy(): Promise<import('../../agents/economic-policy.js').LocalEconomicPolicy> {
  const { LocalEconomicPolicy } = await import('../../agents/economic-policy.js');
  const p = new LocalEconomicPolicy();
  // 注意 (如实标注): load() 内含 resetIfNewDay() → 跨天时会**落盘**一份默认配置
  // (`~/.bolloon/economic-policy.json`)。这是既有服务自身的行为 (Runtime 每次读策略也一样), 不是 CLI 另加的写。
  await p.load();
  return p;
}

export async function walletCommand(flags: CliFlags): Promise<CommandResult> {
  const sub = flags.positionals[0];
  switch (sub) {
    case 'status': return walletStatus(flags);
    case 'policy': return walletPolicy(flags);
    case 'set-policy': return walletSetPolicy(flags);
    case 'sign': return walletSign(flags);
    default:
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', sub ? `未知 wallet 子命令: ${sub}` : '缺少 wallet 子命令', { usage: plain(WALLET_USAGE.trim()) }, [], 'needs_human'),
        human: WALLET_USAGE,
      };
  }
}

async function walletStatus(flags: CliFlags): Promise<CommandResult> {
  const w = readWallet();
  const policy = await loadPolicy();
  const cfg = policy.config();
  const spent = await policy.dailySpent();
  const { readSignatureAudit } = await import('../../agents/task-contract.js');
  const audit = await readSignatureAudit(undefined, 5);

  const data = {
    walletAvailable: w.present,
    address: w.address,                       // 公开地址 (收款用); **私钥永不出现**
    privateKeyPrinted: false,
    walletFile: '~/.bolloon/wallet.json',
    readOnly: true,
    walletFileError: w.error || null,
    policy: {
      perTransactionLimit: cfg.perTransactionLimit,
      dailyLimit: cfg.dailyLimit,
      allowedRecipients: cfg.allowedRecipients,
      allowedServices: cfg.allowedServices,
      rateLimitPerMinute: cfg.rateLimitPerMinute,
      dailySpent: spent,
      source: '~/.bolloon/economic-policy.json (缺文件 = 保守默认值)',
    },
    signatureAudit: {
      file: '~/.bolloon/wallet-signatures.jsonl',
      recent: audit.map((a) => ({ at: a.at, kind: a.kind, mode: a.mode, requestId: a.requestId, taskId: a.taskId || null, signerFingerprint: a.signerFingerprint })),
    },
  };
  const human = [
    title('bolloon wallet status'),
    line('钱包可用', w.present ? '是 (地址已就绪)' : '否 —— 本机还没有钱包 (首次 x402 付款时自动生成)'),
    ...(w.address ? [line('地址', w.address)] : []),
    line('私钥', '未输出 (只在本机进程可用; 这条命令是只读的)'),
    line('单笔上限', `${cfg.perTransactionLimit} USDC`),
    line('日限额', `${cfg.dailyLimit} USDC (今日已用 ${spent})`),
    line('白名单', `收款方 ${cfg.allowedRecipients.length ? cfg.allowedRecipients.join(', ') : '(全部)'} · 服务 ${cfg.allowedServices.length ? cfg.allowedServices.join(', ') : '(全部)'}`),
    line('速率', `${cfg.rateLimitPerMinute}/min`),
    line('签名审计', `${audit.length} 条 (最近; 只给摘要, 无正文/无私钥)`),
    ...(w.error ? [line('说明', w.error)] : []),
  ].join('\n');
  if (!w.present) {
    // §3 WALLET_UNAVAILABLE (放行闸 walletAvailable=false): 说清现状与下一步, 不编造地址
    return {
      envelope: failEnvelope('WALLET_UNAVAILABLE', '本机还没有可用钱包 (wallet.json 不存在或不可读)', data, [], 'needs_human'),
      human: `${human}\n\n${hint('下一步: 钱包在首次 x402 付款时自动生成 (~/.bolloon/wallet.json, 0600); 或 bolloon model / bolloon setup 先跑一遍初始化。策略见 bolloon wallet policy')}`,
    };
  }
  return {
    envelope: okEnvelope('OK', `钱包可用 (${String(w.address).slice(0, 10)}…), 策略: 单笔 ≤ ${cfg.perTransactionLimit} / 日 ≤ ${cfg.dailyLimit}`, data, w.address ? [String(w.address)] : [], null),
    human,
  };
}

async function walletPolicy(flags: CliFlags): Promise<CommandResult> {
  const policy = await loadPolicy();
  const cfg = policy.config();
  const spent = await policy.dailySpent();
  const data = { ...cfg, dailySpent: spent, source: '~/.bolloon/economic-policy.json (缺文件 = 保守默认值)' };
  return {
    envelope: okEnvelope('OK', `支付策略: 单笔 ≤ ${cfg.perTransactionLimit}, 日 ≤ ${cfg.dailyLimit} (今日已用 ${spent})`, data, [], null),
    human: [
      title('bolloon wallet policy'),
      line('单笔上限', `${cfg.perTransactionLimit} USDC`),
      line('每日预算', `${cfg.dailyLimit} USDC (今日已用 ${spent})`),
      line('允许收款方', cfg.allowedRecipients.length ? cfg.allowedRecipients.join(', ') : '(全部)'),
      line('允许服务', cfg.allowedServices.length ? cfg.allowedServices.join(', ') : '(全部)'),
      line('速率', `${cfg.rateLimitPerMinute}/min`),
      `\n  ${hint('改: bolloon wallet set-policy --per-tx 1 --daily 10 [--allow-service research]')}`,
    ].join('\n'),
  };
}

async function walletSetPolicy(flags: CliFlags): Promise<CommandResult> {
  const patch: Record<string, unknown> = {};
  const perTx = opt(flags, '--per-tx');
  const daily = opt(flags, '--daily');
  const rate = opt(flags, '--rate-limit');
  const recipients = optAll(flags, '--allow-recipient');
  const services = optAll(flags, '--allow-service');
  if (perTx !== undefined) patch.perTransactionLimit = Number(perTx);
  if (daily !== undefined) patch.dailyLimit = Number(daily);
  if (rate !== undefined) patch.rateLimitPerMinute = Number(rate);
  if (recipients.length) patch.allowedRecipients = recipients;
  if (services.length) patch.allowedServices = services;

  if (!Object.keys(patch).length) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '没有要改的字段', { usage: plain(WALLET_USAGE.trim()), accepted: ['--per-tx', '--daily', '--rate-limit', '--allow-recipient', '--allow-service'] }, [], 'needs_human'),
      human: `${WALLET_USAGE}\n${hint('示例: bolloon wallet set-policy --per-tx 0.05 --daily 0.1 --allow-service research')}`,
    };
  }
  const bad = Object.entries(patch).filter(([, v]) => typeof v === 'number' && !Number.isFinite(v as number));
  if (bad.length) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', `数值不合法: ${bad.map(([k]) => k).join(', ')}`, { patch }, [], 'needs_human'),
      human: `${title('bolloon wallet set-policy')}\n  数值不合法: ${bad.map(([k]) => k).join(', ')}`,
    };
  }

  const policy = await loadPolicy();
  const before = policy.config();
  policy.updateConfig(patch as any);
  await policy.save();                       // 落盘: 与 recordSpend/resetIfNewDay 同一份文件格式
  const after = policy.config();
  const spent = await policy.dailySpent();
  const data = { before, after, changed: patch, dailySpent: spent, file: '~/.bolloon/economic-policy.json', sourceCommand: 'economic-policy.LocalEconomicPolicy.updateConfig + save' };
  return {
    envelope: okEnvelope('POLICY_UPDATED', `策略已更新: 单笔 ≤ ${after.perTransactionLimit}, 日 ≤ ${after.dailyLimit}`, data, [], null),
    human: [
      title('bolloon wallet set-policy'),
      line('单笔上限', `${before.perTransactionLimit} → ${after.perTransactionLimit}`),
      line('每日预算', `${before.dailyLimit} → ${after.dailyLimit}`),
      line('速率', `${before.rateLimitPerMinute} → ${after.rateLimitPerMinute}/min`),
      line('允许收款方', after.allowedRecipients.length ? after.allowedRecipients.join(', ') : '(全部)'),
      line('允许服务', after.allowedServices.length ? after.allowedServices.join(', ') : '(全部)'),
      line('落地文件', '~/.bolloon/economic-policy.json'),
      `\n  ${hint('注意: 这是系统级闸门; 任务级闸门 (M1 0.05/0.02/0.10) 独立生效, 两层都过才放行')}`,
    ].join('\n'),
  };
}

// ── sign (P3 收尾: 受控自主签名, 唯一放行闸 = authorizeWalletSignature) ────────

/** 本机签名授权策略文件 (它是**本机用户**的显式授权; CLI 参数不能凭空授予) */
const signingPolicyFile = (): string => path.join(process.env.HOME || os.homedir(), '.bolloon', 'signing-policy.json');

export interface LocalSigningPolicy {
  agentAuthorized: boolean;
  allowedNetworks?: string[];
  allowedCapabilities?: string[];
  maxPerTxAtomic?: string;
  dailyLimitAtomic?: string;
  source: string;
  fileError?: string;
}

/**
 * 读本机签名授权策略。**唯一**两个授权来源:
 *   ① `~/.bolloon/signing-policy.json` 的 `agentAuthorized: true`
 *   ② 环境变量 `BOLLOON_AGENT_AUTHORIZED=1` (本机进程显式开启)
 * 命令行参数只能**收紧** (取更小限额 / 白名单交集), **不能**授予权限。
 */
export function readSigningPolicy(): LocalSigningPolicy {
  const out: LocalSigningPolicy = {
    agentAuthorized: String(process.env.BOLLOON_AGENT_AUTHORIZED || '') === '1',
    source: String(process.env.BOLLOON_AGENT_AUTHORIZED || '') === '1' ? 'env BOLLOON_AGENT_AUTHORIZED=1' : 'default (未授权)',
  };
  try {
    const f = signingPolicyFile();
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j?.agentAuthorized === true) { out.agentAuthorized = true; out.source = `${f} (agentAuthorized=true)`; }
      if (Array.isArray(j?.allowedNetworks)) out.allowedNetworks = j.allowedNetworks.map(String);
      if (Array.isArray(j?.allowedCapabilities)) out.allowedCapabilities = j.allowedCapabilities.map(String);
      if (typeof j?.maxPerTxAtomic === 'string') out.maxPerTxAtomic = j.maxPerTxAtomic;
      if (typeof j?.dailyLimitAtomic === 'string') out.dailyLimitAtomic = j.dailyLimitAtomic;
    }
  } catch (e: any) {
    out.fileError = String(e?.message || e).slice(0, 160);
  }
  return out;
}

const ATOMIC = /^[0-9]+$/;
/** 取更小的原子额度 (夹紧, 不放大) */
const minAtomic = (a?: string, b?: string): string | undefined => {
  const ok = (v?: string) => !!v && ATOMIC.test(v);
  if (!ok(a)) return ok(b) ? b : undefined;
  if (!ok(b)) return a;
  return BigInt(a!) <= BigInt(b!) ? a : b;
};

/** 人类单位 → 原子单位 (0 / 非法 / 超精度 → null) */
function toAtomicHuman(human: string, decimals = 6): string | null {
  const s = String(human ?? '').trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) return null;
  return BigInt(i + (f + '0'.repeat(decimals)).slice(0, decimals)).toString();
}

async function walletSign(flags: CliFlags): Promise<CommandResult> {
  const payload = opt(flags, '--payload') || opt(flags, '--message') || flags.positionals.slice(1).join(' ').trim();
  if (!payload) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 --payload (要签什么)', { usage: plain(WALLET_USAGE.trim()), accepted: ['--payload "<文本>"'] }, [], 'needs_human'),
      human: `${WALLET_USAGE}\n${hint('示例: BOLLOON_AGENT_AUTHORIZED=1 bolloon wallet sign --payload "order-42" --capability research --amount 0.01')}`,
    };
  }

  const { isPaymentMode, authorizeWalletSignature, recordSignatureAudit, readSignatureAudit } = await import('../../agents/task-contract.js');
  const { payloadDigest, fingerprintOf } = await import('../../agents/local-signer.js');

  const modeRaw = opt(flags, '--mode') || 'agent-authorized';
  if (!isPaymentMode(modeRaw)) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', `--mode 非法: ${modeRaw} (要 manual|policy|autonomous|agent-authorized)`, { mode: modeRaw }, [], 'needs_human'),
      human: WALLET_USAGE,
    };
  }
  const capability = opt(flags, '--capability') || 'wallet.sign';
  const network = opt(flags, '--network') || 'base-sepolia';
  const currency = String(opt(flags, '--currency') || 'USDC').toUpperCase();
  const amountHuman = opt(flags, '--amount');
  const amountAtomic = amountHuman === undefined ? '0' : (toAtomicHuman(amountHuman, currency === 'ETH' ? 18 : 6) ?? '');
  if (amountAtomic === '') {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', `--amount 不是合法正数 (收到 ${amountHuman}); 原子单位由本命令换算`, { amount: amountHuman, currency }, [], 'needs_human'),
      human: WALLET_USAGE,
    };
  }

  // 幂等键: 同一个 payload 派生出同一个 requestId (同一请求只签一次); 也可 --request-id 原样指定
  const { createHash } = await import('crypto');
  const requestId = flags.requestId || `wsig-${createHash('sha256').update(`${payload}|${capability}|${amountAtomic}`).digest('hex').slice(0, 16)}`;

  // 本机策略 (只能收紧)
  const pol = readSigningPolicy();
  const cliPerTx = opt(flags, '--per-tx');
  const cliDaily = opt(flags, '--daily');
  const maxPerTxAtomic = minAtomic(pol.maxPerTxAtomic, cliPerTx && ATOMIC.test(cliPerTx) ? cliPerTx : undefined);
  const dailyLimitAtomic = minAtomic(pol.dailyLimitAtomic, cliDaily && ATOMIC.test(cliDaily) ? cliDaily : undefined);

  // 今日已签额度 + 已签过的 requestId (都来自审计账本: 只记摘要, 无正文)
  const audit = await readSignatureAudit(undefined, 1000);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const today = audit.filter((a) => a.at >= todayStart.getTime());
  const spentTodayAtomic = today.reduce((acc, a) => acc + (/^[0-9]+$/.test(String(a.amountAtomic || '')) ? BigInt(String(a.amountAtomic)) : 0n), 0n).toString();
  const signedRequestIds = audit.map((a) => a.requestId);

  const w = readWallet();
  const decision = authorizeWalletSignature({
    mode: modeRaw,
    agentAuthorized: pol.agentAuthorized,
    walletAvailable: w.present && w.hasKey,
    network,
    capability,
    requestId,
    amountAtomic,
    allowedNetworks: pol.allowedNetworks,
    allowedCapabilities: pol.allowedCapabilities,
    maxPerTxAtomic,
    dailyLimitAtomic,
    spentTodayAtomic,
    signedRequestIds,
  });

  if (!decision.allowed) {
    // fail-closed: 逐条映射成 §3 的码 (绝不"再试一次就放行")
    const c = decision.checks;
    let code: Code = 'POLICY_DENIED';
    let next: NextAction = 'needs_human';
    if (c.agentAuthorized === false) { code = 'AGENT_NOT_AUTHORIZED'; next = 'needs_human'; }
    else if (c.walletAvailable === false) { code = 'WALLET_UNAVAILABLE'; next = 'needs_human'; }
    else if (c.notDuplicate === false) { code = 'DUPLICATE_REQUEST'; next = null; }
    else if (c.modeIsAutonomous === false) { code = 'PAYMENT_REQUIRED'; next = 'approve_payment'; }
    else if (c.amountIsInteger === false || c.underPerTx === false || c.underDaily === false) { code = 'BUDGET_EXCEEDED'; next = 'raise_budget'; }
    else { code = 'POLICY_DENIED'; next = 'needs_human'; }
    const data = {
      allowed: false, reason: decision.reason, checks: decision.checks,
      requestId, mode: modeRaw, capability, network, amountAtomic,
      walletAvailable: w.present && w.hasKey, walletFile: '~/.bolloon/wallet.json',
      signingPolicy: { agentAuthorized: pol.agentAuthorized, source: pol.source, allowedNetworks: pol.allowedNetworks ?? null, allowedCapabilities: pol.allowedCapabilities ?? null, maxPerTxAtomic: maxPerTxAtomic ?? null, dailyLimitAtomic: dailyLimitAtomic ?? null },
      spentTodayAtomic,
      signed: false, privateKeyPrinted: false, paid: false,
      note: '放行闸拒绝: 没有签名、没有写审计、没有付款 (fail-closed)',
    };
    const howTo: Record<string, string> = {
      AGENT_NOT_AUTHORIZED: '要让本机 Agent 自主签名: 写 ~/.bolloon/signing-policy.json {"agentAuthorized":true,...} 或设 BOLLOON_AGENT_AUTHORIZED=1',
      WALLET_UNAVAILABLE: '本机还没有钱包 (~/.bolloon/wallet.json; 首次 x402 付款时自动生成)',
      DUPLICATE_REQUEST: `这个 requestId 已经签过了 (${requestId}); 同一请求只签一次`,
      PAYMENT_REQUIRED: 'manual/policy 模式要人工放行, 不走自主签名闸',
      BUDGET_EXCEEDED: '降金额, 或放宽 --per-tx/--daily 与策略文件里的额度',
      POLICY_DENIED: '网络/能力不在允许列表 (signing-policy.json 的 allowedNetworks/allowedCapabilities)',
    };
    return {
      envelope: failEnvelope(code, decision.reason || '拒绝签名', data, [requestId], next),
      human: [
        title('bolloon wallet sign'),
        line('结果', `拒绝 (${code})`),
        line('原因', decision.reason || ''),
        line('逐条检查', Object.entries(decision.checks).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')),
        line('怎么放行', howTo[code] || '(见 checks)'),
        line('本次签名', '没有'),
        line('本次付款', '没有'),
      ].join('\n'),
    };
  }

  // ★ 真签名: 私钥只在这几行里存在 (局部变量, 不返回、不打印、不落盘)
  let signature = '';
  let address = String(w.address || '');
  let selfVerified: boolean | null = null;
  let signError: string | null = null;
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const raw = JSON.parse(fs.readFileSync(walletFile(), 'utf8'));
    const pk = String(raw?.privateKey || '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('wallet.json 里没有可用的私钥字段 (格式不对)');
    const account = privateKeyToAccount(pk as `0x${string}`);
    address = account.address;
    signature = await account.signMessage({ message: payload });
    // 现场自检: 用地址把签名验回来 (签名不是"打印出来就算数")
    const viem = await import('viem');
    selfVerified = await (viem as any).verifyMessage({ address: account.address, message: payload, signature });
  } catch (e: any) {
    signError = String(e?.message || e).slice(0, 200);
  }
  if (!signature) {
    return {
      envelope: failEnvelope('WALLET_UNAVAILABLE', `钱包签名失败: ${signError}`,
        { allowed: true, checks: decision.checks, requestId, walletFile: '~/.bolloon/wallet.json', privateKeyPrinted: false, signature: null, paid: false }, [requestId], 'needs_human'),
      human: `${title('bolloon wallet sign')}\n  签名失败: ${signError}\n  (放行闸过了, 但钱包模块没签出来 —— 如实报, 没有假装签过)`,
    };
  }

  // ★ 审计: 只记摘要 (payload 只记 sha256; 绝不记正文/私钥)
  const digest = payloadDigest(payload);
  await recordSignatureAudit({
    kind: 'wallet_payload',
    mode: modeRaw,
    requestId,
    taskId: opt(flags, '--task-id'),
    amountAtomic,
    currency,
    network,
    capability,
    signerFingerprint: fingerprintOf(address),
    payloadDigest: digest,
  });

  const data = {
    allowed: true,
    checks: decision.checks,
    requestId,
    mode: modeRaw,
    capability,
    network,
    amountAtomic,
    spentTodayAtomic: (BigInt(spentTodayAtomic) + BigInt(amountAtomic)).toString(),
    address,                                          // 公开地址
    signerFingerprint: fingerprintOf(address),
    signature,                                        // 签名 (公开材料)
    algorithm: 'eip191 personal_sign (viem/accounts)',
    payloadDigest: digest,
    payloadBytes: Buffer.byteLength(payload, 'utf8'),
    payloadPrinted: false,                            // 正文不输出 (只给摘要)
    selfVerified,
    auditFile: '~/.bolloon/wallet-signatures.jsonl',
    privateKeyPrinted: false,
    paid: false,
    note: '只签名, 不放钱; 私钥全程只在本机进程的局部变量里',
  };
  return {
    envelope: okEnvelope('WALLET_SIGNED', `已用本机钱包签名 (${String(address).slice(0, 10)}…, 自检=${selfVerified === true ? '通过' : '未通过'})`,
      data, [requestId, String(address), `payload:${digest.slice(0, 16)}`], null),
    human: [
      title('bolloon wallet sign'),
      line('结果', '已签名 (放行闸 9 条全过)'),
      line('地址', address),
      line('指纹', fingerprintOf(address)),
      line('算法', 'eip191 personal_sign'),
      line('签名', `${signature.slice(0, 24)}… (${signature.length} 字符)`),
      line('payload 摘要', `${digest} (${Buffer.byteLength(payload, 'utf8')} 字节; 正文未输出)`),
      line('自检验签', selfVerified === true ? '通过 (用地址验回来了)' : '未通过'),
      line('审计', '已写 ~/.bolloon/wallet-signatures.jsonl (只记摘要)'),
      line('私钥', '未输出 (绝不进 stdout/日志)'),
      line('本次付款', '没有 (只签名)'),
    ].join('\n'),
  };
}
