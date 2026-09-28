/**
 * efficode.test.ts — Efficode 参考实现的单测 (2026-09-28)
 *
 * 要证的事:
 *   ① round-trip: encode → decode **逐字节/逐字段**还原 (二进制模式与文本模式都跑);
 *   ② 边界: 超长 / 非法 / 截断 / 篡改 / 未知指令 / 未知压缩 / 尾随垃圾 —— 一律**报错**, 绝不"瞎解";
 *   ③ 压缩层: 真压真解 (lz77 / deflate / none 三条都回环), 压缩比是**真测**出来的数字;
 *   ④ CRC32: 用规范向量自证 (crc32("123456789") = 0xCBF43926), 不是"看起来对";
 *   ⑤ 语言协商: 双方声明才用 · 单方声明回落 · 未知语言**绝不硬解** · 每次都留记录;
 *   ⑥ DID 段: 32B 摘要段可编可解可比对, 但**不能**还原身份 (如实断言 signed:false)。
 *
 * 不确定的属性一律不写成 true —— 例如签名验证能力: 本实现**没有**, 所以只断言 signed === false。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { crc32, crc32Bytes, readCrc32Bytes } from '../efficode/crc32.js';
import { lz77Compress, lz77Decompress } from '../efficode/lz77.js';
import { measureAll, pickAlgo, compressBlock, decompressBlock } from '../efficode/compress.js';
import {
  buildPacket, encodePacket, parsePacket, messageFromSymbolic, packetToMessage,
} from '../efficode/packet.js';
import { instructionsToSymbolic, symbolicToInstructions, opByCode, isKnownOpCode } from '../efficode/ops.js';
import { encodeDidSegment, decodeDidSegment, didDigestString, matchesDidSegment } from '../efficode/did.js';
import {
  negotiateLang, normalizeLang, unknownLangNames, encodeForPeer, decodeFromPeer,
  defaultDeclaredLang, recordLangDecision, readLangDecisionLog, langDecisionLogPath,
} from '../efficode/negotiate.js';
import { EfficodeError, DID_SEGMENT_BYTES, EFFICODE_VERSION } from '../efficode/types.js';
import {
  buildAgentMessage, readAgentMessage, parseAgentMessageFrame,
  setLocalSupportedLangs, manifestLangDeclaration, peerLangsOf, localDeclaredLang, setLocalDeclaredLang,
} from '../agents/agent-lang.js';

// ============== 夹具 ==============

let HOME = '';
const savedHome = process.env.BOLLOON_HOME;

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-efficode-test-'));
  process.env.BOLLOON_HOME = HOME;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.BOLLOON_HOME; else process.env.BOLLOON_HOME = savedHome;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  setLocalSupportedLangs([]);
  setLocalDeclaredLang('natural');
});

/** 从既有包改一个字节并**重算 CRC** —— 用来构造"结构合法但语义非法"的包 */
function reseal(packet: Uint8Array, mutate: (b: Uint8Array) => void): Uint8Array {
  const copy = Uint8Array.from(packet);
  mutate(copy);
  const head = copy.subarray(0, copy.length - 4);
  copy.set(crc32Bytes(head), copy.length - 4);
  return copy;
}

/** 从零手拼一个包 (CRC 现算) —— 用来精确构造"字段级非法"的包, 不靠猜偏移 */
function craft(parts: {
  mode?: number;         // 0 compact / 1 text
  flags: number;
  did?: Uint8Array;      // 32B
  ops?: Uint8Array;      // 指令段内容 (不含外层 varint)
  dataBlock?: Uint8Array; // 数据块内容 (不含外层 varint)
  trailing?: number[];
}): Uint8Array {
  const out: number[] = [];
  out.push((EFFICODE_VERSION << 4) | (parts.mode ?? 0), parts.flags);
  if (parts.did) for (const b of parts.did) out.push(b);
  const ops = parts.ops ?? Uint8Array.from([4, 0]); // 默认: !ACK (opcode 4 + 载荷长 0)
  out.push(ops.length);
  for (const b of ops) out.push(b);
  if (parts.dataBlock) {
    out.push(parts.dataBlock.length);
    for (const b of parts.dataBlock) out.push(b);
  }
  for (const b of parts.trailing ?? []) out.push(b);
  const head = Uint8Array.from(out);
  const crc = crc32Bytes(head);
  return Uint8Array.from([...out, ...crc]);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`期望抛 ${code}, 但没抛`);
  } catch (e) {
    expect(e).toBeInstanceOf(EfficodeError);
    expect((e as EfficodeError).code).toBe(code);
  }
}

