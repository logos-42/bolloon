/**
 * 出口净化 (2026-10-01 落实③): 所有进模型的文本过同一道闸。
 * 纪律: 宁可误伤, 不可漏放; 先脱敏再截断; 幂等; 短文本零成本。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets, elideMiddle, sanitizeForLlm, hasSuspiciousSecret } from '../agents/egress-sanitize.js';

const HEX64 = 'a'.repeat(64);
const HEX64B = 'b3f1' + 'c'.repeat(60);

describe('脱敏: 凭证形态一律打码 (宁可误伤)', () => {
  it('私钥 hex (带 0x / 不带) 都打码', () => {
    expect(redactSecrets(`key=0x${HEX64}`)).not.toContain(HEX64);
    expect(redactSecrets(`key=${HEX64B}`)).not.toContain(HEX64B);
  });
  it('助记词 (12+ 词) 打码', () => {
    const m = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    expect(redactSecrets(`mnemonic: ${m}`)).not.toContain('accident');
  });
  it('各家 token 前缀都打码', () => {
    for (const t of ['sk-abcdefghijklmnopqrstuvwx', 'ghp_' + 'A'.repeat(24), 'xoxb-1234567890-abcd', 'AKIA' + 'B'.repeat(16), 'npm_' + 'c'.repeat(34)]) {
      expect(redactSecrets(`t=${t}`), t.slice(0, 8)).not.toContain(t);
    }
  });
  it('JWT / Bearer / URL 里的用户名密码', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4';
    expect(redactSecrets(`a=${jwt}`)).not.toContain(jwt);
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactSecrets('https://user:hunter2@example.com/x')).not.toContain('hunter2');
  });
  it('key: value 形态 (私钥/助记词/token/password)', () => {
    expect(redactSecrets('{"privateKey": "abcdefghijklmnop"}')).not.toContain('abcdefghijklmnop');
    expect(redactSecrets("password = 'sup3rsecret!'")).not.toContain('sup3rsecret!');
  });
  it('正常文本一个字不动', () => {
    const ok = '规矩: 分界线要满宽。user=leo did=did:key:z6Mkg2hYzB4e3mgT1z';
    expect(redactSecrets(ok)).toBe(ok);
    expect(hasSuspiciousSecret(ok)).toBe(false);
  });
  it('**幂等**: 打过码的文本再跑不变 (不会层层叠加标签)', () => {
    const once = redactSecrets(`k=0x${HEX64}`);
    expect(redactSecrets(once)).toBe(once);
  });
});

describe('中间省略', () => {
  it('短的原样; 长的保留头尾并标出省略量', () => {
    expect(elideMiddle('short', 100)).toBe('short');
    const long = 'H'.repeat(500) + 'T'.repeat(500);
    const out = elideMiddle(long, 200);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out).toContain('省略');
    expect(out.startsWith('H')).toBe(true);
    expect(out.endsWith('T')).toBe(true);
  });
  it('边界: maxChars<=0 / 非数 ⇒ 原样返回 (不做意外截断)', () => {
    expect(elideMiddle('abc', 0)).toBe('abc');
    expect(elideMiddle('abc', NaN)).toBe('abc');
  });
});

describe('唯一出口 sanitizeForLlm', () => {
  it('**先脱敏再截断** —— 截断不能把 key 切成半截漏出去', () => {
    const text = 'x'.repeat(50) + `0x${HEX64}` + 'y'.repeat(500);
    const out = sanitizeForLlm(text, 120);
    expect(out).not.toContain('0x' + 'a'.repeat(40)); // 半截也不行
    expect(hasSuspiciousSecret(out)).toBe(false);
  });
  it('两个动作都会发生 (脱敏 + 省略)', () => {
    const out = sanitizeForLlm(`token=sk-abcdefghijklmnopqrstuvwx ` + 'z'.repeat(400), 100);
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(out).toContain('省略');
  });
});

describe('挂点存在 (源级核对: 闸要真的在路径上, 不是摆着)', () => {
  it('persona 文档格式化前过 sanitizeForLlm', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/bootstrap/persona-loader.ts'), 'utf-8');
    expect(src).toContain('sanitizeForLlm');
  });
});
