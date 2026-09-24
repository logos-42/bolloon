/**
 * task-group.ts — 群聊通道 (C7) 桥接: 让任务的「发布 → 接单 → 交付 → 初筛 → 终审」
 * 在 Bolloon 群聊里留下**过程痕迹**, 同时**不把私有内容塞进群里**。(2026-09-23)
 *
 * 为什么需要这一层: 任务公告板 (task-board.ts) 只解决「把待接单任务放出去 / 被认领」,
 * 但协作过程 (谁宣布了、谁接了、交付了哪个哈希、初筛逐条结果、终审结论) 没有共同的发生地 ——
 * 群聊 (gateway-group.ts) 才是人和 agent 都看得见的那个发生地。
 *
 * 本模块做的三件事 (只加不减弱; **不改群聊核心语义**):
 *   1. 公告入群: 把板上的**一条**待接单公告压成一行极短事实发进群 (announce)
 *   2. 留痕回看: 从群消息里读回本期时间线 (announce/claim/deliver/screen/final), 带时间与发送者标记 (trail)
 *   3. 接单/交付/初筛/终审的群消息桥接 (claim / post)
 *
 * 三条硬纪律:
 *   · **隐私红线**: 群里只许出现短引用 (公告 id / 内容哈希 / capability / 预算 / 时间)。
 *     发送前 `scanPublicText()` 逐条规则把关, 命中就**拒发** (不静默脱敏, 不猜用户本意)。
 *     覆盖: 钱包地址 · DID · peerId · multiaddr · IPv4/IPv6 · 私钥/助记词形态 · PEM ·
 *     orbitdb 群链接本身 · http(s) URL · 邮箱 (后三条属「只加不减」的更严档: 群消息是机器生成的事实行,
 *     任何端点/联系方式都是泄漏面)。
 *   · **发送者标记**: 群里只出现稳定假名 `agent-<8位>` (sha256(DID) 前 8 位), 原始 DID 永不入群。
 *   · **缺群 / 群非法 / 群不存在 → 拒跑**: 绝不静默降级成「只写本地」。群聊通道就是留痕的地方,
 *     没有群就没有留痕, 假造一个本地痕迹等于骗人。
 *
 * 衔接点 (与并行实现的边界, 只读不耦合):
 *   · 公告数据源 = 任务公告板落盘 `~/.bolloon/tasks/board/<announcementId>.json`
 *     (task-board.ts 的 `boardDir()` / `announcementFile()` 同一目录同一形状)。
 *     这里**直接读 JSON** 而不是 import 它的 API: 板的 API 还在演进, 直读文件让本模块不跟着抖;
 *     哪天 board API 定型, 把 `readBoardAnnouncement` / `listOpenBoardAnnouncements` 换成
 *     `readAnnouncement` / `listBoard` 即可, **群消息格式不变**。
 *   · 群接口 = gateway-group.ts 的 `parseGroupLink` / `listGroups` / `groupSend` / `groupMessages` (只读用)。
 *   · 消息格式自描述 (`[bolloon-task] v=1 kind=… k=v …`), 解析失败的行一律**跳过** (不猜、不糊)。
 *
 * 未做 (如实, 不假装):
 *   · 不做跨机群同步验收 (那是 OrbitDB 复制本身的事; 本模块只保证「发进群 / 从群读回」这条链路)。
 *   · 不代发终审结论之外的任何裁决 (release 仍只在链上; 群里的话不替代 `releaseV2`)。
 *   · 不做消息加密 (群是公开可读的 store, 所以本模块只放**公开事实**: 短引用 + 哈希 + 预算)。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseGroupLink, listGroups, groupSend, groupMessages, type GroupMessage } from './gateway-group.js';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 消息标记 (一行一条; 解析只认这一行) */
export const TRAIL_TAG = '[bolloon-task]';
/** 消息版本 (格式变了就 bump; 解析器按 `v=` 分流, 老版本照旧可读) */
export const TRAIL_VERSION = '1';

export type TrailKind = 'announce' | 'claim' | 'deliver' | 'screen' | 'final';
export const TRAIL_KINDS: readonly TrailKind[] = ['announce', 'claim', 'deliver', 'screen', 'final'] as const;

/** 人能看懂的中文名 (人类输出用) */
export const TRAIL_KIND_LABEL: Record<TrailKind, string> = {
  announce: '公告',
  claim: '接单声明',
  deliver: '交付',
  screen: '初筛结果',
  final: '终审结论',
};

