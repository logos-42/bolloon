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
import * as crypto from 'crypto';
import {
  type CliFlags, type CommandResult,
  okEnvelope, failEnvelope, line, title, hint, plain, has,
} from './protocol-envelope.js';
import { getLocalIdentityFile, initLocalIdentity } from './setup-wizard.js';
import { AUDIT_FORBIDDEN_KEYS } from '../agents/task-contract.js';

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
  return {
    envelope: failEnvelope('INVALID_ARGUMENT',
      sub ? `未知 identity 子命令: ${sub}` : '缺少 identity 子命令 (init | show)',
      { usage: plain(IDENTITY_USAGE.trim()), accepted: ['bolloon identity init', 'bolloon identity show'] }, [], 'needs_human'),
    human: IDENTITY_USAGE,
  };
}
