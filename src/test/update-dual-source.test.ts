/**
 * update-dual-source.test.ts — 双源更新 (npm + GitHub) 的单测 (2026-09-25, update-protocol §12)
 *
 * 覆盖 §12 的四条主干 (纯函数 + 临时 HOME, **不打外网**: 两个源都用注入的受控结果):
 *   ① 两套比较语义显式分开: stable = semver, dev = git ref + commit sha
 *   ② 错误分类不合并: github_unavailable(offline/rate_limited/not_found/http_error)
 *   ③ 交叉校验: npm ↔ GitHub 一致 / 记录缺 / 不一致(阻塞)
 *   ④ 拒绝而不是静默退回: 源不可达 → 拒绝 + 退出码 2, 绝不打印"已是最新"
 *
 * 真跑的端到端 (真 npm / 真 registry / 真 GitHub API) 见 `scripts/verify-dual-source.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import {
  checkForUpdate, buildUpdatePlan, renderUpdatePlan, applyUpdate, readUpdateStatus,
  checkExitCode, REFUSED_STATUSES, type RegistryResult,
} from '../utils/update-manager.js';
import {
  classifyGithubError, crossCheckStable, compareDevSnapshots, newestGithubVersion, toGithubReport,
  renderGithubReportLine, type GithubFacts, type GithubResult,
} from '../utils/dual-source.js';
import {
  readUpdateState, writeUpdateState, readUpdateHistory as readHist,
} from '../utils/update-state.js';
import { parseChannelArg, renderStatusReport, renderCheckResult } from '../cli/update-commands.js';
import {
  channelKindOf, devIdentity, baseVersionOf, isDevIdentity, devShaFromIdentity,
  DEV_CHANNEL_WARNING, type InstallationInfo,
} from '../utils/version-info.js';

const PKG = '@bolloon/bolloon-agent';
const HEAD_SHA = 'abc1234' + '0'.repeat(33);   // 40 位 sha (与 git 一致)
const HEAD7 = HEAD_SHA.slice(0, 7);
const IDENTITY = `0.4.33+dev.${HEAD7}`;

let tmpHome: string;
let tmpBolloon: string;
let realHome: string;

beforeEach(() => {
  realHome = os.homedir();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-dual-test-'));
  tmpBolloon = path.join(tmpHome, '.bolloon');
  fs.mkdirSync(tmpBolloon, { recursive: true });
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = realHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

// ── 夹具 ────────────────────────────────────────────────────────────────────

function fakeInstall(version: string): InstallationInfo {
  const root = fs.mkdtempSync(path.join(tmpHome, 'pkg-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: PKG, version }, null, 2));
  return {
    method: 'npm-global', packageRoot: root, installDir: root, binPath: null,
    entryPath: path.join(root, 'dist', 'cli-entry.js'), writable: true, linked: false, linkTarget: null,
    updateSource: 'npm', autoUpdatable: true, reason: '双源测试夹具 (npm-global)',
  };
}

function registryOk(latest: string, versions: string[]): RegistryResult {
  return { ok: true, doc: { latest, distTags: { latest }, versions, gitHeads: {} } };
}

function githubOk(over: Partial<GithubFacts> = {}): GithubResult {
  return {
    ok: true,
    facts: {
      slug: 'logos-42/bolloon', ref: 'refs/heads/master', headSha: HEAD_SHA,
      releases: [], tags: [{ name: 'v0.4.30', sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }],
      fetchedAt: '2026-09-25T00:00:00.000Z', partial: false, missing: [],
      ...over,
    },
  };
}

function githubDown(reason: 'offline' | 'rate_limited' | 'not_found' | 'http_error', detail = '夹具'): GithubResult {
  return { ok: false, kind: 'github_unavailable', reason, detail, retryAt: reason === 'rate_limited' ? '2026-09-25T01:00:00.000Z' : null, facts: null };
}

/** 造一个真的能被解压 + 通过 validateStagedPackage 的 tarball (里面必须有 dist/cli-entry.js)。 */
function makeTarball(version: string): string {
  const work = fs.mkdtempSync(path.join(tmpHome, 'tb-'));
  const pkgDir = path.join(work, 'package');
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version }, null, 2));
  fs.writeFileSync(path.join(pkgDir, 'dist', 'cli-entry.js'), `process.stdout.write(JSON.stringify({ packageVersion: '${version}' }));\n`);
  const tar = spawnSync('tar', ['-czf', path.join(work, 'out.tgz'), '-C', work, 'package'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`夹具 tarball 失败: ${tar.stderr}`);
  return path.join(work, 'out.tgz');
}