export const VERDICTS = ['accept', 'reject', 'unknown'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** 本模块可能返回的失败码 (都是 protocol-envelope 里已有的码, 不新增冻结码) */
export type BridgeFailCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'NETWORK_NOT_JOINED' | 'POLICY_DENIED' | 'TRANSPORT_FAILED';

// ── 隐私守卫 ────────────────────────────────────────────────────────────────

export interface PrivacyRule {
  rule: string;
  why: string;
  re: RegExp;
}

/**
 * 群消息**禁止出现**的形态 (顺序即报告顺序)。宁可多拦 (拒发 + 说清哪条规则), 也不放行一条带标识符的消息。
 *
 * 实现纪律 (2026-09-23 踩过的坑, 不可回退):
 * · **不要用 `\b` 当边界** —— 消息里的 token 会把空白折成 `_`, 而 `_` 也是 \w, 于是 `判据见_0x1111…`
 *   这种"粘在 `_`/汉字后面"的标识符 `\b` 判不出来, 会直接漏进群。一律改成对标识符自身字母表的
 *   lookahead/lookbehind (`(?<![0-9a-fA-FxX])`, `(?![0-9a-fA-F])`), 粘在 `_`/中文/符号后面也照样命中。
 * · ipv6 规则要**避开 ISO 时间戳** (`09:50:12.345Z` 只有两个冒号): 只认 3 组以上 `x:y:z:w` 或含 `::` 的压缩形态。
 * · 内容哈希 (sha256 64 位裸 hex) **不在**禁列 —— 交付就是要贴哈希 (它不是密钥, 也没有 0x 前缀)。
 */
export const PRIVACY_RULES: PrivacyRule[] = [
  { rule: 'wallet-address', why: '以太坊/EVM 钱包地址', re: /(?<![0-9a-fA-FxX])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/ },
  { rule: 'private-key-hex', why: '32 字节私钥形态 (0x + 64 hex)', re: /(?<![0-9a-fA-FxX])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/ },
  { rule: 'hex-0x-blob', why: '0x 开头的十六进制块 (签名/哈希/密钥都长这样, 群里一律不放原文)', re: /(?<![0-9a-fA-FxX])0x[0-9a-fA-F]{8,}(?![0-9a-fA-F])/ },
  { rule: 'did', why: '去中心化身份 DID', re: /did:[a-z0-9]+:[A-Za-z0-9._:%-]{3,}/i },
  { rule: 'peer-id', why: 'libp2p peerId (12D3Koo…/Qm…)', re: /12D3Koo[A-Za-z0-9]{8,}|Qm[1-9A-HJ-NP-Za-km-z]{30,}/ },
  { rule: 'multiaddr', why: 'libp2p multiaddr 或 store 地址 (/ip4 /tcp /p2p /orbitdb …)', re: /\/(ip4|ip6|dns|dns4|dns6|tcp|udp|ws|wss|quic|p2p|p2p-circuit|ipfs|orbitdb)(?![A-Za-z0-9])/i },
  { rule: 'orbitdb-link', why: 'OrbitDB 链接 (群邀请链接本身也不进群消息)', re: /orbitdb:\/\//i },
  { rule: 'ipv4', why: 'IPv4 地址', re: /(?<!\d)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\d)/ },
  { rule: 'ipv6', why: 'IPv6 地址 (不含 ISO 时间戳)', re: /(?<![0-9A-Za-z])(?:[0-9a-fA-F]{1,4})?::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}(?![0-9A-Za-z])|(?<![0-9A-Za-z:])(?:[0-9a-fA-F]{1,4}:){3,}[0-9a-fA-F]{1,4}(?![0-9A-Za-z])/ },
  { rule: 'pem', why: 'PEM 材料 (私钥/证书)', re: /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/ },
  { rule: 'secret-words', why: '私钥/助记词/密钥字样 (正文里提到即停, 人不该把密钥写进群)', re: /(private\s*key|seed\s*phrase|mnemonic|私钥|助记词|密钥材料)/i },
  { rule: 'url', why: 'http(s) 端点 (端点会带 host/IP 与用途指纹)', re: /https?:\/\/\S+/i },
  { rule: 'email', why: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];

export interface PrivacyViolation {
  rule: string;
  why: string;
  /** 只给最少信息: 前 4 个字符 + 省略号 (绝不在输出里复述完整标识符) */
  masked: string;
  chars: number;
}

function mask(s: string): string {
  const t = String(s || '');
  return t.length <= 4 ? '****' : `${t.slice(0, 4)}…`;
}

/** 扫一遍文本, 返回命中的隐私规则 (空数组 = 可以发) */
export function scanPublicText(text: string): PrivacyViolation[] {
  const t = String(text ?? '');
  const out: PrivacyViolation[] = [];
  const seen = new Set<string>();
  for (const r of PRIVACY_RULES) {
    const m = r.re.exec(t);
    if (!m) continue;
    if (seen.has(r.rule)) continue;
    seen.add(r.rule);
    out.push({ rule: r.rule, why: r.why, masked: mask(String(m[0])), chars: String(m[0]).length });
  }
  return out;
}

/** 发送前唯一闸门: 命中任何规则 → 拒绝发送 (返回 violations 供 CLI 如实报出) */
export function requirePublicText(text: string): { ok: true } | { ok: false; violations: PrivacyViolation[] } {
  const v = scanPublicText(text);
  return v.length === 0 ? { ok: true } : { ok: false, violations: v };
}

/**
 * **节点身份**口径 (群管理命令 `task group create|join|list|link|leave` 的输出用, 2026-09-24):
 * 与群消息同一张规则表, 但**去掉 orbitdb 那一档** ——
 *   · `orbitdb-link` 整条去掉: 邀请链接是群唯一能让别人入群的东西, 必须能打印出来;
 *   · `multiaddr` 规则里的 `orbitdb` 选项去掉 (只留节点地址 /ip4 /ip6 /dns /tcp /p2p …):
 *     群 store 地址 (`/orbitdb/zdpu…`) 是**群自己的公开标识**, 不是节点地址。
 * 仍然全拦: 原始 DID · 钱包地址 · peerId · 节点 multiaddr · IPv4/IPv6 · 私钥形态 · PEM · URL · 邮箱。
 *
 * 用法: 群管理**输出**再过一遍这道闸 (`scanNodeIdentity`)。命中 = 输出里真有节点身份/联系方式泄漏,
 * 此时**拒输出并如实报**, 不静默脱敏掉再当成没事 (那样人看到的就不是事实了)。
 */
export const NODE_IDENTITY_RULES: PrivacyRule[] = PRIVACY_RULES
  .filter((r) => r.rule !== 'orbitdb-link')
  .map((r): PrivacyRule => (r.rule === 'multiaddr'
    ? { ...r, re: /\/(ip4|ip6|dns|dns4|dns6|tcp|udp|ws|wss|quic|p2p|p2p-circuit|ipfs)(?![A-Za-z0-9])/i }
    : r));

/** 扫节点身份泄漏 (空数组 = 输出干净) */
export function scanNodeIdentity(text: string): PrivacyViolation[] {
  const t = String(text ?? '');
  const out: PrivacyViolation[] = [];
  for (const r of NODE_IDENTITY_RULES) {
    const m = r.re.exec(t);
    if (!m) continue;
    out.push({ rule: r.rule, why: r.why, masked: mask(String(m[0])), chars: String(m[0]).length });
  }
  return out;
}


// ── 发送者标记 (稳定假名, 原始 DID 不入群) ──────────────────────────────────

const sha256Hex = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** DID → 稳定假名 `agent-<8位>` (同一个人每次都是同一个标记, 但看不出是谁) */
export function senderTag(did: string): string {
  return `agent-${sha256Hex(String(did || '')).slice(0, 8)}`;
}

/**
 * 群消息里的 from → 对外展示的发送者标记。
 * 短显示名 (无隐私形态, 1..24 个字母/数字/汉字/._-) 原样保留 (可读); 其余一律打码成 `#<8位>`。
 */
export function maskSender(from: string): string {
  const s = String(from || '').trim();
  if (!s) return 'unknown';
  if (scanPublicText(s).length === 0 && /^[\p{L}\p{N}._-]{1,24}$/u.test(s)) return s;
  return `#${sha256Hex(s).slice(0, 8)}`;
}

/** 解析本次发送用哪个标记: 显式 `--from` 优先 (要过隐私闸), 否则用本机身份派生假名 */
export async function resolveSenderTag(explicit?: string | null): Promise<
  { ok: true; tag: string; source: 'flag' | 'identity' } | { ok: false; code: BridgeFailCode; message: string; detail: Record<string, unknown> }
> {
  const e = String(explicit ?? '').trim();
  if (e) {
    const v = scanPublicText(e);
    if (v.length) {
      return {
        ok: false, code: 'POLICY_DENIED',
        message: `--from 含隐私形态 → 拒 (${v.map((x) => x.rule).join(', ')})`,
        detail: { violations: v, acceptedHint: '用短显示名, 例如 --from 委托方' },
      };
    }
    if (!/^[\p{L}\p{N}._-]{1,32}$/u.test(e)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '--from 只能是短显示名 (字母/数字/汉字/._-, ≤32 字)', detail: { from: e } };
    }
    return { ok: true, tag: e, source: 'flag' };
  }
  const { loadLocalSigner } = await import('./local-signer.js');
  const signer = await loadLocalSigner().catch(() => null);
  if (signer?.did) return { ok: true, tag: senderTag(signer.did), source: 'identity' };
  return {
    ok: false, code: 'INVALID_ARGUMENT',
    message: '没有本机身份 (~/.bolloon/identity.json) 也没有 --from → 给不出诚实的发送者标记 (拒, 不假造一个)',
    detail: { identityFile: '~/.bolloon/identity.json', accepted: ['--from 委托方', 'bolloon identity init', 'bolloon setup'] },
  };
}

