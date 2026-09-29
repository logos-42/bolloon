#!/usr/bin/env node
/**
 * verify-release.mjs — 发布后硬门 (Phase 8, 2026-09-19)
 *
 * 为什么需要: 「npm publish 退出码 0」和「用户真的能装到、且装到的就是这个版本」是两件事。
 * 本仓已经真踩过: 2FA-bypass 粒度 token 的 publish 只**暂存 (staged)**, 退出码 0、日志打
 * `+ pkg@ver`, 但版本不公开 (直连 404, dist-tags.latest 仍是旧值)。
 * 「已发布」和「用户可安装」必须分开验证 —— 这个脚本就是把它们分开。
 *
 * 用法:
 *   node scripts/verify-release.mjs                  # 用 package.json 的版本
 *   node scripts/verify-release.mjs 0.4.28           # 指定版本
 *   node scripts/verify-release.mjs 0.4.28 --install-check   # 额外做真实全局安装验证 (慢)
 *   node scripts/verify-release.mjs --json
 *
 * 退出码: 0 全过 / 1 有硬门失败。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PKG = '@bolloon/bolloon-agent';
const REGISTRY = process.env.BOLLOON_NPM_REGISTRY || 'https://registry.npmjs.org';

const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const installCheck = argv.includes('--install-check');
const versionArg = argv.find((a) => !a.startsWith('-'));

const results = [];
function check(id, label, ok, detail, hard = true) {
  results.push({ id, label, ok: !!ok, detail, hard });
  return !!ok;
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json' }, timeout: 20000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if ((res.statusCode || 0) >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('无法解析 registry 响应')); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function headTarball(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: 20000 }, (res) => {
      resolve({ status: res.statusCode || 0, length: Number(res.headers['content-length'] || 0) });
    });
    req.on('error', (e) => resolve({ status: 0, length: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, length: 0, error: 'timeout' }); });
    req.end();
  });
}

/** 从可能夹着别的话的 stdout 里切出 JSON —— 「第一个 { 到最后一个 }」, 不按行首猜。 */
function sliceJson(out) {
  const a = out.indexOf('{');
  const b = out.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no json object in output');
  return out.slice(a, b + 1);
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = (versionArg || pkg.version || '').replace(/^v/, '');

  // 1. 版本号自洽
  check('pkg_version', 'package.json 版本与目标一致', pkg.version === version, `package.json=${pkg.version} 目标=${version}`);

  // 2. Git tag / commit
  let gitCommit = null;
  try {
    gitCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { /* 无 git */ }
  let tagCommit = null;
  try {
    // 2026-09-19 修: `^{commit}` 必须和 ref 拼成**同一个参数**。分开传时 git 把 `^{commit}` 当成
    //   独立 revision → 报 unknown revision → 这里 catch 掉, 于是**有 tag 也报"没有 tag"** (假阴性,
    //   v0.4.20 等老 tag 同样会被误报)。annotated tag 需要 `^{commit}` 解引用才能拿到提交号。
    const ref = `v${version}^{commit}`;
    tagCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=7', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { tagCommit = null; }
  if (tagCommit) {
    check('git_tag', `Git tag v${version} 与方法一致`, tagCommit === gitCommit, `tag=${tagCommit} HEAD=${gitCommit}`, false);
  } else {
    check('git_tag', `Git tag v${version}`, false, `没有 v${version} tag (有 tag 才能把 npm 版本和 git 提交对上)`, false);
  }
  let dirty = false;
  try { dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0; } catch { /* 忽略 */ }
  check('git_clean', '工作区干净 (发布的是已提交的代码)', !dirty, dirty ? '工作区有未提交改动' : 'clean', false);

  // 3. registry: 版本存在 + 是否公开为 latest
  let doc = null;
  try {
    doc = await httpGetJson(`${REGISTRY}/${PKG.replace('/', '%2F')}`);
  } catch (e) {
    check('registry', 'registry 可访问', false, e.message);
    return finish(version);
  }
  const versions = Object.keys(doc.versions || {});
  const published = versions.includes(version);
  check('published', `registry 上存在 ${version}`, published, published ? `共 ${versions.length} 个版本` : `registry 上找不到 ${version} (可能仍在暂存/未公开)`, true);
  if (!published) return finish(version);

  const latest = (doc['dist-tags'] || {}).latest;
  check('dist_tag_latest', `dist-tags.latest == ${version}`, latest === version,
    latest === version ? `latest=${latest}` : `latest 仍是 ${latest} → 版本已上传但**未公开为 latest** (staged?), 用户 npm i 拿到的是 ${latest}`, true);

  const dist = doc.versions[version].dist || {};
  check('shasum', 'registry 报出 shasum/integrity', !!(dist.shasum || dist.integrity), `shasum=${dist.shasum || '-'} integrity=${(dist.integrity || '-').slice(0, 24)}`, false);

  // 4. tarball 真的能下载
  const tarUrl = dist.tarball;
  let tarballOk = false;
  let tmpDir = null;
  if (tarUrl) {
    const head = await headTarball(tarUrl);
    tarballOk = check('tarball_head', 'tarball 可下载 (HTTP 200)', head.status === 200,
      head.status === 200
        ? (head.length > 0 ? `${(head.length / 1024 / 1024).toFixed(2)} MiB` : '大小未由 HEAD 返回 (registry 走 CDN 重定向, 不编造数字)')
        : `HTTP ${head.status} ${head.error || ''}`, true);
    if (tarballOk) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-release-'));
      tmpCleanup = tmpDir;
      const dl = spawnSync('curl', ['-fsSL', tarUrl, '-o', path.join(tmpDir, 'pkg.tgz')], { encoding: 'utf8', timeout: 300000 });
      if (dl.status === 0) {
        try {
          const inner = spawnSync('tar', ['-xzOf', path.join(tmpDir, 'pkg.tgz'), 'package/package.json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
          const innerPkg = JSON.parse(inner.stdout);
          check('tarball_version', 'tarball 内 package.json 版本一致', innerPkg.version === version, `tarball=${innerPkg.version}`, true);
          const listing = spawnSync('tar', ['-tzf', path.join(tmpDir, 'pkg.tgz')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
          const hasEntry = String(listing.stdout).split('\n').includes('package/dist/cli-entry.js');
          check('tarball_entry', 'tarball 含 dist/cli-entry.js', hasEntry, hasEntry ? 'ok' : '入口缺失 → 装上不可用', true);
        } catch (e) {
          check('tarball_content', 'tarball 内容可解析', false, e.message);
        }
      } else {
        check('tarball_download', 'tarball 可下载 (curl)', false, String(dl.stderr || '').slice(0, 200));
      }
    }
  } else {
    check('tarball_head', 'registry 给出 tarball 地址', false, 'missing dist.tarball');
  }

  // 5. 真实安装验证 (可选, 慢但最硬)
  if (installCheck && tmpDir) {
    const prefix = path.join(tmpDir, 'install');
    fs.mkdirSync(prefix, { recursive: true });
    const ins = spawnSync('npm', ['install', '-g', '--prefix', prefix, `${PKG}@${version}`, '--no-fund', '--no-audit', '--loglevel=error'],
      { encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024 });
    if (ins.status !== 0) {
      check('install', 'npm install -g 真实安装成功', false, String(ins.stderr || ins.stdout || '').slice(0, 300));
    } else {
      check('install', 'npm install -g 真实安装成功', true, prefix);
      const entry = path.join(prefix, 'lib', 'node_modules', '@bolloon', 'bolloon-agent', 'dist', 'cli-entry.js');
      const v = spawnSync(process.execPath, [entry, '--version', 'json'], { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
      // 2026-09-19 修: 原写法按"行首是 {"过滤, 而 --version json 是**多行 pretty JSON** ——
      //   只有第一行 `{` 活下来 → JSON.parse('{') 必失败 → 门报"装完后 --version json 解析失败"。
      //   这是**门自己的假阴性** (同一类坑早先在 update-manager 出现过一次), 现在统一按
      //   "第一个 { 到最后一个 }" 切片解析。
      let parsed = null;
      try { parsed = JSON.parse(sliceJson(String(v.stdout))); } catch { parsed = null; }
      check('install_version', '装完后 bolloon --version json 可解析且版本一致', parsed?.packageVersion === version,
        parsed ? `packageVersion=${parsed.packageVersion} installMethod=${parsed.installMethod}` : `解析失败: ${String(v.stdout).slice(0, 160)}`, true);
      const human = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', timeout: 180000 });
      check('install_human', '普通版 --version 输出可用 (含安装方式/目录/通道/上游)',
        /安装方式/.test(human.stdout) && /安装目录/.test(human.stdout) && /更新通道/.test(human.stdout) && /上游提交/.test(human.stdout),
        String(human.stdout).split('\n').slice(0, 3).join(' | '), true);
      const plan = spawnSync(process.execPath, [entry, 'update', '--dry-run', 'json'], { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
      let planJson = null;
      try { planJson = JSON.parse(sliceJson(String(plan.stdout))); } catch { planJson = null; }
      check('update_plan', 'bolloon update --dry-run 结果结构正确 (旧 update plan 的只读位)', !!planJson && Array.isArray(planJson.risk) && Array.isArray(planJson.willNotTouch),
        planJson ? `target=${planJson.targetVersion} blockers=${planJson.blockers.length}` : '无法解析 plan JSON', true);
    }
  }

  return finish(version);
}

function finish(version) {
  if (tmpCleanup) { try { fs.rmSync(tmpCleanup, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  const hardFails = results.filter((r) => r.hard && !r.ok);
  const softFails = results.filter((r) => !r.hard && !r.ok);
  if (wantJson) {
    console.log(JSON.stringify({ version, ok: hardFails.length === 0, results }, null, 2));
  } else {
    console.log(`\n发布校验: ${PKG}@${version}\n`);
    for (const r of results) {
      const mark = r.ok ? '✅' : (r.hard ? '❌' : '⚠️ ');
      console.log(`${mark} ${r.label}: ${r.detail}`);
    }
    console.log('');
    if (hardFails.length === 0) {
      console.log(softFails.length ? `结论: 硬门全过 (${softFails.length} 项提醒)` : '结论: 发布可信 —— 版本可下载、可安装、版本号自洽。');
    } else {
      console.log(`结论: 发布**未完成** —— ${hardFails.length} 项硬门失败:`);
      for (const r of hardFails) console.log(`  - ${r.label}: ${r.detail}`);
      console.log('\n注意: 「npm publish 退出码 0」不等于「已发布」。暂存 (staged) 版本会等放行后才公开;');
      console.log('      待放行期间不要轮换 token、不要改版本号重发 (同版本会得 E409)。');
    }
  }
  process.exit(hardFails.length === 0 ? 0 : 1);
}

let tmpCleanup = null;
main().catch((e) => {
  console.error('发布校验执行失败:', e?.message || e);
  process.exit(1);
});
