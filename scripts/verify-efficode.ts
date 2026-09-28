/**
 * verify-efficode.ts — Efficode 参考实现 + 交流语言可选机制的离线验收门 (2026-09-28)
 *
 * 要证的事 (全部离线 · 确定性 · 不需要凭据):
 *   [A] 回环: encode → decode 逐字节/逐字段还原; 同输入同字节 (确定性); 二进制与文本两种模式都跑
 *   [B] 严格性: 截断/篡改/未知指令/未知压缩/非法版本/保留位/尾随垃圾/坏 Base64 —— 一律**报错**, 不许瞎解
 *   [C] 协商: 无声明→自然语言 · 双方声明→真编真解且内容一致 · 单方声明→回落并记录 ·
 *              对端声明未知语言→不硬解 · 对端声明 efficode 而本机不支持→拒解
 *   [D] 真测数字: 与 Bolloon 现在真发的 JSON 帧逐个样本比字节数 —— 省多少**实测**, 哪些场景更贵也写出来
 *   [E] 两进程端到端: 起**两个真进程** (真管道 stdout→stdin), 互发一条 Efficode 消息, 对端解出原文
 *   [F] 变异判红: 真拆机制 (未知指令宽容 · CRC 不查 · 单方声明也切语言 · 未知语言硬解) → 门必须变红
 *
 * 用法:
 *   npx tsx scripts/verify-efficode.ts                # 全跑 (含变异; 会在源码上做短暂变异并还原)
 *   npx tsx scripts/verify-efficode.ts --core-only    # 只跑 A/B/C (变异门内部复用, 快)
 *   npx tsx scripts/verify-efficode.ts --no-mutations  # 不跑 F
 *
 * 诚实边界 (门自己也守):
 *   - 声波/语音模式、链上签名验证、ECC 临时会话密钥 **没有实现**, 门不假装测它们;
 *   - 门的每条断言只依赖**真跑出来的**数字与失败码, 不写"看起来应该"。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';

// 隔离 HOME: 不读真凭据, 也不写用户目录 (语言裁决记录落到临时目录)
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-efficode-'));
process.env.BOLLOON_HOME = HOME;
const ROOT = process.cwd();
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

import { crc32, crc32Bytes } from '../src/efficode/crc32.js';
import { lz77Compress, lz77Decompress } from '../src/efficode/lz77.js';
import { compressBlock, decompressBlock, measureAll, pickAlgo } from '../src/efficode/compress.js';
import { buildPacket, encodePacket, parsePacket } from '../src/efficode/packet.js';
import { symbolicToInstructions, instructionsToSymbolic } from '../src/efficode/ops.js';
import { encodeDidSegment, matchesDidSegment } from '../src/efficode/did.js';
import {
  negotiateLang, encodeForPeer, decodeFromPeer, recordLangDecision, readLangDecisionLog,
} from '../src/efficode/negotiate.js';
import { EfficodeError, DID_SEGMENT_BYTES, EFFICODE_VERSION } from '../src/efficode/types.js';
import { buildAgentMessage, readAgentMessage } from '../src/agents/agent-lang.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function codeOf(fn: () => unknown): string {
  try { fn(); return 'NO_THROW'; } catch (e) { return e instanceof EfficodeError ? e.code : `OTHER:${String((e as Error)?.message ?? e)}`; }
}

const CORE_ONLY = process.argv.includes('--core-only');
const NO_MUT = process.argv.includes('--no-mutations');

// ============================================================ [A] 回环
function sectionA(): void {
  console.log('\n[A] 回环 (encode → decode 逐字节还原 · 确定性)');
  const cases: Array<[string, string]> = [
    ['空正文', ''],
    ['单字', 'a'],
    ['中文短句', '确认收到'],
    ['未配对代理对之外的 emoji', '✅ 已认领 0 人'],
    ['512B 中文混排', Array.from({ length: 20 }, (_, i) => `第 ${i} 期: 口径复核 (${i % 3}) · 预算 1000 USDC`).join('\n')],
    ['8KB 重复 JSON', Array.from({ length: 400 }, (_, i) => `{"i":${i % 9},"k":"value","n":${i}}\n`).join('')],
  ];

  let allExact = true;
  let deterministic = true;
  let textModeExact = true;
  const notes: string[] = [];
  for (const [name, text] of cases) {
    for (const algo of ['none', 'lz77', 'deflate'] as const) {
      const msg = {
        from: 'did:bolloon:0f1e2d3c4b5a69788796a5b4c3d2e1f0',
        instructions: [
          { op: '@DID:' as const, value: 'did:bolloon:0f1e2d3c4b5a69788796a5b4c3d2e1f0' },
          { op: '#DATA:' as const, value: '' },
          { op: '!SEND' as const },
        ],
        data: text,
        mode: 'compact' as const,
        compression: algo,
      };
      const p1 = buildPacket(msg);
      const p2 = buildPacket(msg);
      if (Buffer.compare(Buffer.from(p1), Buffer.from(p2)) !== 0) deterministic = false;
      const d = parsePacket(p1);
      // 空正文不产数据块 ⇒ 解出的 compression 如实为 'none' (没数据可压, 不假装用了压缩层)
      const layerOk = text === '' ? d.compression === 'none' : d.compression === algo;
      const same =
        d.data === text &&
        layerOk &&
        d.rawDataBytes === Buffer.byteLength(text, 'utf-8') &&
        instructionsToSymbolic(d.instructions) === '@DID:did:bolloon:0f1e2d3c4b5a69788796a5b4c3d2e1f0 #DATA: !SEND';
      if (!same) { allExact = false; notes.push(`${name}/${algo}`); }

      // 文本模式 (Base64) 也必须逐字节回环
      const wire = encodePacket({ ...msg, mode: 'text' });
      if (typeof wire !== 'string' || parsePacket(wire).data !== text) textModeExact = false;
    }
  }
  ok(`6 类正文 × 3 种压缩层 = 18 组逐字段还原`, allExact, notes.length ? `失败组: ${notes.join(',')}` : '含空正文/中文/8KB');
  ok('同输入同字节 (无隐藏随机/时间戳)', deterministic);
  ok('文本模式 (Base64) 逐字节回环', textModeExact);
  // 明确写下来的规则: 空正文不产数据块, 解出的 compression 如实报 'none' (不假装用过压缩层)
  ok('空正文: 不产数据块 ⇒ compression 如实报 none (内容仍逐字节一致)',
    parsePacket(buildPacket({ instructions: [{ op: '#DATA:', value: '' }], data: '', compression: 'deflate' })).data === '' &&
      parsePacket(buildPacket({ instructions: [{ op: '#DATA:', value: '' }], data: '', compression: 'deflate' })).compression === 'none');

  // DID 段: 32B 摘要段可比对; 但**不能**还原身份 (本实现无签名能力, 如实断言)
  const seg = encodeDidSegment('did:bolloon:0f1e2d3c4b5a69788796a5b4c3d2e1f0');
  const m = matchesDidSegment('did:bolloon:0f1e2d3c4b5a69788796a5b4c3d2e1f0', seg);
  ok('DID 段固定 32B 且摘要可比对', seg.length === DID_SEGMENT_BYTES && m.match === true);
  ok('DID 段比对是**明文摘要比对**, 不是签名验证 (signed=false)', m.signed === false, 'method=digest');
  ok('DID 段不可还原身份 (摘要里不含原文)', !Buffer.from(seg).toString('hex').includes(Buffer.from('bolloon').toString('hex')));

  // LZ77 自解压: 头里带原始长度 ⇒ 解码器不靠猜
  const lz = lz77Compress(Buffer.from('efficode self-extracting block '.repeat(20)));
  ok('LZ77 自解压块头含 origLen (解码不猜结束位置)', Buffer.from(lz77Decompress(lz)).toString('utf-8').endsWith('block '));
  ok('LZ77 码流被截断 → 抛 (不静默还原一半)', codeOf(() => lz77Decompress(lz.slice(0, lz.length - 1))) === 'EFFICODE_TRUNCATED');
}

// ============================================================ [B] 严格性
function sectionB(): void {
  console.log('\n[B] 严格性 (畸形包一律报错, 不许瞎解)');
  const good = buildPacket({
    from: 'did:bolloon:0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    instructions: [
      { op: '@DID:' as const, value: 'did:bolloon:0f1e2d3c4b5a69788796a5b4c3d2e1f0' },
      { op: '#DATA:' as const, value: '' },
      { op: '!SEND' as const },
    ],
    data: '口径复核开始, 认领 0 人',
    compression: 'none',
  });

  const reseal = (b: Uint8Array, f: (c: Uint8Array) => void): Uint8Array => {
    const c = Uint8Array.from(b); f(c);
    c.set(crc32Bytes(c.subarray(0, c.length - 4)), c.length - 4);
    return c;
  };

  const checks: Array<[string, string, () => unknown]> = [
    ['空输入', 'EFFICODE_TOO_SHORT', () => parsePacket(new Uint8Array(0))],
    ['3B 碎片', 'EFFICODE_TOO_SHORT', () => parsePacket(good.subarray(0, 3))],
    ['版本号未来 (v2)', 'EFFICODE_BAD_VERSION', () => parsePacket(reseal(good, (c) => { c[0] = (2 << 4) | (c[0] & 0xf); }))],
    ['未知模式 id', 'EFFICODE_BAD_MODE', () => parsePacket(reseal(good, (c) => { c[0] = (c[0] & 0xf0) | 0x7; }))],
    ['flags 保留位被置位', 'EFFICODE_BAD_FLAGS', () => parsePacket(reseal(good, (c) => { c[1] |= 0x80; }))],
    ['正文被改一字节 (CRC 不重算)', 'EFFICODE_CRC_MISMATCH', () => { const c = Uint8Array.from(good); c[good.length - 30] ^= 1; return parsePacket(c); }],
    ['尾随垃圾字节 (CRC 重算)', 'EFFICODE_TRAILING_BYTES', () => parsePacket((() => {
      const c = new Uint8Array(good.length - 4 + 3 + 4);
      c.set(good.subarray(0, good.length - 4), 0);
      c.set([0xde, 0xad, 0xbe], good.length - 4);
      const head = c.subarray(0, c.length - 4);
      c.set(crc32Bytes(head), c.length - 4);
      return c;
    })())],
    ['未知操作码', 'EFFICODE_UNKNOWN_OPCODE', () => parsePacket((() => {
      const c = Uint8Array.from(good);
      c[2 + DID_SEGMENT_BYTES + 1] = 200;
      return reseal(c, () => { /* noop */ });
    })())],
    ['未知压缩算法 id', 'EFFICODE_UNKNOWN_COMPRESSION', () => parsePacket((() => {
      const block = compressBlock(Buffer.from('payload'), 'deflate');
      const bad = Uint8Array.from(block); bad[0] = 9;
      const out: number[] = [(EFFICODE_VERSION << 4), 0x02 | 0x04 | 0x08, 2, 4, 0, bad.length, ...bad];
      const head = Uint8Array.from(out);
      return Uint8Array.from([...out, ...crc32Bytes(head)]);
    })())],
    ['未知 DID 摘要算法', 'EFFICODE_DID_SEGMENT_BAD', () => parsePacket(reseal(good, (c) => { c[2] = 9; }))],
    ['文本模式坏 Base64', 'EFFICODE_BAD_BASE64', () => parsePacket('!!!! 不是 base64 !!!!')],
    ['包头声明 text 却按二进制喂', 'EFFICODE_BAD_MODE', () => parsePacket(new Uint8Array(buildPacket({ instructions: [{ op: '!ACK' }], mode: 'text' })))],
    ['未实现模式 (语音/声波) 编码请求', 'EFFICODE_MODE_NOT_IMPLEMENTED', () => buildPacket({ instructions: [{ op: '!ACK' }], mode: 'voice' as never })],
    ['空指令段', 'EFFICODE_BAD_FLAGS', () => buildPacket({ instructions: [] })],
    ['未知指令前缀', 'EFFICODE_UNKNOWN_OPCODE', () => symbolicToInstructions('#DATA:x !EVIL:y')],
  ];
  for (const [name, want, fn] of checks) {
    const got = codeOf(fn);
    ok(`${name} → ${want}`, got === want, got === want ? '' : `实得 ${got}`);
  }

  // 逐长度扫: 任何一处截断都不许"解出来"
  let leaks = 0;
  for (let cut = 1; cut < good.length; cut++) {
    try { parsePacket(good.subarray(0, cut)); leaks++; } catch { /* 期望 */ }
  }
  ok(`包被截断到任意长度 (${good.length - 1} 种) 都不许解出结果`, leaks === 0, leaks ? `${leaks} 个长度漏了` : '');
  ok('CRC32 用规范向量自证: crc32("123456789")=0xCBF43926', crc32(Buffer.from('123456789')) === 0xcbf43926);
}

// ============================================================ [C] 协商
function sectionC(): void {
  console.log('\n[C] 交流语言可选 (双方都声明才用; 否则明确回落 + 记录)');
  const text = '本期口径复核已开始, 请认领';

  const none = negotiateLang(undefined, undefined);
  ok('无声明 → 自然语言 (不是 efficode)', none.lang === 'natural' && none.fallback === false);
  const both = negotiateLang('efficode', 'efficode');
  ok('双方声明 efficode → 用 efficode', both.lang === 'efficode' && both.fallback === false);
  const oneSide = negotiateLang('efficode', 'natural');
  ok('单方声明 → 回落自然语言 + 记原因', oneSide.lang === 'natural' && oneSide.fallback === true && /对端没声明/.test(oneSide.reason));
  const unknown = negotiateLang('efficode', 'efficode-v9');
  ok('对端声明未知语言 → 回落 + unknownSide=theirs', unknown.lang === 'natural' && unknown.unknownSide === 'theirs');

  const safeDecode = (opts: { payload: string; declaredLang: unknown; mine: unknown }) => {
    try { return decodeFromPeer(opts); } catch (e) { return { text: '', declaredLang: null, declaredRaw: null, decoded: false, note: `THREW:${String((e as Error)?.message ?? e)}`, bytes: 0 }; }
  };

  const enc = encodeForPeer({ text, mine: 'efficode', theirs: 'efficode', from: 'did:bolloon:a' });
  const dec = safeDecode({ payload: enc.text, declaredLang: 'efficode', mine: 'efficode' });
  ok('双方声明路径: 真编真解且内容逐字一致', enc.lang === 'efficode' && dec.decoded === true && dec.text === text, `包 ${enc.bytes}B · 符号化 ${enc.symbolic}`);

  const encOne = encodeForPeer({ text, mine: 'efficode', theirs: undefined });
  ok('单方声明路径: 原文直发 (一个字节都没动), 并记回落', encOne.lang === 'natural' && encOne.text === text && encOne.bytes === 0);
  const noDecode = safeDecode({ payload: text, declaredLang: 'efficode-v9', mine: 'efficode' });
  ok('对端声明未知语言 → 不进解码器, 原样呈现', noDecode.decoded === false && noDecode.text === text && /不认识/.test(noDecode.note));
  ok('对端声明 efficode 而本机不支持 → 拒解 (不硬解)',
    codeOf(() => decodeFromPeer({ payload: enc.text, declaredLang: 'efficode', mine: 'natural' })) === 'EFFICODE_LANG_UNSUPPORTED');

  // 智能体封装层 (帧带 lang)
  const built = buildAgentMessage({ text, from: 'did:bolloon:a', to: 'did:bolloon:b', mine: 'efficode', theirs: ['natural', 'efficode'] });
  const recv = readAgentMessage(built.frame, { mine: 'efficode' });
  ok('agent 帧: lang 声明 + 真解出原文', built.lang === 'efficode' && recv?.decoded === true && recv?.text === text && recv?.fromDid === 'did:bolloon:a');
  const builtNatural = buildAgentMessage({ text, from: 'did:bolloon:a', mine: [], theirs: undefined });
  ok('agent 帧 (无声明): lang=natural 且正文原样', builtNatural.lang === 'natural' && JSON.parse(builtNatural.frame).payload.text === text);
  const recvNatural = (() => { try { return readAgentMessage(builtNatural.frame, { mine: 'efficode' }); } catch { return null; } })();
  ok('agent 帧 (无声明) 在接收侧也不解码', recvNatural?.decoded === false && recvNatural?.text === text);

  // 记录: 只记语言与原因, 不记正文
  recordLangDecision(oneSide, { channel: 'gate', peer: 'did:bolloon:b' });
  const log = readLangDecisionLog();
  const raw = fs.readFileSync(path.join(HOME, 'efficode-lang.jsonl'), 'utf-8');
  ok('回落裁决真落盘 (efficode-lang.jsonl 有记录)', log.length >= 1 && log.some((l) => l.fallback === true));
  ok('记录里**没有**消息正文/身份原文 (只有语言名与原因)', !raw.includes(text) && !raw.includes('did:bolloon:a'));
}

