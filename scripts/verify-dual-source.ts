/**
 * verify-dual-source.ts — 双源更新 (npm + GitHub) 的**真跑**验收 (2026-09-25, update-protocol §12)
 *
 * 与 `verify-update-system.ts` 的分工: 那个脚本验收"下载→替换→验证→回滚"这条**单源**主干 (受控 fake registry);
 * 本脚本验收**双源**这条新主干, 并且刻意用**真源**:
 *   · 真 npm registry (registry.npmjs.org) —— 真下载已发布的 0.5.0 当 "from"
 *   · 真 GitHub API (api.github.com) —— 真读 tags / releases / refs/heads/master
 *   · 真 codeload 下载 master 快照 + 真 `npm run build:main` + 真 `npm pack` + 真 `npm install -g`
 *   · 全程隔离在临时 HOME / 临时 npm prefix —— **不碰本机全局安装, 不碰 ~/.bolloon**
 *
 * 五项验收 (对应任务书):
 *   A. stable → dev (真)      B. dev → stable (真)      C. 一键回 stable (真)
 *   D. 假阳性: 源不可达 / 版本不存在 / 两源不一致 → **必须拒绝 + 说清分类** (绝不许静默装旧版)
 *   E. `update --status` 三种状态各真跑一次
 *
 * 用法: npx tsx scripts/verify-dual-source.ts      (需要网络; 约 2~4 分钟)
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import * as http from 'http';

import {
  checkForUpdate, applyUpdate, buildUpdatePlan, renderUpdatePlan, readUpdateStatus,
  checkExitCode, installedVersionOnDisk,
} from '../src/utils/update-manager.js';
import { readUpdateState, readUpdateHistory } from '../src/utils/update-state.js';
import { fetchGithubFacts, toGithubReport, renderGithubReportLine, prepareDevSnapshot } from '../src/utils/dual-source.js';
import { renderStatusReport, renderCheckResult } from '../src/cli/update-commands.js';
import type { InstallationInfo } from '../src/utils/version-info.js';

const PKG = '@bolloon/bolloon-agent';
const FROM_VERSION = '0.5.0';           // npm 上已发布的当 "from" 版本 (2026-09-25 从 0.4.33 前移到 0.5.0 —— 本脚本的 from 必须等于**当前 latest**, 否则 dev 身份前缀断言必红)
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let pass = 0; let fail = 0; let skipped = 0;
const failures: string[] = [];
function skip(name: string, why: string) { skipped++; console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${why}`); }
function assert(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}
function head(t: string) { console.log(`\n\x1b[1m${t}\x1b[0m`); }
function info(t: string) { console.log(`       ${t}`); }

function childInstallation(prefix: string): InstallationInfo {
  const root = path.join(prefix, 'lib', 'node_modules', '@bolloon', 'bolloon-agent');
  return {
    method: 'npm-global', packageRoot: root, installDir: root,
    binPath: path.join(prefix, 'bin', 'bolloon'), entryPath: path.join(root, 'dist', 'cli-entry.js'),
    writable: true, linked: false, linkTarget: null,
    updateSource: 'npm', autoUpdatable: true, reason: 'verify-dual-source 夹具: 临时 prefix 上的 npm-global',
  };
}

/** 真跑 npm (隔离 cache + 强制 --prefix 到临时 prefix, 绝不碰本机全局)。 */
function realNpm(prefix: string, home: string, registry?: string) {
  return (args: string[], cwd: string) => {
    const finalArgs = args[0] === 'install' ? [...args, '--prefix', prefix] : args;
    const r = spawnSync('npm', finalArgs, {
      cwd, encoding: 'utf8', timeout: 300_000,
      env: {
        ...process.env,
        npm_config_prefix: prefix,
        npm_config_cache: path.join(home, '.npm-cache'),
        ...(registry ? { npm_config_registry: registry } : {}),
      },
    });
    return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

/** 切换后的"验证可启动"这一步: 磁盘身份必须等于目标身份 (真读磁盘)。 */
function realVerify(expected: string) {
  return async (target: string) => target === expected;
}

// ════════════════════════════════════════════════════════════════════════════
// 子进程模式: 需要"进程级环境变量"的场景 (源地址在模块加载时读 → 必须新进程)
// ════════════════════════════════════════════════════════════════════════════

async function childMode(mode: string): Promise<void> {
  const home = process.env.VD_HOME as string;
  const prefix = process.env.VD_PREFIX as string;
  const inst = childInstallation(prefix);
  const emit = (o: unknown) => process.stdout.write('VD_JSON:' + JSON.stringify(o) + '\n');

  if (mode === 'check-dev-offline' || mode === 'check-stable-offline' || mode === 'check-mismatch') {
    const channel = mode === 'check-dev-offline' ? 'dev' : 'stable';
    const r = await checkForUpdate({ home, installation: inst, force: true, channel });
    emit({ status: r.status, reason: r.reason, exit: checkExitCode(r.status), latestVersion: r.latestVersion, github: r.github, crossCheck: r.crossCheck, rendered: renderCheckResult(r), installedChannel: r.installedChannel });
    return;
  }
  if (mode === 'apply-must-refuse') {
    let npmCalled = 0;
    const home2 = home;
    const r = await applyUpdate({
      home: home2, installation: inst, force: true, channel: process.env.VD_CHANNEL === 'stable' ? 'stable' : 'dev',
      runNpm: (args, cwd) => { npmCalled++; return realNpm(prefix, home2)(args, cwd); },
    });
    const onDisk = installedVersionOnDisk(inst.packageRoot);
    emit({ stage: r.stage, ok: r.ok, reason: r.reason, npmCalled, onDisk });
    return;
  }
  process.stderr.write(`未知子进程模式 ${mode}\n`);
  process.exit(3);
}

function runChild(mode: string, opts: { home: string; prefix: string; env?: Record<string, string>; channel?: string }) {
  const r = spawnSync('npx', ['tsx', new URL(import.meta.url).pathname, `--mode=${mode}`], {
    encoding: 'utf8', timeout: 600_000,
    env: {
      ...process.env, VD_MODE: mode, VD_HOME: opts.home, VD_PREFIX: opts.prefix,
      ...(opts.channel ? { VD_CHANNEL: opts.channel } : {}),
      ...(opts.env || {}),
    },
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('VD_JSON:'));
  if (!line) throw new Error(`子进程 ${mode} 没输出结果:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice('VD_JSON:'.length));
}

/**
 * 异步版子进程: **假源场景必须用它** —— spawnSync 会阻塞父进程事件循环,
 * 父进程里那个受控假服务器就永远答不上话 (真踩过一次: 表现为 "releases: timeout")。
 */
function runChildAsync(mode: string, opts: { home: string; prefix: string; env?: Record<string, string>; channel?: string }): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', new URL(import.meta.url).pathname, `--mode=${mode}`], {
      env: {
        ...process.env, VD_MODE: mode, VD_HOME: opts.home, VD_PREFIX: opts.prefix,
        ...(opts.channel ? { VD_CHANNEL: opts.channel } : {}),
        ...(opts.env || {}),
      },
    });
    let out = ''; let errt = '';
    child.stdout.on('data', (d: any) => { out += String(d); });
    child.stderr.on('data', (d: any) => { errt += String(d); });
    child.on('error', reject);
    child.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith('VD_JSON:'));
      if (!line) return reject(new Error(`子进程 ${mode} 没输出结果:\n${out}\n${errt}`));
      resolve(JSON.parse(line.slice('VD_JSON:'.length)));
    });
  });
}

/** 起一个受控假 GitHub API (只为了构造"两源不一致", 不碰真源)。 */
function startFakeGithub(tagName: string): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((req, res) => {
    const u = req.url || '';
    res.setHeader('content-type', 'application/json');
    if (u.includes('/releases')) res.end(JSON.stringify([{ tag_name: tagName, name: tagName }]));
    else if (u.includes('/tags')) res.end(JSON.stringify([{ name: tagName, commit: { sha: 'f'.repeat(40) } }]));
    else if (u.includes('/commits/')) res.end(JSON.stringify({ sha: 'f'.repeat(40) }));
    else if (u.includes('/git/ref/')) res.end(JSON.stringify({ ref: 'refs/heads/master', object: { sha: 'f'.repeat(40) } }));
    else res.end('[]');
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 主流程
// ════════════════════════════════════════════════════════════════════════════

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-dual-'));
  const home = path.join(work, 'home');
  const bolloonHome = path.join(home, '.bolloon');
  const prefix = path.join(work, 'prefix');
  fs.mkdirSync(bolloonHome, { recursive: true });
  fs.mkdirSync(prefix, { recursive: true });

  console.log('双源更新真跑验收 (真 npm + 真 GitHub + 真 codeload, 隔离 HOME/prefix, 不碰本机全局安装)');
  console.log(`工作目录: ${work}`);

  // ── 0. 先查事实 ────────────────────────────────────────────────────────────
  head('0. 事实核查: 这个仓到底有没有 git tag / GitHub Release');
  const ghRes = await fetchGithubFacts();
  const gh = toGithubReport(ghRes);
  info(renderGithubReportLine(gh));
  const facts = ghRes.ok ? ghRes.facts : null;
  const tags = facts?.tags.map((t) => t.name) || [];
  const releases = facts?.releases || [];
  info(`tags (${tags.length}): ${tags.slice(-6).join(', ') || '(无)'}`);
  info(`releases (${releases.length}): ${releases.join(', ') || '(无)'}`);
  assert('GitHub 源可达 (真 api.github.com)', gh.reachable === true, gh.reachable ? `HEAD ${gh.headSha?.slice(0, 7)}` : gh.detail);
  if (!gh.reachable) console.log('  ⚠️ GitHub 源当前不可用 (限流/网络) —— 下面的 dev 源相关项会 SKIP; 设 GITHUB_TOKEN 可把配额从 60/h 提到 5000/h');
  assert('master HEAD 可读 (dev 通道的唯一源)', !!gh.headSha, String(gh.headSha || '').slice(0, 7));

  // ── A. stable → dev (真) ──────────────────────────────────────────────────
  head('A. 真 stable → dev (真 GitHub master + 真构建 + 真 npm 替换)');
  const inst = childInstallation(prefix);
  const npm = realNpm(prefix, home);
  assert('预置: 真装 ' + FROM_VERSION + ' 到隔离 prefix', (() => {
    const r = npm(['install', '-g', `${PKG}@${FROM_VERSION}`, '--no-audit', '--no-fund', '--loglevel=error'], work);
    return r.code === 0;
  })(), `磁盘=${installedVersionOnDisk(inst.packageRoot)}`);
  const fromBase = installedVersionOnDisk(inst.packageRoot);
  assert(`from 版本 = ${FROM_VERSION}`, fromBase === FROM_VERSION, String(fromBase));

  // 事实只查一次, 之后进程内注入 (真值, 但不再重复打 GitHub —— 匿名配额只有 60 次/小时)
  const devCheck = await checkForUpdate({ home: bolloonHome, installation: inst, force: true, channel: 'dev', github: ghRes });
  info(`check(dev): status=${devCheck.status} target=${devCheck.latestVersion}`);
  assert('check(dev): 判"有 dev 快照可装" (update_available)', devCheck.status === 'update_available', devCheck.status);
  assert('check(dev): 比较语义 = git-ref (不用 semver)', devCheck.channelKind === 'git-ref', String(devCheck.channelKind));
  assert('check(dev): 目标是 <版本>+dev.<sha7> 身份', String(devCheck.latestVersion).includes('+dev.') && String(devCheck.latestVersion).startsWith(FROM_VERSION), String(devCheck.latestVersion));
  assert('check(dev): 当前装的是 stable (从磁盘身份读)', devCheck.installedChannel === 'stable', String(devCheck.installedChannel));
  assert('check(dev): 说清能切回 stable 且目标 = npm latest', devCheck.switchableTo?.channel === 'stable', JSON.stringify(devCheck.switchableTo));

  // 计划面: dev 必须带警告 + 一键回 stable
  const plan = await buildUpdatePlan({ home: bolloonHome, installation: inst, force: true, channel: 'dev', github: ghRes, workloadRiskOverride: [] });
  assert('plan(dev): 显式警告在场', plan.warnings.some((w) => w.includes('dev 通道')), plan.warnings.join(' | ').slice(0, 90));
  const planText = renderUpdatePlan(plan);
  assert('plan(dev): 打印里有一键回 stable', planText.includes('bolloon update now --channel stable'), '');

  // 真 dev 快照: 真 codeload 下载 + 真 npm run build:main + 真 npm pack
  // (唯一的捷径: 装依赖这步复用本仓 node_modules —— npm install 要 889MB; 构建/打包/替换都是真的)
  const snapshot = await prepareDevSnapshot({
    sha: devCheck.dev?.headSha || '', workDir: path.join(work, 'snap'),
    env: { ...process.env, BOLLOON_DEV_REUSE_NODE_MODULES: path.join(REPO, 'node_modules') },
    runNpm: npm, timeoutMs: 600_000, onStage: (s, d) => info(`  [dev] ${s}: ${d}`),
  });
  assert('真从 codeload 取 master 快照 (真网络)', snapshot.ok === true, snapshot.ok ? `source=${snapshot.source} dir=${path.basename(snapshot.dir)}` : `${snapshot.kind}/${snapshot.reason}: ${snapshot.detail}`);
  if (snapshot.ok) {
    assert('真构建 dev 快照 (npm run build:main 真跑)', snapshot.built === true, `identity=${snapshot.identity} built=${snapshot.built}`);
    assert('dev 身份 = <版本>+dev.<sha7>', snapshot.identity.includes('+dev.'), snapshot.identity);
  }

  let devIdentityInstalled = '';
  if (snapshot?.ok) {
    const snap = snapshot;
    const applied = await applyUpdate({
      home: bolloonHome, installation: inst, force: true, channel: 'dev', github: ghRes,
      devSnapshot: { tarball: snap.tarball, identity: snap.identity, sha: snap.sha },
      runNpm: npm, verifyInstall: realVerify(snap.identity),
    });
    devIdentityInstalled = String(applied.to || '');
    assert('真切换 stable → dev (npm install -g <dev tarball>)', applied.ok === true && applied.stage === 'succeeded', `${applied.stage}: ${applied.reason || ''}`);
    const onDisk = installedVersionOnDisk(inst.packageRoot);
    assert('磁盘身份变成 <版本>+dev.<sha7>', onDisk === snap.identity, `磁盘=${onDisk}`);
    const st = await readUpdateState(bolloonHome);
    assert('状态记录 devSha = master HEAD (真 sha)', st.devSha === snap.sha, String(st.devSha).slice(0, 7));
    assert('状态记录 devRef = refs/heads/master', st.devRef === 'refs/heads/master', String(st.devRef));
    assert('状态记录 installedChannel = dev', st.installedChannel === 'dev', String(st.installedChannel));
    // 真起一次入口, 看它自己报的身份
    const entry = path.join(inst.packageRoot, 'dist', 'cli-entry.js');
    const run = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, BOLLOON_HOME: bolloonHome, HOME: home } });
    const out = `${run.stdout || ''}${run.stderr || ''}`;
    assert('真启动装完的入口, 它自报 dev 身份', out.includes(snap.identity) || out.includes(snap.sha.slice(0, 7)), out.split('\n').slice(0, 2).join(' / ').slice(0, 140));
  }

  // ── B. dev → stable (真) ──────────────────────────────────────────────────
  head('B. 真 dev → stable (拿 npm 上真发布的 ' + FROM_VERSION + ' 换回去)');
  const backCheck = await checkForUpdate({ home: bolloonHome, installation: inst, force: true, channel: 'stable', github: ghRes });
  info(`check(stable): status=${backCheck.status} current=${backCheck.currentVersion} latest=${backCheck.latestVersion}`);
  assert('装了 dev 后 stable 判"可切回" (不因版本号相同说已是最新)', backCheck.status === 'update_available', backCheck.status);
  assert('check(stable): 当前装的是 dev (磁盘身份)', backCheck.installedChannel === 'dev', String(backCheck.installedChannel));
  assert('check(stable): 列出 dev commit sha', !!backCheck.installedDevSha, String(backCheck.installedDevSha));
  assert('check(stable): 理由里写明"切回 stable"', String(backCheck.reason).includes('切回 stable'), String(backCheck.reason).slice(0, 100));
  if (devIdentityInstalled) {
    const back = await applyUpdate({
      home: bolloonHome, installation: inst, force: true, channel: 'stable', github: ghRes,
      runNpm: npm, verifyInstall: realVerify(FROM_VERSION),
    });
    assert('真切换 dev → stable', back.ok === true && back.stage === 'succeeded', `${back.stage}: ${back.reason || ''}`);
    assert('磁盘版本回到 ' + FROM_VERSION, installedVersionOnDisk(inst.packageRoot) === FROM_VERSION, String(installedVersionOnDisk(inst.packageRoot)));
    const st = await readUpdateState(bolloonHome);
    assert('状态改回 installedChannel = stable', st.installedChannel === 'stable', String(st.installedChannel));
    assert('installedDevSha 清空 (当前不是 dev)', st.installedDevSha == null, String(st.installedDevSha));
    assert('保留"上次 dev 快照"记录 (可回答上次装的是哪个 dev 版)', st.devSha === backCheck.installedDevSha || !!st.devSha, String(st.devSha).slice(0, 7));
    const hist = await readUpdateHistory(3, bolloonHome);
    info(`历史: ${hist.map((h) => `${h.from} → ${h.to}`).join(' | ')}`);
    assert('历史留痕 from=<dev 身份> to=' + FROM_VERSION, hist.some((h) => String(h.from).includes('+dev.') && h.to === FROM_VERSION), '');
  }

  // ── C. 一键回 stable (真 CLI 子进程) ──────────────────────────────────────
  head('C. 一键回 stable: 真跑 CLI 子进程 (dev 装回 → update now --channel stable)');
  if (snapshot.ok) {
    const snap2 = snapshot;
    // 准备: 真装回 dev 快照 (身份 = 真 GitHub master commit)
    await applyUpdate({
      home: bolloonHome, installation: inst, force: true, channel: 'dev', github: ghRes,
      devSnapshot: { tarball: snap2.tarball, identity: snap2.identity, sha: snap2.sha },
      runNpm: npm, verifyInstall: realVerify(snap2.identity),
    });
    assert('准备: 先真装回 dev', String(installedVersionOnDisk(inst.packageRoot)).includes('+dev.'), String(installedVersionOnDisk(inst.packageRoot)));

    /**
     * GitHub master 目前是 d2148f3 —— 那份源码里**还没有** `--channel` (就是本次要加的东西)。
     * 所以这里把工作树已构建的 dist 覆盖进这个隔离安装: 身份 = 真 master commit, 代码 = 本次改动。
     * (本次提交推送后, master 上就有这个特性了, 那时这一步会自动跳过 —— 见下面 overlaid 断言)
     */
    const installedCmd = path.join(inst.packageRoot, 'dist', 'cli', 'update-commands.js');
    const overlaid = !(fs.existsSync(installedCmd) && fs.readFileSync(installedCmd, 'utf8').includes('--channel'));
    if (overlaid) {
      info('  (master d2148f3 还没有 --channel → 把工作树 dist 覆盖进隔离安装; 身份仍是真 master commit)');
      fs.rmSync(path.join(inst.packageRoot, 'dist'), { recursive: true, force: true });
      spawnSync('cp', ['-R', path.join(REPO, 'dist'), path.join(inst.packageRoot, 'dist')], { encoding: 'utf8' });
    }
    info(`  CLI 代码来源: ${overlaid ? '工作树 dist (master 上还没这个特性)' : 'GitHub master 快照自带 (无需覆盖)'}`);

    const entry = path.join(inst.packageRoot, 'dist', 'cli-entry.js');
    const cli = spawnSync(process.execPath, [entry, 'update', 'now', '--channel', 'stable'], {
      encoding: 'utf8', timeout: 300_000,
      env: { ...process.env, BOLLOON_HOME: bolloonHome, HOME: home, npm_config_prefix: prefix, npm_config_cache: path.join(home, '.npm-cache') },
    });
    const cliOut = `${cli.stdout || ''}${cli.stderr || ''}`;
    info(`CLI 退出码=${cli.status}`);
    info(cliOut.split('\n').filter(Boolean).slice(-7).join('\n       '));
    assert('CLI 一键回 stable 退出码 0', cli.status === 0, String(cli.status));
    assert('CLI 打印了"切回 stable"的结论', /stable/.test(cliOut), '');
    assert('磁盘版本回到 ' + FROM_VERSION + ' (CLI 真换)', installedVersionOnDisk(inst.packageRoot) === FROM_VERSION, String(installedVersionOnDisk(inst.packageRoot)));
    const stC = await readUpdateState(bolloonHome);
    assert('CLI 跑完后状态 = stable (不是留在 dev)', stC.installedChannel === 'stable', String(stC.installedChannel));
    // 换的是隔离 prefix, 不是本机全局 (本机全局版本不该被动过)
    const globalV = spawnSync('npm', ['ls', '-g', '--depth=0', PKG], { encoding: 'utf8', timeout: 60_000 });
    info(`本机全局 (未被动过): ${(globalV.stdout || '').split('\n').filter((l) => l.includes(PKG))[0] || '(未装)'}`);
  }

  // ── D. 假阳性: 源不可达 / 版本不存在 / 两源不一致 → 必须拒绝 ──────────────
  head('D. 假阳性检查: 坏源必须"拒绝 + 说清分类", 绝不许静默装旧版');

  // D1. GitHub 不可达 (真打一个没人监听的端口) + dev 通道
  const d1 = runChild('check-dev-offline', { home: bolloonHome, prefix, env: { BOLLOON_GITHUB_API: 'https://127.0.0.1:9' } });
  info(`dev + GitHub 不可达 → status=${d1.status} exit=${d1.exit} reason=${String(d1.reason).slice(0, 110)}`);
  assert('dev + GitHub 不可达 → github_unavailable', d1.status === 'github_unavailable', String(d1.status));
  assert('  分类带具体原因 (offline, 不是一句"更新失败")', String(d1.reason).includes('github_unavailable(offline)'), String(d1.reason).slice(0, 80));
  assert('  明确"拒绝安装"且不回落 stable', String(d1.reason).includes('拒绝安装'), '');
  assert('  退出码 2 (拒绝, 不是成功)', d1.exit === 2, String(d1.exit));
  assert('  输出里没有"已是最新"', !String(d1.rendered).includes('已是最新'), '');
  assert('  没有编造可装目标 (latestVersion = null)', d1.latestVersion === null, String(d1.latestVersion));

  // D2. registry 不可达 + stable
  const d2 = runChild('check-stable-offline', { home: bolloonHome, prefix, env: { BOLLOON_NPM_REGISTRY: 'http://127.0.0.1:9' } });
  info(`stable + npm 不可达 → status=${d2.status} exit=${d2.exit} reason=${String(d2.reason).slice(0, 110)}`);
  assert('stable + npm 不可达 → offline / registry_unavailable', d2.status === 'offline' || d2.status === 'registry_unavailable', String(d2.status));
  assert('  分类与 GitHub 侧**不合并** (单独一类)', d2.status !== 'github_unavailable', String(d2.status));
  assert('  退出码 2', d2.exit === 2, String(d2.exit));
  assert('  输出里没有"已是最新"', !String(d2.rendered).includes('已是最新'), '');

  // D2b. registry 不可达时**真执行** update → 必须拒绝, 不许装回旧版
  const d2b = runChild('apply-must-refuse', { home: bolloonHome, prefix, channel: 'stable', env: { BOLLOON_NPM_REGISTRY: 'http://127.0.0.1:9' } });
  info(`apply(stable, npm 坏) → stage=${d2b.stage} npmCalled=${d2b.npmCalled} reason=${String(d2b.reason).slice(0, 100)}`);
  assert('  执行面: 源坏 → 不调用 npm (npmCalled=0)', d2b.npmCalled === 0, String(d2b.npmCalled));
  assert('  执行面: 结论 = blocked 且说清 (不是"已是最新")', d2b.stage === 'blocked' && !String(d2b.reason).includes('已是最新'), `${d2b.stage}: ${String(d2b.reason).slice(0, 80)}`);
  assert('  执行面: 磁盘版本没被改动', d2b.onDisk === FROM_VERSION, String(d2b.onDisk));

  // D3. 两源不一致 (受控假 GitHub 说有个更新的发布) → cross_check_mismatch
  const fake = await startFakeGithub('v9.9.9');
  try {
    const d3 = await runChildAsync('check-mismatch', { home: bolloonHome, prefix, env: { BOLLOON_GITHUB_API: fake.url } });
    info(`GitHub 记录 v9.9.9 / npm latest ${FROM_VERSION} → status=${d3.status} exit=${d3.exit}`);
    info(`  ${String(d3.reason).slice(0, 130)}`);
    assert('两源不一致 → cross_check_mismatch', d3.status === 'cross_check_mismatch', String(d3.status));
    assert('  分类独立 (既不是 registry_unavailable 也不是 github_unavailable)', d3.status !== 'offline' && d3.status !== 'github_unavailable', '');
    assert('  退出码 2', d3.exit === 2, String(d3.exit));
    assert('  输出里没有"已是最新"', !String(d3.rendered).includes('已是最新'), '');
    assert('  交叉校验结论落盘 (crossCheck.kind=mismatch)', d3.crossCheck?.kind === 'mismatch', JSON.stringify(d3.crossCheck?.kind));
  } finally { fake.close(); }

  // D4. "版本不存在": dev 通道拿到一个不存在的 commit → 下载必须 404 拒绝
  head('D4. 版本/commit 不存在 → 拒绝 (真 codeload 404)');
  const bogus = await prepareDevSnapshot({
    sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', workDir: path.join(work, 'bogus'),
    env: { ...process.env }, runNpm: npm, timeoutMs: 60_000,
  });
  info(`不存在的 commit → ok=${bogus.ok} ${bogus.ok ? '' : `kind=${bogus.kind} reason=${bogus.reason}`} detail=${String(bogus.ok ? '' : bogus.detail).slice(0, 110)}`);
  assert('不存在的 commit → 拒绝 (真 codeload 404)', bogus.ok === false, bogus.ok ? '竟然成功了' : `${bogus.kind}/${bogus.reason}`);
  assert('  分类说清 (reason 非空) 且不是静默成功', !bogus.ok && !!bogus.reason, bogus.ok ? '' : String(bogus.reason));

  // ── E. update --status 三种状态 ───────────────────────────────────────────
  head('E. update --status: 三种状态各真跑一次');
  // 渲染前先做一次真检查 (注入真事实), 让 status 里的"源事实/最近检查"反映真实双源状态
  await checkForUpdate({ home: bolloonHome, installation: inst, force: true, channel: 'stable', github: ghRes });
  const st1 = await readUpdateStatus({ home: bolloonHome, env: {}, installation: inst });
  info('— 状态①(刚切回 stable) —\n' + renderStatusReport(st1));
  assert('① 说清装的是哪个源 (stable)', st1.installedChannel === 'stable', String(st1.installedChannel));
  assert('① 说清能切回哪个源 (dev)', st1.switchableTo?.channel === 'dev', JSON.stringify(st1.switchableTo));

  const snapE = snapshot;
  if (snapE.ok) {
    await applyUpdate({
      home: bolloonHome, installation: inst, force: true, channel: 'dev', github: ghRes,
      devSnapshot: { tarball: snapE.tarball, identity: snapE.identity, sha: snapE.sha },
      runNpm: npm, verifyInstall: realVerify(snapE.identity),
    });
    await checkForUpdate({ home: bolloonHome, installation: inst, force: true, channel: 'dev', github: ghRes });
    const st2 = await readUpdateStatus({ home: bolloonHome, env: {}, installation: inst });
    info('— 状态②(装了 dev) —\n' + renderStatusReport(st2));
    assert('② 说清装的是 dev', st2.installedChannel === 'dev', String(st2.installedChannel));
    assert('② 给出 commit sha', st2.installedDevSha === snapE.sha.slice(0, 7), String(st2.installedDevSha));
    assert('② 说清一键回 stable', renderStatusReport(st2).includes('--channel stable'), '');
    assert('② 带显式警告', renderStatusReport(st2).includes('dev 通道'), '');

    await applyUpdate({
      home: bolloonHome, installation: inst, force: true, channel: 'stable', github: ghRes,
      runNpm: npm, verifyInstall: realVerify(FROM_VERSION),
    });
    await checkForUpdate({ home: bolloonHome, installation: inst, force: true, channel: 'stable', github: ghRes });
    const st3 = await readUpdateStatus({ home: bolloonHome, env: {}, installation: inst });
    info('— 状态③(刚切回 stable) —\n' + renderStatusReport(st3));
    assert('③ 说清切回后是 stable', st3.installedChannel === 'stable', String(st3.installedChannel));
    assert('③ 仍能回答"上次 dev 是哪个 commit"', !!st3.lastDevSha, String(st3.lastDevSha));
  } else {
    info('(跳过 ②/③: dev 快照没做出来)');
  }

  // ── 收尾 ──────────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m结果: ${pass} PASS / ${fail} FAIL / ${skipped} SKIP\x1b[0m`);
  if (failures.length) console.log('失败项:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  console.log(`(隔离目录保留: ${work})`);
  process.exit(fail === 0 ? 0 : 1);
}

const modeArg = process.argv.find((a) => a.startsWith('--mode='));
if (modeArg) await childMode(modeArg.slice('--mode='.length));
else await main();
