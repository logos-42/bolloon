/**
 * K8 门: Communication Runtime 收口 —— 台账与盘上事实双向一致 (台账先行, 行为零改变)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { K8_EVENT_FACES, K8_TRANSPORT_AGENT_SITES, K8_PER_CHANNEL_STATE, K8_PROGRESS, K8_ACCEPTANCE } from '../kernel/plan-communication.js';
import { scanCommunicationLedger, countTransportAgentSites, K8_SITE_KINDS, scanChannelStateLedger, countChannelStateSymbols } from '../kernel/gate-scan.js';

const ROOT = process.cwd();
const readFile = (rel: string): string | null => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
const STATE = { sites: K8_PER_CHANNEL_STATE, progress: K8_PROGRESS };
const REAL = {
  faces: K8_EVENT_FACES,
  sites: K8_TRANSPORT_AGENT_SITES,
  perChannel: K8_PER_CHANNEL_STATE,
  progress: K8_PROGRESS,
};

describe('K8 台账门: Communication Runtime 收口', () => {
  it('① 真跑: 台账与盘上事实一致 (零 finding)', () => {
    expect(scanCommunicationLedger(REAL, { readFile })).toEqual([]);
  });

  it('①b 自洽: 10 个事件面 / 直连合计 == progress / 各通道状态 == progress', () => {
    expect(K8_EVENT_FACES).toHaveLength(10);
    expect(new Set(K8_EVENT_FACES).size).toBe(10);
    expect(K8_TRANSPORT_AGENT_SITES.reduce((n, s) => n + s.count, 0)).toBe(K8_PROGRESS.directSites);
    expect(K8_PER_CHANNEL_STATE).toHaveLength(K8_PROGRESS.perChannelStateFiles);
    expect(K8_PROGRESS.directSites).toBeLessThanOrEqual(12);   // 棘轮: 量测基线 12, 只许减 (2026-10-02 已迁 2 处 ⇒ 10)
    expect(K8_PROGRESS.directSites).toBeLessThanOrEqual(12);
    expect(K8_PROGRESS.directSites).toBe(0);   // 12 → 10 → 7 → 3 → 0 (K8 第二/三/四步)
    expect(K8_TRANSPORT_AGENT_SITES.filter((s) => s.status === 'migrated')).toHaveLength(2);
    expect(K8_ACCEPTANCE.length).toBeGreaterThanOrEqual(4);
  });

  it('② 判别力: 直连数被改 (盘上没改) ⇒ 红', () => {
    const bad = { ...REAL, sites: K8_TRANSPORT_AGENT_SITES.map((s, i) => (i === 0 ? { ...s, count: s.count + 2 } : s)) };
    expect(scanCommunicationLedger(bad, { readFile }).some((x) => /盘上=/.test(x.what))).toBe(true);
  });

  it('② 判别力: 文件读不出来 ⇒ 拒跑 (不是"跳过")', () => {
    const bad = { ...REAL, sites: [{ ...K8_TRANSPORT_AGENT_SITES[0], file: 'src/__nope__.ts' }], progress: { ...K8_PROGRESS, directSites: 0 } };
    const f = scanCommunicationLedger(bad, { readFile });
    expect(f.some((x) => /拒跑/.test(x.what))).toBe(true);
  });

  it('② 判别力: 未知 kind / 事件面重复 / 各通道文件不存在 都要判红', () => {
    expect(scanCommunicationLedger({ ...REAL, sites: [{ ...K8_TRANSPORT_AGENT_SITES[0], kind: 'whatever' }], progress: { ...K8_PROGRESS, directSites: K8_TRANSPORT_AGENT_SITES[0].count } }, { readFile }).some((x) => /未知 kind/.test(x.what))).toBe(true);
    expect(scanCommunicationLedger({ ...REAL, faces: [...K8_EVENT_FACES.slice(0, 9), K8_EVENT_FACES[0]] }, { readFile }).some((x) => /重复/.test(x.what))).toBe(true);
    expect(scanCommunicationLedger({ ...REAL, perChannel: [{ file: 'src/__nope__.ts', kind: 'outbox' }], progress: { ...K8_PROGRESS, perChannelStateFiles: 1 } }, { readFile }).some((x) => /文件不存在/.test(x.what))).toBe(true);
  });

  it('② 判别力: 台账里写行号 ⇒ 红 (行号会漂, 按符号写)', () => {
    const bad = { ...REAL, sites: [{ ...K8_TRANSPORT_AGENT_SITES[0], why: 'web 通道 (第 668 行, 1000 行)' }], progress: { ...K8_PROGRESS, directSites: K8_TRANSPORT_AGENT_SITES[0].count } };
    expect(scanCommunicationLedger(bad, { readFile }).some((x) => /行号/.test(x.what))).toBe(true);
  });

  it('③ 机械: 口径函数只认 `\\.promptStream(`/`\\.prompt(` 且先剥注释', () => {
    expect(countTransportAgentSites('// a.prompt(x)\n/* b.promptStream(y) */\n c.promptStream(z)')).toBe(1);
    expect(K8_SITE_KINDS).toEqual(['direct-prompt', 'via-actor']);
  });
});