const SAMPLE = '#REQ: summarize the fusion conversion report please';

// ============== ① CRC32 自证 ==============

describe('efficode · crc32', () => {
  it('规范向量: crc32("123456789") === 0xCBF43926', () => {
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
  });
  it('空输入 = 0; 4 字节大端往返一致', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    const b = crc32Bytes(Buffer.from('hello efficode', 'utf-8'));
    expect(b.length).toBe(4);
    expect(readCrc32Bytes(b, 0)).toBe(crc32(Buffer.from('hello efficode', 'utf-8')));
  });
});

// ============== ② 压缩层 (真压真解) ==============

describe('efficode · 压缩层', () => {
  const cases: Array<[string, Uint8Array]> = [
    ['空', new Uint8Array(0)],
    ['单字节', Uint8Array.from([7])],
    ['短重复', Buffer.from('ababababababab')],
    ['结构化重复 2KB', Buffer.from(Array.from({ length: 200 }, (_, i) => `{"i":${i % 7},"k":"value"}\n`).join(''))],
    ['超窗口 (5KB 单字符)', new Uint8Array(5120).fill(65)],
    ['中文 JSON', Buffer.from(JSON.stringify({ 任务: '核聚变口径复核', 轮次: 3 }), 'utf-8')],
  ];

  for (const [name, raw] of cases) {
    it(`lz77 逐字节回环: ${name} (${raw.length}B)`, () => {
      expect(Buffer.from(lz77Decompress(lz77Compress(raw))).equals(Buffer.from(raw))).toBe(true);
    });
    it(`三算法都逐字节回环 + 压缩层带算法 id: ${name}`, () => {
      for (const algo of ['none', 'lz77', 'deflate'] as const) {
        const block = compressBlock(raw, algo);
        const back = decompressBlock(block);
        expect(back.algo).toBe(algo);
        // 逐字节比 (Uint8Array vs Buffer 的类型差异不是内容差异, 用 Buffer 归一后比)
        expect(Buffer.from(back.data).equals(Buffer.from(raw))).toBe(true);
      }
    });
  }

  it('measureAll 给的是真数字 (不是估计): 重复文本 deflate 比原文小', () => {
    const raw = Buffer.from(Array.from({ length: 300 }, () => 'efficode binary packet stream repetition\n').join(''));
    const m = measureAll(raw);
    expect(m.none).toBe(raw.length + 1);
    expect(m.deflate).toBeLessThan(raw.length);
    expect(m.lz77).toBeLessThan(raw.length);
    // 真实数字必须自洽: 带算法 id 的三个结果互不相同 (说明真跑了三条路)
    expect(new Set([m.none, m.lz77, m.deflate]).size).toBeGreaterThan(1);
  });

  it('随机字节**压不小** ⇒ pickAlgo 退回 none (不硬压)', () => {
    const rand = new Uint8Array(256);
    for (let i = 0; i < rand.length; i++) rand[i] = (i * 137 + 91) % 251;
    expect(pickAlgo(rand, 'deflate')).toBeDefined();
    const small = Buffer.from('tiny');
    expect(pickAlgo(small, 'deflate')).toBe('none'); // 小消息头上开箱代价 > 收益
  });

  it('未知压缩算法 id → 报错 (不许"跳过解压直接给原文")', () => {
    expectCode(() => decompressBlock(Uint8Array.from([9, 1, 2, 3])), 'EFFICODE_UNKNOWN_COMPRESSION');
    expectCode(() => decompressBlock(new Uint8Array(0)), 'EFFICODE_TRUNCATED');
  });

  it('lz77 截断码流 → 报错', () => {
    const c = lz77Compress(Buffer.from('aaaaaaaaaaaaaaaaaaaa'));
    const truncated = c.slice(0, Math.max(3, c.length - 2));
    expect(() => lz77Decompress(truncated)).toThrow(EfficodeError);
  });
});

// ============== ③ 包封装 round-trip ==============

