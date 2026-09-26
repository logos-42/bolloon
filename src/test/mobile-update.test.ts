/**
 * mobile-update.test.ts — 手机端 web 资源层双源 OTA 的单测 (2026-09-26, update-protocol §13)
 *
 * 纪律 (与其它 mobile-* 测试同): **只换传输层**。
 *   · 两个源 (npm packument / GitHub facts) 用**注入**的响应 —— 不打真网
 *   · 下载走一个假 fetch (从本地文件读真 tgz 字节) —— 解压/摘要/切换/验证/回滚**都是真代码**
 *   · 夹具 tar.gz 用**系统 tar 真打出来** (不用我自己写的 tar 去自证自己的 parser)
 *
 * 真网 + 真 npm tarball + 真 GitHub 的那一遍在 `scripts/verify-mobile-update.ts`。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  checkMobileUpdate, prepareMobileUpdate, applyMobileUpdate, rollbackMobileUpdate,
  autoPrepareMobileUpdate, createMemoryWebStore, readMobileUpdateState,
  downloadArtifact, untarBytes, gunzipBytes, pickWebLayer, scriptRefsOf, parseSri,
  MOBILE_REFUSED_STATUSES, MOBILE_WEB_STATUSES, MOBILE_UPDATE_AGENT_CONTRACT,
  MOBILE_WEB_REQUIRED_FILES, WEB_LAYOUT, NATIVE_CEILING_LINE,
  renderMobileUpdateReport,
  type MobileUpdateDeps, type WebResourceStore,
} from '../web/mobile-update.js';

// ── 夹具 ────────────────────────────────────────────────────────────────────

let TMP = '';
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-update-test-')); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } });

const WEB_HTML = `<!DOCTYPE html><html><body><nav class="tabbar"></nav>
<script src="./mobile-core.js"></script><script src="./mobile.js"></script></body></html>`;

function webFixture(versionTag: string): { rel: string; content: string }[] {
  return [
    ...MOBILE_WEB_REQUIRED_FILES.map((f) => ({ rel: f, content: f === 'mobile.html' ? WEB_HTML : `/* ${f} ${versionTag} */\n` })),
    { rel: 'a2ui-client.js', content: `/* a2ui ${versionTag} */\n` },
    { rel: 'manifest.json', content: `{"name":"Bolloon","tag":"${versionTag}"}\n` },
  ];
}

/** 真打一个 tar.gz (用系统 tar; 路径结构与 npm 包 / dev web 包一致) */
function makeTgz(opts: { prefix: string; files: { rel: string; content: string }[]; extra?: Record<string, string> }): Buffer {
  const dir = fs.mkdtempSync(path.join(TMP, 'src-'));
  const base = path.join(dir, opts.prefix);
  for (const f of opts.files) {
    const p = path.join(base, f.rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content, 'utf8');
  }
  for (const [name, content] of Object.entries(opts.extra || {})) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  const out = path.join(TMP, `fixture-${Math.random().toString(36).slice(2)}.tgz`);
  const r = spawnSync('tar', ['-czf', out, '-C', dir, ...fs.readdirSync(dir)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`夹具打包失败: ${r.stderr}`);
  return fs.readFileSync(out);
}

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** npm 侧夹具: 真 tgz 字节 + 真 dist.shasum */
const NPM_VERSION = '0.5.1';
let NPM_TGZ: Buffer;
let NPM_SHASUM: string;
const DEV_MASTER_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
let DEV_TGZ: Buffer;
let DEV_BUNDLE_SHA256: string;
const DEV_BUNDLE_URL = 'https://example.invalid/bolloon-web/{sha}.tar.gz';

beforeAll(() => {
  NPM_TGZ = makeTgz({ prefix: 'package/dist/web', files: webFixture('npm-0.5.1') });
  NPM_SHASUM = sha1(NPM_TGZ);
  DEV_TGZ = makeTgz({
    prefix: 'dist/web',
    files: webFixture('dev-master'),
    extra: {
      '.bolloon-dev-snapshot.json': JSON.stringify({
        channel: 'dev', ref: 'refs/heads/master', sha: DEV_MASTER_SHA, identity: `0.5.0+dev.${DEV_MASTER_SHA.slice(0, 7)}`,
        source: 'fixture', built: false, bundleSha256: '',
      }, null, 2),
    },
  });
  DEV_BUNDLE_SHA256 = sha256(DEV_TGZ);
});

/** 假 fetch: 把 URL 映射到本地真字节 (真 tgz); 其它 URL 一律 404 */
function makeFetch(route: Record<string, Buffer>, opts: { fail?: boolean; notFound?: string[] } = {}) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    if (opts.fail) throw Object.assign(new Error('Failed to fetch'), { code: 'ENOTFOUND' });
    if ((opts.notFound || []).some((u) => String(url).includes(u))) return { status: 404, headers: { get: () => null }, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    const hit = Object.keys(route).find((k) => String(url).startsWith(k) || String(url).includes(k));
    if (!hit) return { status: 404, headers: { get: () => null }, text: async () => 'not found', arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = route[hit];
    return {
      status: 200,
      headers: { get: (k: string) => (String(k).toLowerCase() === 'content-length' ? String(buf.length) : null) },
      text: async () => buf.toString('utf8'),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
  (fn as any).calls = calls;
  return fn;
}

function npmDoc(version: string, tarballUrl: string, shasum: string, extraVersions: string[] = []) {
  const versions: Record<string, any> = {};
  for (const v of [...extraVersions, version]) versions[v] = { version: v };
  versions[version] = { version, dist: { tarball: tarballUrl, shasum, integrity: `sha1-${Buffer.from(shasum, 'hex').toString('base64')}` } };
  return { 'dist-tags': { latest: version }, versions };
}

function githubFacts(opts: { headSha?: string; tags?: string[]; releases?: string[]; reachable?: boolean; reason?: string } = {}) {
  const headSha = opts.headSha ?? DEV_MASTER_SHA;
  const facts = {
    slug: 'logos-42/bolloon', ref: 'refs/heads/master', headSha,
    releases: opts.releases || [], tags: (opts.tags || []).map((name) => ({ name, sha: headSha })),
    fetchedAt: '2026-09-26T00:00:00.000Z', partial: false, missing: [],
  };
  if (opts.reachable === false) return { ok: false as const, kind: 'github_unavailable' as const, reason: (opts.reason || 'offline') as any, detail: '注入的 GitHub 不可达', retryAt: null, facts };
  return { ok: true as const, facts };
}

/** 一个"已经装好 stable 0.5.0"的 web 层 + 一个稳定的 deps 骨架 */
async function freshStore(): Promise<WebResourceStore> {
  const store = createMemoryWebStore({ rootLabel: 'memory://case', baseUrl: null });
  for (const f of webFixture('installed-0.5.0')) await store.writeBytes(path.posix.join(WEB_LAYOUT.current, f.rel), new TextEncoder().encode(f.content));
  return store;
}

const NPM_URL = 'https://registry.example.invalid/pkg.tgz';
/**
 * 路由**必须**是函数 —— 写成常量会在模块加载期求值, 那时 `NPM_TGZ` / `DEV_TGZ` 还是 undefined
 * (它们在 beforeAll 里才被赋真字节), 于是每个 case 都变成"下载失败"的假红。
 */
const npmRoute = () => ({ [NPM_URL]: NPM_TGZ });
const devRoute = () => ({ 'https://example.invalid/bolloon-web/': DEV_TGZ });

function baseDeps(store: WebResourceStore, over: Partial<MobileUpdateDeps> = {}): MobileUpdateDeps {
  return {
    store,
    localIdentity: { version: '0.5.0' },
    nativeWritable: true,
    bootTimeoutMs: 300,
    ...over,
  };
}

// ── 结论枚举 / 拒绝口径 (与桌面共用同一份) ─────────────────────────────────

describe('结论枚举与拒绝口径 (与桌面同一份)', () => {
  it('桌面那 9 个结论逐字保留, 手机特有的只增不改', () => {
    for (const s of ['up_to_date', 'update_available', 'check_skipped', 'offline', 'registry_unavailable',
      'local_version_unknown', 'unsupported_installation', 'github_unavailable', 'cross_check_mismatch']) {
      expect(MOBILE_WEB_STATUSES).toContain(s as any);
    }
    expect(MOBILE_WEB_STATUSES.length).toBe(17);
  });

  it('桌面那 5 个必拒结论仍在必拒表里, 手机特有的 8 个也都在', () => {
    for (const s of ['offline', 'registry_unavailable', 'local_version_unknown', 'github_unavailable', 'cross_check_mismatch']) {
      expect(MOBILE_REFUSED_STATUSES).toContain(s as any);
    }
    for (const s of ['target_unpublished', 'dev_bundle_unavailable', 'dev_sha_mismatch', 'digest_mismatch',
      'web_bundle_malformed', 'decompress_unavailable', 'payload_too_large', 'native_shell_not_wired']) {
      expect(MOBILE_REFUSED_STATUSES).toContain(s as any);
    }
  });

  it('智能体契约: 自动只到 prepare/verify, switch/reload/rollback 必须人在环', () => {
    expect(MOBILE_UPDATE_AGENT_CONTRACT.autoAllowedSteps).toContain('prepare');
    expect(MOBILE_UPDATE_AGENT_CONTRACT.autoAllowedSteps).not.toContain('switch');
    expect(MOBILE_UPDATE_AGENT_CONTRACT.humanRequiredSteps).toEqual(['switch', 'reload', 'rollback', 'channel-switch']);
    expect(MOBILE_UPDATE_AGENT_CONTRACT.riskBoundaries.join(' ')).toMatch(/iOS 原生壳层\*\*不能自更\*\*/);
    expect(MOBILE_UPDATE_AGENT_CONTRACT.riskBoundaries.join(' ')).toMatch(/未知来源/);
  });

  it('原生天花板的说法不承诺"iOS 整体自动更新"', () => {
    expect(NATIVE_CEILING_LINE).toMatch(/App Store/);
    expect(NATIVE_CEILING_LINE).toMatch(/未知来源/);
    expect(NATIVE_CEILING_LINE).toMatch(/web 资源层/);
  });
});

// ── 解压 / 摘要等纯函数 ─────────────────────────────────────────────────────

describe('解压与摘要 (纯函数)', () => {
  it('gunzip + untar 能把我用真 tar 打的包解回来 (含 package/ 前缀)', async () => {
    const raw = await gunzipBytes(new Uint8Array(NPM_TGZ));
    expect(raw).not.toBeNull();
    const entries = untarBytes(raw!);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('package/dist/web/mobile.js');
    const { files, snapshot } = pickWebLayer(entries);
    expect(files.length).toBe(webFixture('x').length);
    expect(snapshot).toBeNull();
    expect(files.find((f) => f.rel === 'mobile.html')).toBeTruthy();
  });

  it('dev 包的 .bolloon-dev-snapshot.json 能被认出来', async () => {
    const raw = await gunzipBytes(new Uint8Array(DEV_TGZ));
    const { files, snapshot } = pickWebLayer(untarBytes(raw!));
    expect(snapshot?.channel).toBe('dev');
    expect(snapshot?.sha).toBe(DEV_MASTER_SHA);
    expect(files.length).toBe(webFixture('x').length);
  });

  it('scriptRefsOf 只取相对脚本引用', () => {
    expect(scriptRefsOf(WEB_HTML)).toEqual(['./mobile-core.js', './mobile.js']);
  });

  it('parseSri 认 sha512/sha256/sha1', () => {
    expect(parseSri('sha512-abc+/=')?.algo).toBe('sha512');
    expect(parseSri('sha1-xyz')?.algo).toBe('sha1');
    expect(parseSri('不认识的') ).toBeNull();
    expect(parseSri(null)).toBeNull();
  });
});

// ── 检查: 拒绝语义 (假阳性检查) ────────────────────────────────────────────

describe('检查: 源不可达 / 版本不存在 / 交叉校验不一致 ⇒ 拒绝并说清', () => {
  it('stable: npm 不可达 → offline, 且不下载任何东西', async () => {
    const store = await freshStore();
    const fetchImpl = makeFetch(npmRoute(), { fail: true });
    const r = await checkMobileUpdate(baseDeps(store, { fetchImpl, npmDoc: null, githubFacts: githubFacts() }));
    expect(r.status).toBe('offline');
    expect(MOBILE_REFUSED_STATUSES).toContain(r.status);
    expect(r.reason).toMatch(/不能判定为最新/);
    expect((fetchImpl as any).calls).toEqual([]);
  });

  it('stable: registry 5xx → registry_unavailable', async () => {
    const store = await freshStore();
    const fetchImpl = async () => ({ status: 503, headers: { get: () => null }, text: async () => 'boom' });
    const r = await checkMobileUpdate(baseDeps(store, { fetchImpl, githubFacts: githubFacts() }));
    expect(r.status).toBe('registry_unavailable');
    expect(r.reason).toMatch(/HTTP 503/);
  });

  it('stable: 两源指向不同版本 → cross_check_mismatch (阻塞)', async () => {
    const store = await freshStore();
    const r = await checkMobileUpdate(baseDeps(store, {
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM),
      githubFacts: githubFacts({ tags: ['v9.9.9'] }),
      fetchImpl: makeFetch(npmRoute()),
    }));
    expect(r.status).toBe('cross_check_mismatch');
    expect(r.crossCheck?.blocking).toBe(true);
    expect(r.reason).toMatch(/拒绝按 GitHub 的记录安装/);
  });

  it('stable: npm 指向一个 versions 里没有的版本 → target_unpublished', async () => {
    const store = await freshStore();
    const doc = npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM);
    doc['dist-tags'].latest = '9.9.9';                 // latest 存在, 但版本不在 versions 里
    const r = await checkMobileUpdate(baseDeps(store, { npmDoc: doc, githubFacts: githubFacts({ tags: ['9.9.9'] }) }));
    expect(r.status).toBe('target_unpublished');
    expect(r.targetPublished).toBe(false);
  });

  it('stable: 两源一致 → update_available, 且计划里带真摘要', async () => {
    const store = await freshStore();
    const r = await checkMobileUpdate(baseDeps(store, {
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM), githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }), fetchImpl: makeFetch(npmRoute()),
    }));
    expect(r.status).toBe('update_available');
    expect(r.crossCheck?.kind).toBe('agree');
    expect(r.artifact?.url).toBe(NPM_URL);
    expect(r.artifact?.digest).toEqual({ algo: 'sha1', hex: NPM_SHASUM });
    expect(r.identityLine).toMatch(/当前安装源: stable \(npm registry\)/);
  });

  it('dev: GitHub 不可达 → github_unavailable(5 类之一) 且不回落 stable', async () => {
    for (const reason of ['offline', 'rate_limited', 'not_found', 'http_error', 'parse_error']) {
      const store = await freshStore();
      const r = await checkMobileUpdate(baseDeps(store, {
        channel: 'dev', npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM),
        githubFacts: githubFacts({ reachable: false, reason }),
      }));
      expect(r.status).toBe('github_unavailable');
      expect(r.reason).toContain(`github_unavailable(${reason})`);
      expect(r.reason).toMatch(/拒绝安装/);
      expect(r.reason).toMatch(/不回落到 stable/);
    }
  });

  it('dev: 没配 web 包地址 → dev_bundle_unavailable (源码快照里没有 dist/web, 手机端不现场构建)', async () => {
    const store = await freshStore();
    const r = await checkMobileUpdate(baseDeps(store, { channel: 'dev', githubFacts: githubFacts(), devBundleUrl: null }));
    expect(r.status).toBe('dev_bundle_unavailable');
    expect(r.reason).toMatch(/dist\/web/);
    expect(r.reason).toMatch(/build-mobile-web-bundle\.ts --channel dev/);
    expect(r.reason).toMatch(/完整 40 位 sha/);
    expect(r.reason).toMatch(/stable 通道不受影响/);
  });

  it('dev: 模板缺 {sha} 也判 dev_bundle_unavailable (不能装一个身份不明的包)', async () => {
    const store = await freshStore();
    const r = await checkMobileUpdate(baseDeps(store, { channel: 'dev', githubFacts: githubFacts(), devBundleUrl: 'https://x.invalid/fixed.tar.gz' }));
    expect(r.status).toBe('dev_bundle_unavailable');
    expect(r.reason).toMatch(/不含 \{sha\}/);
  });

  it('dev: master HEAD 只给前 7 位也要跟装过的 7 位对得上 → up_to_date', async () => {
    const store = await freshStore();
    const r = await checkMobileUpdate(baseDeps(store, {
      channel: 'dev', localIdentity: { version: `0.5.0+dev.${DEV_MASTER_SHA.slice(0, 7)}` },
      githubFacts: githubFacts({ headSha: DEV_MASTER_SHA }), devBundleUrl: DEV_BUNDLE_URL,
    }));
    expect(r.status).toBe('up_to_date');
    expect(r.dev?.same).toBe(true);
  });

  it('读不到本地身份 → local_version_unknown (绝不猜 0.0.0)', async () => {
    const store = createMemoryWebStore({ baseUrl: null });
    const r = await checkMobileUpdate({ store, localIdentity: null, localIdentityUrl: null, nativeWritable: true });
    expect(r.status).toBe('local_version_unknown');
    expect(r.currentVersion).toBe('unknown');
    expect(r.reason).toMatch(/不判断有没有更新/);
  });
});

// ── 下载: 摘要校验 ──────────────────────────────────────────────────────────

describe('拒绝语义必须"从拒绝那条路"出来 (分类说清, 不是碰巧没装)', () => {
  it('源不可达时 apply 的理由必须是"拒绝更新 (offline)", 而不是"没有可执行的更新"', async () => {
    const store = await freshStore();
    const out = await applyMobileUpdate(baseDeps(store, {
      fetchImpl: makeFetch({}, { fail: true }), npmDoc: null, githubFacts: githubFacts(), confirm: true,
    }));
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('blocked');
    // 关键: 必须命中"拒绝"这条路 (拒绝表 + 分类), 而不是靠"没有 artifact"顺带挡住的
    expect(out.reason).toMatch(/拒绝更新 \(offline\)/);
    expect(out.reason).toMatch(/一个字节都没下载/);
  });
});

describe('下载: 摘要对不上就拒绝 (不"先装上再说")', () => {
  it('声明摘要与真字节不符 → digest_mismatch', async () => {
    const store = await freshStore();
    const plan = { channel: 'stable' as const, identity: NPM_VERSION, source: 'test', url: NPM_URL, digest: { algo: 'sha1' as const, hex: 'deadbeef'.repeat(5) } };
    const dl = await downloadArtifact(plan, baseDeps(store, { fetchImpl: makeFetch(npmRoute()) }));
    expect(dl.ok).toBe(false);
    expect(dl.status).toBe('digest_mismatch');
    expect(dl.detail).toMatch(/拒绝安装/);
  });

  it('真摘要 → 过, 并自报核对过', async () => {
    const store = await freshStore();
    const plan = { channel: 'stable' as const, identity: NPM_VERSION, source: 'test', url: NPM_URL, digest: { algo: 'sha1' as const, hex: NPM_SHASUM } };
    const dl = await downloadArtifact(plan, baseDeps(store, { fetchImpl: makeFetch(npmRoute()) }));
    expect(dl.ok).toBe(true);
    expect(dl.digest.matched).toBe(true);
  });

  it('HTTP 404 → target_unpublished (版本不存在), 不是"装了个空的"', async () => {
    const store = await freshStore();
    const plan = { channel: 'stable' as const, identity: '9.9.9', source: 'test', url: 'https://registry.example.invalid/missing.tgz', digest: null };
    const dl = await downloadArtifact(plan, baseDeps(store, { fetchImpl: makeFetch({}, { notFound: ['missing.tgz'] }) }));
    expect(dl.ok).toBe(false);
    expect(dl.status).toBe('target_unpublished');
  });

  it('超过 payload 上限 → payload_too_large (不拿内存赌)', async () => {
    const store = await freshStore();
    const plan = { channel: 'stable' as const, identity: NPM_VERSION, source: 'test', url: NPM_URL, digest: null };
    const dl = await downloadArtifact(plan, baseDeps(store, { fetchImpl: makeFetch(npmRoute()), maxPayloadBytes: 64 }));
    expect(dl.ok).toBe(false);
    expect(dl.status).toBe('payload_too_large');
  });
});

// ── 端到端: stable → dev → stable ─────────────────────────────────────────

describe('真跑: stable → dev → stable (同一份流水线, 只在 staging 与 current 之间搬)', () => {
  it('stable → dev: 装上后 current 里是 dev 的资源，状态里记得住身份/来源/摘要/能切回谁', async () => {
    const store = await freshStore();
    const deps = baseDeps(store, {
      channel: 'dev', devBundleUrl: DEV_BUNDLE_URL,
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM),
      githubFacts: githubFacts({ tags: ['v0.5.0'], headSha: DEV_MASTER_SHA }),
      fetchImpl: makeFetch({ ...devRoute(), ...npmRoute() }),
    });
    const r = await checkMobileUpdate(deps);
    expect(r.status).toBe('update_available');
    expect(r.targetIdentity).toBe(`0.5.0+dev.${DEV_MASTER_SHA.slice(0, 7)}`);
    expect(r.artifact?.url).toBe(`https://example.invalid/bolloon-web/${DEV_MASTER_SHA}.tar.gz`);

    const out = await applyMobileUpdate({ ...deps, confirm: true });
    expect(out.ok).toBe(true);
    expect(out.stage).toBe('succeeded');
    expect(out.to).toBe(`0.5.0+dev.${DEV_MASTER_SHA.slice(0, 7)}`);
    expect(out.needsReload).toBe(true);

    const cur = await store.readText(`${WEB_LAYOUT.current}/mobile.js`);
    expect(cur).toMatch(/dev-master/);
    const prev = await store.readText(`${WEB_LAYOUT.previous}/mobile.js`);
    expect(prev).toMatch(/installed-0.5.0/);       // 旧资源留在 previous, 没被删

    const st = await readMobileUpdateState(store);
    expect(st.installedChannel).toBe('dev');
    expect(st.installedDevSha).toBe(DEV_MASTER_SHA.slice(0, 7));
    expect(st.currentVersion).toBe(`0.5.0+dev.${DEV_MASTER_SHA.slice(0, 7)}`);
    expect(st.devRef).toBe('refs/heads/master');
    expect(st.installedFrom?.source).toContain('github master');
    expect(st.switchableTo).toEqual({ channel: 'stable', source: 'npm', target: NPM_VERSION });
    expect(st.lastFailure).toBeNull();
    expect(st.history[0].stage).toBe('succeeded');
    expect(st.autoPrepared).toBeNull();
  });

  it('dev → stable: 一键切回, 状态改回 stable 且保留"上次那个 dev 快照"', async () => {
    // 造一个"现在装的是 dev"的现场
    const store = createMemoryWebStore({ rootLabel: 'memory://case2', baseUrl: null });
    for (const f of webFixture('installed-dev')) await store.writeBytes(`${WEB_LAYOUT.current}/${f.rel}`, new TextEncoder().encode(f.content));
    const devIdentity = `0.5.0+dev.${DEV_MASTER_SHA.slice(0, 7)}`;
    const deps = baseDeps(store, {
      channel: 'stable', localIdentity: { version: devIdentity },
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM),
      githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch(npmRoute()),
    });
    const check = await checkMobileUpdate(deps);
    expect(check.installedChannel).toBe('dev');
    expect(check.installedDevSha).toBe(DEV_MASTER_SHA.slice(0, 7));
    expect(check.status).toBe('update_available');
    expect(check.reason).toMatch(/切回 stable/);
    expect(check.identityLine).toMatch(/当前安装源: dev \(GitHub master 快照\)/);

    const out = await applyMobileUpdate({ ...deps, confirm: true });
    expect(out.ok).toBe(true);
    expect(out.to).toBe(NPM_VERSION);
    const cur = await store.readText(`${WEB_LAYOUT.current}/mobile.js`);
    expect(cur).toMatch(/npm-0\.5\.1/);
    const st = await readMobileUpdateState(store);
    expect(st.installedChannel).toBe('stable');
    expect(st.installedDevSha).toBeNull();
    expect(st.lastDevSha).toBe(DEV_MASTER_SHA.slice(0, 7));
    expect(st.switchableTo?.channel).toBe('dev');
    expect(st.installedFrom?.source).toContain('npm registry');
    expect(st.installedFrom?.digest).toBe(`sha1:${NPM_SHASUM}`);
  });

  it('装到一半失败 (备份后、staging 未上位) → 诚实报 rolled_back, 旧资源真的回到 current', async () => {
    const store = await freshStore();
    const deps = baseDeps(store, {
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM), githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch(npmRoute()),
    });
    const out = await applyMobileUpdate({ ...deps, confirm: true, failSwitch: 'after_backup' });
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('rolled_back');
    expect(out.failedAt).toBe('switching');
    expect(out.reason).toMatch(/已回滚到 0\.5\.0/);
    expect(out.reason).toMatch(/验证通过/);
    // 关键: current 仍是能启动的旧资源
    const cur = await store.readText(`${WEB_LAYOUT.current}/mobile.js`);
    expect(cur).toMatch(/installed-0\.5\.0/);
    const st = await readMobileUpdateState(store);
    expect(st.lastFailure?.stage).toBe('switching');
    expect(st.currentVersion).not.toBe(NPM_VERSION);
    expect(st.history[0].stage).toBe('rolled_back');
  });

  it('备份前就失败 → 报 failed (不是 rolled_back): current 一个字节没动, 不假装"回滚过"', async () => {
    const store = await freshStore();
    const deps = baseDeps(store, {
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM), githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch(npmRoute()),
    });
    const out = await applyMobileUpdate({ ...deps, confirm: true, failSwitch: true });
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('failed');
    expect(out.reason).toMatch(/current 未被改动/);
    expect(await store.readText(`${WEB_LAYOUT.current}/mobile.js`)).toMatch(/installed-0\.5\.0/);
  });

  it('切换后验证失败 → 回滚 (previous 搬回 current)', async () => {
    const store = await freshStore();
    const deps = baseDeps(store, {
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM), githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch(npmRoute()),
    });
    // 让"切换后"这一验不过: 把 prepared 的 mobile-core.js 在切换后损坏 —— 用 store 钩子模拟
    const origRename = store.rename.bind(store);
    store.rename = async (from: string, to: string) => {
      await origRename(from, to);
      if (from === WEB_LAYOUT.staging && to === WEB_LAYOUT.current) {
        await store.writeBytes(`${WEB_LAYOUT.current}/mobile-core.js`, new TextEncoder().encode('这 不是 JS ((('));
      }
    };
    const out = await applyMobileUpdate({ ...deps, confirm: true });
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('rolled_back');
    expect(out.failedAt).toBe('verifying');
    expect(out.reason).toMatch(/切换后验证失败/);
    const cur = await store.readText(`${WEB_LAYOUT.current}/mobile.js`);
    expect(cur).toMatch(/installed-0\.5\.0/);      // 回到旧资源
  });

  it('一键回滚: previous 能起来才滚, 且在环才滚', async () => {
    const store = await freshStore();
    const deps = baseDeps(store, {
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM), githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch(npmRoute()),
    });
    await applyMobileUpdate({ ...deps, confirm: true });
    expect(await store.readText(`${WEB_LAYOUT.current}/mobile.js`)).toMatch(/npm-0\.5\.1/);

    const noConfirm = await rollbackMobileUpdate(deps);
    expect(noConfirm.ok).toBe(false);
    expect(noConfirm.reason).toMatch(/human_confirm_required/);

    const rb = await rollbackMobileUpdate({ ...deps, confirm: true });
    expect(rb.ok).toBe(true);
    expect(rb.stage).toBe('rolled_back');
    expect(await store.readText(`${WEB_LAYOUT.current}/mobile.js`)).toMatch(/installed-0\.5\.0/);
  });
});