// ── ① 两套比较语义显式分开 ──────────────────────────────────────────────────

describe('两套比较语义 (§12.1: stable=semver / dev=git-ref)', () => {
  it('通道 → 比较语义是显式的, 不靠约定', () => {
    expect(channelKindOf('stable')).toBe('semver');
    expect(channelKindOf('beta')).toBe('semver');
    expect(channelKindOf('dev')).toBe('git-ref');
  });

  it('dev 身份 = <版本>+dev.<sha7>, 且能反解出 sha', () => {
    expect(devIdentity('0.4.33', HEAD_SHA)).toBe(IDENTITY);
    expect(isDevIdentity(IDENTITY)).toBe(true);
    expect(isDevIdentity('0.4.33')).toBe(false);
    expect(devShaFromIdentity(IDENTITY)).toBe(HEAD7);
    expect(devShaFromIdentity('0.4.33')).toBeNull();
    // 基础版本号 (stable 目标的比对基准) 必须能把 dev 后缀剥掉
    expect(baseVersionOf(IDENTITY)).toBe('0.4.33');
    expect(baseVersionOf('0.4.33')).toBe('0.4.33');
  });

  it('dev 判定只看 commit sha, 不看版本号 (版本号相同也是另一个 dev 版)', () => {
    const other = 'ffffffffffffffffffffffffffffffffffffffff';
    const same = compareDevSnapshots(HEAD7, HEAD_SHA);
    expect(same.same).toBe(true);
    expect(same.behind).toBe(false);
    const behind = compareDevSnapshots(other.slice(0, 7), HEAD_SHA);
    expect(behind.same).toBe(false);
    expect(behind.behind).toBe(true);
    expect(behind.detail).toContain('按 commit sha 判定');
    // 不是 dev 安装: 明说"切过去会得到哪个 sha", 不假装同步
    const fromStable = compareDevSnapshots(null, HEAD_SHA);
    expect(fromStable.same).toBe(false);
    expect(fromStable.detail).toContain(HEAD7);
    // 拿不到 HEAD: 不猜
    expect(compareDevSnapshots(HEAD7, null).detail).toContain('无法判定');
  });
});

// ── ② 错误分类不合并 ────────────────────────────────────────────────────────

describe('classifyGithubError: 分类与 registry 侧并列, 不合并成一句', () => {
  it('网络类 → offline', () => {
    expect(classifyGithubError({ code: 'ENOTFOUND' }).reason).toBe('offline');
    expect(classifyGithubError({ code: 'ECONNREFUSED' }).reason).toBe('offline');
    expect(classifyGithubError({ message: '请求超时' }).reason).toBe('offline');
  });

  it('403/429 → rate_limited (带重试时间)', () => {
    const r = classifyGithubError(null, 403, { 'x-ratelimit-reset': String(Math.floor(Date.parse('2026-09-25T01:00:00Z') / 1000)) });
    expect(r.reason).toBe('rate_limited');
    expect(r.retryAt).toBe('2026-09-25T01:00:00.000Z');
    expect(classifyGithubError(null, 429).reason).toBe('rate_limited');
  });

  it('404 → not_found; 5xx/其它 → http_error (不塞进前三类)', () => {
    expect(classifyGithubError(null, 404).reason).toBe('not_found');
    expect(classifyGithubError(null, 500).reason).toBe('http_error');
    expect(classifyGithubError(null, 401).reason).toBe('http_error');
    expect(classifyGithubError(new Error('odd')).reason).toBe('http_error');
  });

  it('四种分类都能渲染成人话 (谁答的 / 哪一类)', () => {
    expect(renderGithubReportLine(toGithubReport(githubDown('offline')))).toContain('github_unavailable(offline)');
    expect(renderGithubReportLine(toGithubReport(githubDown('rate_limited')))).toContain('限流重试时间');
    expect(renderGithubReportLine(toGithubReport(githubOk()))).toContain('master HEAD abc1234');
    expect(renderGithubReportLine(null)).toContain('未查询');
  });
});