// ── 群解析 (缺群 / 群非法 / 群不存在 → 拒) ───────────────────────────────────

export interface GroupRef {
  ref: string;
  groupId: string;
  name: string | null;
  via: 'link' | 'id';
}

/** 与 gateway-group 内部 `groupIdOf` 同款派生 (它没导出; 这里只作地址比不中时的兜底) */
function groupIdOfAddress(address: string): string {
  const m = /\/orbitdb\/(.{8,})/.exec(String(address || ''));
  return m ? m[1] : String(address || '');
}

export type GroupResolution =
  | { ok: true; group: GroupRef }
  | { ok: false; code: BridgeFailCode; message: string; detail: Record<string, unknown> };

/**
 * `--group <群链接|groupId>` → 本机已知的群。
 * 三件事一律拒 (并说清原因 + 已加入的群有哪些): 缺 --group · 链接非法 · 本机没这个群。
 */
export async function resolveGroupRef(ref: string | undefined | null): Promise<GroupResolution> {
  const raw = String(ref ?? '').trim();
  const groups = await listGroups();
  const joined = groups.map((g) => ({ id: g.id, name: g.name }));

  if (!raw) {
    return {
      ok: false, code: 'INVALID_ARGUMENT',
      message: '缺少 --group (群链接 orbitdb://…?type=group&name=… 或已加入群的 groupId)',
      detail: {
        joined, accepted: ['--group orbitdb:///orbitdb/<store>?type=group&name=<群名>', '--group <groupId>'],
        why: '没有群就没有留痕的落点: 本命令**不**降级成只写本地',
      },
    };
  }

  if (/^orbitdb:\/\//i.test(raw)) {
    const parsed = parseGroupLink(raw);
    if (!parsed) {
      return {
        ok: false, code: 'INVALID_ARGUMENT',
        message: `--group 不是合法的群链接 (需要 orbitdb://<store 地址>?type=group&name=<群名>): ${mask(raw)}`,
        detail: { refChars: raw.length, parsed: null, joined, why: '链接解析失败 → 拒 (不猜你想发到哪个群)' },
      };
    }
    const hit = groups.find((g) => g.address === parsed.address)
      || groups.find((g) => g.id === groupIdOfAddress(parsed.address))
      || null;
    if (!hit) {
      return {
        ok: false, code: 'NETWORK_NOT_JOINED',
        message: '本机还没加入这个群 (链接指向的群不在本地群列表里) → 先入群, 再发过程痕迹',
        detail: {
          joined,
          howTo: 'bolloon gateway list 看已加入的群; 用群链接加入后在群里发 (本命令不替你静默入群/也不静默改发本地)',
        },
      };
    }
    return { ok: true, group: { ref: raw, groupId: hit.id, name: hit.name, via: 'link' } };
  }

  const hit = groups.find((g) => g.id === raw) || groups.find((g) => g.name === raw) || null;
  if (hit) return { ok: true, group: { ref: raw, groupId: hit.id, name: hit.name, via: 'id' } };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return {
      ok: false, code: 'INVALID_ARGUMENT',
      message: `--group 不是群链接 (${raw.slice(0, 12)}…) — 群聊链接形如 orbitdb://…?type=group&name=…`,
      detail: { scheme: raw.split(':')[0], joined },
    };
  }
  return {
    ok: false, code: 'NOT_FOUND',
    message: `本机没有这个群: ${mask(raw)} (既不是已加入群的 groupId, 也不是群名)`,
    detail: { joined, howTo: 'bolloon gateway list / 用群链接加入后重试' },
  };
}