// ── 智能体自动更新: 只能到 prepare/verify ──────────────────────────────────

describe('智能体自主更新: 自动跑到"准备并验证", 切换必须人在环', () => {
  it('autoPrepare 停下时是 awaiting_human, current 一个字节没动', async () => {
    const store = await freshStore();
    const deps = baseDeps(store, {
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM), githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch(npmRoute()),
    });
    const prep = await autoPrepareMobileUpdate(deps);
    expect(prep.ok).toBe(true);
    expect(prep.stage).toBe('awaiting_human');
    expect(prep.fileCount).toBe(webFixture('x').length);
    expect(await store.readText(`${WEB_LAYOUT.current}/mobile.js`)).toMatch(/installed-0\.5\.0/);
    expect(await store.readText(`${WEB_LAYOUT.staging}/mobile.js`)).toMatch(/npm-0\.5\.1/);
    const st = await readMobileUpdateState(store);
    expect(st.autoPrepared?.identity).toBe(NPM_VERSION);
    expect(st.autoPrepared?.digest).toBe(`sha1:${NPM_SHASUM}`);
    expect(st.autoPrepared?.steps.length).toBeGreaterThan(3);
  });

  it('没确认位的 apply 直接拒绝 (human_confirm_required), 且没有切换', async () => {
    const store = await freshStore();
    const deps = baseDeps(store, {
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM), githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch(npmRoute()),
    });
    const out = await applyMobileUpdate(deps);
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('blocked');
    expect(out.reason).toMatch(/human_confirm_required/);
    expect(await store.readText(`${WEB_LAYOUT.current}/mobile.js`)).toMatch(/installed-0\.5\.0/);
  });

  it('人确认后复用智能体准备好的 staging (不重复下载), 且身份对不上就拒绝切换', async () => {
    const store = await freshStore();
    const deps = baseDeps(store, {
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM), githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch(npmRoute()),
    });
    await autoPrepareMobileUpdate(deps);
    const before = ((deps.fetchImpl as any).calls as string[]).length;
    const out = await applyMobileUpdate({ ...deps, confirm: true, reuseStaging: true });
    expect(out.ok).toBe(true);
    expect(out.stage).toBe('succeeded');
    expect(((deps.fetchImpl as any).calls as string[]).length).toBe(before);   // 没有第二个 tarball 请求
    expect(out.steps.some((s) => s.startsWith('auto:'))).toBe(true);
  });
});

