/**
 * verify-mobile-update.ts — 手机端 web 资源层「双源 OTA」的**真跑验收** (2026-09-26, update-protocol §13)
 *
 * 这个脚本的全部意义是: **不是描述能力, 而是跑一遍给你看**。分三层逐层标注清楚哪些是真的:
 *
 *   ① 真网: npm registry packument + `dist.shasum` 真摘要 + GitHub API (releases/tags/commits/master)
 *      → 真下载 npm tarball (十几 MB) → 真 gunzip/untar → 真摘要核对 → 真落盘 → 真原子替换 → 真读回状态
 *   ② 本机 HTTP: dev 通道的 web 包用 `build-mobile-web-bundle.ts` **真打出来**的 tar.gz, 经真 HTTP 取回
 *   ③ 受控不可达/不一致: 用**真 HTTP**(本机端口, 包括死端口) 造 源不可达 / 版本不存在 / 交叉校验不一致 / 摘要不符
 *
 * **不做**的部分会逐条打印 `未验证` (原生层自更 / 真机 boot / Android APK 构建) —— 不许假装验过。
 *
 * 用法: npx tsx scripts/verify-mobile-update.ts [--quick]
 *   跑之前先: npx tsx scripts/build-mobile-web-bundle.ts --channel dev --no-build
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import {
  checkMobileUpdate, applyMobileUpdate, prepareMobileUpdate, rollbackMobileUpdate,
  autoPrepareMobileUpdate, readMobileUpdateState, renderMobileUpdateReport, verifyWebLayer,
  nativeWired, MOBILE_REFUSED_STATUSES, MOBILE_UPDATE_AGENT_CONTRACT,
  type WebResourceStore, type MobileUpdateDeps,
} from '../src/web/mobile-update.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-update-verify-'));

let PASS = 0, FAIL = 0, SKIP = 0;
const FAILED: string[] = [];
const UNVERIFIED: string[] = [];
function ok(name: string, detail = '') { PASS++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); }
function bad(name: string, detail = '') { FAIL++; FAILED.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
function skip(name: string, why: string) { SKIP++; console.log(`  ⊘ ${name} — ${why}`); }
function section(t: string) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }
function expect(name: string, cond: boolean, detail = '') { cond ? ok(name, detail) : bad(name, detail); }

// ── 真机替身: 文件系统 store (接口与 Capacitor store 同一个 `WebResourceStore`) ──
function createFsWebStore(root: string, baseUrl: string | null): WebResourceStore {
  const abs = (rel: string) => path.join(root, rel);
  return {
    kind: 'fs',
    rootLabel: root.replace(os.homedir(), '~'),
    baseUrl: () => baseUrl,
    async list(rel) {
      try {
        const es = fs.readdirSync(abs(rel), { withFileTypes: true });
        return es.filter((e) => e.isFile()).map((e) => e.name);
      } catch { return []; }
    },
    async readBytes(rel) { try { return new Uint8Array(fs.readFileSync(abs(rel))); } catch { return null; } },
    async readText(rel) { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; } },
    async writeBytes(rel, data) { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), data); },
    async remove(rel) { fs.rmSync(abs(rel), { recursive: true, force: true }); },
    async exists(rel) { return fs.existsSync(abs(rel)); },
    async rename(from, to) { fs.mkdirSync(path.dirname(abs(to)), { recursive: true }); fs.rmSync(abs(to), { recursive: true, force: true }); fs.renameSync(abs(from), abs(to)); },
  };
}

/** 真 HTTP 静态服务 (给 dev 包 / 受控假源的字节用) */
function serve(dir: string): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(String(req.url || '/').split('?')[0]);
    const p = path.join(dir, u);
    if (!p.startsWith(dir) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(fs.statSync(p).size));
    res.end(fs.readFileSync(p));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    port: (srv.address() as any).port,
    close: () => new Promise((r) => srv.close(() => r())),
  })));
}

/**
 * 造一个**真的**最小 web 层 tar.gz (系统 tar 打出来的真包) —— 给"受控注入"的 case 用,
 * 这样它们能走到**最后一步**(切换判据), 而不是在下载就断掉。
 */