// ── 公告数据源 (板上的事实; 只读) ─────────────────────────────────────────────

export interface BoardAnnouncementFacts {
  announcementId: string;
  capability: string;
  status: string;
  budget: { maxAmount: string; currency: string; network: string } | null;
  deadline: number | null;
  instructionDigest: string | null;
  instructionPreview: string | null;
  createdAt: number | null;
  signed: boolean;
  claimCount: number;
  source: 'board-file';
}

export const boardDirOf = (home?: string): string =>
  path.join(home || process.env.HOME || os.homedir(), '.bolloon', 'tasks', 'board');

/** 公告 id 形状闸 (防目录穿越): 与 task-board 的 safeId 同形 */
export function isAnnouncementId(id: string): boolean {
  return /^ann-[A-Za-z0-9._-]{4,96}$/.test(String(id || '').trim());
}

/** 读一条公告 (不存在/坏 JSON → null, 不猜) */
export function readBoardAnnouncement(announcementId: string, home?: string): BoardAnnouncementFacts | null {
  const id = String(announcementId || '').trim();
  if (!isAnnouncementId(id)) return null;
  const file = path.join(boardDirOf(home), `${id}.json`);
  try {
    if (!fs.existsSync(file)) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || String(j.announcementId || '') !== id) return null;
    return {
      announcementId: id,
      capability: String(j.capability || ''),
      status: String(j.status || 'unknown'),
      budget: j.budget && typeof j.budget === 'object'
        ? { maxAmount: String(j.budget.maxAmount), currency: String(j.budget.currency || ''), network: String(j.budget.network || '') }
        : null,
      deadline: j.deadline === null || j.deadline === undefined || j.deadline === '' ? null : (Number.isFinite(Number(j.deadline)) ? Number(j.deadline) : null),
      instructionDigest: j.instructionDigest ? String(j.instructionDigest) : null,
      instructionPreview: j.instructionPreview ? String(j.instructionPreview) : null,
      createdAt: j.createdAt === null || j.createdAt === undefined || j.createdAt === '' ? null : (Number.isFinite(Number(j.createdAt)) ? Number(j.createdAt) : null),
      signed: !!j.signature,
      claimCount: Array.isArray(j.claims) ? j.claims.length : 0,
      source: 'board-file',
    };
  } catch { return null; }
}