describe('K8 第二步门: 各通道自带状态台账 (按符号核, 不按行号)', () => {
  it('① 真跑: 35 个状态符号**逐个**在盘上真实存在 (零 finding)', () => {
    expect(scanChannelStateLedger(STATE, { readFile })).toEqual([]);
    expect(countChannelStateSymbols(STATE)).toBe(K8_PROGRESS.perChannelStateSymbols);
    expect(countChannelStateSymbols(STATE)).toBe(35);
    expect(K8_PER_CHANNEL_STATE).toHaveLength(10);
  });

  it('② 判别力: 坏样本用**不可能撞上真值**的符号 (__noSuchSymbol__) ⇒ 判红', () => {
    const bad = { sites: [{ ...K8_PER_CHANNEL_STATE[0], symbols: ['__noSuchSymbol__'] }], progress: { perChannelStateFiles: 1, perChannelStateSymbols: 1 } };
    const fs2 = scanChannelStateLedger(bad, { readFile });
    expect(fs2.some((x) => /盘上找不到: __noSuchSymbol__/.test(x.what))).toBe(true);
    expect(fs2.some((x) => /盘上=无/.test(x.what))).toBe(true);
  });

  it('② 判别力: 文件读不出来 ⇒ **拒跑** (不是"跳过")', () => {
    const bad = { sites: [{ file: 'src/__nope__.ts', kind: 'outbox', symbols: ['x'], why: 'x' }], progress: { perChannelStateFiles: 1, perChannelStateSymbols: 1 } };
    expect(scanChannelStateLedger(bad, { readFile }).some((x) => /拒跑/.test(x.what))).toBe(true);
  });

  it('② 判别力: 台账里出现行号 (四种自然写法) ⇒ 判红 (行号会漂)', () => {
    for (const bad_text of ['(668,', ':668', '第 668 行']) {
      const bad = { sites: [{ ...K8_PER_CHANNEL_STATE[3], why: `web 通道 (${bad_text} 附近)` }], progress: { perChannelStateFiles: 1, perChannelStateSymbols: 35 } };
      expect(scanChannelStateLedger(bad, { readFile }).some((x) => /写了行号/.test(x.what))).toBe(true);
    }
  });

  it('② 判别力: 空符号表没说明"无自带状态" ⇒ 判红 (不许静默留白)', () => {
    const bad = { sites: [{ file: 'src/agents/contacts/store.ts', kind: 'none', symbols: [], why: '联系人存储' }], progress: { perChannelStateFiles: 1, perChannelStateSymbols: 0 } };
    expect(scanChannelStateLedger(bad, { readFile }).some((x) => /空表要显式声明/.test(x.what))).toBe(true);
  });

  it('② 棘轮: 符号数超预算 ⇒ 判红 (新增自带状态必须走 router/mailbox)', () => {
    const bad = { sites: K8_PER_CHANNEL_STATE, progress: { ...K8_PROGRESS, perChannelStateSymbols: 34 } };
    expect(scanChannelStateLedger(bad, { readFile }).some((x) => /超棘轮/.test(x.what))).toBe(true);
  });

  it('③ ★ 真盘变异: 把符号从**盘上副本**里删掉 ⇒ 门必须判红 (证明它读的是源码, 不是台账)', () => {
    const mutated = fs2_real(readFile('src/network/p2p-outbox.ts')!.replace(/sendOrQueue/g, 'sendOrQ__x'));
    const io = { readFile: (rel: string) => (rel === 'src/network/p2p-outbox.ts' ? mutated : readFile(rel)) };
    expect(mutated.includes('sendOrQueue')).toBe(false);   // 变异真的落到了"盘上"
    const f2 = scanChannelStateLedger(STATE, io);
    expect(f2.some((x) => /盘上找不到: sendOrQueue/.test(x.what))).toBe(true);
    expect(scanChannelStateLedger(STATE, { readFile })).toEqual([]);   // 未变异 ⇒ 仍绿
  });
});

/** 把变异文本**真写进临时文件**再读回 —— 变异必须每次真做, 不是在内存里假装 */
function fs2_real(text: string): string {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'k8-mut-'));
  const p = path.join(dir, 'p2p-outbox.ts');
  fs.writeFileSync(p, text, 'utf8');
  return fs.readFileSync(p, 'utf8');
}