function makeMiniWebTgz(tag = 'mini', prefix = 'package/dist/web'): { bytes: Buffer; sha1: string } {
  const dir = fs.mkdtempSync(path.join(TMP, 'mini-'));
  const html = '<!DOCTYPE html><html><body><nav class="tabbar"></nav>'
    + '<script src="./mobile-core.js"></script><script src="./mobile.js"></script></body></html>';
  const files: Record<string, string> = {
    'mobile.html': html.replace('</body>', `<!-- ${tag} --></body>`),
    'mobile.js': `/* mobile.js ${tag} */\n`, 'mobile-core.js': `/* mobile-core.js ${tag} */\n`,
    'mobile.css': `/* ${tag} */\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, prefix, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  const out = path.join(dir, `mini-${tag}.tgz`);
  const r = spawnSync('tar', ['-czf', out, '-C', dir, ...fs.readdirSync(dir).filter((e) => !e.endsWith('.tgz'))], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`mini web 包打包失败: ${r.stderr}`);
  const bytes = fs.readFileSync(out);
  return { bytes, sha1: createHash('sha1').update(bytes).digest('hex') };
}

/** 受控 GitHub facts (构造与给定版本一致的 Tag, 让交叉校验不被"真 GitHub 的更高 tag"打断) */
function ghFactsFor(v: string) {
  return {
    ok: true as const,
    facts: {
      slug: 'logos-42/bolloon', ref: 'refs/heads/master', headSha: 'a'.repeat(40),
      releases: [], tags: [{ name: `v${v}`, sha: 'a'.repeat(40) }],
      fetchedAt: new Date().toISOString(), partial: false, missing: [],
    },
  };
}

/** 死端口 (连不上的真地址) */
async function deadPort(): Promise<number> {
  const s = await serve(TMP);
  const p = s.port; await s.close();
  return p;
}

// ══════════════════════════════════════════════════════════════════════════
console.log('手机端 web 资源层双源 OTA — 真跑验收 (update-protocol §13)');
console.log(`仓库: ${ROOT}`);
console.log(`时间: ${new Date().toISOString()}`);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = String(pkg.version);

// ── 0. 前置: 真网络探测 ────────────────────────────────────────────────────
section('0. 源可达性 (真网探测)');
let npmDoc: any = null, ghHead: string | null = null, ghTags: string[] = [], ghReason: string | null = null;
try {
  const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name).replace('%40', '@')}`, { headers: { Accept: 'application/json' } });
  if (r.ok) npmDoc = await r.json();
  else console.log(`  ! npm registry HTTP ${r.status}`);
} catch (e: any) { console.log(`  ! npm registry 不可达: ${e?.message}`); }
try {
  const r = await fetch('https://api.github.com/repos/logos-42/bolloon/commits/master', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bolloon-verify' } });
  if (r.ok) ghHead = String((await r.json()).sha || '');
  else ghReason = `http_error(HTTP ${r.status})`;
} catch { ghReason = 'offline'; }
try {
  const r = await fetch('https://api.github.com/repos/logos-42/bolloon/tags', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bolloon-verify' } });
  if (r.ok) ghTags = (await r.json()).map((t: any) => String(t.name));
} catch { /* 交叉校验那一项会自己说清 */ }

const npmLatest = npmDoc?.['dist-tags']?.latest || null;
console.log(`  npm latest      = ${npmLatest || '不可达'}`);
console.log(`  GitHub master   = ${ghHead ? ghHead.slice(0, 7) : `不可达 (${ghReason})`}`);
console.log(`  GitHub tags     = ${ghTags.length ? ghTags.slice(0, 6).join(', ') : '不可达'}`);
expect('真网可达: npm registry', !!npmDoc);
expect('真网可达: GitHub API', !!ghHead);
if (!npmDoc || !ghHead) {
  console.log('\n真网不可达 ⇒ 下面依赖真网的项目会逐条标 "未验证" (不伪造数据)。');
}

const realNet = !!(npmDoc && ghHead);
const webBundleDir = path.join(ROOT, 'build', 'mobile-web');
const devBundles = fs.existsSync(webBundleDir)
  ? fs.readdirSync(webBundleDir).filter((f) => f.endsWith('.tar.gz'))
  : [];
const devBundleForHead = ghHead ? devBundles.find((f) => f.includes(ghHead)) : null;

// ══════════════════════════════════════════════════════════════════════════
// A. 真跑: 真网 + 真 npm tarball + 真 dev web 包 → stable → dev → stable
// ══════════════════════════════════════════════════════════════════════════
section('A. 真跑 stable → dev → stable (真网 + 真 tarball + 真替换)');
const storeRoot = path.join(TMP, 'store');
const staticDir = await (async () => {
  // 把 store 根目录直接当静态站点服务 (baseUrl 指向它) —— 与"壳层指向可写目录"同构
  fs.mkdirSync(storeRoot, { recursive: true });
  return serve(storeRoot);
})();
const store = createFsWebStore(storeRoot, `http://127.0.0.1:${staticDir.port}`);
const bundleSrv = fs.existsSync(webBundleDir) ? await serve(webBundleDir) : null;

if (!realNet || !devBundleForHead) {
  skip('stable → dev (真跑)', !realNet ? '真网不可达' : `没找到跟 master HEAD (${ghHead?.slice(0, 7)}) 对应的 web 包 — 先跑 npx tsx scripts/build-mobile-web-bundle.ts --channel dev`);
  UNVERIFIED.push('stable → dev 真跑 (源/包不可用)');
} else {
  const bundlePath = path.join(webBundleDir, devBundleForHead);
  const bundleSha256 = fs.readFileSync(bundlePath + '.sha256', 'utf8').split(/\s+/)[0];
  // 起点: 已装 stable 0.5.0 (真 npm tarball 里的 dist/web) —— 为了让下面 dev→stable 能真跑, 先真装一次 stable
  const deps0: MobileUpdateDeps = {
    store, localIdentity: { version: VERSION }, nativeWritable: true, channel: 'stable',
    localIdentityUrl: null, // 身份由壳层给 (真机上是原生壳注入)
  };
  const c0 = await checkMobileUpdate(deps0);
  console.log(`  初始检查: status=${c0.status} (local ${VERSION} vs npm ${npmLatest}) ${c0.reason?.slice(0, 90) || ''}`);
  expect('真网 stable 检查: 两源一致 → 不阻塞', c0.status === 'up_to_date' || c0.status === 'update_available',
    `status=${c0.status} crossCheck=${c0.crossCheck?.kind || 'n/a'}`);
  if (c0.crossCheck) expect('真网交叉校验: ' + c0.crossCheck.kind, c0.crossCheck.kind === 'agree', c0.crossCheck.detail?.slice(0, 70));
  else skip('真网交叉校验', 'GitHub tags 不可达');

  // A1. 真装 stable (真 npm tarball, 真 shasum) —— 建立"能回滚的旧资源"
  const npmVer = c0.latestVersion || npmLatest;
  const npmDocTarget = npmDoc?.versions?.[npmVer];
  if (!npmDocTarget?.dist?.tarball) {
    skip('A1 真装 stable', `npm packument 里没有 ${npmVer} 的 dist.tarball`);
  } else {
    const t0 = Date.now();
    const a1 = await applyMobileUpdate({
      ...deps0, channel: 'stable', localIdentity: { version: '0.4.9' }, // 造一个"比当前旧"的已装身份 → 真下载真替换
      confirm: true,
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    expect('A1 真装 stable (真 npm tarball + 真 shasum + 原子替换)', a1.ok, `stage=${a1.stage} to=${a1.to} digest=${a1.digest} ${dt}s`);
    if (!a1.ok) console.log(`     ↳ ${a1.reason}`);
    const cur = await store.readText('current/mobile.js');
    expect('A1 current 里是真的 web 资源', !!cur && cur.length > 1000, `${cur ? cur.length : 0} bytes`);
    const prev = await store.readText('previous/mobile.js');
    expect('A1 空 store 上第一次装: previous 本来就该是空的 (没有旧资源可备份, 不假装备份过)', prev === null, prev ? `${prev.length} bytes` : 'previous 空 ✓');
    const v = await verifyWebLayer(store, 'current', { bootTimeoutMs: 1500 });
    console.log(`     ↳ current 启动验证: mode=${v.mode} ok=${v.ok} — ${v.detail}`);
    expect('A1 替换后 current 通过启动验证', v.ok, v.detail.slice(0, 90));

    // A2. 真跑 stable → dev (真 dev web 包, 经真 HTTP)
    const c1 = await checkMobileUpdate({
      ...deps0, channel: 'dev', localIdentity: undefined,
      devBundleUrl: `http://127.0.0.1:${bundleSrv!.port}/bolloon-web-{sha}.tar.gz`,
      devBundleSha256: bundleSha256,
    });
    expect('A2 dev 检查: 目标身份 = <版本>+dev.<sha7>', c1.targetIdentity === `0.5.0+dev.${ghHead.slice(0, 7)}`, `target=${c1.targetIdentity}`);
    expect('A2 dev 检查: 载荷摘要已 pin', c1.artifact?.digest?.algo === 'sha256', JSON.stringify(c1.artifact?.digest || null));
    const a2 = await applyMobileUpdate({
      ...deps0, channel: 'dev', localIdentity: undefined,
      devBundleUrl: `http://127.0.0.1:${bundleSrv!.port}/bolloon-web-{sha}.tar.gz`,
      devBundleSha256: bundleSha256, confirm: true,
    });
    expect('A2 真跑 stable → dev (真 dev 包, 真 sha 核对)', a2.ok, `stage=${a2.stage} to=${a2.to}`);
    if (!a2.ok) console.log(`     ↳ ${a2.reason}`);
    const st2 = await readMobileUpdateState(store);
    expect('A2 状态记得住: 装的是 dev + sha7', st2.installedChannel === 'dev' && st2.installedDevSha === ghHead.slice(0, 7),
      `channel=${st2.installedChannel} sha=${st2.installedDevSha} 能切回=${st2.switchableTo?.channel}`);
    expect('A2 溯源: URL + 摘要落进 state', !!st2.installedFrom?.url && st2.installedFrom?.digest?.startsWith('sha256:'),
      `${st2.installedFrom?.url || 'n/a'}`);
    const prev2 = await store.readText('previous/mobile.js');
    expect('A2 被覆盖掉的 stable 层留在 previous (能回滚)', !!prev2 && prev2.length > 1000, `${prev2 ? prev2.length : 0} bytes`);

    // A3. 真跑 dev → stable (切回权威源)
    const c2 = await checkMobileUpdate({ ...deps0, channel: 'stable', localIdentity: undefined, devBundleUrl: null });
    expect('A3 dev→stable 检查: 说明里点明"切回 stable"', c2.status === 'update_available' && /切回 stable/.test(c2.reason || ''), `status=${c2.status}`);
    const a3 = await applyMobileUpdate({ ...deps0, channel: 'stable', localIdentity: undefined, devBundleUrl: null, confirm: true });
    expect('A3 真跑 dev → stable', a3.ok, `stage=${a3.stage} to=${a3.to}`);
    const st3 = await readMobileUpdateState(store);
    expect('A3 状态: 回到 stable, 且记得上次那个 dev 快照', st3.installedChannel === 'stable' && st3.installedDevSha === null && st3.lastDevSha === ghHead.slice(0, 7),
      `channel=${st3.installedChannel} lastDevSha=${st3.lastDevSha} 能切回=${st3.switchableTo?.channel}`);
    const v3 = await verifyWebLayer(store, 'current', { bootTimeoutMs: 1500 });
    expect('A3 切回后 current 仍能启动', v3.ok, `mode=${v3.mode}`);
    console.log('\n  报告口径 (与桌面 update --status 同措辞):');
    for (const l of renderMobileUpdateReport(c2, st3)) console.log(`    | ${l}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// B. 假阳性检查: 源不可达 / 版本不存在 / 交叉校验不一致 / 摘要不符 ⇒ 必拒 + 分类
// ══════════════════════════════════════════════════════════════════════════
section('B. 假阳性检查: 必须拒绝且分类说清 (0 字节下载)');
const badDir = path.join(TMP, 'bad');
fs.mkdirSync(badDir, { recursive: true });

async function runCheck(name: string, depsOverride: Partial<MobileUpdateDeps>, wantStatus: string, wantPattern?: RegExp) {
  const st = createFsWebStore(path.join(TMP, `s-${Math.random().toString(36).slice(2)}`), null);
  const r = await checkMobileUpdate({
    store: st, localIdentity: { version: VERSION }, nativeWritable: true, ...depsOverride,
  } as MobileUpdateDeps);
  const hit = r.status === wantStatus && (!wantPattern || wantPattern.test(r.reason || ''));
  expect(name, hit, `status=${r.status}${hit ? '' : ` (期望 ${wantStatus})`} · ${(r.reason || '').slice(0, 110)}`);
  return r;
}

// B1. registry 真不可达 (死端口) → offline
const dp1 = await deadPort();
await runCheck('B1 registry 不可达 (真连不上的端口) → offline 且拒绝', {
  registryBase: `http://127.0.0.1:${dp1}`, localIdentityUrl: null,
}, 'offline', /不能判定为最新/);

// B2. dev 通道 GitHub 真不可达 → github_unavailable(offline), 不回落 stable
const dp2 = await deadPort();
await runCheck('B2 dev 通道 GitHub 不可达 (死端口) → github_unavailable, 不回落 stable', {
  channel: 'dev', apiBase: `http://127.0.0.1:${dp2}`, localIdentityUrl: null,
  devBundleUrl: `http://127.0.0.1:${dp2}/bolloon-web-{sha}.tar.gz`,
}, 'github_unavailable', /github_unavailable\(offline\)[\s\S]*不回落到 stable/);

// B3. 交叉校验不一致: 假 GitHub API 说 v9.9.9, 真 npm 说 0.5.0
const fakeApi: Record<string, string> = {
  '/repos/logos-42/bolloon/commits/master': JSON.stringify({ sha: 'f'.repeat(40) }),
  '/repos/logos-42/bolloon/releases': JSON.stringify([{ tag_name: 'v9.9.9' }]),
  '/repos/logos-42/bolloon/tags': JSON.stringify([{ name: 'v9.9.9', commit: { sha: 'f'.repeat(40) } }]),
};
const fakeApiSrv = http.createServer((req, res) => {
  const body = fakeApi[String(req.url || '').split('?')[0]];
  if (!body) { res.statusCode = 404; res.end('{}'); return; }
  res.setHeader('content-type', 'application/json'); res.end(body);
});
await new Promise<void>((r) => fakeApiSrv.listen(0, '127.0.0.1', () => r()));
const fakeApiPort = (fakeApiSrv.address() as any).port;
if (npmDoc) {
  const r3 = await runCheck('B3 交叉校验不一致 (假 GitHub 说 v9.9.9 vs 真 npm) → cross_check_mismatch', {
    apiBase: `http://127.0.0.1:${fakeApiPort}`, localIdentityUrl: null,
  }, 'cross_check_mismatch', /拒绝按 GitHub 的记录安装/);
  expect('B3 交叉校验被标为阻塞', r3.crossCheck?.blocking === true);
} else {
  skip('B3 交叉校验不一致', '真 npm 不可达 (需要真 npm 做权威侧)');
  UNVERIFIED.push('交叉校验不一致真跑 (npm 不可达)');
}

// B4. 版本不存在: 假 registry 的 dist-tags.latest 指向 versions 里没有的版本
const fakeRegSrv = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ 'dist-tags': { latest: '9.9.9' }, versions: { '9.9.8': { version: '9.9.8' } } }));
});
await new Promise<void>((r) => fakeRegSrv.listen(0, '127.0.0.1', () => r()));
const fakeRegPort = (fakeRegSrv.address() as any).port;
await runCheck('B4 版本不存在 (dist-tags 指向 versions 里没有的版本) → target_unpublished 拒绝', {
  registryBase: `http://127.0.0.1:${fakeRegPort}`, localIdentityUrl: null,
}, 'target_unpublished', /0 字节下载/);