/** 板上**可接单**的公告 (status=open), 新的在前 */
export function listOpenBoardAnnouncements(home?: string): BoardAnnouncementFacts[] {
  const dir = boardDirOf(home);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('ann-') && f.endsWith('.json'))
      .map((f) => readBoardAnnouncement(f.replace(/\.json$/, ''), home))
      .filter((a): a is BoardAnnouncementFacts => !!a && a.status === 'open')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch { return []; }
}

/**
 * 选一条要发进群的公告:
 *   `--announcement-id` 显式指定 > (可选 `--capability` 过滤后的) 板上最新的 open 公告。
 * 板上有多条且没给能力/公告号 → 也拒 (不替人选一条发出去)。
 */
export function pickAnnouncement(opts: { home?: string; announcementId?: string | null; capability?: string | null }): {
  ok: true; announcement: BoardAnnouncementFacts;
} | { ok: false; code: BridgeFailCode; message: string; detail: Record<string, unknown> } {
  const explicit = String(opts.announcementId ?? '').trim();
  if (explicit) {
    if (!isAnnouncementId(explicit)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: `announcementId 不合法: ${mask(explicit)} (形如 ann-xxxxxxxxxxxxxxxx)`, detail: { accepted: ['ann-<16 位>'] } };
    }
    const a = readBoardAnnouncement(explicit, opts.home);
    if (!a) {
      return {
        ok: false, code: 'NOT_FOUND',
        message: `板上没有这条公告: ${explicit}`,
        detail: { dir: '~/.bolloon/tasks/board', howTo: 'bolloon task board 看板上有什么; 先 bolloon task publish 发一条' },
      };
    }
    return { ok: true, announcement: a };
  }
  const open = listOpenBoardAnnouncements(opts.home);
  const cap = String(opts.capability ?? '').trim().toLowerCase();
  const pool = cap ? open.filter((a) => a.capability.trim().toLowerCase() === cap) : open;
  if (pool.length === 0) {
    return {
      ok: false, code: 'NOT_FOUND',
      message: open.length === 0
        ? '板上没有可接单的公告 (status=open) → 没有可发进群的东西'
        : `板上 ${open.length} 条 open 公告里没有 capability='${cap}' 的`,
      detail: { dir: '~/.bolloon/tasks/board', openCount: open.length, capability: cap || null, howTo: 'bolloon task publish --capability … --instruction "…" --budget 0.05' },
    };
  }
  if (pool.length > 1) {
    return {
      ok: false, code: 'INVALID_ARGUMENT',
      message: `板上有多条 open 公告 (${pool.length} 条) → 用 --announcement-id 指定要发哪一条 (不替人选)`,
      detail: { candidates: pool.slice(0, 10).map((a) => ({ announcementId: a.announcementId, capability: a.capability })) },
    };
  }
  return { ok: true, announcement: pool[0] };
}

// ── 消息构造 (一行极短事实; 无正文, 无标识符) ─────────────────────────────────

/** token 值里不能有空白 (格式靠空格切); 空白一律折成 `_` */
function tok(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\s+/g, '_');
  return s || '-';
}
function short(s: string, n = 96): string {
  const p = String(s || '').trim().replace(/\s+/g, '_');
  return p.length > n ? `${p.slice(0, n)}…` : p;
}
function budgetTok(b: BoardAnnouncementFacts['budget']): string {
  if (!b) return '-';
  return short(`${b.maxAmount}${b.currency ? b.currency.toUpperCase() : ''}${b.network ? `@${b.network}` : ''}`, 64);
}

export interface AnnounceMessageInput {
  /** 期号 (人给的事实; 没给就如实写 `-`, 不替它编一个) */
  round?: string | null;
  /** 验收判据摘要 (极短); 没给 → 如实写 `unstated;sha256=<任务书摘要前16位>` */
  criteria?: string | null;
}

/**
 * 公告入群的那一行: 期号 · capability · 预算 · 验收判据摘要 · 公告 id (只有这些公开事实)。
 * 任务正文 (instruction) 与其预览都**不进**消息 —— 群里只有摘要引用, 正文私下发给已入群的人。
 */
export function buildAnnounceMessage(a: BoardAnnouncementFacts, input: AnnounceMessageInput = {}): string {
  const round = String(input.round ?? '').trim();
  const criteria = String(input.criteria ?? '').trim();
  const digest = a.instructionDigest ? a.instructionDigest.slice(0, 16) : null;
  const judge = criteria
    ? short(criteria, 80)
    : (digest ? `unstated;sha256=${digest}` : 'unstated');
  return [
    TRAIL_TAG,
    `v=${TRAIL_VERSION}`,
    'kind=announce',
    `id=${a.announcementId}`,
    `cap=${short(a.capability, 48)}`,
    `budget=${budgetTok(a.budget)}`,
    `deadline=${a.deadline ? new Date(a.deadline).toISOString() : '-'}`,
    `round=${round ? short(round, 24) : '-'}`,
    `judge=${judge}`,
  ].join(' ');
}

