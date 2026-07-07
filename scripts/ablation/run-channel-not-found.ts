// @ts-nocheck
/**
 * ablation/run-channel-not-found.ts — "channel 不在也没显示" 三层失守修复验证 (v0.2.12)
 *
 * 设计目标: 验证 H2 bug 修复 — channel 不存在时, API / 客户端都明确报错
 *
 * 实验矩阵 (5 项):
 *   C1: /sessions/<bad-id> 返回 404 (修复前: 200 + 空 Session)
 *   C2: /message {channelId: <bad-id>} 返回 404 (修复前: 202 静默通过)
 *   C3: /sessions/<existing-id> 仍正常 (不能误伤正常 case)
 *   C4: /message {channelId: <existing-id>, text} 仍 202
 *   C5: 异常 channelId (空 / 特殊字符) 也能正确拒绝
 *
 * 假阳性检查:
 *   - C3/C4 baseline 必须能正常返回, 不能因为校验反而破坏正常路径
 *   - 5 项独立测试, 至少 4/5 必须通过
 *
 * 运行: npx tsx scripts/ablation/run-channel-not-found.ts
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS_DIR = path.join(ROOT, 'docs', 'ablation');
const PORT = 54198; // 用独立端口避免与其他 runner 冲突
const BASE = `http://127.0.0.1:${PORT}`;

const results: Record<string, any> = {};

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

let serverProc: any = null;
const serverLog: string[] = [];

async function startServer(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { console.log('[server] already up'); return; }
    } catch {}
    await sleep(500);
  }
  console.log('[server] starting ...');
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'node.exe' : 'node';
    const tsxEntry = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    serverProc = spawn(
      cmd,
      [tsxEntry, '-r', 'dotenv/config', 'src/index.ts', '--web', '--port', String(PORT)],
      { cwd: ROOT, env: { ...process.env, BOLLOON_VERBOSE: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    serverProc.stdout?.on('data', (d: any) => { serverLog.push(`[out] ${d.toString()}`); });
    serverProc.stderr?.on('data', (d: any) => { serverLog.push(`[err] ${d.toString()}`); });
    serverProc.on('error', (e: any) => { console.log('[server error]', e); reject(e); });
    const checkUp = async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { console.log('[server] ready'); resolve(); return; }
      } catch {}
      setTimeout(checkUp, 300);
    };
    setTimeout(checkUp, 500);
    setTimeout(() => reject(new Error('server start timeout')), 30000);
  });
}

async function stopServer(): Promise<void> {
  if (!serverProc) return;
  return new Promise((resolve) => {
    serverProc.on('exit', () => { serverProc = null; resolve(); });
    try { serverProc.kill(); } catch { resolve(); }
    setTimeout(() => { try { serverProc?.kill('SIGKILL'); } catch {} serverProc = null; resolve(); }, 2000);
  });
}

// ─── 实验 1: 准备一个存在的 channel 用于 baseline ─────────────────
async function setupRealChannel(): Promise<string> {
  const r = await fetch(`${BASE}/channels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'ablation-channel-not-found-test', autoInvokeTools: false })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`create channel failed: ${JSON.stringify(data)}`);
  return data.id;
}

// ─── 实验 C1: /sessions/<bad-id> 返回 404 ─────────────────────
async function c1_sessionsBadChannel(): Promise<{ pass: boolean; desc: string; out?: any; err?: string }> {
  const badId = `non-existent-${Date.now()}`;
  try {
    const r = await fetch(`${BASE}/sessions/${badId}?sessionId=default`);
    const data = await r.json().catch(() => ({}));
    const pass = r.status === 404 && data.error === 'channel not found';
    return {
      pass,
      desc: `GET /sessions/<bad-id> 返回 404 (修复前 200 + 空 Session)`,
      out: { status: r.status, body: data, expected: 404 },
    };
  } catch (e: any) {
    return { pass: false, desc: 'C1 fetch 失败', err: e.message };
  }
}

// ─── 实验 C2: /message {channelId: <bad-id>} 返回 404 ──────────────
async function c2_messageBadChannel(): Promise<{ pass: boolean; desc: string; out?: any; err?: string }> {
  const badId = `non-existent-${Date.now()}`;
  try {
    const r = await fetch(`${BASE}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', channelId: badId }),
    });
    const data = await r.json().catch(() => ({}));
    const pass = r.status === 404 && data.error === 'channel not found';
    return {
      pass,
      desc: `POST /message {channelId: <bad-id>} 返回 404 (修复前 202 静默通过)`,
      out: { status: r.status, body: data, expected: 404 },
    };
  } catch (e: any) {
    return { pass: false, desc: 'C2 fetch 失败', err: e.message };
  }
}

// ─── 实验 C3: /sessions/<existing-id> 仍正常 ────────────────────
async function c3_sessionsGoodChannel(realId: string): Promise<{ pass: boolean; desc: string; out?: any; err?: string }> {
  try {
    const r = await fetch(`${BASE}/sessions/${realId}?sessionId=default`);
    const data = await r.json().catch(() => ({}));
    const pass = r.status === 200 && data.channelId === realId;
    return {
      pass,
      desc: `GET /sessions/<existing-id> 仍正常 (不能误伤正常 case)`,
      out: { status: r.status, channelId: data.channelId, messagesCount: (data.messages || []).length },
    };
  } catch (e: any) {
    return { pass: false, desc: 'C3 fetch 失败', err: e.message };
  }
}

// ─── 实验 C4: /message {channelId: <existing-id>} 仍 202 ────────
async function c4_messageGoodChannel(realId: string): Promise<{ pass: boolean; desc: string; out?: any; err?: string }> {
  try {
    const r = await fetch(`${BASE}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ablation ping (no LLM needed if autoInvokeTools=false)', channelId: realId }),
    });
    const data = await r.json().catch(() => ({}));
    const pass = r.status === 202 && data.ok === true;
    return {
      pass,
      desc: `POST /message {channelId: <existing-id>} 仍 202 (正常路径不被破坏)`,
      out: { status: r.status, ok: data.ok, async: data.async },
    };
  } catch (e: any) {
    return { pass: false, desc: 'C4 fetch 失败', err: e.message };
  }
}

// ─── 实验 C5: 异常 channelId 处理 ─────────────────────────────
async function c5_abnormalChannelIds(): Promise<{ pass: boolean; desc: string; out?: any; err?: string }> {
  const cases = [
    { name: '空 channelId', body: { text: 'x', channelId: '' }, expect: 400 },
    { name: '畸形特殊字符', body: { text: 'x', channelId: '../../../etc/passwd' }, expect: 404 },
    { name: '超长', body: { text: 'x', channelId: 'x'.repeat(1024) }, expect: 404 },
    { name: 'null', body: { text: 'x', channelId: null }, expect: 400 },
  ];
  const results: any[] = [];
  let allPass = true;
  for (const c of cases) {
    try {
      const r = await fetch(`${BASE}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(c.body),
      });
      const pass = r.status === c.expect;
      results.push({ name: c.name, status: r.status, expected: c.expect, pass });
      if (!pass) allPass = false;
    } catch (e: any) {
      results.push({ name: c.name, err: e.message, pass: false });
      allPass = false;
    }
  }
  return {
    pass: allPass,
    desc: '异常 channelId (空/畸形/超长/null) 能被正确拒绝',
    out: results,
  };
}

// ─── Main ──────────────────────────────────────────────────
async function main() {
  console.log('\n=== ablation v0.2.12: channel-not-found 三层失守修复验证 ===\n');

  let realId = '';
  try {
    await startServer();
    realId = await setupRealChannel();
    console.log(`[setup] 创建测试 channel: ${realId}\n`);

    // C1
    console.log('--- C1: /sessions/<bad-id> 返回 404 ---');
    results.C1 = await c1_sessionsBadChannel();
    console.log(`  ${results.C1.pass ? '✓' : '✗'} ${results.C1.desc}`);
    if (!results.C1.pass) console.log(`    → status: ${results.C1.out?.status}, body: ${JSON.stringify(results.C1.out?.body)?.slice(0, 200)}`);

    // C2
    console.log('\n--- C2: /message {bad channelId} 返回 404 ---');
    results.C2 = await c2_messageBadChannel();
    console.log(`  ${results.C2.pass ? '✓' : '✗'} ${results.C2.desc}`);
    if (!results.C2.pass) console.log(`    → status: ${results.C2.out?.status}, body: ${JSON.stringify(results.C2.out?.body)?.slice(0, 200)}`);

    // C3
    console.log('\n--- C3: /sessions/<existing> 仍 200 (不能误伤) ---');
    results.C3 = await c3_sessionsGoodChannel(realId);
    console.log(`  ${results.C3.pass ? '✓' : '✗'} ${results.C3.desc}`);
    if (!results.C3.pass) console.log(`    → status: ${results.C3.out?.status}, channelId: ${results.C3.out?.channelId}`);

    // C4
    console.log('\n--- C4: /message {good channelId} 仍 202 ---');
    results.C4 = await c4_messageGoodChannel(realId);
    console.log(`  ${results.C4.pass ? '✓' : '✗'} ${results.C4.desc}`);
    if (!results.C4.pass) console.log(`    → status: ${results.C4.out?.status}, ok: ${results.C4.out?.ok}`);

    // C5
    console.log('\n--- C5: 异常 channelId 处理 ---');
    results.C5 = await c5_abnormalChannelIds();
    console.log(`  ${results.C5.pass ? '✓' : '✗'} ${results.C5.desc}`);
    for (const r of (results.C5.out || [])) {
      console.log(`    ${r.pass ? '✓' : '✗'} ${r.name}: status=${r.status ?? r.err}, expected=${r.expected}`);
    }

    // Cleanup: delete the test channel
    try {
      await fetch(`${BASE}/channels/${realId}`, { method: 'DELETE' });
      console.log(`\n[cleanup] 删除测试 channel`);
    } catch {}
  } catch (e: any) {
    console.error('[ablation] fatal:', e.message);
  } finally {
    await stopServer();
  }

  // Summary
  const passed = Object.values(results).filter((r: any) => r.pass).length;
  const total = Object.keys(results).length;
  console.log(`\n=== 总计: ${passed}/${total} pass ===\n`);

  // Write results
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(RESULTS_DIR, 'results-channel-not-found.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), results, summary: { passed, total } }, null, 2),
    'utf-8'
  );
  console.log(`[ablation] results -> ${path.join(RESULTS_DIR, 'results-channel-not-found.json')}`);

  process.exit(passed === total ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });