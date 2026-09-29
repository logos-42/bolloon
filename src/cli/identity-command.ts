/**
 * identity-command.ts — `bolloon identity init|show` (2026-09-24)
 *
 * 补的真缺口: 建本机身份以前**只有** `bolloon setup` —— 一个 readline 交互向导。
 * 没有 TTY 的环境 (CI / 容器 / ssh 管道 / 第二实例的自动化) 跑它会
 * `readline was closed` (ERR_USE_AFTER_CLOSE), 于是"新机器/第二个身份"根本建不出来,
 * 而群/任务/签名这条链全靠 `~/.bolloon/identity.json`。
 *
 * 本模块只做薄包装 (不重实现任何密钥学):
 *   · `init` — 幂等建 `~/.bolloon/identity.json` (复用 `setup-wizard.initLocalIdentity`,
 *     它内部走 `KeyManager.generate/saveToFile`, 与 `src/index.ts:bootstrapIdentity` 同一条路径);
 *     已存在 → **一个字不改** + `action:'reused'` + exit 0; 损坏 → **拒绝覆盖** (要 --force)。
 *   · `show` — 只出 did / 公钥指纹 / 文件权限; **绝不打印私钥**。
 *
 * 红线: 本模块任何路径都不把 `privateKey` 写进 stdout / data / human。
 * 兜底还有 `finalizeEnvelope` 的 `redactSecrets` (AUDIT_FORBIDDEN_KEYS 含 `privateKey`)。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  type CliFlags, type CommandResult,
  okEnvelope, failEnvelope, line, title, hint, plain, has, opt,
} from './protocol-envelope.js';
import { getLocalIdentityFile, initLocalIdentity } from './setup-wizard.js';
import { AUDIT_FORBIDDEN_KEYS } from '../agents/task-contract.js';
import { KeyManager } from '@diap/sdk';
import {
  ADDRESS_BINDING_PROTOCOL, ADDRESS_BINDING_SCHEMA_VERSION, BINDINGS_DIRNAME, BINDING_INDEX_FILENAME,
  DEFAULT_BINDING_CHAIN_ID, BINDING_ADDRESS_RE,
  bindingsDir, bindingIndexPath, newBindingNonce,
  createAddressBinding, verifyAddressBinding, payerIdentityOf,
  writeBindingRecord, readBindingRecord, readBindingIndex, rebuildBindingIndex,
  loadPayerIdentityIndex, buildPublicBindingProjection,
  shortAgentName, didShort, addressHash,
  type AddressBindingRecord,
} from '../agents/identity/address-binding.js';

export const IDENTITY_USAGE = `
${title('bolloon identity')}
  bolloon identity init [--force] [--json]
      非交互建本机身份 → ~/.bolloon/identity.json (文件模式 0600)
      字段与既有完全一致: keyType='Ed25519' · privateKey · publicKey · did · createdAt · version
      幂等: 已存在 → 一个字不改 (action=reused), 仍然 exit 0
      损坏 (读不出 did) → 拒绝覆盖 (exit 1); 确认重来加 --force (会先备份成 .bak-<时间戳>)
      **绝不打印私钥** (输出只有 did / 文件路径 / 文件权限)
  bolloon identity show [--json]
      看本机身份: did · 公钥指纹(sha256 前 16 位) · 文件权限 · 创建时间 (不含私钥)
  bolloon identity bind-address --address 0x…全小写 --address-key-file <path> [--label <名>]
                              [--did-key-file <path>] [--chain-id 8453] [--expires-at <ISO8601>]
                              [--bindings-dir <dir>] [--json]
      登记「地址 ↔ DID」绑定 (**链下登记, 可离线验签**): 同一份声明正文被**两侧**签名 ——
        · sig_did  = DID 私钥 (Ed25519, ~/.bolloon/identity.json) 对 canonical 正文签名
        · sig_addr = 该以太地址私钥 (EIP-191 personal_sign) 对**同一份**正文签名
      验证 = 两侧都过才算数 (少一侧 = 拒, 不降级)。落盘前**自验不通过就整条失败** (不留半成品)。
      红线: **没有默认钱包路径** (--address-key-file 必填, 以免手滑拿主钱包签); 私钥不进任何输出。
      名字短写: --label 会被清洗成 [A-Za-z0-9._-] + 中日文 (≤24 字符), 另有一枚 label_sig 覆盖它。
  bolloon identity bindings list   [--bindings-dir <dir>] [--json]
      列本机绑定库 (~/.bolloon/bindings): id · 名字短写 · DID 短写 · 地址(仅本机) · 链 · 签发时间
      **重验**: 每条都当场验一遍, 不通过的如实列出 (它们不会进快照)
  bolloon identity bindings show   <file> [--json]
      看一条绑定的正文/签名/判据 (地址与 DID 全文只在本机命令里出; 页面上只出短写)
  bolloon identity bindings verify <file> [--bindings-dir <dir>] [--json]
      离线复验一条绑定: 逐条列判据 (双侧签名 · 正文 canonical · did↔公钥自洽 · 时效 · nonce 一次性);
      **不过 = 非零退出码**
  bolloon identity bindings publish --out <path> [--bindings-dir <dir>] [--json]
      写出**对外投影** (显式路径): 只有短写 (name_short / did_short) + 地址哈希; 地址与完整 DID 不出

选项: --json · --quiet · --force (只对 init 有效)
说明: 只建 identity.json; 供应商/API key 仍走 bolloon setup (或 bolloon setup --provider … --api-key …);
      用户称呼/归属身份在 ~/.bolloon/identity/user.json (bolloon setup --name 写它)
`;

/** 公钥指纹 (sha256 前 16 位 hex) —— 不可逆, 不含密钥材料 */
function fingerprint(pub: string): string {
  return `sha256:${crypto.createHash('sha256').update(String(pub || '')).digest('hex').slice(0, 16)}`;
}

/** 读现有身份文件 (只取**非私密**字段; privateKey 连读都不读出来) */
async function readIdentityPublicFacts(home: string): Promise<
  { exists: false } | { exists: true; did: string | null; keyType: string | null; createdAt: string | null; version: string | null; fingerprint: string | null; keys: string[] }
> {
  const file = getLocalIdentityFile(home);
  try {
    const j = JSON.parse(await fs.readFile(file, 'utf-8'));
    const pub = typeof j?.publicKey === 'string' ? j.publicKey : null;
    return {
      exists: true,
      did: typeof j?.did === 'string' && j.did ? j.did : null,
      keyType: typeof j?.keyType === 'string' ? j.keyType : null,
      createdAt: typeof j?.createdAt === 'string' ? j.createdAt : null,
      version: typeof j?.version === 'string' ? j.version : null,
      fingerprint: pub ? fingerprint(pub) : null,
      // 只报**非私密**字段名 (schema 一致性的证据落在测试里: 那边直接读文件比对 6 个键)。
      // 私钥类字段名 (AUDIT_FORBIDDEN_KEYS: privateKey/…) 连名字都不出现在输出里 ——
      // 免得"输出里有个 privateKey 字样"被当成可疑, 也让 `grep privateKey` 这种粗检查能直接过。
      keys: Object.keys(j ?? {}).filter((k) => !AUDIT_FORBIDDEN_KEYS.includes(k)).sort(),
    };
  } catch {
    return { exists: false };
  }
}