// ── ③ 交叉校验 (stable: npm 权威 + GitHub 记录) ─────────────────────────────

describe('crossCheckStable: npm 是权威, GitHub 只回答"发布记录在不在"', () => {
  const facts = (over: Partial<GithubFacts> = {}): GithubFacts => ({
    slug: 'logos-42/bolloon', ref: 'refs/heads/master', headSha: HEAD_SHA,
    releases: [], tags: [], fetchedAt: '2026-09-25T00:00:00.000Z', partial: false, missing: [], ...over,
  });

  it('同名 tag → agree (两条记录指向同一版)', () => {
    const r = crossCheckStable('0.4.30', facts({ tags: [{ name: 'v0.4.30', sha: 'x' }] }));
    expect(r.kind).toBe('agree');
    expect(r.blocking).toBe(false);
    expect(r.detail).toContain('两个源指向同一版');
  });

  it('同名 Release 也算 agree', () => {
    const r = crossCheckStable('0.4.30', facts({ releases: ['v0.4.30'] }));
    expect(r.kind).toBe('agree');
    expect(r.hasRelease).toBe(true);
  });

  it('GitHub 有更新的发布记录而 registry 没有 → mismatch 且**阻塞**', () => {
    const r = crossCheckStable('0.4.30', facts({ releases: ['v0.4.31'], tags: [{ name: 'v0.4.31', sha: 'x' }] }));
    expect(r.kind).toBe('mismatch');
    expect(r.blocking).toBe(true);
    expect(r.detail).toContain('拒绝按 GitHub 的记录安装');
  });

  it('registry 有该版本但 GitHub 缺记录 → 提醒级 (不阻塞 stable 更新)', () => {
    const r = crossCheckStable('0.4.33', facts({ tags: [{ name: 'v0.4.30', sha: 'x' }] }));
    expect(r.kind).toBe('missing_record');
    expect(r.blocking).toBe(false);
    expect(r.detail).toContain('发布记录缺 Tag');
  });

  it('GitHub 上一条版本记录都没有 → 如实报"暂无 tag 可交叉校验" (不编造)', () => {
    const r = crossCheckStable('0.4.33', facts());
    expect(r.kind).toBe('no_record_at_all');
    expect(r.blocking).toBe(false);
    expect(r.detail).toContain('暂无任何 tag');
    expect(newestGithubVersion(facts())).toBeNull();
  });
});

// ── ④ 检查结论: 双源各自何时出现 ────────────────────────────────────────────