// B5. 摘要不符: 真 npm 的 shasum 声明 + 被改过的字节 (真 HTTP 供字节)
{
  const tarballUrl = npmDoc?.versions?.[npmLatest || '']?.dist?.tarball;
  const declared = npmDoc?.versions?.[npmLatest || '']?.dist?.shasum;
  if (realNet && tarballUrl && declared) {
    const real = Buffer.from(await (await fetch(tarballUrl)).arrayBuffer());
    const tampered = Buffer.from(real); tampered[tampered.length - 1] ^= 0xff;   // 改一个字节
    fs.writeFileSync(path.join(badDir, 'tampered.tgz'), tampered);
    const srv5 = await serve(badDir);
    const st5 = createFsWebStore(path.join(TMP, 's5'), null);
    const r5 = await checkMobileUpdate({
      store: st5, localIdentity: { version: '0.4.9' }, nativeWritable: true, localIdentityUrl: null,
      registryBase: `http://127.0.0.1:${srv5.port}`, // 假 registry: 用真版本号+真 shasum, 但 tarball 指向被改过的字节
      npmDoc: { 'dist-tags': { latest: npmLatest }, versions: { [npmLatest!]: { version: npmLatest, dist: { tarball: `http://127.0.0.1:${srv5.port}/tampered.tgz`, shasum: declared } } } },
    });
    expect('B5 摘要不符 (真 shasum vs 被改字节) → 检查阶段判出待装', r5.status === 'update_available', `status=${r5.status}`);
    const a5 = await applyMobileUpdate({
      store: st5, localIdentity: { version: '0.4.9' }, nativeWritable: true, localIdentityUrl: null, confirm: true,
      registryBase: `http://127.0.0.1:${srv5.port}`,
      npmDoc: { 'dist-tags': { latest: npmLatest }, versions: { [npmLatest!]: { version: npmLatest, dist: { tarball: `http://127.0.0.1:${srv5.port}/tampered.tgz`, shasum: declared } } } },
    } as any);
    expect('B5 摘要不符 → 拒绝安装 (digest_mismatch), current 没被动', a5.stage === 'failed' && a5.failedAt === 'downloading' && /digest_mismatch/.test(a5.reason), `stage=${a5.stage}/${a5.failedAt} · ${a5.reason.slice(0, 90)}`);
    expect('B5 拒绝后 current 仍是空的 (没装半个)', !(await st5.exists('current/mobile.html')));
    await srv5.close();
  } else {
    skip('B5 摘要不符', '真 npm tarball/shasum 不可用');
    UNVERIFIED.push('摘要不符真跑 (npm 不可达)');
  }
}