/** 哈希闸: 只收内容哈希形状 (sha256 64 位 / CIDv1); 地址/Qm 形状一律拒 (防把钱包地址或 peerId 同形物贴进群) */
export function normalizeContentHash(raw: string): { ok: true; token: string } | { ok: false; error: string } {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: '缺少 --hash (交付只贴哈希: 内容哈希是这份交付的公开承诺)' };
  if (/^sha256:[0-9a-f]{16,64}$/i.test(s)) return { ok: true, token: `sha256:${s.slice(7).toLowerCase()}` };
  if (/^[0-9a-f]{16,64}$/i.test(s)) return { ok: true, token: `hex:${s.toLowerCase()}` };
  if (/^bafy[a-z0-9]{20,}$/i.test(s)) return { ok: true, token: `cid:${s}` };
  if (/^0x[0-9a-f]{40}$/i.test(s)) return { ok: false, error: '--hash 是**钱包地址**形状 (0x + 40 hex) — 交付哈希不是地址 (拒, 别把地址贴进群)' };
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{30,}$/.test(s)) {
    return { ok: false, error: '--hash 是 CIDv0 (Qm…) 形状, 它与 libp2p peerId **同形** —— 群里无法区分两者 → 拒 (用 sha256/<内容哈希> 或 CIDv1 bafy… 表达交付)' };
  }
  return { ok: false, error: `--hash 形状不认识: ${mask(s)} (要 sha256:<hex> / 裸 hex(16..64) / CIDv1(bafy…) )` };
}

export interface CheckItem { name: string; result: 'pass' | 'fail' | 'unknown' }

/** `--checks "渠道结构=pass,价格带=fail"` 或 `a:pass,b:fail` → 逐条结果 (名字与结果都闸过) */
export function parseChecks(raw: string): { ok: true; checks: CheckItem[] } | { ok: false; error: string } {
  const items = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return { ok: false, error: '缺少 --checks (初筛要逐条结果: --checks "渠道结构=pass,价格带=fail")' };
  const out: CheckItem[] = [];
  for (const it of items) {
    const m = /^(.+?)\s*[=:]\s*(pass|fail|unknown)$/i.exec(it);
    if (!m) return { ok: false, error: `--checks 里的条目不认识: ${mask(it)} (每条形如 名字=pass|fail|unknown)` };
    const name = m[1].trim();
    if (!/^[\p{L}\p{N}._-]{1,32}$/u.test(name)) return { ok: false, error: `--checks 的名字只能是短词 (字母/数字/汉字/._-, ≤32): ${mask(name)}` };
    out.push({ name, result: m[2].toLowerCase() as CheckItem['result'] });
  }
  return { ok: true, checks: out };
}

export interface PostInput {
  kind: Exclude<TrailKind, 'announce'>;
  announcementId?: string | null;
  round?: string | null;
  /** claim: 声明价格 (人给的原文, 只做短化; 没给 → `unstated`) */
  price?: string | null;
  /** deliver */
  hash?: string | null;
  bytes?: number | null;
  /** screen */
  checksRaw?: string | null;
  /** final */
  verdict?: string | null;
}