describe('checkForUpdate + 双源', () => {
  it('stable: GitHub 不可达**不影响** npm 的权威结论 (交叉校验降级为提醒)', async () => {
    const inst = fakeInstall('0.4.32');
    const r = await checkForUpdate({
      home: tmpBolloon, installation: inst, force: true,
      registry: registryOk('0.4.33', ['0.4.32', '0.4.33']), github: githubDown('offline', 'ENOTFOUND api.github.com'),
    });
    expect(r.status).toBe('update_available');       // 以 npm 为准, 不是 github_unavailable
    expect(r.latestVersion).toBe('0.4.33');
    expect(r.github?.reachable).toBe(false);
    expect(r.github?.reason).toBe('offline');
    expect(r.crossCheck).toBeNull();                 // 交叉校验没做成 → 明说没有, 不假装验过
    expect(r.sourceFacts?.github?.reachable).toBe(false);
    expect(checkExitCode(r.status)).toBe(0);
  });

  it('stable: 两源不一致 → cross_check_mismatch, 退出码 2, 且人话里没有"已是最新"', async () => {
    const inst = fakeInstall('0.4.30');
    const r = await checkForUpdate({
      home: tmpBolloon, installation: inst, force: true,
      registry: registryOk('0.4.30', ['0.4.30']), github: githubOk({ releases: ['v0.4.31'] }),
    });
    expect(r.status).toBe('cross_check_mismatch');
    expect(r.crossCheck?.kind).toBe('mismatch');
    expect(checkExitCode(r.status)).toBe(2);
    const text = renderCheckResult(r);
    expect(text).toContain('两个源不一致');
    expect(text).not.toContain('已是最新');
  });

  it('stable: npm 不可达 → registry_unavailable/offline, 退出码 2, 不显示"已是最新"', async () => {
    const inst = fakeInstall('0.4.32');
    for (const kind of ['offline', 'registry_unavailable'] as const) {
      const r = await checkForUpdate({
        home: tmpBolloon, installation: inst, force: true,
        registry: { ok: false, kind, detail: kind === 'offline' ? 'ENOTFOUND' : 'HTTP 503' }, github: githubOk(),
      });
      expect(r.status).toBe(kind);
      expect(checkExitCode(r.status)).toBe(2);
      expect(renderCheckResult(r)).not.toContain('已是最新');
    }
  });

  it('dev: GitHub 不可达 → **直接拒**, 退出码 2, 明确说清分类, 不回落到 stable', async () => {
    const inst = fakeInstall('0.4.33');
    for (const reason of ['offline', 'rate_limited', 'not_found', 'http_error'] as const) {
      const r = await checkForUpdate({
        home: tmpBolloon, installation: inst, force: true, channel: 'dev',
        registry: registryOk('0.4.33', ['0.4.33']), github: githubDown(reason),
      });
      expect(r.status).toBe('github_unavailable');
      expect(r.reason).toContain(`github_unavailable(${reason})`);
      expect(r.reason).toContain('拒绝安装');
      expect(r.latestVersion).toBeNull();            // 不编造一个可装的目标
      expect(checkExitCode(r.status)).toBe(2);
      const text = renderCheckResult(r);
      expect(text).not.toContain('已是最新');
      expect(text).toContain('不会退回 stable 装旧版');
    }
  });

  it('dev: master HEAD 读不到 → github_unavailable(not_found), 不装身份不明的快照', async () => {
    const inst = fakeInstall('0.4.33');
    const r = await checkForUpdate({
      home: tmpBolloon, installation: inst, force: true, channel: 'dev',
      registry: registryOk('0.4.33', ['0.4.33']), github: githubOk({ headSha: null }),
    });
    expect(r.status).toBe('github_unavailable');
    expect(r.reason).toContain('not_found');
  });

  it('dev: 从 stable 切过去 → 目标是 <版本>+dev.<sha7>, 且说清能切回 stable', async () => {
    const inst = fakeInstall('0.4.33');
    const r = await checkForUpdate({
      home: tmpBolloon, installation: inst, force: true, channel: 'dev',
      registry: registryOk('0.4.33', ['0.4.33']), github: githubOk(),
    });
    expect(r.status).toBe('update_available');
    expect(r.latestVersion).toBe(IDENTITY);
    expect(r.targetIdentity).toBe(IDENTITY);
    expect(r.installedChannel).toBe('stable');
    expect(r.switchableTo?.channel).toBe('stable');
    expect(r.channelKind).toBe('git-ref');
    expect(r.dev?.headSha).toBe(HEAD_SHA);
  });

  it('dev: 同一个 commit → up_to_date (按 sha 判, 不看版本号)', async () => {
    const inst = fakeInstall(IDENTITY);
    const r = await checkForUpdate({
      home: tmpBolloon, installation: inst, force: true, channel: 'dev',
      registry: registryOk('0.4.33', ['0.4.33']), github: githubOk(),
    });
    expect(r.status).toBe('up_to_date');
    expect(r.installedChannel).toBe('dev');
    expect(r.installedDevSha).toBe(HEAD7);
    expect(r.dev?.same).toBe(true);
  });

  it('dev: 版本号没变但 commit 变了 → 仍是另一个 dev 版 (update_available)', async () => {
    const inst = fakeInstall(IDENTITY);
    const r = await checkForUpdate({
      home: tmpBolloon, installation: inst, force: true, channel: 'dev',
      registry: registryOk('0.4.33', ['0.4.33']),
      github: githubOk({ headSha: '9999999' + HEAD_SHA.slice(7) }),
    });
    expect(r.status).toBe('update_available');
    expect(r.dev?.behind).toBe(true);
    expect(r.reason).toContain('dev 快照落后');
  });

  it('装了 dev 快照 → stable 通道必须判"能切回", 不许因版本号相同说"已是最新"', async () => {
    const inst = fakeInstall(IDENTITY);
    const r = await checkForUpdate({
      home: tmpBolloon, installation: inst, force: true,
      registry: registryOk('0.4.33', ['0.4.33']), github: githubOk(),
    });
    expect(r.status).toBe('update_available');
    expect(r.latestVersion).toBe('0.4.33');
    expect(r.installedChannel).toBe('dev');
    expect(r.reason).toContain('切回 stable');
    expect(r.switchableTo?.target).toBe('0.4.33');
  });

  it('检查结果落盘: 谁装的 / 哪个 sha / 能切回哪 / 两个源各给了什么', async () => {
    const inst = fakeInstall('0.4.32');
    await checkForUpdate({
      home: tmpBolloon, installation: inst, force: true,
      registry: registryOk('0.4.33', ['0.4.32', '0.4.33']), github: githubOk(),
    });
    const st = await readUpdateState(tmpBolloon);
    expect(st.installedChannel).toBe('stable');
    expect(st.sourceFacts?.npm?.latest).toBe('0.4.33');
    expect(st.sourceFacts?.github?.headSha).toBe(HEAD_SHA);
    expect(st.sourceFacts?.crossCheck?.kind).toBe('missing_record');
    expect(st.switchableTo?.channel).toBe('dev');
  });

  it('REFUSED_STATUSES 覆盖 5 个"源不可达/版本不存在"结论 (它们都必须拒)', () => {
    for (const s of ['offline', 'registry_unavailable', 'local_version_unknown', 'github_unavailable', 'cross_check_mismatch'] as const) {
      expect(REFUSED_STATUSES).toContain(s);
      expect(checkExitCode(s)).toBe(2);
    }
    expect(checkExitCode('up_to_date')).toBe(0);
    expect(checkExitCode('update_available')).toBe(0);
    expect(checkExitCode('unsupported_installation')).toBe(0);
  });
});

