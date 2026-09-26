/**
 * build-mobile-web-bundle.ts — 给手机端打一个 **web 资源层** 的 dev 快照包 (2026-09-26, update-protocol §13)
 *
 * 为什么需要它: 手机端 dev 通道要比 `<版本>+dev.<master sha7>`, 但 **GitHub master 的源码快照里没有
 * `dist/web`** (构建产物不入 git), 而手机端不做现场构建。所以 dev 那一跳必须由桌面导出、手机消费。
 *
 * 产出的包 = `dist/web/**` + `.bolloon-dev-snapshot.json`(channel/ref/sha/identity/bundleSha256)。
 * 手机端装之前会核对: 包内 sha == GitHub master HEAD, 且 sha256(tarball) == bundleSha256 —— 对不上就拒。
 *
 * stable 通道**不需要**这个包: 手机端直接下 npm registry 上的 tarball 并按 dist.shasum 校验
 * (复用现有发布产物, 不新造一种分发格式)。
 *
 * 用法:
 *   npx tsx scripts/build-mobile-web-bundle.ts                      # dev, sha = 本地 HEAD (会与 GitHub master 核对)
 *   npx tsx scripts/build-mobile-web-bundle.ts --channel stable      # 打 stable 包 (仅供自测; 正式走 npm)
 *   npx tsx scripts/build-mobile-web-bundle.ts --allow-stale-sha     # 本地 HEAD ≠ master 时也允许 (会大声警告)
 *   npx tsx scripts/build-mobile-web-bundle.ts --no-build            # 不用重编 dist/web
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { devIdentity, baseVersionOf } from '../src/utils/version-identity.js';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string, d: string | null = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const channel = (val('--channel', 'dev') || 'dev').toLowerCase();
if (channel !== 'dev' && channel !== 'stable') {
  console.error(`✗ 未知通道 "${channel}" (只有 stable / dev)`);
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version);
const pkgName = String(pkg.name);

function sh(cmd: string, cmdArgs: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, out: String(r.stdout || '').trim() || String(r.stderr || '').trim() };
}

// ── 1. dist/web 就绪 ───────────────────────────────────────────────────────
const webDir = path.join(ROOT, 'dist', 'web');
if (!fs.existsSync(path.join(webDir, 'mobile.html'))) {
  console.log('· dist/web 不完整 — 先跑 npm run build:web');
  const r = sh('npm', ['run', 'build:web']);
  if (!r.ok) { console.error(`✗ build:web 失败: ${r.out}`); process.exit(1); }
}
if (!has('--no-build')) {
  console.log('· 重新编译 web 资源 (npm run build:web)');
  const r = sh('npm', ['run', 'build:web']);
  if (!r.ok) { console.error(`✗ build:web 失败: ${r.out}`); process.exit(1); }
}

// ── 2. 身份 = <版本> 或 <版本>+dev.<sha7> ──────────────────────────────────
let sha = (val('--sha') || '').trim();
if (!sha) {
  const g = sh('git', ['rev-parse', 'HEAD']);
  if (g.ok) sha = g.out.split(/\s/)[0];
}
if (channel === 'dev') {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    console.error(`✗ dev 通道需要一个 40 位 commit sha (拿到 "${sha}") — 用 --sha <sha> 指定`);
    process.exit(2);
  }
  // 与 GitHub master HEAD 核对: 手机端会按这个 sha 判断"是不是最新"
  const t0 = Date.now();
  const res = await fetch('https://api.github.com/repos/logos-42/bolloon/commits/master', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bolloon-mobile-web-bundle' },
  }).catch(() => null);
  const head = res && res.ok ? String((await res.json()).sha || '') : null;
  if (!head) {
    console.log(`! GitHub 源不可达 (${Date.now() - t0}ms) — 无法核对 sha 是不是 master HEAD (手机端检查时会再次核对并可能拒绝)`);
  } else if (head !== sha && !has('--allow-stale-sha')) {
    console.error(`✗ 本地 sha ${sha.slice(0, 7)} ≠ GitHub master HEAD ${head.slice(0, 7)}`);
    console.error('  这样打出来的包手机端会判 dev_sha_mismatch 而拒绝安装 (这是设计如此)。');
    console.error('  先同步 master, 或明确用 --sha ' + head.slice(0, 7) + ' / --allow-stale-sha (仅供本地调试)。');
    process.exit(2);
  } else if (head === sha) {
    console.log(`✓ sha 与 GitHub master HEAD 一致 (${sha.slice(0, 7)})`);
  } else {
    console.log(`! --allow-stale-sha: 本地 ${sha.slice(0, 7)} ≠ master ${head.slice(0, 7)} — 这个包会被手机端拒绝, 仅供调试`);
  }
}

const identity = channel === 'dev' ? devIdentity(baseVersionOf(version), sha) : version;

// ── 3. 组装 tar.gz: dist/web/** + (dev) .bolloon-dev-snapshot.json ──────────
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-web-bundle-'));
const stageWeb = path.join(stage, 'dist', 'web');
fs.mkdirSync(path.dirname(stageWeb), { recursive: true });
// 只带 web 资源那一层需要的文件 (与手机端 MOBILE_WEB_REQUIRED_FILES 对齐; 目录整体拷)
fs.cpSync(webDir, stageWeb, { recursive: true });
const fileCount = (function count(dir: string): number {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) =>
    n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
})(stageWeb);

// 包内的构建戳必须描述**这个包自己的身份** —— 否则 dev 包会带着 build:web 写的 "stable/0.5.0"
// 出厂, 手机端装完读戳会得到错的身份 (真跑抓到过的坑)。
fs.writeFileSync(path.join(stageWeb, 'bolloon-web.json'), JSON.stringify({
  schema: 'bolloon-mobile-web/1',
  version: identity,
  channel,
  commit: channel === 'dev' ? sha : null,
  layer: 'web',
  builtAt: new Date().toISOString(),
  note: 'web 资源层构建戳 (手机端 OTA 的身份第 ③ 级回退)',
}, null, 2) + '\n');

if (channel === 'dev') {
  fs.writeFileSync(path.join(stage, '.bolloon-dev-snapshot.json'), JSON.stringify({
    schema: 'bolloon-mobile-web-snapshot/1',
    channel: 'dev',
    ref: 'refs/heads/master',
    sha,
    identity,
    baseVersion: baseVersionOf(version),
    package: pkgName,
    builtAt: new Date().toISOString(),
    files: fileCount,
    // 自摘要**必须放在包外**: tar.gz 的 sha256 只有压完之后才知道, 写回包内会让摘要循环变化。
    // 所以这里留 null, 真值写在同名 `.sha256` 清单里 (手机端可用 BOLLOON_MOBILE_DEV_BUNDLE_SHA256 pin 住它)。
    bundleSha256: null,
  }, null, 2) + '\n');
}

const outDir = path.resolve(val('--out', path.join(ROOT, 'build', 'mobile-web')) || '');
fs.mkdirSync(outDir, { recursive: true });
// 文件名里放**完整 40 位 sha** (dev): 手机端 `BOLLOON_MOBILE_DEV_BUNDLE_URL` 的 `{sha}` 就是拿完整 sha 去替换的,
// 两边必须逐字对得上, 否则 404 (踩过: 文件名用 sha7 而模板替换用 full sha)。
const fileKey = channel === 'dev' ? sha : version;
const outName = `bolloon-web-${fileKey.replace(/[^A-Za-z0-9._+-]/g, '_')}.tar.gz`;
const outFile = path.join(outDir, outName);
const tar = spawnSync('tar', ['-czf', outFile, '-C', stage, ...fs.readdirSync(stage)], { encoding: 'utf8' });
if (tar.status !== 0) { console.error(`✗ tar 失败: ${tar.stderr}`); process.exit(1); }

const buf = fs.readFileSync(outFile);
const sha256 = createHash('sha256').update(buf).digest('hex');
fs.writeFileSync(outFile + '.sha256', `${sha256}  ${outName}\n`);
fs.writeFileSync(outFile + '.json', JSON.stringify({
  channel, identity, sha: channel === 'dev' ? sha : null, baseVersion: baseVersionOf(version),
  package: pkgName, file: outName, bytes: buf.length, fileCount,
  sha256, builtAt: new Date().toISOString(),
  install: channel === 'dev'
    ? '手机端「更新」页选 dev 通道 → 把这个 tar.gz 的 URL 配到 BOLLOON_MOBILE_DEV_BUNDLE_URL (模板含 {sha})'
    : 'stable 通道正式走 npm registry; 这个包仅供自测 (把 BOLLOON_MOBILE_WEB_BUNDLE_URL 指过来)',
}, null, 2) + '\n');

fs.rmSync(stage, { recursive: true, force: true });

console.log('');
console.log(`✓ ${outFile}`);
console.log(`  身份:      ${identity}`);
console.log(`  通道:      ${channel}${channel === 'dev' ? ` (ref=refs/heads/master, sha=${sha})` : ''}`);
console.log(`  大小:      ${(buf.length / 1048576).toFixed(2)} MiB · ${fileCount} 个文件`);
console.log(`  sha256:    ${sha256}`);
console.log(`  自检清单:  ${outFile.replace(/\.tar\.gz$/, '.tar.gz.json')}`);
if (channel === 'dev') {
  console.log('');
  console.log(`  手机端配置 (需要 HTTP 能取到这个文件的地址, 模板里必须有 {sha}):`);
  console.log(`    BOLLOON_MOBILE_DEV_BUNDLE_URL=https://<host>/<path>/bolloon-web-{sha}.tar.gz`);
  console.log(`    BOLLOON_MOBILE_DEV_BUNDLE_SHA256=${sha256}   # 可选但推荐: pin 住载荷摘要 (dev 通道固有缺口)`);
}