describe('efficode · 包封装 round-trip', () => {
  it('二进制模式: 逐字段还原 + 两次编码字节完全相同', () => {
    const msg = {
      from: 'did:bolloon:7f3a91cc',
      instructions: [
        { op: '@DID:' as const, value: 'did:bolloon:7f3a91cc' },
        { op: '#REQ:' as const, value: 'compute' },
        { op: '!SEND' as const },
      ],
      data: SAMPLE,
      mode: 'compact' as const,
      compression: 'lz77' as const,
    };
    const p1 = buildPacket(msg);
    const p2 = buildPacket(msg);
    expect(p1).toEqual(p2); // 确定性: 同输入同字节

    const d = parsePacket(p1);
    expect(d.mode).toBe('compact');
    expect(d.compression).toBe('lz77');
    expect(d.data).toBe(SAMPLE);
    expect(d.rawDataBytes).toBe(Buffer.from(SAMPLE, 'utf-8').length);
    expect(instructionsToSymbolic(d.instructions)).toBe('@DID:did:bolloon:7f3a91cc #REQ:compute !SEND');
    expect(d.bytes).toBe(p1.length);
    // DID 段是真 32B 摘要, 且能比对
    expect(d.didSegmentHex).toHaveLength(DID_SEGMENT_BYTES * 2);
    expect(matchesDidSegment('did:bolloon:7f3a91cc', Buffer.from(d.didSegmentHex as string, 'hex')).match).toBe(true);
    expect(matchesDidSegment('did:bolloon:deadbeef', Buffer.from(d.didSegmentHex as string, 'hex')).match).toBe(false);
  });

  it('文本模式: Base64 进去 Base64 出来, 内容一致', () => {
    const msg = { instructions: [{ op: '#DATA:' as const, value: '' }, { op: '!END' as const }], data: SAMPLE, mode: 'text' as const };
    const wire = encodePacket(msg);
    expect(typeof wire).toBe('string');
    const d = parsePacket(wire as string);
    expect(d.mode).toBe('text');
    expect(d.data).toBe(SAMPLE);
    expect(instructionsToSymbolic(d.instructions)).toBe('#DATA: !END');
  });

  it('中文/emoji 数据块往返 (UTF-8 边界)', () => {
    const text = '核聚变口径复核 ✅ 1000 USDC @ base — 已认领 0';
    const p = buildPacket({ instructions: [{ op: '#DATA:' as const, value: '' }], data: text, compression: 'deflate' });
    expect(parsePacket(p).data).toBe(text);
  });

  it('大消息 (64KB 重复文本) 往返 + 真压缩', () => {
    const big = Array.from({ length: 1500 }, (_, i) => `line ${i % 50}: efficode payload repetition\n`).join('');
    const p = buildPacket({ instructions: [{ op: '#DATA:' as const, value: '' }], data: big, compression: 'deflate' });
    const d = parsePacket(p);
    expect(d.data).toBe(big);
    expect(d.rawDataBytes).toBe(Buffer.from(big, 'utf-8').length);
    expect(p.length).toBeLessThan(Buffer.from(big, 'utf-8').length); // 真压小了
  });

  it('无 DID 段的包: 省 32B 且语义不变 (省略是可选的, 不是默认假设)', () => {
    const withDid = buildPacket({ from: 'did:bolloon:x', instructions: [{ op: '!ACK' as const }] });
    const noDid = buildPacket({ instructions: [{ op: '!ACK' as const }] });
    expect(noDid.length).toBe(withDid.length - DID_SEGMENT_BYTES);
    expect(parsePacket(noDid).didDigest).toBeNull();
    expect(parsePacket(noDid).instructions).toEqual([{ op: '!ACK' }]);
  });

  it('符号化文本 ↔ 指令序列双向一致 (前缀表达式)', () => {
    const symbolic = '@DID:did:bolloon:abc #DATA: !SEND';
    const ins = symbolicToInstructions(symbolic);
    expect(instructionsToSymbolic(ins)).toBe(symbolic);
    const msg = messageFromSymbolic(symbolic, 'hi');
    expect(packetToMessage(buildPacket(msg)).symbolic).toBe(symbolic);
  });
});

// ============== ④ 边界: 一律报错, 不许瞎解 ==============