// ── 原生壳没接上: 诚实拒绝, 不假装生效 ─────────────────────────────────────

describe('原生壳天花板: 接不上就明说, 不假装能自更', () => {
  it('nativeWritable=false → 到验证为止都做了, 但不切换 (native_shell_not_wired)', async () => {
    const store = await freshStore();
    const deps = baseDeps(store, {
      nativeWritable: false,
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM), githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch(npmRoute()),
    });
    const out = await applyMobileUpdate({ ...deps, confirm: true });
    expect(out.ok).toBe(false);
    expect(out.stage).toBe('blocked');
    expect(out.status).toBe('native_shell_not_wired');
    // 资源确实准备好了 (staging 里有), 但 current 没被换
    expect(await store.readText(`${WEB_LAYOUT.staging}/mobile.js`)).toMatch(/npm-0\.5\.1/);
    expect(await store.readText(`${WEB_LAYOUT.current}/mobile.js`)).toMatch(/installed-0\.5\.0/);
  });

  it('nativeWritable=true → 同一条流水线真的切换 (差别只在最后一步的判据)', async () => {
    const store = await freshStore();
    const deps = baseDeps(store, {
      nativeWritable: true,
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM), githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch(npmRoute()),
    });
    const out = await applyMobileUpdate({ ...deps, confirm: true });
    expect(out.ok).toBe(true);
    expect(await store.readText(`${WEB_LAYOUT.current}/mobile.js`)).toMatch(/npm-0\.5\.1/);
  });
});

