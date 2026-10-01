/**
 * 出口净化 (2026-10-01 落实③)。
 *
 * 为什么: 记忆/身份文档/历史片段这些"文本资产"最终都会**拼进给模型的提示**。秘密一旦混进去, 就等于
 *   通过 API 送出去了 —— 而且会**反复**送(每一轮)。纪律上我们早就规定"凭证只落 0600 文件、绝不回显",
 *   但那靠的是调用方自觉;出口必须是一道**闸**: 所有要进模型的文本都过同一个函数。
 * 设计对齐 (只搬约束): **一个 choke point** · 先脱敏再截断 · 中间省略保留头尾 · 短文本原样返回(零成本)。
 * 取舍: 宁可误伤(把长得像密钥的东西打码), 不可漏放 —— 误伤只是少几个字符, 漏放是事故。
 */
/** 常见凭证形态 (按"长得像"判, 不依赖具体厂商) */
const SECRET_PATTERNS: Array<{ re: RegExp; tag: string }> = [
  // 私钥 hex: 0x + 64 hex, 或裸 64 hex
  { re: /\b0x[0-9a-fA-F]{64}\b/g, tag: '[REDACTED:hex-key]' },
  { re: /\b[0-9a-fA-F]{64}\b/g, tag: '[REDACTED:hex64]' },
  // 助记词: 12+ 个连续小写词 (空格分隔)
  { re: /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, tag: '[REDACTED:mnemonic]' },
  // 常见 token 前缀
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, tag: '[REDACTED:api-key]' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, tag: '[REDACTED:github-token]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, tag: '[REDACTED:slack-token]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, tag: '[REDACTED:aws-key]' },
  { re: /\bnpm_[A-Za-z0-9]{30,}\b/g, tag: '[REDACTED:npm-token]' },
  // JWT
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, tag: '[REDACTED:jwt]' },
  // Authorization: Bearer xxx
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, tag: 'Bearer [REDACTED]' },
  // URL 里的用户名:密码
  { re: /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, tag: '$1[REDACTED]@' },
  // key: value 形态的敏感字段 (私钥/助记词/密钥/token/password)
  { re: /((?:privateKey|private_key|mnemonic|seedPhrase|seed_phrase|secret|apiKey|api_key|token|password|passwd|passphrase)"?\s*[:=]\s*)"[^"]{8,}"/gi, tag: '$1"[REDACTED]"' },
  { re: /((?:privateKey|private_key|mnemonic|seedPhrase|seed_phrase|secret|apiKey|api_key|token|password|passwd|passphrase)"?\s*[:=]\s*)'[^']{8,}'/gi, tag: "$1'[REDACTED]'" },
  { re: /((?:privateKey|private_key|mnemonic|seedPhrase|seed_phrase|secret|apiKey|api_key|token|password|passwd|passphrase)"?\s*[:=]\s*)[^\s,;"'}\]]{8,}/gi, tag: '$1[REDACTED]' },
];

/** 把长得像凭证的东西打码 (纯函数, 幂等 — 已打码的文本再跑不变) */
export function redactSecrets(text: string): string {
  let out = String(text ?? '');
  for (const { re, tag } of SECRET_PATTERNS) out = out.replace(re, tag as any);
  return out;
}

/** 中间省略: 长度 <= maxChars 原样返回; 否则保留头 head、尾 tail, 中间插省略标记 */
export function elideMiddle(text: string, maxChars: number, headChars = 0, tailChars = 0): string {
  const s = String(text ?? '');
  const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  if (!max || s.length <= max) return s;
  // 头/尾各留一部分, **给省略标记留出余量** —— 上一版 head+tail 正好等于 max ⇒ 落到"直接截断"分支,
  // 省略标记根本不出现(门抓到: 输出里没有 "省略" ✗)。现在按 60%/25% 留, 剩下给标记。
  const head = headChars > 0 ? Math.min(headChars, Math.floor(max * 0.8)) : Math.floor(max * 0.6);
  const tail = tailChars > 0 ? Math.min(tailChars, Math.floor(max * 0.3)) : Math.floor(max * 0.25);
  const marker = (n: number) => `\n…[省略 ${n} 字符]…\n`;
  if (head <= 0 && tail <= 0) return s.slice(0, max);
  const omitted = Math.max(0, s.length - head - tail);
  const out = `${s.slice(0, head)}${marker(omitted)}${tail > 0 ? s.slice(-tail) : ''}`;
  return out.length <= max + marker(omitted).length ? out : out.slice(0, max + marker(omitted).length);
}

/**
 * **唯一出口**: 任何要拼进模型的文本都过这里。
 * 顺序很重要 —— 先脱敏再截断: 否则截断可能把 key 的中间切掉, 让模式匹配失效(半截 key 照样是泄漏)。
 */
export function sanitizeForLlm(text: string, maxChars = 0): string {
  const redacted = redactSecrets(text);
  return maxChars > 0 ? elideMiddle(redacted, maxChars) : redacted;
}

/** 一行内是否含可疑凭证 (给调用方做审计/告警用, 不改变文本) */
export function hasSuspiciousSecret(text: string): boolean {
  return redactSecrets(text) !== String(text ?? '');
}