// ── ⑤ --channel 解析 ────────────────────────────────────────────────────────

describe('--channel 解析 (§12.2)', () => {
  it('认 stable / dev / beta, 两种写法都吃', () => {
    expect(parseChannelArg(['--channel', 'dev']).channel).toBe('dev');
    expect(parseChannelArg(['--channel=stable']).channel).toBe('stable');
    expect(parseChannelArg(['channel', 'beta']).channel).toBe('beta');
    expect(parseChannelArg([]).given).toBe(false);
  });

  it('不认识的值 → 拒绝并说清 (不静默落回 stable)', () => {
    const bad = parseChannelArg(['--channel', 'nightly']);
    expect(bad.error).toContain('拒绝执行');
    expect(bad.channel).toBeUndefined();
    expect(parseChannelArg(['--channel=']).error).toBeTruthy();
  });
});

// ── ⑥ 计划面 (dev 警告必须出现) ─────────────────────────────────────────────

describe('更新计划: dev 通道的三条硬约束', () => {
  it('dev 计划必须带同一句警告 + 一键回 stable; GitHub 不可达时**阻塞**', async () => {
    const inst = fakeInstall('0.4.33');
    const plan = await buildUpdatePlan({
      home: tmpBolloon, installation: inst, force: true, channel: 'dev',
      registry: registryOk('0.4.33', ['0.4.33']), github: githubOk(), workloadRiskOverride: [],
    });
    expect(plan.channelKind).toBe('git-ref');
    expect(plan.targetVersion).toBe(IDENTITY);
    expect(plan.warnings).toContain(DEV_CHANNEL_WARNING);
    const text = renderUpdatePlan(plan);
    expect(text).toContain('dev 通道 = GitHub master HEAD');
    expect(text).toContain('一键回稳定版');
    expect(text).toContain('比较语义: git-ref');
    expect(text).toContain('GitHub master (唯一源)');

    const blocked = await buildUpdatePlan({
      home: tmpBolloon, installation: inst, force: true, channel: 'dev',
      registry: registryOk('0.4.33', ['0.4.33']), github: githubDown('offline'), workloadRiskOverride: [],
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers.join(' ')).toContain('GitHub 源可达');
    expect(blocked.targetVersion).toBeNull();
  });

  it('stable 下 GitHub 不可达只是**提醒**, 不阻塞 (npm 仍是权威)', async () => {
    const inst = fakeInstall('0.4.32');
    const plan = await buildUpdatePlan({
      home: tmpBolloon, installation: inst, force: true,
      registry: registryOk('0.4.33', ['0.4.32', '0.4.33']), github: githubDown('rate_limited'), workloadRiskOverride: [],
    });
    expect(plan.ok).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.advisories.join(' ')).toContain('github_unavailable(rate_limited)');
  });

  it('两源不一致 → 计划阻塞 (不执行任何安装)', async () => {
    const inst = fakeInstall('0.4.30');
    const plan = await buildUpdatePlan({
      home: tmpBolloon, installation: inst, force: true,
      registry: registryOk('0.4.30', ['0.4.30']), github: githubOk({ releases: ['v0.4.31'] }), workloadRiskOverride: [],
    });
    expect(plan.ok).toBe(false);
    expect(plan.blockers.join(' ')).toContain('两个源指向同一版本');
  });
});