/** 接单 / 交付 / 初筛 / 终审的群消息 (同样只有极短事实) */
export function buildPostMessage(input: PostInput): { ok: true; text: string; checks?: CheckItem[] } | { ok: false; code: BridgeFailCode; message: string; detail: Record<string, unknown> } {
  const id = String(input.announcementId ?? '').trim();
  if (!id) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少 --announcement-id (过程痕迹要挂在某一条公告上)', detail: { accepted: ['--announcement-id ann-…'] } };
  if (!isAnnouncementId(id)) return { ok: false, code: 'INVALID_ARGUMENT', message: `announcementId 不合法: ${mask(id)}`, detail: { accepted: ['ann-<16 位>'] } };
  const base = [TRAIL_TAG, `v=${TRAIL_VERSION}`, `kind=${input.kind}`, `id=${id}`];
  const round = String(input.round ?? '').trim();
  if (round) base.push(`round=${short(round, 24)}`);

  if (input.kind === 'claim') {
    const price = String(input.price ?? '').trim();
    return { ok: true, text: [...base, `price=${price ? short(price, 32) : 'unstated'}`].join(' ') };
  }
  if (input.kind === 'deliver') {
    const h = normalizeContentHash(String(input.hash ?? ''));
    if (!h.ok) return { ok: false, code: 'INVALID_ARGUMENT', message: h.error, detail: { hashChars: String(input.hash ?? '').length } };
    const bytes = input.bytes === null || input.bytes === undefined
      ? null
      : (Number.isFinite(Number(input.bytes)) ? Math.max(0, Math.floor(Number(input.bytes))) : null);
    // 没给字节数 → 写 `-`(未声明); **不许**写成 0 (0 是一个事实断言, 会谎报"零字节交付")
    return { ok: true, text: [...base, `hash=${h.token}`, `bytes=${bytes === null ? '-' : bytes}`].join(' ') };
  }
  if (input.kind === 'screen') {
    const c = parseChecks(String(input.checksRaw ?? ''));
    if (!c.ok) return { ok: false, code: 'INVALID_ARGUMENT', message: c.error, detail: { sample: '--checks "渠道结构=pass,价格带=fail"' } };
    const pass = c.checks.filter((x) => x.result === 'pass').length;
    const fail = c.checks.filter((x) => x.result === 'fail').length;
    const unknown = c.checks.filter((x) => x.result === 'unknown').length;
    return {
      ok: true,
      checks: c.checks,
      text: [...base, `screened=${c.checks.length}`, `pass=${pass}`, `fail=${fail}`, `unknown=${unknown}`,
        `checks=${c.checks.map((x) => `${tok(x.name)}${x.result === 'pass' ? '✓' : x.result === 'fail' ? '✗' : '?'}`).join(',')}`].join(' '),
    };
  }
  // final
  const v = String(input.verdict ?? '').trim().toLowerCase();
  if (!(VERDICTS as readonly string[]).includes(v)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: `--verdict 必须是 ${VERDICTS.join('|')} (拿到 ${mask(v)})`, detail: { verdict: v || null } };
  }
  return { ok: true, text: [...base, `verdict=${v}`].join(' ') };
}

// ── 发送 (先过隐私闸, 再发) ──────────────────────────────────────────────────

export interface SendResult {
  ok: boolean;
  /** 真发出去了没有 (闸拦下 → false) */
  sent: boolean;
  text: string;
  error?: string;
  violations?: PrivacyViolation[];
  /** 明确写死: 本模块只会发进群, 不会退化成只写本地 */
  localFallback: false;
}

/** 唯一发送出口: 隐私闸 → groupSend。任何路径都不写本地副本 (本地副本 = 假痕迹) */
export async function sendTrailMessage(groupId: string, text: string, from: string): Promise<SendResult> {
  const gate = requirePublicText(text);
  if (!gate.ok) {
    return {
      ok: false, sent: false, text,
      error: `群消息命中隐私红线, 拒绝发送: ${gate.violations.map((v) => `${v.rule}(${v.why})`).join('; ')}`,
      violations: gate.violations, localFallback: false,
    };
  }
  const g = requirePublicText(String(from || ''));
  if (!g.ok) {
    return { ok: false, sent: false, text, error: `发送者标记命中隐私红线: ${g.violations.map((v) => v.rule).join(', ')}`, violations: g.violations, localFallback: false };
  }
  const r = await groupSend(groupId, text, from);
  if (!r.ok) return { ok: false, sent: false, text, error: r.error || '群消息没发出去', localFallback: false };
  return { ok: true, sent: true, text, localFallback: false };
}

// ── 留痕回看 (trail) ────────────────────────────────────────────────────────

export interface TrailEntry {
  kind: TrailKind;
  at: number;
  sender: string;
  announcementId: string | null;
  /** k=v 事实 (id 之外的全部字段) */
  fields: Record<string, string>;
  /** 原样消息 (只看, 不回显到 stdout 之外的地方) */
  text: string;
}

/** 解析一行群消息 (不是本模块发的 / 格式不认识 → null, 不猜) */
export function parseTrailLine(text: string): { kind: TrailKind; fields: Record<string, string> } | null {
  const line = String(text ?? '').trim();
  const tagAt = line.indexOf(TRAIL_TAG);
  if (tagAt < 0) return null;
  const body = line.slice(tagAt + TRAIL_TAG.length).trim();
  const tokens = body.split(/\s+/).filter(Boolean);
  const fields: Record<string, string> = {};
  let kind: string | null = null;
  for (const t of tokens) {
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i);
    const v = t.slice(i + 1);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,24}$/.test(k)) continue;
    fields[k] = v;
    if (k === 'kind') kind = v;
  }
  if (!kind || !(TRAIL_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as TrailKind, fields };
}

export interface TrailSummary {
  count: number;
  byKind: Record<TrailKind, number>;
  entries: TrailEntry[];
  /** 本期出现过的公告 id (按首次出现顺序) */
  announcements: string[];
  flags: {
    announced: boolean; claimed: boolean; delivered: boolean; screened: boolean; finalized: boolean;
    accepted: boolean; rejected: boolean;
  };
  /** 消息之间的**事实矛盾** (如实标出, 不替它圆场; 也绝不凭此伪造一条不存在的痕迹) */
  inconsistencies: string[];
  /** 群消息里没被本模块格式识别 / 被过滤掉的行数 (诚实计数) */
  ignoredMessages: number;
  /**
   * 读回时被遮蔽的字段 (`<规则>@<kind>`)：别人没走本模块的闸就发了带标识符的消息时,
   * 时间线**不把它当事实回显**, 只留一条遮蔽记录 —— 读路径不能变成泄漏通道。
   * (本模块自己发的消息都过了发送闸, 正常情况这里恒为空。)
   */
  redacted: string[];
}