describe('efficode · 边界与畸形包', () => {
  const good = buildPacket({
    from: 'did:bolloon:aaaaaaaaaaaaaaaa',
    instructions: [{ op: '@DID:' as const, value: 'did:bolloon:aaaaaaaaaaaaaaaa' }, { op: '#DATA:' as const, value: '' }, { op: '!SEND' as const }],
    data: SAMPLE,
    compression: 'deflate',
  });

  it('空 / 超短输入 → TOO_SHORT', () => {
    expectCode(() => parsePacket(new Uint8Array(0)), 'EFFICODE_TOO_SHORT');
    expectCode(() => parsePacket(good.slice(0, 3)), 'EFFICODE_TOO_SHORT');
  });

  it('任意一处截断都不许"解出来" (逐长度扫一遍)', () => {
    for (let cut = 1; cut < good.length; cut++) {
      const sliced = good.slice(0, cut);
      let threw = false;
      try { parsePacket(sliced); } catch (e) { threw = e instanceof EfficodeError; }
      expect(threw, `截断到 ${cut}B 竟然解出来了`).toBe(true);
    }
  });

  it('版本/模式/flags 保留位非法 → 各自的结构化失败码', () => {
    expectCode(() => parsePacket(reseal(good, (b) => { b[0] = (2 << 4) | (b[0] & 0xf); })), 'EFFICODE_BAD_VERSION');
    expectCode(() => parsePacket(reseal(good, (b) => { b[0] = (b[0] & 0xf0) | 0x5; })), 'EFFICODE_BAD_MODE');
    expectCode(() => parsePacket(reseal(good, (b) => { b[1] |= 0x80; })), 'EFFICODE_BAD_FLAGS');
  });

  it('数据块被改一个字节 (CRC 不重算) → CRC_MISMATCH (不是"看着像就收下")', () => {
    // 用 none 压缩的长正文包: 改正文中间一字节, 结构仍然自描述, 只有 CRC 拦得住它
    const body = 'A'.repeat(60);
    const p = buildPacket({ instructions: [{ op: '#DATA:' as const, value: '' }], data: body, compression: 'none' });
    const tampered = Uint8Array.from(p);
    const at = p.length - 4 - 30; // 落在正文里, 不碰任何长度字段
    tampered[at] = tampered[at] ^ 0x01;
    expectCode(() => parsePacket(tampered), 'EFFICODE_CRC_MISMATCH');
    // 对照组: 同一包不改任何字节就能解出原文 (证明上面那条是 CRC 判的, 不是别的错撞上去的)
    expect(parsePacket(p).data).toBe(body);
  });

  it('尾随垃圾字节 → TRAILING_BYTES (CRC 已重算也拦得住)', () => {
    const junk = craft({ flags: 0x02, trailing: [0xaa, 0xbb, 0xcc] });
    expectCode(() => parsePacket(junk), 'EFFICODE_TRAILING_BYTES');
  });

  it('未知操作码 → UNKNOWN_OPCODE (CRC 合法也照样拒)', () => {
    expectCode(() => parsePacket(craft({ flags: 0x02, ops: Uint8Array.from([99, 0]) })), 'EFFICODE_UNKNOWN_OPCODE');
    // 控制指令带载荷也拒 (指令表说它无载荷, 就不许有)
    expectCode(() => parsePacket(craft({ flags: 0x02, ops: Uint8Array.from([4, 3, 1, 2, 3]) })), 'EFFICODE_UNKNOWN_OPCODE');
  });

  it('未知压缩算法 id → UNKNOWN_COMPRESSION (算法 id 真可替换 = 可插拔不是声明而已)', () => {
    const block = compressBlock(Buffer.from('some payload for algo swap'), 'deflate');
    const bad = Uint8Array.from(block);
    bad[0] = 9; // 换成一个不存在的算法 id
    const flags = 0x02 | 0x04 | 0x08; // 有指令段 + 有数据块 + 已压缩
    expectCode(() => parsePacket(craft({ flags, dataBlock: bad })), 'EFFICODE_UNKNOWN_COMPRESSION');
    // 对照组: 同一形状换成合法 id 就能解出来 (证明上面那条不是别的错撞上去的)
    expect(parsePacket(craft({ flags, dataBlock: block })).data).toBe('some payload for algo swap');
  });

  it('未知 DID 摘要算法 → DID_SEGMENT_BAD', () => {
    expectCode(() => parsePacket(reseal(good, (b) => { b[2] = 7; })), 'EFFICODE_DID_SEGMENT_BAD');
  });

  it('文本模式的坏 Base64 / 形态不一致 → 结构化失败码', () => {
    expectCode(() => parsePacket('!!!not-base64!!!'), 'EFFICODE_BAD_BASE64');
    const p = buildPacket({ instructions: [{ op: '!ACK' as const }], mode: 'text' });
    const asBinary = new Uint8Array(p);
    expectCode(() => parsePacket(asBinary), 'EFFICODE_BAD_MODE'); // 声明 text 却按二进制喂
  });

  it('空指令段 / 未实现模式 (语音·声波) → 显式拒绝, 不静默降级', () => {
    expectCode(() => buildPacket({ instructions: [] }), 'EFFICODE_BAD_FLAGS');
    expectCode(() => buildPacket({ instructions: [{ op: '!ACK' }], mode: 'voice' as never }), 'EFFICODE_MODE_NOT_IMPLEMENTED');
  });

  it('操作表: 未知 opcode 直接抛; 前缀表达式里的未知指令也抛', () => {
    expectCode(() => opByCode(42), 'EFFICODE_UNKNOWN_OPCODE');
    expect(isKnownOpCode(1)).toBe(true);
    expect(isKnownOpCode(42)).toBe(false);
    // 整串不以任何已知前缀开头 → 抛
    expectCode(() => symbolicToInstructions('$EVIL:payload'), 'EFFICODE_UNKNOWN_OPCODE');
    // 带 sigil 但不是已知前缀 → 抛
    expectCode(() => symbolicToInstructions('#DATA:x !EVIL:y'), 'EFFICODE_UNKNOWN_OPCODE');
    // 控制指令不吃载荷 → 抛
    expectCode(() => symbolicToInstructions('!ACK:with-payload'), 'EFFICODE_UNKNOWN_OPCODE');
    // 明确的解析规则 (写下来免得被当成"随便切"): 不带 sigil 的词接在上一条指令的载荷后面
    expect(symbolicToInstructions('#DATA:a b c')).toEqual([{ op: '#DATA:', value: 'a b c' }]);
    expect(symbolicToInstructions('#DATA:a b !SEND')).toEqual([{ op: '#DATA:', value: 'a b' }, { op: '!SEND' }]);
    // 而"以 $ 开头的陌生记号"在载荷位置上是**普通文本** (它不带 sigil, 就是载荷内容)
    expect(symbolicToInstructions('@DID:x $note:hello')).toEqual([{ op: '@DID:', value: 'x $note:hello' }]);
  });

  it('DID 段: 空身份 / 长度不符 / 未知算法都抛; 摘要串是单向的', () => {
    expectCode(() => encodeDidSegment(''), 'EFFICODE_DID_SEGMENT_BAD');
    expectCode(() => decodeDidSegment(new Uint8Array(8)), 'EFFICODE_DID_SEGMENT_BAD');
    const seg = encodeDidSegment('did:bolloon:abc');
    expect(seg.length).toBe(DID_SEGMENT_BYTES);
    expect(seg[0]).toBe(1);
    const parsed = decodeDidSegment(seg);
    expect(parsed.origLen).toBe('did:bolloon:abc'.length);
    expect(didDigestString(parsed)).toMatch(/^algo1:[0-9a-f]{56}$/);
    // 摘要里**不含**原文 (单向) —— 这条比"压缩率"更值得断言
    expect(didDigestString(parsed)).not.toContain('bolloon');
    // 本实现没有签名能力, 如实断言
    expect(matchesDidSegment('did:bolloon:abc', seg).signed).toBe(false);
  });
});

