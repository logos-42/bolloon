/**
 * task-public-text.ts — **公开文本的隐私红线 (单一来源)** (2026-09-25)
 *
 * 为什么要单独一个文件: 同一条红线要同时把住**两个入口** ——
 *   · 桌面/CLI: 群消息发送前 (`task-group.ts` → `requirePublicText`)
 *   · 手机 WebView: 手机侧发公告/接单/入群前 (mobile-tasks.ts → 同一函数)
 * 两边各抄一份规则 = 迟早漂移 (一边加了规则另一边没加, 于是手机成了绕过红线的后门)。
 * 所以规则表放在这里, 双方都 import 这一份; 本文件**不 import 任何 node: 模块**,
 * 因此既能进 Node, 也能进浏览器 bundle。
 *
 * 群消息**禁止出现**的形态 (顺序即报告顺序)。宁可多拦 (拒发 + 说清哪条规则),
 * 也不放行一条带标识符的消息。
 *
 * 实现纪律 (2026-09-23 踩过的坑, 不可回退):
 * · **不要用 `\b` 当边界** —— 消息里的 token 会把空白折成 `_`, 而 `_` 也是 \w, 于是 `判据见_0x1111…`
 *   这种"粘在 `_`/汉字后面"的标识符 `\b` 判不出来, 会直接漏进群。一律改成对标识符自身字母表的
 *   lookahead/lookbehind (`(?<![0-9a-fA-FxX])`, `(?![0-9a-fA-F])`), 粘在 `_`/中文/符号后面也照样命中。
 * · ipv6 规则要**避开 ISO 时间戳** (`09:50:12.345Z` 只有两个冒号): 只认 3 组以上 `x:y:z:w` 或含 `::` 的压缩形态。
 * · 内容哈希 (sha256 64 位裸 hex) **不在**禁列 —— 交付就是要贴哈希 (它不是密钥, 也没有 0x 前缀)。
 */

export interface PrivacyRule {
  rule: string;
  why: string;
  re: RegExp;
}

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

/** 标识符打码 (只留前 4 字符) */
export function mask(s: string): string {
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

/** 发送前唯一闸门: 命中任何规则 → 拒绝发送 (返回 violations 供 CLI/手机如实报出) */
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