// B6. dev 包 sha ≠ master HEAD: 用真 GitHub HEAD 之外的 sha 造包
if (ghHead) {
  const otherSha = (ghHead[0] === 'a' ? 'b' : 'a').repeat(40);
  const st6 = createFsWebStore(path.join(TMP, 's6'), null);
  const r6 = await checkMobileUpdate({
    store: st6, localIdentity: { version: '0.5.0' }, nativeWritable: true, channel: 'dev', localIdentityUrl: null,
    devBundleUrl: `http://127.0.0.1:${(bundleSrv?.port || 1)}/bolloon-web-{sha}.tar.gz`,
  });
  expect('B6 dev 目标身份按 GitHub master HEAD 算 (不是本地 HEAD)',
    r6.targetIdentity === `0.5.0+dev.${ghHead.slice(0, 7)}`, `target=${r6.targetIdentity} (master=${ghHead.slice(0, 7)}, 另一个 sha=${otherSha.slice(0, 7)})`);
  const a6 = await applyMobileUpdate({
    store: st6, localIdentity: { version: '0.5.0' }, nativeWritable: true, channel: 'dev', localIdentityUrl: null, confirm: true,
    // 冒充: 让 {sha} 解析到一个不是 master HEAD 的包名 → 404 → 也必须拒绝 (不静默跳过)
    devBundleUrl: `http://127.0.0.1:${(bundleSrv?.port || 1)}/bolloon-web-{sha}-MISSING.tar.gz`,
  });
  expect('B6 dev 包取不到 → 拒绝 (target_unpublished/registry_unavailable), 不留半份',
    !a6.ok && /下载|404|失败/.test(a6.reason), `stage=${a6.stage} · ${a6.reason.slice(0, 90)}`);
  expect('B6 拒绝后 current 没被动', !(await st6.exists('current/mobile.html')));
}