/** 字段值过隐私闸: 命中 → 换成 `[已遮蔽:<规则>]` 并记下规则 (绝不回显标识符) */
export function redactFields(kind: TrailKind, fields: Record<string, string>): { fields: Record<string, string>; redacted: string[] } {
  const out: Record<string, string> = {};
  const redacted: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const hit = scanPublicText(String(v));
    if (hit.length) {
      out[k] = `[已遮蔽:${hit[0].rule}]`;
      redacted.push(`${hit[0].rule}@${kind}`);
    } else out[k] = String(v);
  }
  return { fields: out, redacted };
}

/**
 * 群消息 → 时间线汇总 (按 ts 升序)。
 * **只汇总真的发过的事实**: 没发过「交付」就不会凭空出现「已交付」条目;
 * 反而会把这些矛盾显式列出来 (终审说 accept 但没有交付痕迹 → `final-accept-without-delivery`)。
 * 每个字段值都再过一次隐私闸 (命中 → 遮蔽 + 记录), 所以时间线本身也不是泄漏面。
 */
export function summarizeTrail(msgs: GroupMessage[], opts: { announcementId?: string | null } = {}): TrailSummary {
  const only = String(opts.announcementId ?? '').trim();
  const byKind: Record<TrailKind, number> = { announce: 0, claim: 0, deliver: 0, screen: 0, final: 0 };
  const entries: TrailEntry[] = [];
  const redacted: string[] = [];
  let ignored = 0;
  for (const m of msgs || []) {
    const parsed = parseTrailLine(m?.text);
    if (!parsed) { ignored++; continue; }
    const id = parsed.fields.id || null;
    if (only && id !== only) continue;
    const safe = redactFields(parsed.kind, parsed.fields);
    for (const r of safe.redacted) if (!redacted.includes(r)) redacted.push(r);
    // id 也会被遮蔽: 别人写 `id=did:…` 时, 这一条不留 id 出来 (遮蔽过的不当引用)
    const safeId = safe.fields.id && !safe.fields.id.startsWith('[已遮蔽') ? id : null;
    byKind[parsed.kind]++;
    entries.push({
      kind: parsed.kind, at: Number(m.ts) || 0, sender: maskSender(String(m.from || '')),
      announcementId: safeId, fields: safe.fields, text: String(m.text || ''),
    });
  }
  entries.sort((a, b) => (a.at - b.at) || (TRAIL_KINDS.indexOf(a.kind) - TRAIL_KINDS.indexOf(b.kind)));
  const announcements: string[] = [];
  for (const e of entries) if (e.announcementId && !announcements.includes(e.announcementId)) announcements.push(e.announcementId);
  const finalVerdicts = entries.filter((e) => e.kind === 'final').map((e) => e.fields.verdict);
  const flags = {
    announced: byKind.announce > 0,
    claimed: byKind.claim > 0,
    delivered: byKind.deliver > 0,
    screened: byKind.screen > 0,
    finalized: byKind.final > 0,
    accepted: finalVerdicts.includes('accept'),
    rejected: finalVerdicts.includes('reject'),
  };
  const inconsistencies: string[] = [];
  if (flags.finalized && flags.accepted && !flags.delivered) inconsistencies.push('final-accept-without-delivery');
  if (flags.screened && !flags.delivered) inconsistencies.push('screen-without-delivery');
  if (flags.claimed && !flags.announced) inconsistencies.push('claim-without-announce');
  if (flags.delivered && !flags.claimed) inconsistencies.push('deliver-without-claim');
  if (flags.rejected && flags.accepted) inconsistencies.push('both-accept-and-reject');
  if (redacted.length) inconsistencies.push('group-message-hit-privacy-rule');
  return { count: entries.length, byKind, entries, announcements, flags, inconsistencies, ignoredMessages: ignored, redacted };
}

/** 读群里的过程痕迹并汇总 (群必须已加入; 读不到 → 由调用方如实报错) */
export async function readTrail(groupId: string, opts: { limit?: number; announcementId?: string | null } = {}): Promise<TrailSummary> {
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(opts.limit) || 300)));
  const msgs = await groupMessages(groupId, limit);
  return summarizeTrail(msgs, { announcementId: opts.announcementId ?? null });
}

/** 时间线的一行 (人类输出) */
export function formatTrailLine(e: TrailEntry): string {
  const t = e.at ? new Date(e.at).toISOString().replace('T', ' ').slice(0, 19) : '(无时间)';
  const facts = Object.entries(e.fields)
    .filter(([k]) => k !== 'kind')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return `${t}  ${TRAIL_KIND_LABEL[e.kind].padEnd(4, '　')}  ${e.sender.padEnd(14)}  ${facts}`;
}