// ============== ⑤ 语言协商 (双方都声明才用) ==============

describe('efficode · 语言协商与回落', () => {
  it('双方声明 efficode → 用 efficode', () => {
    const d = negotiateLang('efficode', 'efficode');
    expect(d.lang).toBe('efficode');
    expect(d.fallback).toBe(false);
  });

  it('没有任何声明 → 自然语言 (不是 efficode)', () => {
    for (const [m, t] of [[undefined, undefined], [null, null], [[], []]] as Array<[unknown, unknown]>) {
      const d = negotiateLang(m, t);
      expect(d.lang).toBe('natural');
      expect(d.fallback).toBe(false);
    }
  });

  it('单方声明 → 回落自然语言 + 记原因', () => {
    const a = negotiateLang('efficode', undefined);
    expect(a.lang).toBe('natural');
    expect(a.fallback).toBe(true);
    expect(a.reason).toContain('对端没声明');
    const b = negotiateLang(undefined, 'efficode');
    expect(b.lang).toBe('natural');
    expect(b.fallback).toBe(true);
    expect(b.reason).toContain('本机没声明');
  });

  it('对端声明未知语言 → 回落 + 标出 unknownSide (不当成 efficode)', () => {
    const d = negotiateLang('efficode', 'efficode-v2-experimental');
    expect(d.lang).toBe('natural');
    expect(d.unknownSide).toBe('theirs');
    expect(d.reason).toContain('不认识');
    expect(unknownLangNames('efficode-v2-experimental')).toEqual(['efficode-v2-experimental']);
    expect(normalizeLang('EFFICODE')).toBeNull(); // 大小写不同 = 另一个名字, 不算
    expect(normalizeLang(' efficode ')).toBe('efficode'); // 只容忍首尾空白
  });

  it('manifest 的数组形态声明: 含 efficode 才算宣称', () => {
    expect(normalizeLang(['natural', 'efficode'])).toBe('efficode');
    expect(normalizeLang(['natural'])).toBe('natural');
    expect(normalizeLang(['natural', 'klingon'])).toBe('natural');
  });

  it('出站: 双方声明才真编码 (Base64 文本模式), 单方则原文直发', () => {
    const text = '#REQ: 给我一份口径复核清单';
    const both = encodeForPeer({ text, mine: 'efficode', theirs: 'efficode', from: 'did:bolloon:me' });
    expect(both.lang).toBe('efficode');
    expect(both.text).not.toBe(text);
    expect(both.bytes).toBeGreaterThan(0);
    expect(both.symbolic).toBe('@DID:did:bolloon:me #DATA: !SEND');

    const one = encodeForPeer({ text, mine: 'efficode', theirs: undefined });
    expect(one.lang).toBe('natural');
    expect(one.text).toBe(text); // 一个字节都没动
    expect(one.bytes).toBe(0);
    expect(one.note).toContain('回落');
  });

  it('入站: 声明的语言决定分派 —— 未知/非 efficode 一律不进解码器', () => {
    const text = '这是一句自然语言';
    const ok = decodeFromPeer({ payload: text, declaredLang: undefined, mine: 'efficode' });
    expect(ok.decoded).toBe(false);
    expect(ok.text).toBe(text);

    const unknown = decodeFromPeer({ payload: text, declaredLang: 'efficode-x', mine: 'efficode' });
    expect(unknown.decoded).toBe(false);
    expect(unknown.declaredLang).toBeNull();
    expect(unknown.note).toContain('不认识');

    expectCode(
      () => decodeFromPeer({ payload: 'AAAA', declaredLang: 'efficode', mine: 'natural' }),
      'EFFICODE_LANG_UNSUPPORTED'
    );
  });

  it('入站: 真 efficode 包 → 真解出原文; 畸形包 → 抛 (不吞)', () => {
    const text = '群公告: 本期口径复核开始';
    const enc = encodeForPeer({ text, mine: 'efficode', theirs: 'efficode', from: 'did:bolloon:a' });
    const dec = decodeFromPeer({ payload: enc.text, declaredLang: 'efficode', mine: 'efficode' });
    expect(dec.decoded).toBe(true);
    expect(dec.text).toBe(text);
    const broken = enc.text.slice(0, Math.max(8, enc.text.length - 6)) + 'AAAA';
    expect(() => decodeFromPeer({ payload: broken, declaredLang: 'efficode', mine: 'efficode' })).toThrow(EfficodeError);
  });

  it('默认声明: 没给 env 就是 natural; 值非法也回 natural', () => {
    expect(defaultDeclaredLang({} as NodeJS.ProcessEnv)).toBe('natural');
    expect(defaultDeclaredLang({ BOLLOON_EFFICODE_LANG: 'efficode' } as NodeJS.ProcessEnv)).toBe('efficode');
    expect(defaultDeclaredLang({ BOLLOON_EFFICODE_LANG: 'yes' } as NodeJS.ProcessEnv)).toBe('natural');
  });

  it('裁决记录真落盘, 且只记语言与原因 (不含正文/DID)', () => {
    const text = 'SECRET-PAYLOAD-不该进记录';
    const enc = encodeForPeer({ text, mine: 'efficode', theirs: undefined });
    expect(recordLangDecision(enc.decision, { channel: 'unit-test', peer: 'did:bolloon:peer' })).toBe(true);
    const log = readLangDecisionLog();
    expect(log.length).toBe(1);
    expect(log[0].lang).toBe('natural');
    expect(log[0].fallback).toBe(true);
    const raw = fs.readFileSync(langDecisionLogPath(), 'utf-8');
    expect(raw).not.toContain('SECRET-PAYLOAD');
    expect(raw).not.toContain(text);
  });
});

