#!/usr/bin/env node
/**
 * gh-release.mjs — 发版第二步: 建 GitHub Release, 与 npm 版本 / git tag **同名同步**
 *
 * 为什么需要: 本仓历史是「只打 tag 不发 Release」—— 仓库里 tag 二十多个, GitHub Release 0 个,
 * 于是「发过什么、改了什么」在外人看来只能在 npm 上查版本号。本脚本把 GitHub Release 拉到与
 * npm / tag **同一命名**: Release 名 = tag 名 = `v<package.json 的 version>`, 三者逐字一致。
 *
 * notes 从哪来 (一个字都不编):
 *   `docs/release-notes/v<版本>.md` 是 notes 真源 (人工从 git log / wiki 归纳, 见同目录 TEMPLATE);
 *   最后一节「可核验信息 / 提交列表」由本脚本**现取现算**覆盖生成:
 *     - npm registry: `dist.shasum` · SRI · 文件数 · 解包大小 · tarball 字节数 (真 HEAD/真下载重算)
 *     - git: `git log <上一个 tag>..v<版本> --oneline`
 *   手抄数字会过期, 现取的不会 —— 所以这两节禁止手写。
 *
 * 与 scripts/verify-release.mjs 的分工 (同一处点名, 不要各查各的):
 *   verify-release.mjs = **发布后硬门**, 管「npm 那一侧可不可信」(真公开 / 同名 tag / 真装得上);
 *   gh-release.mjs     = **发版第二步**, 管「GitHub 那一侧有没有、名字对不对、notes 是不是真材料」。
 *   顺序: npm publish → `verify-release.mjs <版本> --install-check` → `gh-release.mjs` → `gh release view` 复核。
 *
 * 用法:
 *   node scripts/gh-release.mjs --dry-run                    # 只生成 notes 并打印, 不建 Release
 *   node scripts/gh-release.mjs                              # 用 package.json 版本建 Release (标记 latest)
 *   node scripts/gh-release.mjs --draft                      # 建草稿 (草稿不标记 latest)
 *   node scripts/gh-release.mjs --version 0.5.0 --backfill --no-latest   # 回填历史版本 (不抢 latest)
 *   node scripts/gh-release.mjs --verify-tarball             # 额外真下载 tarball 重算 SHA-1
 *   node scripts/gh-release.mjs --clobber --yes              # 已存在则覆盖 notes/title
 *   node scripts/gh-release.mjs --json                       # 机器可读摘要
 *
 * 幂等: 目标 Release 已存在时**默认不建也不改**, 打印现有 name/isLatest/url 后退出 0;
 *       要覆盖必须显式 `--clobber` (TTY 下再问一次, `--yes` 跳过提问)。
 * 退出码: 0 成功 (含幂等跳过) · 1 任一硬校验不过 (报原文) · 2 用法错。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PKG_NAME = '@bolloon/bolloon-agent';
const REPO = process.env.BOLLOON_GH_REPO || 'logos-42/bolloon';
const REGISTRY = process.env.BOLLOON_NPM_REGISTRY || 'https://registry.npmjs.org';
const NOTES_DIR = path.join(ROOT, 'docs', 'release-notes');
// 公开 Release 的机械兜底: 这两个字样一旦出现就连退, 免得把内部命名/私有锚点带上公开页。
// 判据在人 (见 RELEASE-NOTES-TEMPLATE.md), 这里只兜底。
const FORBIDDEN_LITERALS = ['her' + 'mes', 'private-anchors'];
// (上面第一条是拼起来的: 它在公开页上是禁词, 本文件里也没必要把它写出来 —— 脚本自己不该是被禁的字样的出处。)

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const DRY_RUN = flag('--dry-run');
const DRAFT = flag('--draft');
const CLOBBER = flag('--clobber');
const YES = flag('--yes');
const BACKFILL = flag('--backfill');
const STRICT = flag('--strict');
const AS_JSON = flag('--json');
const VERIFY_TARBALL = flag('--verify-tarball');
const NO_LATEST = flag('--no-latest');
const LATEST = !NO_LATEST && !DRAFT;
const NO_VERIFY_TAG = flag('--no-verify-tag');
// 提交列表默认**不搬到公开页**: 本仓是公开仓, 历史提交标题里真出现过内部锚点路径与课题引用
// (本脚本的禁止字样门在 `v0.4.30..v0.5.0` 区间真拦下过一条)。要点名「有问题去哪看」,
// 给区间就够 —— `git log <区间> --oneline` 谁都能自查, 不必把私有材料搬到公开 Release。
// 确实要带列表时用 --with-commit-list, 命中的行会被**显式标注略去** (不静默删)。
const WITH_COMMIT_LIST = flag('--with-commit-list');
const AT_REF = opt('--at') || 'HEAD';
const REPO_FLAG = opt('--repo') || REPO;
const NOTES_FILE_FLAG = opt('--notes-file');
const VERSION_FLAG = opt('--version');

const steps = [];
function step(label, ok, detail) {
  steps.push({ label, ok: ok === null ? 'warn' : !!ok, detail });
  const mark = ok === null ? '⚠️ ' : ok ? '✅' : '❌';
  if (!AS_JSON) console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok === true;
}
function die(msg, code = 1) {
  console.error(`\n❌ ${msg}`);
  if (AS_JSON) console.log(JSON.stringify({ ok: false, error: msg, steps }, null, 2));
  process.exit(code);
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    const text = (r.stderr || r.stdout || '').trim();
    const err = new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}\n${text}`);
    err.raw = text;
    err.status = r.status;
    throw err;
  }
  return (r.stdout || '').trim();
}
function shAllowFail(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// ---------- 1. 版本 → tag (唯一真源: package.json) ----------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const pkgVersion = pkg.version;
const version = VERSION_FLAG || pkgVersion;
const tag = `v${version}`;

if (!/^\d+\.\d+\.\d+$/.test(version)) die(`版本号不像 semver: ${version}`, 2);
if (VERSION_FLAG && VERSION_FLAG !== pkgVersion && !BACKFILL)
  die(
    `--version ${VERSION_FLAG} 与 package.json 的 ${pkgVersion} 不一致。` +
      `这是回填历史版本才需要的情形, 请显式加 --backfill (免得把版本发错)`, 2);
if (!BACKFILL && version !== pkgVersion) die(`版本不一致: ${version} != package.json ${pkgVersion}`, 1);

step('版本与 tag 命名', true, `package.json=${pkgVersion} → tag=${tag}${BACKFILL ? ' (回填模式)' : ''}`);

// ---------- 2. git 侧硬校验 ----------
let tagCommit = null;
try {
  sh('git', ['rev-parse', '--verify', `refs/tags/${tag}`]);
} catch (e) {
  die(`tag ${tag} 不存在 (本地)。发版必须先打 tag: git tag -a ${tag} -m "..."\n原文: ${e.raw}`);
}
try {
  const objType = sh('git', ['cat-file', '-t', tag]);
  if (objType !== 'tag')
    die(`tag ${tag} 是轻量 tag (对象类型 ${objType}) —— 发版要求 annotated tag: git tag -a ${tag} -m "..."`);
  step('tag 是 annotated', true, `对象类型 = tag`);
} catch (e) {
  if (e.raw === undefined) throw e;
  die(`读 tag 对象类型失败: ${e.raw}`);
}
tagCommit = sh('git', ['rev-parse', `${tag}^{commit}`]);
let atCommit = null;
try {
  atCommit = sh('git', ['rev-parse', `${AT_REF}^{commit}`]);
} catch (e) {
  die(`--at ${AT_REF} 解析不了: ${e.raw}`);
}
if (tagCommit !== atCommit) {
  const ahead = Number(sh('git', ['rev-list', '--count', `${tagCommit}..${atCommit}`]) || '0');
  const behind = Number(sh('git', ['rev-list', '--count', `${atCommit}..${tagCommit}`]) || '0');
  const detail = `tag ${tag} → ${tagCommit.slice(0, 7)} ≠ ${AT_REF} ${atCommit.slice(0, 7)} (HEAD 比 tag 多 ${ahead} 个提交)`;
  if (!BACKFILL)
    die(
      `tag 指向的不是 ${AT_REF} —— ${detail}\n` +
        `发版提交必须就是 tag 指向的那份源码。若确属「发布记录回写在 tag 之后」的历史回填, 用 --backfill。`);
  const dirty = behind > 0 ? ` (且 tag 比 ${AT_REF} 多 ${behind} 个提交 —— 更可疑)` : '';
  step('tag 与 HEAD 重合', null, `[回填模式放行, 仅告警] ${detail}${dirty}`);
} else {
  step(`tag 指向 ${AT_REF}`, true, `${tag} → ${tagCommit.slice(0, 7)}`);
}

const worktreeDirty = shAllowFail('git', ['status', '--porcelain']).stdout.length > 0;
if (worktreeDirty && !AS_JSON) console.log(`⚠️  工作区不干净 (Release 建在 tag 上, 与工作区无关; 只是提醒)`);

// ---------- 3. npm registry: 现取可核验数字 ----------
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { Accept: 'application/json' }, timeout: 20000 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) return reject(new Error(`GET ${url} → HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(d));
          } catch {
            reject(new Error(`GET ${url} → 响应不是 JSON`));
          }
        });
      })
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error(`GET ${url} 超时`));
      });
  });
}
function httpsHead(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', timeout: 20000 }, (res) => {
      resolve({ status: res.statusCode || 0, length: Number(res.headers['content-length'] || 0) });
    });
    req.on('error', reject).on('timeout', function () {
      this.destroy(new Error(`HEAD ${url} 超时`));
    });
    req.end();
  });
}
function httpsDownloadSha1(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 120000 }, (res) => {
        if ((res.statusCode || 0) >= 400) return reject(new Error(`GET ${url} → HTTP ${res.statusCode}`));
        const h = crypto.createHash('sha1');
        let bytes = 0;
        res.on('data', (c) => {
          h.update(c);
          bytes += c.length;
        });
        res.on('end', () => resolve({ sha1: h.digest('hex'), bytes }));
      })
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error(`GET ${url} 超时`));
      });
  });
}

const versionDocUrl = `${REGISTRY}/@bolloon%2F${PKG_NAME.split('/')[1]}/${version}`;
let dist;
try {
  const doc = await httpsGetJson(versionDocUrl);
  dist = doc.dist || {};
  if (!dist.shasum) die(`registry 里 ${PKG_NAME}@${version} 没有 dist.shasum (该版本可能没真公开): ${versionDocUrl}`);
  step('npm 版本存在且给得出 dist.shasum', true, `shasum=${dist.shasum} · tarball=${dist.tarball}`);
} catch (e) {
  die(
    `npm registry 查不到 ${PKG_NAME}@${version} —— 先 npm publish 并用 scripts/verify-release.mjs ${version} 过发布后硬门。\n原文: ${e.message}`,
  );
}

let latestTag = 'unknown';
try {
  const packument = await httpsGetJson(`${REGISTRY}/@bolloon%2F${PKG_NAME.split('/')[1]}`);
  latestTag = (packument['dist-tags'] || {}).latest || 'unknown';
} catch (e) {
  if (!AS_JSON) console.log(`⚠️  读 dist-tags 失败 (不阻塞): ${e.message}`);
}
if (latestTag === version) {
  step('npm dist-tags.latest', true, `latest = ${version} (= 本版本)`);
} else {
  const note = `latest = ${latestTag} ≠ ${version}`;
  if (STRICT && !BACKFILL) die(`本版本不是 npm latest (${note}) —— 若非回填, 先把 npm 那一侧发出去`);
  step('npm dist-tags.latest', false, `[不阻塞] ${note}${BACKFILL ? ' (回填旧版本属正常)' : ''}`);
}

// tarball 字节数 (真 HEAD) + 可选真下载重算 SHA-1
let tarballBytes = 0;
try {
  const head = await httpsHead(dist.tarball);
  if (head.status < 400) tarballBytes = head.length;
} catch (e) {
  if (!AS_JSON) console.log(`⚠️  读 tarball Content-Length 失败 (不阻塞): ${e.message}`);
}
let recomputed = null;
if (VERIFY_TARBALL) {
  try {
    recomputed = await httpsDownloadSha1(dist.tarball);
    if (recomputed.sha1 !== dist.shasum)
      die(`tarball 本地 SHA-1 (${recomputed.sha1}) ≠ packument dist.shasum (${dist.shasum}) —— 包里内容与登记不符, 停`);
    step('tarball 真下载 + 本地重算 SHA-1 逐字相同', true, `${recomputed.bytes} 字节 · ${recomputed.sha1}`);
  } catch (e) {
    die(`--verify-tarball 失败: ${e.message}`);
  }
}

// ---------- 4. notes: 真材料 + 现取节 ----------
const notesPath = NOTES_FILE_FLAG ? path.resolve(ROOT, NOTES_FILE_FLAG) : path.join(NOTES_DIR, `${tag}.md`);
if (!fs.existsSync(notesPath))
  die(
    `notes 真源不存在: ${path.relative(ROOT, notesPath)}\n` +
      `本脚本不编内容 —— 先照 docs/release-notes/RELEASE-NOTES-TEMPLATE.md 写一份 (从 git log / wiki 归纳)。`,
  );
let body = fs.readFileSync(notesPath, 'utf8');
// 去掉手写的「可核验信息 / 提交列表」占位, 这两节一律重新生成
for (const head of ['## 可核验信息', '## 提交列表']) {
  const i = body.search(new RegExp(`^${head}\\s*$`, 'm'));
  if (i >= 0) body = body.slice(0, i);
}
body = body.replace(/\n{3,}/g, '\n\n').trimEnd();

// 上一个版本 tag (用于提交列表区间)
function parseVer(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const allTags = sh('git', ['tag', '--list', 'v*']).split('\n').filter(Boolean);
const target = parseVer(version);
// 上一个版本 tag = 严格小于本版本的最大 vX.Y.Z
const prevTag = allTags
  .filter((t) => parseVer(t) && t !== tag)
  .filter((t) => {
    const a = parseVer(t);
    return a[0] < target[0] || (a[0] === target[0] && (a[1] < target[1] || (a[1] === target[1] && a[2] < target[2])));
  })
  .sort((a, b) => {
    const x = parseVer(a);
    const y = parseVer(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  })
  .pop() || null;

let commitList = null;
if (prevTag) {
  const range = `${prevTag}..${tag}`;
  const oneline = sh('git', ['log', range, '--oneline']).split('\n').filter(Boolean);
  commitList = { range, oneline };
}

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z';
const num = (n) => Number(n || 0).toLocaleString('en-US');
const generatedVerify = [
  '## 可核验信息',
  '',
  `> 本节由 \`scripts/gh-release.mjs\` 于 ${stamp} **从 npm registry 现取**生成 (非手抄, 手抄会过期)。`,
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  `| npm 包 | \`${PKG_NAME}@${version}\` |`,
  `| tarball | ${dist.tarball} |`,
  `| shasum (SHA-1) | \`${dist.shasum}\`${recomputed ? ' (本地真下载重算, 逐字相同)' : ' (packument `dist.shasum`; 本地未重算)'} |`,
  `| tarball 字节数 | ${tarballBytes ? num(tarballBytes) : '未知 (HEAD 未取到)'}${recomputed ? ` · 真下载 ${num(recomputed.bytes)} 字节` : ''} |`,
  `| 解包大小 / 文件数 | ${dist.unpackedSize ? num(dist.unpackedSize) + ' 字节' : '未知'} / ${dist.fileCount || '未知'} |`,
  `| integrity (SRI) | \`${dist.integrity || '未知'}\` |`,
  `| npm dist-tags.latest | \`${latestTag}\`${latestTag === version ? ' (= 本版本)' : ` (本版本 ${version}, 非 latest)`} |`,
  `| git tag | \`${tag}\` (annotated) → commit \`${tagCommit.slice(0, 7)}\` |`,
  `| 发布后硬门 (npm 那一侧) | \`node scripts/verify-release.mjs ${version} --install-check\` |`,
  '',
  '自己复算 (两行应输出同一个 shasum):',
  '',
  '```bash',
  `npm view ${PKG_NAME}@${version} dist.shasum`,
  `curl -sL ${dist.tarball} | shasum | cut -d' ' -f1`,
  '```',
].join('\n');

const redacted = [];
const commitLines = commitList
  ? commitList.oneline.map((line) => {
      const hit = FORBIDDEN_LITERALS.find((lit) => line.toLowerCase().includes(lit));
      if (!hit) return line;
      redacted.push(line.slice(0, 9));
      return `${line.slice(0, 7)} (略去 —— 标题含内部锚点/课题引用, 公开页不搬运; 原文在仓内 git log)`;
    })
  : [];

const generatedCommits = !commitList
  ? ['', '## 提交列表', '', `> 未找到比 ${tag} 更早的版本 tag ⇒ 无法给出区间。`].join('\n')
  : WITH_COMMIT_LIST
    ? [
        '',
        '## 提交列表',
        '',
        `> 现取 \`git log ${commitList.range} --oneline\`, 共 **${commitList.oneline.length}** 个提交` +
          (redacted.length ? ` (其中 ${redacted.length} 条标题含内部锚点/课题引用, 已显式标注略去)` : '') +
          ' —— 上面每条亮点/修复都能在这里找到出处。',
        '',
        `<details><summary>展开 ${commitList.oneline.length} 个提交</summary>`,
        '',
        '```text',
        ...commitLines,
        '```',
        '',
        '</details>',
      ].join('\n')
    : [
        '',
        '## 提交列表',
        '',
        `> 本版区间 \`${commitList.range}\`, 共 **${commitList.oneline.length}** 个提交 —— 明细请在仓库里自查:`,
        '',
        '```bash',
        `git log ${commitList.range} --oneline`,
        '```',
        '',
        '> (列表不默认贴到 Release: 本仓是公开仓, 历史提交标题里可能带内部锚点/课题引用, 不往公开页搬。)',
      ].join('\n');

const finalBody = `${body}\n\n${generatedVerify}\n${generatedCommits}\n`;

for (const lit of FORBIDDEN_LITERALS) {
  const hits = finalBody.split('\n').filter((l) => l.toLowerCase().includes(lit));
  if (hits.length)
    die(
      `notes 里出现禁止字样 \`${lit}\` (${hits.length} 行) —— 公开 Release 不许带内部命名/私有锚点:\n` +
        hits.map((h) => `  ${h.slice(0, 160)}`).join('\n'),
    );
}
step('notes 生成', true, `${path.relative(ROOT, notesPath)} + 现取节 · ${finalBody.split('\n').length} 行`);

// ---------- 5. 幂等: 目标 Release 是否已存在 ----------
const gh = (args, opts = {}) => shAllowFail('gh', args, opts);
// gh 2.87.3 的 `release view --json` 里**没有** isLatest (它是 `release list` 的字段) —— 真踩过:
// 用了它回读会以 `Unknown JSON field: "isLatest"` 退出 1。latest 状态只从 list 取。
const VIEW_FIELDS = 'name,isDraft,url,body,createdAt,tagName,targetCommitish';
function latestFlagFor(tagName) {
  const r = gh(['release', 'list', '-R', REPO_FLAG, '-L', '100', '--json', 'tagName,isLatest,isDraft']);
  if (r.status !== 0) return { ok: false, detail: (r.stderr || '').trim() };
  try {
    const rows = JSON.parse(r.stdout);
    const hit = rows.find((x) => x.tagName === tagName);
    return hit ? { ok: true, isLatest: hit.isLatest, isDraft: hit.isDraft } : { ok: true, isLatest: null };
  } catch (e) {
    return { ok: false, detail: `解析 release list 失败: ${e.message}` };
  }
}
const viewExisting = gh(['release', 'view', tag, '-R', REPO_FLAG, '--json', VIEW_FIELDS]);
const exists = viewExisting.status === 0;
let existing = null;
if (exists) {
  try {
    existing = JSON.parse(viewExisting.stdout);
  } catch {
    existing = { name: '?' };
  }
  const lf = latestFlagFor(tag);
  existing.isLatest = lf.ok ? lf.isLatest : `未知 (${lf.detail})`;
  step(
    '目标 Release 已存在 (幂等判定)',
    true,
    `name=${existing.name} · isLatest=${existing.isLatest} · url=${existing.url} · ${existing.createdAt || ''}`,
  );
  if (STRICT && existing.name !== tag) die(`已存在的 Release 名字是 ${existing.name}, 期望 ${tag} —— 命名没同步`);
}

if (AS_JSON && DRY_RUN) {
  console.log(JSON.stringify({ ok: true, dryRun: true, version, tag, tagCommit, latest: LATEST, draft: DRAFT, exists, steps, notes: finalBody }, null, 2));
  process.exit(0);
}

// ---------- 6. notes 落临时文件 → gh release create / edit ----------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-gh-release-'));
const tmpNotes = path.join(tmpDir, `notes-${tag}.md`);
fs.writeFileSync(tmpNotes, finalBody, 'utf8');

if (DRY_RUN) {
  console.log('\n---------- notes (dry-run, 未建 Release) ----------\n');
  console.log(finalBody);
  console.log(`\n(shell 里会执行: gh release create ${tag} -R ${REPO_FLAG} --title ${tag}` +
    `${LATEST ? ' --latest' : ' --latest=false'}${DRAFT ? ' --draft' : ''}${NO_VERIFY_TAG ? '' : ' --verify-tag'} --notes-file <临时文件>)`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
}

if (exists && !CLOBBER) {
  console.log(
    `\nℹ️  ${tag} 的 Release 已存在 —— 默认**不建也不改** (幂等)。` +
      `\n    现有: ${existing.url}\n    要覆盖 notes/title 请显式加 --clobber (会先提示)。`,
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n结果: 幂等跳过 (未对 GitHub 做任何写操作)');
  process.exit(0);
}

if (exists && CLOBBER) {
  const bodyChanged = (existing.body || '').trim() !== finalBody.trim();
  console.log(
    `\n⚠️  --clobber: 将**覆盖** ${tag} 现有 Release 的 title/notes。` +
      `\n    现有 title: ${existing.name}\n    notes ${bodyChanged ? '与本轮生成的内容**不同**, 覆盖后旧正文丢失' : '与本轮生成一致 (覆盖等于无变化)'}`,
  );
  if (!YES && process.stdin.isTTY) {
    process.stdout.write('    继续? 输入 yes 回车: ');
    const answer = await new Promise((res) => {
      process.stdin.once('data', (d) => res(String(d).trim()));
    });
    if (answer !== 'yes') die('用户未确认, 已中止 (未做任何写操作)', 2);
  } else if (!YES) {
    die('--clobber 需要确认: 非交互环境请加 --yes', 2);
  }
}

const args = exists
  ? ['release', 'edit', tag, '-R', REPO_FLAG, '--title', tag, '--notes-file', tmpNotes]
  : [
      'release', 'create', tag, '-R', REPO_FLAG,
      '--title', tag,
      '--notes-file', tmpNotes,
      ...(DRAFT ? ['--draft'] : []),
      ...(DRAFT ? ['--latest=false'] : [LATEST ? '--latest' : '--latest=false']),
      ...(NO_VERIFY_TAG ? [] : ['--verify-tag']),
    ];
if (exists) {
  if (DRAFT) args.push('--draft');
  args.push(LATEST && !DRAFT ? '--latest' : '--latest=false');
}
if (!AS_JSON) console.log(`\n$ gh ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);

const run = gh(args, { stdio: ['ignore', 'pipe', 'pipe'] });
if (run.status !== 0)
  die(
    `gh release ${exists ? 'edit' : 'create'} 失败 (退出码 ${run.status}) —— 原文:\n` +
      `${(run.stderr || run.stdout || '(无输出)').trim()}`,
  );
const ghOut = run.stdout.trim();
if (ghOut && !AS_JSON) console.log(ghOut);

// ---------- 7. 回读复核 (写外部系统后必须读回来) ----------
const after = gh(['release', 'view', tag, '-R', REPO_FLAG, '--json', `${VIEW_FIELDS},body`]);
if (after.status !== 0)
  die(`Release 写完了但回读失败 (gh release view ${tag} 退出码 ${after.status}): ${(after.stderr || '').trim()}`);
const final = JSON.parse(after.stdout);
final.isLatest = latestFlagFor(tag).isLatest;
let ok = true;
if (final.name !== tag) {
  ok = false;
  step('回读: Release 名 == tag 名', false, `name=${final.name} ≠ ${tag}`);
} else {
  step('回读: Release 名 == tag 名', true, `name=${final.name}`);
}
if (DRAFT) {
  step('回读: draft 状态', final.isDraft === true, `isDraft=${final.isDraft}`);
} else {
  step('回读: latest 标记', final.isLatest === LATEST, `isLatest=${final.isLatest} (期望 ${LATEST})`);
}
step('回读: 正文非空', ok && (final.body || '').length > 200, `body ${(final.body || '').length} 字符`);
step('回读: url', true, final.url);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (AS_JSON) console.log(JSON.stringify({ ok, version, tag, tagCommit, url: final.url, isLatest: final.isLatest, isDraft: final.isDraft, steps }, null, 2));
console.log(`\n结果: ${ok ? 'OK' : '有软项未达期望 (见上)'} · ${final.url}`);
process.exit(ok ? 0 : 1);