// ══════════════════════════════════════════════════════════════════════════
// C. 回滚真跑 (装到一半失败 → 回到旧资源且能启动)
// ══════════════════════════════════════════════════════════════════════════
section('C. 回滚真跑');
if (realNet && npmDoc?.versions?.[npmLatest || '']?.dist?.tarball) {
  const st = createFsWebStore(path.join(TMP, 'rollback'), null);
  const base: MobileUpdateDeps = { store: st, nativeWritable: true, localIdentityUrl: null, registryBase: 'https://registry.npmjs.org' };
  // C0: 先真装一份"旧资源" (0.4.9 → npm latest)
  const first = await applyMobileUpdate({ ...base, localIdentity: { version: '0.4.9' }, confirm: true });
  expect('C0 先真装一份旧资源作为回滚目标', first.ok, `stage=${first.stage}/${first.failedAt || '-'} to=${first.to} · ${first.reason.slice(0, 130)}`);
  const beforeHash = createHash('sha256').update((await st.readBytes('current/mobile-core.js'))!).digest('hex').slice(0, 16);
  // C1: 注入"备份已做但 staging 未上位"的失败 —— 这才是真回滚
  const rb = await applyMobileUpdate({ ...base, localIdentity: { version: '0.4.8' }, confirm: true, failSwitch: 'after_backup' });
  expect('C1 装到一半失败 → rolled_back (不是假成功)', !rb.ok && rb.stage === 'rolled_back', `stage=${rb.stage} failedAt=${rb.failedAt}`);
  expect('C1 回滚后 current 逐字等于回滚前 (真·回滚)', createHash('sha256').update((await st.readBytes('current/mobile-core.js'))!).digest('hex').slice(0, 16) === beforeHash, `sha256[0:16]=${beforeHash}`);
  const vb = await verifyWebLayer(st, 'current', { bootTimeoutMs: 1500 });
  expect('C1 回滚后仍能启动', vb.ok, `mode=${vb.mode} — ${vb.detail.slice(0, 70)}`);
  const stRb = await readMobileUpdateState(st);
  expect('C1 失败被如实记进 state (不掩盖)', stRb.lastFailure?.stage === 'switching', `lastFailure.stage=${stRb.lastFailure?.stage}`);
  expect('C1 history 记的是 rolled_back', stRb.history[0]?.stage === 'rolled_back');
  // C2a: 没有 previous 时的"一键回滚"必须如实拒绝 (不能假装滚了 —— C1 已经把 previous 消费掉了)
  const rb2 = await rollbackMobileUpdate({ ...base, confirm: true });
  expect('C2a 没有 previous 时一键回滚 → 拒绝并说清 (不假装滚过)', !rb2.ok && /previous/.test(rb2.reason),
    `stage=${rb2.stage} · ${rb2.reason.slice(0, 90)}`);
  expect('C2a 拒绝后 current 还是那份能启动的资源', (await verifyWebLayer(st, 'current', { bootTimeoutMs: 1500 })).ok);

  // C2b: 真有 previous 时真滚回 (上一份被 OTA 覆盖掉的资源能一键搬回来)
  {
    const st2 = createFsWebStore(path.join(TMP, 'rollback2'), null);
    const b2: MobileUpdateDeps = { store: st2, nativeWritable: true, localIdentityUrl: null };
    // 预置: 真机出厂就带着一份内置 web 资源 —— 先把它写进 current, 才有"旧资源"可回滚
    const seeded = makeMiniWebTgz('seeded', 'dist/web');
    fs.writeFileSync(path.join(badDir, 'seeded.tgz'), seeded.bytes);
    const seededSrv = await serve(badDir);
    const seededDoc = { 'dist-tags': { latest: '0.4.1' }, versions: { '0.4.1': { version: '0.4.1', dist: { tarball: `http://127.0.0.1:${seededSrv.port}/seeded.tgz`, shasum: seeded.sha1 } } } };
    const seedOut = await applyMobileUpdate({
      ...b2, localIdentity: { version: '0.4.0' }, confirm: true, npmDoc: seededDoc, githubFacts: ghFactsFor('0.4.1'),
    } as any);
    expect('C2b 预备: 先把"出厂内置资源"装进 current', seedOut.ok && await st2.exists('current/mobile.html'), `stage=${seedOut.stage} · ${seedOut.reason.slice(0, 100)}`);
    await seededSrv.close();
    const mini = makeMiniWebTgz('newer');
    fs.writeFileSync(path.join(badDir, 'mini.tgz'), mini.bytes);
    const srv = await serve(badDir);
    const stg = await prepareMobileUpdate({
      ...b2, localIdentity: { version: '0.4.0' }, githubFacts: ghFactsFor('0.5.0'),
      npmDoc: { 'dist-tags': { latest: '0.5.0' }, versions: { '0.5.0': { version: '0.5.0', dist: { tarball: `http://127.0.0.1:${srv.port}/mini.tgz`, shasum: mini.sha1 } } } },
    } as any);
    expect('C2b 预备: 受控真包能落 staging 并通过验证', stg.ok, `stage=${stg.stage}`);
    const app = await applyMobileUpdate({
      ...b2, localIdentity: { version: '0.4.0' }, confirm: true, githubFacts: ghFactsFor('0.5.0'),
      npmDoc: { 'dist-tags': { latest: '0.5.0' }, versions: { '0.5.0': { version: '0.5.0', dist: { tarball: `http://127.0.0.1:${srv.port}/mini.tgz`, shasum: mini.sha1 } } } },
    } as any);
    expect('C2b 预备: 真装一份 (previous 里有旧资源)', app.ok && await st2.exists('previous/mobile.html'), `stage=${app.stage} · ${app.reason.slice(0, 100)}`);
    const before = createHash('sha256').update((await st2.readBytes('current/mobile.js'))!).digest('hex').slice(0, 12);
    const rb3 = await rollbackMobileUpdate({ ...b2, confirm: true });
    expect('C2b 一键回滚 (有 previous, 在环) → 真滚回', rb3.ok && rb3.stage === 'rolled_back', `stage=${rb3.stage} · ${rb3.reason.slice(0, 110)}`);
    const after = createHash('sha256').update((await st2.readBytes('current/mobile.js'))!).digest('hex').slice(0, 12);
    expect('C2b 滚回后 current 真的换成了 previous 那份 (内容确实变了)', before !== after, `${before} → ${after}`);
    expect('C2b 滚回后仍能启动', (await verifyWebLayer(st2, 'current', { bootTimeoutMs: 1500 })).ok);
    await srv.close();
  }
} else {
  skip('C 回滚真跑', '真 npm 不可达');
  UNVERIFIED.push('回滚真跑 (npm 不可达)');
}