// ============================================================ [D] 真测数字
function sectionD(): void {
  console.log('\n[D] 真测数字 —— 与 Bolloon 现在真发的 JSON 帧逐样本比 (省多少是量出来的, 不是声称的)');
  const samples: Array<[string, string]> = [
    ['寒暄 4 字', '确认收到'],
    ['一行群消息 中文', '本期口径复核已开始, 认领 0 人, 轮次 1'],
    ['任务公告 JSON', JSON.stringify({ cap: 'fusion-conversion-consistency', budget: '1000 USDC', network: 'base' })],
    ['1KB 重复日志', Array.from({ length: 25 }, (_, i) => `line ${i}: efficode payload\n`).join('')],
    ['真发 JSON 帧 x40', Array.from({ length: 40 }, (_, i) => JSON.stringify({ i, cap: 'fusion-conversion-consistency', budget: '1000 USDC', status: 'open' }) + '\n').join('')],
    ['高熵十六进制 1KB (半可压: 4bit/字符)', (() => {
      let x = 12345;
      return Array.from({ length: 512 }, () => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return ((x >>> 8) & 0xff).toString(16).padStart(2, '0');
      }).join('');
    })()],
  ];

  console.log('    样本                      raw   naturalJSON  compact  text(base64)  data:none/lz77/deflate');
  const rows: Array<Record<string, number | string>> = [];
  const rawBufs: Record<string, Buffer> = {};
  for (const [name, text] of samples) {
    const raw = Buffer.byteLength(text, 'utf-8');
    // 真基线: 走真代码路径产出的自然语言帧 (无声明 → 原文直发)
    const natural = Buffer.byteLength(buildAgentMessage({ text, from: 'did:bolloon:0f1e2d3c4b5a69788796a5b4c3d2e1f0', mine: [], theirs: undefined }).frame, 'utf-8');
    const compact = buildPacket({
      from: 'did:bolloon:0f1e2d3c4b5a69788796a5b4c3d2e1f0',
      instructions: [
        { op: '@DID:', value: 'did:bolloon:0f1e2d3c4b5a69788796a5b4c3d2e1f0' },
        { op: '#DATA:', value: '' },
        { op: '!SEND' },
      ],
      data: text,
      mode: 'compact',
    }).length;
    const textMode = buildPacket({ instructions: [{ op: '#DATA:', value: '' }], data: text, mode: 'text' }).length;
    const textWire = Math.ceil(textMode / 3) * 4; // 文本模式 = 整包 Base64 ⇒ 线上字符数
    const m = measureAll(Buffer.from(text, 'utf-8'));
    rawBufs[String(name)] = Buffer.from(text, 'utf-8');
    rows.push({ name, raw, natural, compact, textWire, none: m.none, lz77: m.lz77, deflate: m.deflate });
    console.log(
      `    ${String(name).padEnd(22)} ${String(raw).padStart(6)} ${String(natural).padStart(9)} ${String(compact).padStart(9)} ${String(textWire).padStart(11)}   ${m.none}/${m.lz77}/${m.deflate}`
    );
  }

  const tiny = rows[0];
  const big = rows[4];
  ok('小消息 (12B 正文): compact 包 > 正文 (头上开箱代价真实存在)',
    Number(tiny.compact) > Number(tiny.raw),
    `正文 ${tiny.raw}B → 包 ${tiny.compact}B (放大 ${(Number(tiny.compact) / Number(tiny.raw)).toFixed(1)}x)`);
  ok('小消息文本模式比自然语言帧小 (Base64 也压不住固定头的量级差异)',
    Number(tiny.textWire) < Number(tiny.natural),
    `${tiny.textWire}B vs 自然语言帧 ${tiny.natural}B`);
  ok('大消息 (重复结构化文本): 省 ≥ 50%',
    Number(big.compact) / Number(big.natural) < 0.5,
    `包 ${big.compact}B vs 自然语言帧 ${big.natural}B (省 ${(100 - (Number(big.compact) / Number(big.natural)) * 100).toFixed(1)}%)`);
  ok('半可压内容 (十六进制 1KB, 4bit/字符): deflate 真压小, 但没有"提升 30%"这种笼统数字 —— 逐样本看',
    Number(rows[5].deflate) < Number(rows[5].raw),
    `deflate ${rows[5].deflate}B vs 正文 ${rows[5].raw}B (省 ${(100 - (Number(rows[5].deflate) / Number(rows[5].raw)) * 100).toFixed(1)}%)`);

  // 真·不可压内容: 直接量**字节** (不经过字符串, 免得 UTF-8 把样本改掉)
  const entropy = (() => {
    const out = new Uint8Array(1024);
    let x = 88172645463325252n;
    for (let i = 0; i < out.length; i++) {
      x ^= (x << 13n) & 0xffffffffffffffffn;
      x ^= x >> 7n;
      x ^= (x << 17n) & 0xffffffffffffffffn;
      out[i] = Number(x & 0xffn);
    }
    return out;
  })();
  const em = measureAll(entropy);
  console.log(`    真随机字节 1KB (字节级)      raw  1024 · none=${em.none} lz77=${em.lz77} deflate=${em.deflate} · pickAlgo=${pickAlgo(entropy, 'deflate')}`);
  ok('不可压内容 (真随机 1KB): pickAlgo 退回 none —— 不让包白白膨胀 (不假装省)',
    pickAlgo(entropy, 'deflate') === 'none',
    `deflate ${em.deflate}B / lz77 ${em.lz77}B vs 正文 1024B`);
  ok('不可压内容真测: deflate 与 lz77 都**没有**把它压小 (lz77 还涨了 —— 控制位开销)',
    em.deflate >= entropy.length && em.lz77 > entropy.length,
    `lz77 ${em.lz77}B (+${(((em.lz77 / entropy.length) - 1) * 100).toFixed(1)}%) · deflate ${em.deflate}B`);
  ok('deflate 在重复内容上不差于 lz77 (真数字, 不是声称)',
    Number(rows[3].deflate) <= Number(rows[3].lz77),
    `1KB 重复: deflate ${rows[3].deflate}B vs lz77 ${rows[3].lz77}B`);

  // 固定头开销: 空正文 + 带 DID 段的 compact 包 = header 2 + DID 32 + varint(1) + 一条指令 2 + CRC 4
  const emptyMsg = buildPacket({ from: 'did:bolloon:x', instructions: [{ op: '!ACK' }], mode: 'compact' });
  ok('固定头开销可量化 (空正文带 DID 段的包 = 2B 头 + 32B DID 段 + 1B 段长 + 2B 指令 + 4B CRC = 41B)',
    emptyMsg.length === 41,
    `实测 ${emptyMsg.length}B; 无 DID 段时 ${buildPacket({ instructions: [{ op: '!ACK' }] }).length}B`);

  fs.writeFileSync(path.join(HOME, 'efficode-measurements.json'), JSON.stringify(rows, null, 2), 'utf-8');
  console.log(`    (逐样本原始数字: ${path.join(HOME, 'efficode-measurements.json')})`);
}

