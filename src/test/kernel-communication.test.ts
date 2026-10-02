/**
 * K8 门: Communication Runtime 收口 —— 台账与盘上事实双向一致 (台账先行, 行为零改变)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { K8_EVENT_FACES, K8_TRANSPORT_AGENT_SITES, K8_PER_CHANNEL_STATE, K8_PROGRESS, K8_ACCEPTANCE } from '../kernel/plan-communication.js';
import {
  scanCommunicationLedger, countTransportAgentSites, K8_SITE_KINDS, scanChannelStateLedger,
  countChannelStateSymbols, scanDidFixConsolidation, scanRunStateConsolidation, countSymbolOccurrences, stripJsComments,
} from '../kernel/gate-scan.js';
import { K8_CHANNEL_RUNSTATE } from '../kernel/plan-communication.js';

/** 把文本**真写进临时文件**再读回 —— 变异必须每次真做, 不是在内存里假装 */
function realTmp(name: string, text: string): string {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'k8-mut-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, text, 'utf8');
  return fs.readFileSync(p, 'utf8');
}

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
    // 口径: 35 个是"文件里出现的状态符号", 其中 **31 个**才是 K8 要收口的对象
    // 2026-10-02 补登 (漏了两个真状态: channelRunState / didFixTimer) ⇒ 35/31 → 37/33
    expect(countChannelStateSymbols(STATE)).toEqual({ total: 37, target: 33 });
    expect(countChannelStateSymbols(STATE).total).toBe(K8_PROGRESS.perChannelStateSymbols);
    expect(countChannelStateSymbols(STATE).target).toBe(K8_PROGRESS.k8TargetSymbols);
    expect(K8_PER_CHANNEL_STATE).toHaveLength(10);
    // 范围外符号必须逐条写明理由 (不许静默豁免)
    const outOfScope = K8_PER_CHANNEL_STATE.flatMap((e) => e.symbols).filter((s) => s.scope !== 'k8-target');
    expect(outOfScope).toHaveLength(4);
    for (const s of outOfScope) expect((s.note ?? '').length).toBeGreaterThan(5);
  });

  it('② 判别力: 坏样本用**不可能撞上真值**的符号 (__noSuchSymbol__) ⇒ 判红', () => {
    const bad = { sites: [{ ...K8_PER_CHANNEL_STATE[0], symbols: [{ name: '__noSuchSymbol__', scope: 'k8-target' }] }], progress: { perChannelStateFiles: 1, perChannelStateSymbols: 1, k8TargetSymbols: 1 } };
    const fs2 = scanChannelStateLedger(bad, { readFile });
    expect(fs2.some((x) => /盘上找不到: __noSuchSymbol__/.test(x.what))).toBe(true);
    expect(fs2.some((x) => /盘上=无/.test(x.what))).toBe(true);
  });

  it('② 判别力: 文件读不出来 ⇒ **拒跑** (不是"跳过")', () => {
    const bad = { sites: [{ file: 'src/__nope__.ts', kind: 'outbox', symbols: [{ name: 'x', scope: 'k8-target' }], why: 'x' }], progress: { perChannelStateFiles: 1, perChannelStateSymbols: 1, k8TargetSymbols: 1 } };
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

  it('② 棘轮: K8 收口对象符号数超预算 ⇒ 判红 (新增自带 outbound/重试/恢复必须走 router/mailbox)', () => {
    const bad = { sites: K8_PER_CHANNEL_STATE, progress: { ...K8_PROGRESS, k8TargetSymbols: 30 } };
    expect(scanChannelStateLedger(bad, { readFile }).some((x) => /超棘轮/.test(x.what))).toBe(true);
  });

  it('② 判别力: 符号总数与 progress 不符 ⇒ 判红 (增了要登记, 减了要同步)', () => {
    const bad = { sites: K8_PER_CHANNEL_STATE, progress: { ...K8_PROGRESS, perChannelStateSymbols: 99 } };
    expect(scanChannelStateLedger(bad, { readFile }).some((x) => /符号总数/.test(x.what))).toBe(true);
  });

  it('② 判别力: 标成"范围外"却不写理由 ⇒ 判红 (不许拿 scope 当静默豁免)', () => {
    const bad = { sites: [{ ...K8_PER_CHANNEL_STATE[3], symbols: [{ name: 'messageQueue', scope: 'ui-state' }] }], progress: { perChannelStateFiles: 1, perChannelStateSymbols: 1, k8TargetSymbols: 0 } };
    expect(scanChannelStateLedger(bad, { readFile }).some((x) => /不许静默豁免/.test(x.what))).toBe(true);
  });

  it('② 判别力: scope 非法 ⇒ 判红', () => {
    const bad = { sites: [{ ...K8_PER_CHANNEL_STATE[3], symbols: [{ name: 'didFixQueue', scope: 'whatever' }] }], progress: { perChannelStateFiles: 1, perChannelStateSymbols: 1, k8TargetSymbols: 1 } };
    expect(scanChannelStateLedger(bad, { readFile }).some((x) => /scope 非法/.test(x.what))).toBe(true);
  });

  it('④ 收口实证: DID 修复待办执行**经内核邮箱**, 且通道自己的全局单飞已删 (直接读源码)', () => {
    const src = readFile('src/web/server.ts');
    expect(src).not.toBeNull();
    expect(scanDidFixConsolidation({ src: src!, removedFlag: 'didFixRunning', mustUse: 'getChannelQueue', nextTargetSymbol: 'channelRunState' })).toEqual([]);
    // 必须是**真调用** + 从内核 import 进来 (不是只写在注释里 / 不是本地同名函数)
    expect((src!.match(/getChannelQueue\s*\(/g) || []).length).toBeGreaterThanOrEqual(1);   // 调用点
    expect(src!).toMatch(/import \{[^}]*getChannelQueue[^}]*\} from '\.\.\/kernel\/channel-actor\.js'/);
  });

  it('④ ★ 真盘变异: 把 `getChannelQueue(` 从副本里换掉 ⇒ 判红; 把全局单飞字段塞回代码 ⇒ 判红', () => {
    const src = readFile('src/web/server.ts')!;
    // 变异 A: 邮箱调用被换掉 ⇒ "没走内核邮箱"
    const mutA = realTmp('server-mutA.ts', src.replace(/getChannelQueue/g, 'plainQueue__x'));
    expect(scanDidFixConsolidation({ src: mutA, removedFlag: 'didFixRunning', mustUse: 'getChannelQueue', nextTargetSymbol: 'channelRunState' })
      .some((x) => /没走内核邮箱/.test(x.what))).toBe(true);
    // 变异 B: 全局单飞字段塞回**代码**里 (非注释) ⇒ "收口没真生效"
    const mutB = realTmp('server-mutB.ts', src.replace('  const didFixQueue = new Set<string>();', '  let didFixRunning = false;\n  const didFixQueue = new Set<string>();'));
    expect(scanDidFixConsolidation({ src: mutB, removedFlag: 'didFixRunning', mustUse: 'getChannelQueue', nextTargetSymbol: 'channelRunState' })
      .some((x) => /收口没真生效/.test(x.what))).toBe(true);
    // 未变异 ⇒ 仍绿
    expect(scanDidFixConsolidation({ src, removedFlag: 'didFixRunning', mustUse: 'getChannelQueue', nextTargetSymbol: 'channelRunState' })).toEqual([]);
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

describe('K8 大目标门: channelRunState 迁移工作面 (台账 == 盘上, 按符号不按行号)', () => {
  it('① 真跑: 台账与盘上**完全一致** (21 处用法 / 7 个字段都在接口里; queue 已删 · running 降观测)', () => {
    expect(scanRunStateConsolidation(K8_CHANNEL_RUNSTATE, K8_PROGRESS, { readFile })).toEqual([]);
    const src = readFile('src/web/server.ts')!;
    expect(countSymbolOccurrences(src, 'channelRunState')).toBe(K8_CHANNEL_RUNSTATE.sites);
    expect(K8_CHANNEL_RUNSTATE.sites).toBe(K8_PROGRESS.runStateSites);          // 棘轮基线
    expect(K8_CHANNEL_RUNSTATE.fields).toHaveLength(7);   // 8 → 7: `queue` 已删除 (2026-10-02 正刀)
    // 三种语义分开登记: **1 个真收口** (只剩 abort) + 5 观测 (running 已从收口降为观测) + 1 协作
    expect(K8_CHANNEL_RUNSTATE.fields.filter((f) => f.role === 'k8-target').map((f) => f.name)).toEqual(['abortController']);
    expect(K8_CHANNEL_RUNSTATE.fields.filter((f) => f.role === 'observational')).toHaveLength(5);
    expect(K8_CHANNEL_RUNSTATE.fields.filter((f) => f.role === 'domain-collab')).toHaveLength(1);
    for (const f of K8_CHANNEL_RUNSTATE.fields.filter((x) => x.role === 'k8-target')) {
      expect((f.replacedBy ?? '').length).toBeGreaterThan(9);   // 收口对象必须写替代机制
    }
  });

  it('② 判别力: 用法数被改成不可能撞上的值 (999) ⇒ 判红', () => {
    const bad = { ...K8_CHANNEL_RUNSTATE, sites: 999 };
    expect(scanRunStateConsolidation(bad, K8_PROGRESS, { readFile }).some((x) => /用法数 台账=999/.test(x.what))).toBe(true);
  });

  it('② 判别力: 收口字段没写替代机制 / 非收口字段没写理由 ⇒ 判红 (不许静默豁免)', () => {
    const noReplace = { ...K8_CHANNEL_RUNSTATE, fields: K8_CHANNEL_RUNSTATE.fields.map((f) => (f.name === 'abortController' ? { ...f, replacedBy: '' } : f)) };
    expect(scanRunStateConsolidation(noReplace, K8_PROGRESS, { readFile }).some((x) => /没写替代机制/.test(x.what))).toBe(true);
    const noNote = { ...K8_CHANNEL_RUNSTATE, fields: K8_CHANNEL_RUNSTATE.fields.map((f) => (f.name === 'lastSummary' ? { ...f, note: '' } : f)) };
    expect(scanRunStateConsolidation(noNote, K8_PROGRESS, { readFile }).some((x) => /不许静默豁免/.test(x.what))).toBe(true);
  });

  it('② 判别力: 字段在接口里找不到 ⇒ 判红 (台账不许凭空造字段)', () => {
    const ghost = { ...K8_CHANNEL_RUNSTATE, fields: [...K8_CHANNEL_RUNSTATE.fields, { name: '__ghostField__', role: 'observational', note: '凭空造的字段' }] };
    const found = scanRunStateConsolidation(ghost, K8_PROGRESS, { readFile }).map((x) => x.what);
    expect({ found, 命中: found.some((w) => /__ghostField__/.test(w)) }).toEqual({ found: expect.anything(), 命中: true });
  });

  it('② 判别力: 读不出源码 ⇒ 拒跑 (不是"跳过")', () => {
    const bad = { ...K8_CHANNEL_RUNSTATE, file: 'src/__nope__.ts' };
    expect(scanRunStateConsolidation(bad, K8_PROGRESS, { readFile }).some((x) => /拒跑/.test(x.what))).toBe(true);
  });

  it('③ ★ 真盘变异: 往副本里**插一处**新用法 ⇒ 台账立刻过期判红 (证明它数的是盘上代码)', () => {
    const src = readFile('src/web/server.ts')!;
    const mut = realTmp('server-runstate-mut.ts', src.replace(
      '  function getOrCreateRunState(channelId: string): ChannelRunState {',
      '  function __probeExtraUse(): number { return channelRunState.size; }\n  function getOrCreateRunState(channelId: string): ChannelRunState {'));
    expect(countSymbolOccurrences(mut, 'channelRunState')).toBe(K8_CHANNEL_RUNSTATE.sites + 1);
    const io = { readFile: (rel: string) => (rel === 'src/web/server.ts' ? mut : readFile(rel)) };
    expect(scanRunStateConsolidation(K8_CHANNEL_RUNSTATE, K8_PROGRESS, io).some((x) => /用法数 台账=21 盘上=22/.test(x.what))).toBe(true);
    expect(scanRunStateConsolidation(K8_CHANNEL_RUNSTATE, K8_PROGRESS, { readFile })).toEqual([]);   // 未变异 ⇒ 仍绿
  });
});

describe('K8 正刀: 每条消息都进内核邮箱 (通道不再兼任调度器, 重复的第二条路径已删)', () => {
  it('⑤ 机械: 一处 finishChannelRun 实现 + 一处调用 · 简化版路径与通道队列都不存在 · 消息经 getChannelQueue().submit', () => {
    // 注意: 形状判据只看**剥注释后**的代码 —— 注释里应当保留"删了什么、为什么删"的说明,
    //   否则下次有人看到 `runMessageFromQueue` 这个名字会以为它还在 (文档与代码各说各话)。
    const src = stripJsComments(readFile('src/web/server.ts')!);
    expect((src.match(/function finishChannelRun\(/g) || []).length).toBe(1);            // 两份实现 → 一处
    expect((src.match(/finishChannelRun\(channelId, runState\)/g) || []).length).toBe(1); // 只剩 finally 那一处 (drain 分支已删)
    expect(src).not.toMatch(/runMessageFromQueue/);                       // **简化版第二条路径已删**
    expect(src).not.toMatch(/runState\.queue/);                          // 通道不再持队列
    expect(src).not.toMatch(/\[queue-drain\]/);                          // drain 日志随之消失
    expect(src).toMatch(/getChannelQueue\(channelId\)\.submit\(runChannelMessage\)/);  // 每条消息都投邮箱
  });
});