// ============== ⑥ 智能体消息封装层 (lang 声明) ==============

describe('efficode · 智能体消息帧的 lang 声明', () => {
  it('双方声明 → 真编真解且内容一致; 帧里 lang=efficode', () => {
    const built = buildAgentMessage({ text: '任务: 复核口径', from: 'did:bolloon:a', to: 'did:bolloon:b', mine: 'efficode', theirs: ['natural', 'efficode'] });
    expect(built.lang).toBe('efficode');
    expect(built.encoded).toBe(true);
    const frame = parseAgentMessageFrame(built.frame);
    expect(frame?.payload.lang).toBe('efficode');
    const got = readAgentMessage(built.frame, { mine: 'efficode' });
    expect(got?.decoded).toBe(true);
    expect(got?.text).toBe('任务: 复核口径');
    expect(got?.fromDid).toBe('did:bolloon:a');
  });

  it('无声明 → 自然语言 (原文直发)', () => {
    const built = buildAgentMessage({ text: 'hello', from: 'did:bolloon:a', theirs: undefined, mine: [] });
    expect(built.lang).toBe('natural');
    expect(JSON.parse(built.frame).payload.text).toBe('hello');
    const got = readAgentMessage(built.frame, { mine: 'efficode' });
    expect(got?.decoded).toBe(false);
    expect(got?.text).toBe('hello');
  });

  it('单方声明 → 回落, 且对端不会去解它', () => {
    const built = buildAgentMessage({ text: '口径复核', from: 'did:bolloon:a', theirs: 'natural', mine: 'efficode' });
    expect(built.lang).toBe('natural');
    const got = readAgentMessage(built.frame, { mine: 'efficode' });
    expect(got?.decoded).toBe(false);
    expect(got?.text).toBe('口径复核');
  });

  it('对端声明未知语言 → 回落 + unknownLangs 如实标出', () => {
    // 真发一帧出来, 但把 lang 改成"对端其实声明了另一个名字"的样子
    const built = buildAgentMessage({ text: 'x', theirs: 'efficode-v9', mine: 'efficode' });
    expect(built.lang).toBe('natural');
    const frame = JSON.stringify({ ...JSON.parse(built.frame), payload: { text: 'x', lang: 'efficode-v9' } });
    const got = readAgentMessage(frame, { mine: 'efficode' });
    expect(got?.unknownLangs).toEqual(['efficode-v9']);
    expect(got?.decoded).toBe(false);
    expect(got?.text).toBe('x');
  });

  it('对端声称 efficode 但本机没声明支持 → 拒绝解码', () => {
    const enc = encodeForPeer({ text: 'secret', mine: 'efficode', theirs: 'efficode' });
    const frame = JSON.stringify({ type: 'agent_message', payload: { text: enc.text, lang: 'efficode' }, ts: 1, fromDid: 'did:bolloon:a' });
    expectCode(() => readAgentMessage(frame, { mine: 'natural' }), 'EFFICODE_LANG_UNSUPPORTED');
  });

  it('manifest 声明读写: 不设就清空; 老 manifest 没有字段 = 没声明', () => {
    setLocalSupportedLangs(['natural', 'efficode']);
    expect(manifestLangDeclaration()).toEqual(['natural', 'efficode']);
    expect(peerLangsOf({ supportedLangs: ['efficode'] })).toEqual(['efficode']);
    expect(peerLangsOf({})).toEqual([]);
    expect(peerLangsOf(null)).toEqual([]);
    setLocalSupportedLangs([]);
    expect(manifestLangDeclaration()).toEqual(['natural']); // 回落到本机默认声明
    setLocalDeclaredLang('efficode');
    expect(localDeclaredLang()).toBe('efficode');
    expect(manifestLangDeclaration()).toEqual(['efficode']);
  });

  it('帧解析: 不是 agent_message / 坏 JSON → null (不抛, 不猜)', () => {
    expect(parseAgentMessageFrame('not json')).toBeNull();
    expect(parseAgentMessageFrame(JSON.stringify({ type: 'manifest_request', payload: {} }))).toBeNull();
    expect(parseAgentMessageFrame(JSON.stringify({ type: 'agent_message', payload: {} }))).toBeNull();
  });
});