// ── ⑦ 执行: 真切换 / 真回滚 / 真记 sha ──────────────────────────────────────

describe('applyUpdate 双源: 切换、记录、一键回 stable', () => {
  it('stable → dev: 身份变 +dev.<sha>, 状态记 devSha/devRef, 历史留痕', async () => {
    const inst = fakeInstall('0.4.33');
    const tarball = makeTarball(IDENTITY);
    let switchTarget = '';
    const res = await applyUpdate({
      home: tmpBolloon, installation: inst, force: true, channel: 'dev',
      registry: registryOk('0.4.33', ['0.4.33']), github: githubOk(),
      devSnapshot: { tarball, identity: IDENTITY, sha: HEAD_SHA },
      runNpm: (args) => {
        if (args[0] === 'install') {
          switchTarget = String(args[2]);
          fs.writeFileSync(path.join(inst.packageRoot, 'package.json'), JSON.stringify({ name: PKG, version: IDENTITY }));
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      verifyInstall: async (target) => target === IDENTITY,
    });
    expect(res.ok).toBe(true);
    expect(res.to).toBe(IDENTITY);
    // 切换交给 npm 的是 dev 快照 tarball (不是 npm 上的某个版本号)
    expect(switchTarget).toBe(tarball);
    const st = await readUpdateState(tmpBolloon);
    expect(st.installedChannel).toBe('dev');
    expect(st.devSha).toBe(HEAD_SHA);
    expect(st.devRef).toBe('refs/heads/master');
    expect(st.installedDevSha).toBe(HEAD7);
    expect(st.devCheckedAt).toBeTruthy();
    const hist = await readHist(5, tmpBolloon);
    expect(hist[0].from).toBe('0.4.33');
    expect(hist[0].to).toBe(IDENTITY);
  });

  it('dev → stable (一键回): 磁盘身份变回 semver + 状态改回 stable 且保留上次 dev 记录', async () => {
    const inst = fakeInstall(IDENTITY);
    // 先落一份"上次装的是 dev"的记录 —— 切回 stable 之后它必须还在 (能回答"上次那个 dev 版是哪个")
    await writeUpdateState({
      installedChannel: 'dev', installedDevSha: HEAD7, devSha: HEAD_SHA,
      devRef: 'refs/heads/master', devCheckedAt: '2026-09-25T00:00:00.000Z',
    }, tmpBolloon);
    const res = await applyUpdate({
      home: tmpBolloon, installation: inst, force: true, channel: 'stable',
      registry: registryOk('0.4.33', ['0.4.33']), github: githubOk(),
      runNpm: (args, cwd) => {
        if (args[0] === 'pack') {
          // 交给真 tar 产一个 0.4.33 的 tarball (校验/解压都是真的)
          const src = makeTarball('0.4.33');
          fs.copyFileSync(src, path.join(cwd, 'bolloon-agent-0.4.33.tgz'));
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'install') {
          fs.writeFileSync(path.join(inst.packageRoot, 'package.json'), JSON.stringify({ name: PKG, version: '0.4.33' }));
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      verifyInstall: async (target) => target === '0.4.33',
    });
    expect(res.ok).toBe(true);
    expect(res.from).toBe(IDENTITY);
    expect(res.to).toBe('0.4.33');
    const st = await readUpdateState(tmpBolloon);
    expect(st.installedChannel).toBe('stable');
    expect(st.installedDevSha).toBeNull();
    // "上次用过的 dev 快照"要留着 (切回之后仍能回答"我上次装的是哪个 dev 版")
    expect(st.devSha).toBe(HEAD_SHA);
    expect(st.devRef).toBe('refs/heads/master');
    const hist = await readHist(5, tmpBolloon);
    expect(hist[0].from).toBe(IDENTITY);
    expect(hist[0].to).toBe('0.4.33');
  });

  it('dev 快照准备失败 (源取不到) → 失败, 旧版本没被动过, 锁已释放', async () => {
    const inst = fakeInstall('0.4.33');
    // BOLLOON_DEV_SOURCE_DIR 指向一个不是 git 检出的目录 → 必须拒绝 (不许拿错的源码当快照)
    const bogus = fs.mkdtempSync(path.join(tmpHome, 'bogus-src-'));
    fs.writeFileSync(path.join(bogus, 'package.json'), JSON.stringify({ name: PKG, version: '0.4.33' }));
    const res = await applyUpdate({
      home: tmpBolloon, installation: inst, force: true, channel: 'dev',
      env: { ...process.env, BOLLOON_DEV_SOURCE_DIR: bogus, HOME: tmpHome },
      registry: registryOk('0.4.33', ['0.4.33']), github: githubOk(),
      runNpm: (args) => args[0] === 'install'
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 1, stdout: '', stderr: '不应该跑到这里' },
    });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('failed');
    expect(res.reason).toContain('sha_unverifiable');
    expect(fs.readFileSync(path.join(inst.packageRoot, 'package.json'), 'utf8')).toContain('0.4.33');
    expect(fs.existsSync(path.join(tmpBolloon, 'update.lock'))).toBe(false);
    const st = await readUpdateState(tmpBolloon);
    expect(st.lastFailure?.stage).toBe('downloading');
  });
});

// ── ⑧ status 三种状态各说清"哪个源/哪个 sha/能切回哪" ───────────────────────

describe('update --status: 三种状态都必须说清来源', () => {
  const render = async (version: string) => {
    const inst = fakeInstall(version);
    return renderStatusReport(await readUpdateStatus({ home: tmpBolloon, env: {}, installation: inst }));
  };

  it('只装 npm: 说清 stable + 能切回 dev', async () => {
    const inst = fakeInstall('0.4.33');
    await checkForUpdate({
      home: tmpBolloon, installation: inst, force: true,
      registry: registryOk('0.4.33', ['0.4.33']), github: githubOk(),
    });
    const text = await render('0.4.33');
    expect(text).toContain('安装来源:   stable (npm registry)');
    expect(text).toContain('能切回:     dev');
    expect(text).toContain('比较语义: semver');
    expect(text).toContain('源事实:');
  });

  it('装了 dev: 说清 dev + commit sha + 一键回 stable', async () => {
    await fs.promises.writeFile(path.join(tmpBolloon, 'update-state.json'), JSON.stringify({
      schema: 'bolloon-update/1', installedChannel: 'dev', installedDevSha: HEAD7, devSha: HEAD_SHA,
      devRef: 'refs/heads/master', devCheckedAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
      lastCheckAt: null,
    }));
    const text = await render(IDENTITY);
    expect(text).toContain(`commit ${HEAD7}`);
    expect(text).toContain('refs/heads/master');
    expect(text).toContain('能切回:     stable');
    expect(text).toContain('bolloon update now --channel stable');
    expect(text).toContain(DEV_CHANNEL_WARNING);
  });

  it('刚切回 stable: 仍能看到"上次 dev"记录', async () => {
    await fs.promises.writeFile(path.join(tmpBolloon, 'update-state.json'), JSON.stringify({
      schema: 'bolloon-update/1', installedChannel: 'stable', installedDevSha: null, devSha: HEAD_SHA,
      devRef: 'refs/heads/master', devCheckedAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
      lastCheckAt: null,
    }));
    const text = await render('0.4.33');
    expect(text).toContain('安装来源:   stable');
    expect(text).toContain('上次 dev:');
    expect(text).toContain(`commit ${HEAD_SHA}`);
    expect(text).not.toContain(DEV_CHANNEL_WARNING);
  });
});
