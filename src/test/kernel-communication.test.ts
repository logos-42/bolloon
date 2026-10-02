/**
 * K8 门: Communication Runtime 收口 —— 台账与盘上事实双向一致 (台账先行, 行为零改变)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { K8_EVENT_FACES, K8_TRANSPORT_AGENT_SITES, K8_PER_CHANNEL_STATE, K8_PROGRESS, K8_ACCEPTANCE } from '../kernel/plan-communication.js';
import { scanCommunicationLedger, countTransportAgentSites, K8_SITE_KINDS } from '../kernel/gate-scan.js';

const ROOT = process.cwd();
const readFile = (rel: string): string | null => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
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
    expect(K8_PROGRESS.directSites).toBe(3);   // 12 → 10 → 7 → 3 (K8 第二/三/四步)
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