/** `bolloon identity init` —— 幂等建本机身份 */
async function identityInit(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon identity init';
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const force = has(flags, '--force');
  let r;
  try {
    r = await initLocalIdentity(home, { force });
  } catch (e: any) {
    return {
      envelope: failEnvelope('INTERNAL_ERROR', `建身份失败: ${String(e?.message || e).slice(0, 200)}`, { file: getLocalIdentityFile(home), created: false }, [], 'needs_human'),
      human: `${title(head)}\n  建身份失败: ${String(e?.message || e).slice(0, 200)}`,
    };
  }

  if (!r.ok) {
    // 拒绝覆盖 (损坏 / force 下备份失败): 如实失败, 不静默重建
    return {
      envelope: failEnvelope('POLICY_DENIED', r.reason || '拒绝覆盖既有身份文件',
        { file: r.file, action: r.action, created: false, overwritten: false }, [], 'needs_human'),
      human: `${title(head)}\n  ${r.reason || '拒绝覆盖'}\n\n${hint('静默盖掉一个可能还能救的身份 = 丢钥匙: 本命令宁可失败')}`,
    };
  }

  const reused = r.action === 'reused';
  const facts = await readIdentityPublicFacts(home);
  const payload: Record<string, unknown> = {
    action: r.action,
    did: r.did ?? null,
    file: r.file,
    mode: r.mode ?? null,
    created: !reused,
    changed: false,
    keyMaterialInOutput: false,
    publicFields: facts.exists ? facts.keys : null,
    fingerprint: facts.exists ? facts.fingerprint : null,
    keyType: facts.exists ? facts.keyType : null,
    createdAt: facts.exists ? facts.createdAt : null,
    version: facts.exists ? facts.version : null,
    nextSteps: reused
      ? ['身份已存在, 未改动 (幂等); 直接用即可']
      : ['跑任务/建群/签名现在有身份可用: bolloon task group create --name <群名>', '要配模型供应商/API key: bolloon setup'],
  };
  return {
    envelope: okEnvelope('OK', reused
      ? `本机身份已存在, 未改动 (${String(r.did).slice(0, 24)}…)`
      : `已建本机身份 (${String(r.did).slice(0, 24)}…), 文件模式 ${r.mode}`,
      payload, [], null),
    human: [
      title(head),
      line('动作', reused ? 'reused (已存在, 一个字没改 — 幂等)' : 'created (新建)'),
      line('DID', r.did ?? '(无)'),
      line('身份文件', r.file),
      line('文件模式', r.mode ?? '(读不到)'),
      line('字段', facts.exists ? facts.keys.join(' · ') : '(无)'),
      line('公钥指纹', facts.exists ? facts.fingerprint : '(无)'),
      '',
      `  ${hint(reused ? '幂等: 第二个身份请换一个 HOME (HOME=/tmp/x bolloon identity init)' : '下一步')}`,
      ...(reused
        ? ['  要用第二个身份: `HOME=/tmp/second bolloon identity init` (每个 HOME 一对自己的密钥)']
        : ['  建群: bolloon task group create --name <群名>', '  模型/API key: bolloon setup (交互向导)']),
    ].join('\n'),
  };
}

/** `bolloon identity show` —— 看本机身份 (不含私钥) */
async function identityShow(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon identity show';
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const facts = await readIdentityPublicFacts(home);
  const file = getLocalIdentityFile(home);
  if (!facts.exists) {
    return {
      envelope: failEnvelope('NOT_FOUND', `本机还没有身份文件: ${file}`,
        { file, exists: false, howTo: 'bolloon identity init', keyMaterialInOutput: false }, [], 'needs_human'),
      human: `${title(head)}\n  本机还没有身份文件: ${file}\n\n${hint('建一个: bolloon identity init (非交互, 0600, 幂等)')}`,
    };
  }
  const payload = {
    file,
    exists: true,
    did: facts.did,
    keyType: facts.keyType,
    createdAt: facts.createdAt,
    version: facts.version,
    fingerprint: facts.fingerprint,
    publicFields: facts.keys,
    keyMaterialInOutput: false,
  };
  return {
    envelope: okEnvelope('OK', `本机身份: ${String(facts.did).slice(0, 24)}…`, payload, [], null),
    human: [
      title(head),
      line('DID', facts.did ?? '(缺 did — 文件可能损坏)'),
      line('身份文件', file),
      line('keyType', facts.keyType ?? '(无)'),
      line('version', facts.version ?? '(无)'),
      line('createdAt', facts.createdAt ?? '(无)'),
      line('公钥指纹', facts.fingerprint ?? '(无)'),
      line('非私密字段', facts.keys.join(' · ')),
      '',
      '  私钥只在本机文件里 (0600), 不进任何输出/日志',
    ].join('\n'),
  };
}