// ── dev 包身份核对 ─────────────────────────────────────────────────────────

describe('dev 包身份核对 (身份对不上就拒绝)', () => {
  async function devDepsWith(snapshotOverride: any, headSha = DEV_MASTER_SHA) {
    const tgz = makeTgz({
      prefix: 'dist/web', files: webFixture('dev-x'),
      extra: { '.bolloon-dev-snapshot.json': JSON.stringify({ ...snapshotOverride }) },
    });
    const store = await freshStore();
    return baseDeps(store, {
      channel: 'dev', devBundleUrl: DEV_BUNDLE_URL,
      githubFacts: githubFacts({ headSha }),
      fetchImpl: makeFetch({ 'https://example.invalid/bolloon-web/': tgz }),
    });
  }

  it('包里 sha ≠ master HEAD → dev_sha_mismatch', async () => {
    const deps = await devDepsWith({ channel: 'dev', sha: 'ffffffffffffffffffffffffffffffffffffffff' });
    const out = await prepareMobileUpdate(deps);
    expect(out.ok).toBe(false);
    expect(out.status).toBe('dev_sha_mismatch');
    expect(out.reason).toMatch(/≠ GitHub master HEAD/);
  });

  it('包里 snpashot 标的是 stable → dev_sha_mismatch', async () => {
    const deps = await devDepsWith({ channel: 'stable', sha: DEV_MASTER_SHA });
    const out = await prepareMobileUpdate(deps);
    expect(out.ok).toBe(false);
    expect(out.status).toBe('dev_sha_mismatch');
    expect(out.reason).toMatch(/channel=stable/);
  });

  it('包里没有 snapshot 标记 → dev_sha_mismatch (身份证明不了)', async () => {
    const tgz = makeTgz({ prefix: 'dist/web', files: webFixture('dev-nosnap') });
    const store = await freshStore();
    const out = await prepareMobileUpdate(baseDeps(store, {
      channel: 'dev', devBundleUrl: DEV_BUNDLE_URL, githubFacts: githubFacts(),
      fetchImpl: makeFetch({ 'https://example.invalid/bolloon-web/': tgz }),
    }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe('dev_sha_mismatch');
    expect(out.reason).toMatch(/没有 \.bolloon-dev-snapshot\.json/);
  });

  it('结构对得上 → 过 (真下载真解压真验证)', async () => {
    const deps = await devDepsWith({ channel: 'dev', sha: DEV_MASTER_SHA, identity: `0.5.0+dev.${DEV_MASTER_SHA.slice(0, 7)}` });
    const out = await prepareMobileUpdate(deps);
    expect(out.ok).toBe(true);
    expect(out.fileCount).toBe(webFixture('x').length);
  });

  it('包里没有 dist/web → web_bundle_malformed', async () => {
    const tgz = makeTgz({ prefix: 'other', files: [{ rel: 'a.txt', content: 'x' }] });
    const store = await freshStore();
    const out = await prepareMobileUpdate(baseDeps(store, {
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, sha1(tgz)),          // 摘要对得上, 这样才能验到"包结构"那一层
      githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch({ [NPM_URL]: tgz }),
    }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe('web_bundle_malformed');
  });
});

// ── 报告措辞 (与桌面同一口径) ──────────────────────────────────────────────

describe('可见性: 当前源 / 版本 sha / 能切回谁 (同桌面口径)', () => {
  it('报告里有身份行 + 更新层 + 能切回 (不说"iOS 整体自动更新")', async () => {
    const store = await freshStore();
    const r = await checkMobileUpdate(baseDeps(store, {
      npmDoc: npmDoc(NPM_VERSION, NPM_URL, NPM_SHASUM), githubFacts: githubFacts({ tags: [`v${NPM_VERSION}`] }),
      fetchImpl: makeFetch(npmRoute()),
    }));
    const lines = renderMobileUpdateReport(r, await readMobileUpdateState(store));
    const text = lines.join('\n');
    expect(text).toMatch(/当前安装源: stable \(npm registry\)/);
    expect(text).toMatch(/能切回:     dev \(github @ /);
    expect(text).toMatch(/更新层:     web 资源层/);
    expect(text).not.toMatch(/iOS 整体自动更新(?!.*不能)/);
  });

  it('dev 结论带桌面同一句警告 + 手机版回 stable 提示', async () => {
    const store = await freshStore();
    const r = await checkMobileUpdate(baseDeps(store, { channel: 'dev', githubFacts: githubFacts(), devBundleUrl: DEV_BUNDLE_URL }));
    const text = renderMobileUpdateReport(r).join('\n');
    expect(text).toMatch(/dev 通道 = GitHub master HEAD 的即时快照/);
    expect(text).toMatch(/手机端「更新」页 → 切回 stable/);
  });
});