// ============================================================ [E] 两进程端到端
async function sectionE(): Promise<void> {
  console.log('\n[E] 两进程端到端: 真起两个进程, 真管道互发一条 Efficode 消息');
  const child = path.join(ROOT, 'scripts', 'lib', 'efficode-e2e-child.ts');
  const text = '#REQ: 本期口径复核 — 请接单一期, 预算 1000 USDC @ base';

  const run = (args: string[], stdin?: string): Promise<{ out: string; err: string; code: number }> =>
    new Promise((resolve) => {
      const p = spawn(TSX, [child, ...args], { cwd: ROOT, env: { ...process.env, BOLLOON_HOME: HOME } });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += String(d); });
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('close', (code) => resolve({ out, err, code: code ?? -1 }));
      if (stdin !== undefined) { p.stdin.write(stdin); p.stdin.end(); }
    });

  const SENDER = ['--role=sender', '--mine=efficode', '--from=did:bolloon:agent-a', '--to=did:bolloon:agent-b', `--text=${text}`];
  const RECEIVER = ['--role=receiver', '--mine=efficode'];

  // ① 双方都声明 → 真编真解
  const sender = await run([...SENDER, '--peer-langs=efficode']);
  const frame = sender.out.trim().split('\n').filter(Boolean).pop() ?? '';
  ok('发送进程真跑通并产出一帧', sender.code === 0 && frame.startsWith('{'), sender.err.trim().split('\n').pop() ?? '');
  const recv = await run(RECEIVER, frame + '\n');
  const r1 = (() => { try { return JSON.parse(recv.out.replace(/^RESULT /, '').trim()); } catch { return null; } })();
  ok('接收进程 (另一进程) 真解出原文, 且声明的语言是 efficode',
    recv.code === 0 && r1?.got?.decoded === true && r1?.got?.text === text && r1?.got?.declaredLang === 'efficode',
    `解出 ${String(r1?.got?.text ?? '').slice(0, 24)}…`);
  ok('两进程身份经 DID 段传递 (32B 摘要段可核)',
    typeof r1?.got?.fromDid === 'string' && r1!.got.fromDid === 'did:bolloon:agent-a');

  // ② 对端没声明 → 回落自然语言, 接收方**不**解码
  const sender2 = await run(SENDER);
  const frame2 = sender2.out.trim().split('\n').filter(Boolean).pop() ?? '';
  const recv2 = await run(RECEIVER, frame2 + '\n');
  const r2 = (() => { try { return JSON.parse(recv2.out.replace(/^RESULT /, '').trim()); } catch { return null; } })();
  ok('对端没声明 → 原文直发 + 接收方不解码 (内容仍逐字一致)',
    r2?.got?.decoded === false && r2?.got?.text === text && r2?.got?.declaredLang === 'natural');

  // ③ 接收方不支持 → 拒解 (另一进程里真抛)
  const recv3 = await run(['--role=receiver', '--mine=natural'], frame + '\n');
  const r3 = (() => { try { return JSON.parse(recv3.out.replace(/^RESULT /, '').trim()); } catch { return null; } })();
  ok('接收方没声明支持而对方声明 efficode → 另一进程里真拒解 (不硬解)',
    /EFFICODE_LANG_UNSUPPORTED/.test(String(r3?.error ?? '')) && r3?.got === null);

  ok('三进程都退出码 0 (没有靠崩溃来"通过")', sender.code === 0 && recv.code === 0 && sender2.code === 0 && recv2.code === 0 && recv3.code === 0);
}