// ══════════════════════════════════════════════════════════════════════════
// D. 智能体自主更新: 只到"准备并验证", 切换必须人在环
// ══════════════════════════════════════════════════════════════════════════
section('D. 智能体自主更新 (前置条件与边界)');
{
  const st = createFsWebStore(path.join(TMP, 'agent'), null);
  if (realNet) {
    const deps: MobileUpdateDeps = { store: st, nativeWritable: true, localIdentityUrl: null };
    const prep = await autoPrepareMobileUpdate({ ...deps, localIdentity: { version: '0.4.9' } });
    expect('D1 智能体自动跑到"准备并验证"就停 (awaiting_human)', prep.ok && prep.stage === 'awaiting_human', `stage=${prep.stage} files=${prep.fileCount}`);
    expect('D1 自动阶段 current 一个字节没动', !(await st.exists('current/mobile.html')));
    expect('D1 staging 里是准备好并验证过的资源', await st.exists('staging/mobile.html'));
    const stA = await readMobileUpdateState(st);
    expect('D1 自动准备的结果落进 state (带摘要 + 步骤)', !!stA.autoPrepared && stA.autoPrepared.steps.length >= 4, `steps=${stA.autoPrepared?.steps.length}`);
    const noConfirm = await applyMobileUpdate({ ...deps, localIdentity: { version: '0.4.9' } });
    expect('D2 没有人在环 → 拒绝切换 (human_confirm_required)', !noConfirm.ok && /human_confirm_required/.test(noConfirm.reason), noConfirm.reason.slice(0, 80));
    const yes = await applyMobileUpdate({ ...deps, localIdentity: { version: '0.4.9' }, confirm: true, reuseStaging: true });
    expect('D3 人工确认后复用 staging 完成切换 (没有第二次下载)', yes.ok && yes.steps.some((s) => s.startsWith('auto:')), `stage=${yes.stage}`);
    const stN = await readMobileUpdateState(st);
    expect('D3 装完清掉 autoPrepared', stN.autoPrepared === null && stN.needsReload === true);
  } else {
    skip('D 智能体自主更新真跑', '真 npm 不可达');
  }
  // D4: 原生壳未接 → 不切换 (无论网络如何都能验, 用受控注入)
  const stN = createFsWebStore(path.join(TMP, 'agent-nowire'), null);
  const miniN = makeMiniWebTgz();
  fs.writeFileSync(path.join(badDir, 'mini-nowire.tgz'), miniN.bytes);
  const srvN = await serve(badDir);
  const docN = { 'dist-tags': { latest: '0.5.0' }, versions: { '0.5.0': { version: '0.5.0', dist: { tarball: `http://127.0.0.1:${srvN.port}/mini-nowire.tgz`, shasum: miniN.sha1 } } } };
  const rNow = await applyMobileUpdate({
    store: stN, nativeWritable: false, localIdentityUrl: null, localIdentity: { version: '0.4.9' }, confirm: true, npmDoc: docN,
  } as any);
  expect('D4 原生壳没接可写目录 → 到验证为止都不切换 (native_shell_not_wired), 不说"装好了"',
    rNow.status === 'native_shell_not_wired' && !(await stN.exists('current/mobile.html')),
    `status=${rNow.status} · ${rNow.reason.slice(0, 80)}`);
  expect('D4 资源确实准备好了 (staging 有, current 空) — 诚实: 准备好了但不生效', await stN.exists('staging/mobile.html'));
  await srvN.close();
  console.log(`  · 契约: 自动=${MOBILE_UPDATE_AGENT_CONTRACT.autoAllowedSteps.join('/')} | 人在环=${MOBILE_UPDATE_AGENT_CONTRACT.humanRequiredSteps.join('/')}`);
  console.log(`  · 风险边界 ${MOBILE_UPDATE_AGENT_CONTRACT.riskBoundaries.length} 条已写进契约 (手机端 UI 直接显示)`);
}
expect('D5 nativeWired 语义: 真机 store 未声明 = 未接 (不赌)', nativeWired({ store, nativeWritable: undefined } as any) === false);