/** 命令入口 (cli-entry 用 runCommand 包它: 统一 --json/--quiet/--timeout/异常兜底) */
export async function identityCommand(flags: CliFlags): Promise<CommandResult> {
  const sub = String(flags.positionals[0] ?? '').trim().toLowerCase();
  if (sub === 'init') return identityInit(flags);
  if (sub === 'show' || sub === 'status') return identityShow(flags);
  if (sub === 'bind-address') return identityBindAddress(flags);
  if (sub === 'bindings') return identityBindings(flags);
  return {
    envelope: failEnvelope('INVALID_ARGUMENT',
      sub ? `未知 identity 子命令: ${sub}` : '缺少 identity 子命令 (init | show | bind-address | bindings)',
      { usage: plain(IDENTITY_USAGE.trim()), accepted: ['bolloon identity init', 'bolloon identity show', 'bolloon identity bind-address --address 0x… --address-key-file <path>', 'bolloon identity bindings list|show|verify|publish'] }, [], 'needs_human'),
    human: IDENTITY_USAGE,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 地址 ↔ DID 绑定登记 (`diap-address-binding/1`) —— 2026-09-29
//   让网关能把链上付款行里的**付款方地址**翻成**智能体身份**。
//   红线 (逐条都在这段代码里落实):
//     · **不默认任何钱包路径** —— `--address-key-file` 必填, 免得手滑拿主钱包签名;
//     · 私钥只在进程内用一次, **不进 stdout / 不进绑定文件 / 不进日志** (只打印地址);
//     · 绑定库的 `nonce` 一次性: 生成时先查索引, 撞了就换;
//     · 落盘前必须**自验通过**(双侧签名), 否则整条命令失败, 不留半成品。
// ═══════════════════════════════════════════════════════════════════════════

/** 读一个"以太地址私钥"文件: 认 JSON 的 `privateKey` 字段, 也认纯文本 (0x + 64 hex) */
async function readAddressKeyFile(file: string): Promise<string> {
  const raw = (await fs.readFile(file, 'utf-8')).trim();
  let pk = '';
  if (raw.startsWith('{')) {
    const j = JSON.parse(raw);
    pk = String(j?.privateKey ?? j?.private_key ?? j?.key ?? '');
  } else {
    pk = raw.split(/\s+/)[0];
  }
  pk = pk.trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(`地址私钥文件里没找到 32 字节私钥 (JSON 的 privateKey 字段或纯文本 0x+64 hex): ${file}`);
  }
  return pk.startsWith('0x') ? pk : `0x${pk}`;
}

/** `bolloon identity bind-address --address 0x… --address-key-file <path> [--label …]` */
async function identityBindAddress(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon identity bind-address';
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const address = String(opt(flags, '--address') || '').trim().toLowerCase();
  const keyFile = opt(flags, '--address-key-file');
  const didFile = opt(flags, '--did-key-file') || getLocalIdentityFile(home);
  const dir = opt(flags, '--bindings-dir') || bindingsDir(home);
  const label = opt(flags, '--label');
  const chainIdRaw = opt(flags, '--chain-id');
  const expiresAt = opt(flags, '--expires-at') || null;

  const bad = (code: Parameters<typeof failEnvelope>[0], msg: string, data: Record<string, unknown> = {}) => ({
    envelope: failEnvelope(code, msg, { ...data, keyMaterialInOutput: false }, [], 'needs_human' as const),
    human: `${title(head)}\n  原因: ${msg}\n\n${hint(IDENTITY_USAGE.trim())}`,
  });

  if (!address || !BINDING_ADDRESS_RE.test(address)) {
    return bad('INVALID_ARGUMENT', `--address 必须是**全小写** 0x + 40 位十六进制 (实得 ${JSON.stringify(opt(flags, '--address') ?? '')})`, { address: address || null });
  }
  if (!keyFile) {
    return bad('INVALID_ARGUMENT',
      '必须显式给 --address-key-file <path> —— 本命令**没有默认钱包**: 不替你在任何目录里找一个私钥来签 (以免拿主钱包误签)',
      { address, needs: '--address-key-file' });
  }
  const chainId = chainIdRaw ? Number(chainIdRaw) : DEFAULT_BINDING_CHAIN_ID;
  if (!Number.isInteger(chainId) || chainId <= 0) return bad('INVALID_ARGUMENT', `--chain-id 必须是正整数 (实得 ${JSON.stringify(chainIdRaw)})`, { chainId: chainIdRaw ?? null });
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) return bad('INVALID_ARGUMENT', `--expires-at 必须是 ISO8601 时间串 (实得 ${expiresAt})`, { expiresAt });

  // 地址私钥 (只读一次, 不进任何输出)
  let addressKey = '';
  try {
    addressKey = await readAddressKeyFile(keyFile);
  } catch (e: any) {
    return bad('NOT_FOUND', `读地址私钥失败: ${String(e?.message || e).slice(0, 160)}`, { addressKeyFile: keyFile });
  }
  // DID 身份 (与 `agent-identity.ts` / 卖方签名同源: KeyManager)
  let did = ''; let didPrivateKeyHex = ''; let didPublicKeyHex = '';
  try {
    const kp: any = await KeyManager.fromFile(didFile);
    did = String(kp?.did || '');
    didPrivateKeyHex = Buffer.from(kp.privateKey).toString('hex');
    didPublicKeyHex = Buffer.from(kp.publicKey).toString('hex');
  } catch (e: any) {
    return bad('NOT_FOUND', `读本机 DID 身份失败 (${didFile}): ${String(e?.message || e).slice(0, 160)} —— 没有身份先跑 bolloon identity init`, { didKeyFile: didFile });
  }

  // nonce 一次性: 生成前先看本机索引里有没有撞 (撞了就换一枚)
  let index = readBindingIndex({ dir });
  if (!index) { try { index = await rebuildBindingIndex({ dir }); } catch { index = null; } }
  const used = new Set(Object.keys(index?.nonces || {}));
  let nonce = newBindingNonce();
  for (let i = 0; i < 8 && used.has(nonce); i++) nonce = newBindingNonce();

  let rec: AddressBindingRecord;
  try {
    rec = await createAddressBinding({ did, didPrivateKeyHex, didPublicKeyHex, addressPrivateKeyHex: addressKey, address, chainId, expiresAt, nonce, label, createdBy: 'bolloon identity bind-address' });
  } catch (e: any) {
    return bad('POLICY_DENIED', `造绑定失败 (未落盘): ${String(e?.message || e).slice(0, 200)}`, { address, chainId, didShort: didShort(did) });
  } finally {
    addressKey = '';                                                  // 用完即弃 (不留到后面任何一行)
  }

  let file = '';
  try {
    const w = await writeBindingRecord(rec, { dir });
    file = w.file;
  } catch (e: any) {
    return bad('DUPLICATE_REQUEST', `绑定落盘失败: ${String(e?.message || e).slice(0, 160)}`, { id: rec.id, dir });
  }
  const ident = payerIdentityOf(rec);
  const payload = {
    action: 'bound',
    id: rec.id,
    protocol: ADDRESS_BINDING_PROTOCOL,
    address,
    did,
    didShort: ident.did_short,
    nameShort: ident.name_short,
    label: rec.label ?? null,
    chainId: rec.statement.chainId,
    issuedAt: rec.statement.issuedAt,
    expiresAt: rec.statement.expiresAt,
    nonce: rec.statement.nonce,
    statementJson: rec.statement_json,
    sigDidAlg: 'ed25519',
    sigAddrAlg: 'eip-191-personal-sign',
    verified: true,
    verifiedChecks: rec.verified_checks ?? [],
    file,
    bindingsDir: dir,
    didKeyFile: didFile,
    addressKeyFile: keyFile,
    keyMaterialInOutput: false,
    semantics: '链下登记(可离线验签) —— 不是链上事实',
  };
  return {
    envelope: okEnvelope('OK', `已登记地址↔DID 绑定 (${rec.id} · 双侧签名自验通过)`, payload, [
      `off-chain signed statement: ${rec.statement_json}`,
    ], null),
    human: [
      title(head),
      line('绑定 id', rec.id),
      line('协议', ADDRESS_BINDING_PROTOCOL),
      line('地址', address),
      line('DID', did),
      line('DID 短写', ident.did_short),
      line('智能体名', ident.name_short),
      line('chainId', rec.statement.chainId),
      line('issuedAt', rec.statement.issuedAt),
      line('expiresAt', rec.statement.expiresAt ?? '(不过期)'),
      line('绑定文件', file),
      line('自验判据', (rec.verified_checks || []).join(' · ')),
      '',
      `  ${hint('口径: 「链下登记(可离线验签)」—— 这是签名声明, 不是链上事实')}`,
      '  私钥没进任何输出; 地址私钥只在本进程内用了一瞬',
      `  复核: bolloon identity bindings verify ${file}`,
    ].join('\n'),
  };
}

/** `bolloon identity bindings list|show|verify|publish` */
async function identityBindings(flags: CliFlags): Promise<CommandResult> {
  const head = 'bolloon identity bindings';
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const dir = opt(flags, '--bindings-dir') || bindingsDir(home);
  const sub = String(flags.positionals[1] ?? '').trim().toLowerCase();
  const rest = flags.positionals.slice(2).filter((p) => p && p !== 'true');
  const fail = (code: Parameters<typeof failEnvelope>[0], msg: string, data: Record<string, unknown> = {}) => ({
    envelope: failEnvelope(code, msg, { ...data, bindingsDir: dir, keyMaterialInOutput: false }, [], 'needs_human' as const),
    human: `${title(head)}\n  原因: ${msg}\n\n${hint('用法: bindings list [--bindings-dir <dir>] · bindings show <file> · bindings verify <file> [--bindings-dir <dir>] · bindings publish --out <path>')}`,
  });

  if (sub === 'list' || sub === '') {
    let index = readBindingIndex({ dir });
    let rebuilt = false;
    if (!index) { index = await rebuildBindingIndex({ dir }); rebuilt = true; }
    const rows = index.bindings.map((b) => ({
      id: b.id, address: b.address, name_short: b.name_short, did_short: b.did_short,
      chainId: b.chainId, issuedAt: b.issuedAt, expiresAt: b.expiresAt, verified_at: b.verified_at, file: b.file,
    }));
    const loaded = await loadPayerIdentityIndex({ dir, now: Date.now() });
    return {
      envelope: okEnvelope('OK', `${rows.length} 条绑定 (重验通过 ${loaded.verified}${loaded.rejected.length ? ` · 拒 ${loaded.rejected.length}` : ''})`, {
        action: 'list', bindingsDir: dir, indexFile: bindingIndexPath(home) === path.join(dir, BINDING_INDEX_FILENAME) ? bindingIndexPath(home) : path.join(dir, BINDING_INDEX_FILENAME),
        rebuilt, count: rows.length, verified: loaded.verified, rejected: loaded.rejected, reason: loaded.reason,
        bindings: rows, keyMaterialInOutput: false,
        semantics: '链下登记(可离线验签) —— 每行是签名声明, 不是链上事实; address 只在本机索引里',
      }, [], null),
      human: [
        title(head + ' list'),
        line('绑定库', dir),
        line('条数', rows.length),
        line('重验', loaded.reason),
        ...(rows.length
          ? ['', ...rows.map((r) => `  ${r.id}  ${r.name_short.padEnd(20)} ${r.did_short}  ${r.address}  chain=${r.chainId}  ${r.issuedAt}`)]
          : ['', '  (空 —— 还没有地址↔DID 登记; 地址不出公开面, 名字来自链下签名声明)']),
        ...(loaded.rejected.length ? ['', `  ⚠ 有 ${loaded.rejected.length} 条重验不过 (不进快照): ${loaded.rejected.map((r) => `${r.id}:${r.reasons.join(',')}`).join(' | ').slice(0, 200)}`] : []),
      ].join('\n'),
    };
  }

  if (sub === 'show' || sub === 'verify') {
    const file = rest[0] ? path.resolve(rest[0]) : '';
    if (!file) return fail('INVALID_ARGUMENT', `bindings ${sub} 需要文件路径: <file>`);
    let rec: AddressBindingRecord;
    try { rec = readBindingRecord(file); } catch (e: any) {
      return fail('NOT_FOUND', `读绑定文件失败: ${String(e?.message || e).slice(0, 160)}`, { file });
    }
    const index = readBindingIndex({ dir });
    const verdict = await verifyAddressBinding(rec, { now: Date.now(), ...(index ? { nonces: index.nonces } : {}) });
    if (sub === 'show') {
      const ident = verdict.ok ? payerIdentityOf(rec) : null;
      return {
        envelope: okEnvelope('OK', `绑定 ${rec.id} (验签 ${verdict.ok ? '通过' : '不通过'})`, {
          action: 'show', file, id: rec.id, protocol: rec.protocol,
          statement: rec.statement, statementJson: rec.statement_json,
          didPublicKey: rec.did_public_key, label: rec.label ?? null, labelCovered: verdict.label_covered,
          sigDid: rec.sig_did, sigAddr: rec.sig_addr,
          verified: verdict.ok, verifyReasons: verdict.reasons, checks: verdict.checks,
          nameShort: ident ? ident.name_short : null, didShort: ident ? ident.did_short : null,
          verified_at: rec.verified_at ?? null, created_by: rec.created_by ?? null,
          keyMaterialInOutput: false,
          semantics: '链下登记(可离线验签) —— 不是链上事实',
        }, [], null),
        human: [
          title(head + ' show'),
          line('文件', file),
          line('id', rec.id),
          line('正文 (canonical)', rec.statement_json),
          line('DID', rec.statement.did),
          line('地址', rec.statement.address),
          line('chainId', rec.statement.chainId),
          line('label', rec.label ?? '(无)'),
          line('名字覆盖', verdict.label_covered === null ? '(无 label)' : (verdict.label_covered ? 'label_sig 有效' : 'label_sig 无效')),
          line('sig_did', `${String(rec.sig_did || '').slice(0, 24)}… (ed25519, ${verdict.sig_did_ok ? '通过' : '不通过'})`),
          line('sig_addr', `${String(rec.sig_addr || '').slice(0, 20)}… (eip-191, ${verdict.sig_addr_ok ? '通过' : '不通过'})`),
          line('验签结论', verdict.ok ? '✅ 通过 (两侧)' : `❌ 拒: ${verdict.reasons.join(' | ')}`),
          '',
          `  ${hint('名字与短写只在**验签通过**时才算数; 未通过一律不出名字/不出 DID')}`,
        ].join('\n'),
      };
    }
    // verify: 判据逐条列出; 不过 = 非零退出码
    const humanLines = [
      title(head + ' verify'),
      line('文件', file),
      line('id', rec.id),
      `  结论: ${verdict.ok ? '✅ 通过 (双侧签名 + 正文 canonical + 时效/nonce)' : `❌ 拒 (${verdict.reasons.join(' | ')})`}`,
      '',
      ...verdict.checks.map((c) => `  ${c.ok ? '✔' : '✘'} ${c.name.padEnd(24)} ${String(c.detail).slice(0, 120)}`),
    ];
    const payload = {
      action: 'verify', file, id: rec.id, ok: verdict.ok, reasons: verdict.reasons,
      checks: verdict.checks, sigDidOk: verdict.sig_did_ok, sigAddrOk: verdict.sig_addr_ok,
      labelCovered: verdict.label_covered, address: verdict.address, did: verdict.did,
      nonceChecked: !!index, keyMaterialInOutput: false,
      semantics: '链下登记(可离线验签) —— 不是链上事实',
    };
    return verdict.ok
      ? { envelope: okEnvelope('OK', `验签通过: ${rec.id}`, payload, [], null), human: humanLines.join('\n') }
      : {
        envelope: failEnvelope('SIGNATURE_INVALID', `验签不通过: ${rec.id} —— ${verdict.reasons.join(' | ')}`, payload, [], 'needs_human'),
        human: humanLines.join('\n'),
      };
  }

  if (sub === 'publish') {
    const out = opt(flags, '--out');
    if (!out) return fail('INVALID_ARGUMENT', '缺少 --out <path> (显式路径, 不写死目录)');
    const proj = await buildPublicBindingProjection({ dir });
    const target = path.resolve(out);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(proj, null, 2), 'utf-8');
    } catch (e: any) {
      return fail('INTERNAL_ERROR', `写投影失败 (${target}): ${String(e?.message || e).slice(0, 160)}`);
    }
    return {
      envelope: okEnvelope('OK', `已写出对外投影 ${proj.count} 条 → ${target}`, {
        action: 'publish', out: target, count: proj.count, protocol: proj.protocol, kind: proj.kind,
        // 对外面只出短写: 地址只以 sha256 前 16 位出现
        rows: proj.bindings.map((b) => ({ id: b.id, address_hash: b.address_hash, name_short: b.name_short, did_short: b.did_short })),
        keyMaterialInOutput: false,
        semantics: '链下登记(可离线验签) —— 对外只出短写; 地址不出 (只有哈希)',
      }, [], null),
      human: [
        title(head + ' publish'),
        line('写入', target),
        line('条数', proj.count),
        line('协议', proj.protocol),
        ...proj.bindings.map((b) => `  ${b.id}  ${b.name_short.padEnd(20)} ${b.did_short}  ${b.address_hash}`),
        '',
        `  ${hint('对外面里没有完整地址、没有完整 DID —— 网关是**本机**按地址匹配的')}`,
      ].join('\n'),
    };
  }

  return fail('INVALID_ARGUMENT', `未知 bindings 子命令: ${sub || '(空)'} (list | show | verify | publish)`);
}