// ============================================================ [F] 变异判红
function sectionF(): void {
  console.log('\n[F] 变异判红 (真拆机制 → 门必须变红; 拆完还原)');
  const py = path.join(ROOT, 'scripts', 'verify-efficode-mutations.py');
  if (!fs.existsSync(py)) { ok('变异门脚本存在', false, py); return; }
  const res = spawnSync('python3', [py], { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, BOLLOON_HOME: HOME } });
  const lines = String(res.stdout || '').split('\n').filter((l) => /^\s*(M\d|✅|❌|变异)/.test(l));
  for (const l of lines) console.log(`    ${l.trim()}`);
  if (res.status !== 0 && res.stderr) console.log(`    stderr: ${String(res.stderr).split('\n').slice(-3).join(' | ')}`);
  ok('≥3 条变异全部判红 (拆掉机制 = 门变红 = 该机制真承重)', res.status === 0);
  ok('变异后源码逐字节还原 (无残留)', String(res.stdout || '').includes('已还原'));
}

async function main(): Promise<void> {
  console.log(`Efficode 验收门 (隔离 HOME=${HOME})`);
  console.log(`参考实现: src/efficode/* · 交流语言可选: src/agents/agent-lang.ts · 群消息: src/agents/gateway-group.ts`);
  sectionA();
  sectionB();
  sectionC();
  if (!CORE_ONLY) {
    sectionD();
    await sectionE();
    if (!NO_MUT) sectionF();
  } else {
    console.log('\n[D/E/F] 跳过 (--core-only)');
  }
  console.log(`\n结果: ${passed} passed / ${failed} failed`);
  if (failed) {
    console.log('失败项:');
    for (const f of failures) console.log(`  · ${f}`);
    process.exit(1);
  }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}

void main();