// ══════════════════════════════════════════════════════════════════════════
// E. 可见性: 当前源 / 版本·sha / 能切回谁
// ══════════════════════════════════════════════════════════════════════════
section('E. 可见性 (与桌面同口径)');
{
  const st = createFsWebStore(path.join(TMP, 'visible'), null);
  const r = await checkMobileUpdate({
    store: st, localIdentity: { version: VERSION }, nativeWritable: true, localIdentityUrl: null,
  });
  const lines = renderMobileUpdateReport(r, await readMobileUpdateState(st));
  const text = lines.join('\n');
  expect('E1 身份行与桌面同措辞 (当前安装源: …)', /当前安装源: (stable \(npm registry\)|dev \(GitHub master 快照\))/.test(text), '');
  expect('E2 标明更新的是哪一层 (web 资源层)', /更新层:\s+web 资源层/.test(text));
  expect('E3 能切回哪个源可见', /能切回:/.test(text));
  expect('E4 报告里不出现"iOS 整体自动更新"这种做不到的承诺', !/iOS 整体自动更新/.test(text));
  expect('E5 原生层天花板必须写清 (App Store / 未知来源)', /App Store/.test(text + MOBILE_UPDATE_AGENT_CONTRACT.riskBoundaries.join('')) && /未知来源/.test(text + MOBILE_UPDATE_AGENT_CONTRACT.riskBoundaries.join('')));
  expect('E6 拒绝表与桌面同源 (5 个桌面结论都在)', ['offline', 'registry_unavailable', 'local_version_unknown', 'github_unavailable', 'cross_check_mismatch'].every((s) => (MOBILE_REFUSED_STATUSES as string[]).includes(s)));
  console.log('\n  报告样张:');
  for (const l of lines) console.log(`    | ${l}`);
}

