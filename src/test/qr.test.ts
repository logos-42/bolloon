import { describe, it, expect } from 'vitest';
// 扫码入网二维码 (PC /net qr 出码) 纯函数单测
import { buildQrPayload, encodeQrTerminal } from '../web/qr.js';

describe('qr 扫码入网', () => {
  it('buildQrPayload 拼接链接+name/ctx/version query', () => {
    const p = buildQrPayload({ link: 'https://x.com/registry', name: 'alpha', ctxCid: 'Qm1', version: '1' });
    expect(p).toContain('/registry?name=alpha');
    expect(p).toContain('ctx=Qm1');
    expect(p).toContain('v=1');
  });

  it('链接已带 query 时用 & 追加', () => {
    const p = buildQrPayload({ link: 'https://x.com/registry?name=beta', ctxCid: 'Qm2' });
    expect(p).toContain('&ctx=Qm2');
  });

  it('encodeQrTerminal 产出非空 ASCII 二维码', async () => {
    const s = await encodeQrTerminal('https://x.com/registry?name=netX');
    expect(s.length).toBeGreaterThan(10);
    expect(s).toMatch(/[█▀▄]/); // 半块字符
  });
});
