/**
 * k10-write-verify-wiring.test.ts — K10 ⑦: **写类工具的「读回自证」真接线**
 *
 * 背景 (2026-10-02 查 K10 ⑦ 兼容层时挖出来的): `verifyWriteOutcome` 是"写后读回"这条纪律的
 * **唯一实现**, 却**一个调用点都没有** —— 而且它自己还踩了两个坑:
 *   ① 函数体里 `require('node:fs')` ⇒ 产物是 ESM ⇒ `require` 未定义 ⇒ 被自己的 catch 吞成
 *      `[未核对] 读回失败: require is not defined` ⇒ **它一次都没成功过**;
 *   ② 在 `pi-sdk.ts` 里 ⇒ 想接进 `pi-sdk-tools.ts` 会形成循环 import。
 * 处置: 拆成 `src/agents/write-verify.ts` (静态 import) + **真接进** write_file / edit_file 的成功返回。
 *
 * 判据分三段: 端到端真跑(真写文件, 看结果里有没有事实) · 单元真跑(真 fs 的四种形态) · 反回归(不许退回)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 与 `pi-sdk-tools-validation.test.ts` 同款 mock: 避免 registerBuiltinTools 的副作用依赖
vi.mock('../documents/reader.js', () => ({
  documentReader: { read: vi.fn(async (p: string) => ({ text: 'mock', metadata: { filename: p, size: 4, type: '.txt' } })) },
}));
vi.mock('../network/p2p.js', () => ({ p2pNetwork: { getPeers: () => [], sendMessage: vi.fn(), broadcast: vi.fn() } }));
vi.mock('../constraints/index.js', () => ({ getMinimax: () => ({ summarize: vi.fn(async () => ({ summary: 's', qualityScore: 1 })) }) }));
vi.mock('../agents/pi-sdk-session-factory.js', () => ({ runSelfImproveLoop: vi.fn() }));
vi.mock('../agents/p2p-document-tools.js', () => ({ p2pDocumentTools: [], initDocumentReceiver: vi.fn() }));
vi.mock('../agents/shell-tool.js', () => ({ shellExec: vi.fn() }));
vi.mock('../agents/shell-guard.js', () => ({ checkWritePath: () => ({ allowed: true, reason: '' }) }));

import { registerBuiltinTools } from '../agents/pi-sdk-tools.js';
import { verifyWriteOutcome, withWriteVerified } from '../agents/write-verify.js';
import type { Tool } from '../agents/pi-sdk-types.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k10wv-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

function makeCtx(cwd: string) {
  const tools = new Map<string, Tool>();
  const ctx: any = {
    tools,
    cwd,
    identity: { did: 'did:test', name: 'test' },
    persona: null,
    minimaxAvailable: false,
    setPersona: vi.fn(),
    sessionManager: { addFileContext: vi.fn(), getAllChannels: () => [] },
    constraintLayer: { getLogs: () => [] },
    _inboxMessages: [],
  };
  registerBuiltinTools(ctx);
  return ctx;
}

describe('K10 ⑦-A. 单元真跑 (真 fs): 四种形态', () => {
  it('写过的文件存在 ⇒ `[已核对] 文件已落盘` + 真大小', () => {
    const rel = 'note.txt';
    fs.writeFileSync(path.join(tmp, rel), 'hello 世界');
    const fact = verifyWriteOutcome('write_file', { path: rel }, tmp);
    expect(fact).toContain('[已核对] 文件已落盘: note.txt');
    expect(fact, '大小是读回来的真值').toContain(`${Buffer.byteLength('hello 世界')} 字节`);
  });

  it('目录 ⇒ `[已核对] 目录存在`', () => {
    fs.mkdirSync(path.join(tmp, 'sub'));
    expect(verifyWriteOutcome('mkdir', { path: 'sub' }, tmp)).toContain('[已核对] 目录存在: sub');
  });

  it('读不回来的路径 ⇒ `[未核对]` + 提示"别急着说已完成" (且**不许**是 require 报错)', () => {
    const fact = verifyWriteOutcome('write_file', { path: 'definitely-missing/xx.txt' }, tmp);
    expect(fact).toContain('[未核对] 读回失败');
    expect(fact).toContain('别急着说');
    expect(fact, 'ESM 陷阱的指纹: 不该出现 require 相关报错').not.toMatch(/require is not defined/);
  });

  it('非写类工具 ⇒ null (不该给读类工具也拼一行)', () => {
    expect(verifyWriteOutcome('read_file', { path: 'note.txt' }, tmp)).toBeNull();
    expect(verifyWriteOutcome('write_file', {}, tmp), '没有路径 ⇒ 不适用').toBeNull();
  });

  it('withWriteVerified: 成功才拼; 失败结果原样返回', () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
    const ok = withWriteVerified('write_file', { path: 'a.txt' }, tmp, { success: true, output: '✅ wrote a.txt (1 bytes)' });
    expect(ok.output).toContain('✅ wrote a.txt (1 bytes)');
    expect(ok.output).toContain('[已核对]');
    const bad = withWriteVerified('write_file', { path: 'a.txt' }, tmp, { success: false, error: '磁盘满' });
    expect(bad).toEqual({ success: false, error: '磁盘满' });
  });
});

describe('K10 ⑦-B. 端到端真跑: 真调 write_file / edit_file, 结果里带读回事实', () => {
  it('write_file ⇒ 输出含 `[已核对] 文件已落盘` 且文件真在盘上', async () => {
    const ctx = makeCtx(tmp);
    const tool = ctx.tools.get('write_file') as Tool;
    expect(tool, 'write_file 必须注册').toBeDefined();
    const r: any = await tool.execute({ path: 'e2e.txt', content: '端到端真跑' });
    expect(r.success).toBe(true);
    expect(String(r.output), '成功结果必须自带读回事实').toContain('[已核对] 文件已落盘: e2e.txt');
    expect(fs.readFileSync(path.join(tmp, 'e2e.txt'), 'utf-8')).toBe('端到端真跑');
  });

  it('edit_file ⇒ 输出同样带读回事实', async () => {
    fs.writeFileSync(path.join(tmp, 'e2e2.txt'), 'AAAA');
    const ctx = makeCtx(tmp);
    const tool = ctx.tools.get('edit_file') as Tool;
    // ⚠️ 入参是 snake_case (`old_text`/`new_text`) —— 写成驼峰会得到 success:false (踩过)
    const r: any = await tool.execute({ path: 'e2e2.txt', old_text: 'AAAA', new_text: 'BB' });
    expect(r.success).toBe(true);
    expect(String(r.output)).toContain('[已核对]');
  });
});

describe('K10 ⑦-C. 反回归: 不许退回"有实现没人调"和 require 陷阱', () => {
  it('实现模块不许出现函数体里的 `require(` (ESM 产物里必炸, 会被 catch 吞)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/write-verify.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(code, 'write-verify.ts 里不许有 require(').not.toMatch(/\brequire\s*\(/);
  });

  it('两个写类工具的成功返回必须经 withWriteVerified (源级钉住)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk-tools.ts'), 'utf8');
    expect(src).toMatch(/withWriteVerified\('write_file'/);
    expect(src).toMatch(/withWriteVerified\('edit_file'/);
    // 旧的裸返回形状不许再出现 (否则等于把接线拆了却没人发现)
    expect(src).not.toMatch(/return \{ success: true, output: `✅ wrote \$\{relPath\}/);
    expect(src).not.toMatch(/return \{ success: true, output: `✅ edited \$\{relPath\}/);
  });

  it('pi-sdk 仍转出同名符号 (老 import 点不受影响)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf8');
    expect(src).toMatch(/export \{ verifyWriteOutcome, withWriteVerified, WRITE_TOOLS \} from '\.\/write-verify\.js';/);
  });
});