// ══════════════════════════════════════════════════════════════════════════
// F. 未验证项 (诚实清单)
// ══════════════════════════════════════════════════════════════════════════
section('F. 未验证 / 做不了的部分 (如实标注)');
UNVERIFIED.push('真机 (iOS/Android) 上的 OTA —— 本机 macOS 13 无签名环境 + 无真机, 需 leo 插设备');
UNVERIFIED.push('原生壳改造 (server.url → 可写目录) —— 未改动原生工程, 所以真机上 apply 会判 native_shell_not_wired 拒绝切换');
UNVERIFIED.push('iOS 原生壳层自更 —— 做不到 (App Store 规则), 不在承诺范围内');
for (const u of UNVERIFIED) console.log(`  ⊘ ${u}`);
console.log('  · Node 里没有 DOM ⇒ 本脚本的"启动验证"是 static-only (结构 + JS 语法编译 + HTML 引用闭合);');
console.log('    真 iframe 加载 + BolloonCore 就位的探测在 scripts/verify-mobile-update-ui.ts (真 Chrome) 里跑。');

// ── 收尾 ───────────────────────────────────────────────────────────────────
await staticDir.close();
if (bundleSrv) await bundleSrv.close();
fakeApiSrv.close();
fakeRegSrv.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${'═'.repeat(70)}`);
console.log(`真跑验收: ${PASS} 通过 · ${FAIL} 失败 · ${SKIP} 跳过 · ${UNVERIFIED.length} 条未验证 (如实标注)`);
if (FAILED.length) console.log(`失败项: ${FAILED.join(' | ')}`);
process.exit(FAIL === 0 ? 0 : 1);
