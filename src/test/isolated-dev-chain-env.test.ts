/**
 * isolated-dev-chain-env.test.ts — 锁住「隔离链 anvil 起不来」的两个真因 (2026-09-22)
 *
 * 真问题 (本机实测): foundry 的 anvil 在 macOS 上动态链到 libusb
 *   `dyld: Library not loaded: /usr/local/opt/libusb/lib/libusb-1.0.0.dylib` → SIGABRT
 *   → 上层只看到「隔离链没能在 30000ms 内就绪」(动态库问题被伪装成超时)。
 * 两个成因 (都在这里被断言锁住):
 *   ① 库目录探测用 `os.homedir()` (= $HOME) 拼 `~/.local/lib` ——
 *      **干净 HOME 下必然指向空目录** → 必须按真实候选探测, 且优先用
 *      `os.userInfo().homedir` (账号真实 HOME), 免得 $HOME 一换就找不到库。
 *   ② 子进程 env 整份继承 process.env —— 必须走显式白名单, 且 `PATH`/`HOME`/
 *      `DYLD_LIBRARY_PATH` 必须在白名单里 (探到的库目录要真传下去)。
 * 另外锁住「探测不到」时的报错必须是**人话 + 可操作**(装哪/怎么指), 不是含糊超时。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  probeMacosDylibs, buildAnvilChildEnv, dylibCandidateDirs, realUserHome,
  missingDylibsFromOtool, defaultAnvilBin, startIsolatedDevChain,
  ANVIL_ENV_WHITELIST, ANVIL_ENV_PREFIXES,
  type DylibProbeResult,
} from '../../scripts/lib/isolated-dev-chain.js';

// ── 辅助: 临时目录 + 假 otool 输出 (真文件系统, 不 mock fs) ────────────────────
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function putDylib(dir: string, name = 'libusb-1.0.0.dylib'): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), '');
  return path.join(dir, name);
}

/** anvil 的 otool -L 输出 (真机就是这几行; libusb 那行写死 /usr/local/opt/libusb/lib) */
const OTTOOL_OUTPUT = [
  '  /fake/bin/anvil:',
  '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.120.2)',
  '\t/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation (compatibility version 300.0.0, current version 2503.1.0)',
  '\t/usr/local/opt/libusb/lib/libusb-1.0.0.dylib (compatibility version 7.0.0, current version 7.0.0)',
  '',
].join('\n');
const saidOtool = () => OTTOOL_OUTPUT;

describe('anvil 动态库探测 — 不依赖 $HOME', () => {
  it('★ 干净/临时 HOME 下, 仍能把**账号真实 HOME** 的 ~/.local/lib 拼进 DYLD_LIBRARY_PATH', () => {
    const realAccountHome = tmp('bolloon-userhome-');   // 真账号 HOME (getpwuid 给的那个)
    const cleanHome = tmp('bolloon-cleanhome-');        // $HOME 指向的空目录 (CI/验收用的临时 HOME)
    const realLibDir = path.dirname(putDylib(path.join(realAccountHome, '.local', 'lib')));

    const r = probeMacosDylibs({
      anvilBin: '/fake/bin/anvil',
      env: { HOME: cleanHome },        // ← 干净 HOME: 它下面什么都没有
      userHome: realAccountHome,       // ← 账号真实 HOME: 库在这里
      otool: saidOtool,
    });

    expect(r.error).toBeNull();
    expect(r.missing).toEqual(['/usr/local/opt/libusb/lib/libusb-1.0.0.dylib']);
    expect(r.dirs).toContain(realLibDir);
    expect(String(r.dyldLibraryPath).split(':')).toContain(realLibDir);
    // 而且**没有**把 $HOME 那个空目录拼进去 (拼进去 = 靠巧合)
    expect(String(r.dyldLibraryPath).split(':')).not.toContain(path.join(cleanHome, '.local', 'lib'));
  });

  it('★ 探测顺序: 真账号 HOME 的 ~/.local/lib 排在各候选之前', () => {
    const userHome = tmp('bolloon-userhome2-');
    const dirs = dylibCandidateDirs({ HOME: '/nonexistent-home' }, userHome);
    expect(dirs[0]).toBe(path.join(userHome, '.local', 'lib'));
    expect(dirs).toContain('/usr/local/lib');
    expect(dirs).toContain('/opt/homebrew/lib');
    expect(dirs).toContain('/usr/local/opt/libusb/lib');
  });

  it('候选目录里**没有**所需库 → 不拼进 DYLD_LIBRARY_PATH (只拼真命中的)', () => {
    const home = tmp('bolloon-bare-home-');
    putDylib(path.join(home, 'lib'), 'libsomething-else-9.dylib');   // 有个库, 但不是缺的那个
    const r = probeMacosDylibs({
      anvilBin: '/fake/bin/anvil', env: { HOME: home }, userHome: home, otool: saidOtool,
    });
    expect(r.dirs).not.toContain(path.join(home, 'lib'));
    // 本机真 FS 上 /Users/apple/.local/lib 这种"真的存在"的目录不该被凭空拼进来
    expect(r.dirs.every((d) => fs.existsSync(path.join(d, 'libusb-1.0.0.dylib')))).toBe(true);
    expect(r.dyldLibraryPath).toBeNull();
  });

  it('★ 一个都找不到 → 报**人话 + 可操作**的错 (装哪 / 怎么指 / 列全探测过的目录)', () => {
    const home = tmp('bolloon-nolib-home-');
    const r = probeMacosDylibs({
      anvilBin: '/fake/bin/anvil', env: { HOME: home }, userHome: home, otool: saidOtool,
    });
    expect(r.error).toBeTruthy();
    expect(r.dyldLibraryPath).toBeNull();
    // 点名缺的库 + 原始信号 (dyld 报的那条路径)
    expect(r.error).toMatch(/libusb-1\.0\.0\.dylib/);
    expect(r.error).toMatch(/\/usr\/local\/opt\/libusb\/lib\/libusb-1\.0\.0\.dylib/);
    // 可操作: 装法 / 显式指法 / 换 anvil, 三条都要给
    expect(r.error).toMatch(/brew install libusb/);
    expect(r.error).toMatch(/DYLD_LIBRARY_PATH=/);
    expect(r.error).toMatch(/ANVIL_BIN=/);
    // 探测过的候选目录要列出来 (不然人不知道该往哪装)
    expect(r.error).toContain(path.join(home, '.local', 'lib'));
    expect(r.error).toContain('/opt/homebrew/lib');
    // 不许出现"含糊超时"式措辞替代真因
    expect(r.error).not.toMatch(/没能在 \d+ms 内就绪/);
  });

  it('env 里已有的 DYLD_LIBRARY_PATH 原样保留 (调用方显式选择优先), 命中目录追加在后', () => {
    const userHome = tmp('bolloon-userhome3-');
    const realLibDir = path.dirname(putDylib(path.join(userHome, '.local', 'lib')));
    const r = probeMacosDylibs({
      anvilBin: '/fake/bin/anvil',
      env: { HOME: '/nonexistent-home', DYLD_LIBRARY_PATH: '/opt/custom/lib:/another/lib' },
      userHome, otool: saidOtool,
    });
    const parts = String(r.dyldLibraryPath).split(':');
    expect(parts.slice(0, 2)).toEqual(['/opt/custom/lib', '/another/lib']);
    expect(parts).toContain(realLibDir);
  });

  it('otool 用不了 (非 macOS / 没装 CLI 工具) → 只按已知库名探测, 找不到也不报错 (不敢断言缺)', () => {
    const home = tmp('bolloon-nootool-home-');
    const r = probeMacosDylibs({ anvilBin: '/fake/bin/anvil', env: { HOME: home }, userHome: home, otool: null });
    expect(r.missing).toEqual([]);
    expect(r.error).toBeNull();
  });

  it('missingDylibsFromOtool: 只管本机缺的**非系统**库 (系统库/@rpath 不归 DYLD_LIBRARY_PATH 管)', () => {
    const out = [
      '  /x/anvil:',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.120.2)',
      '\t/System/Library/Frameworks/IOKit.framework/Versions/A/IOKit (compatibility version 1.0.0, current version 275.0.0)',
      '\t@rpath/libfoo.dylib (compatibility version 1.0.0, current version 1.0.0)',
      '\t/opt/weird/lib/libusb-1.0.0.dylib (compatibility version 7.0.0, current version 7.0.0)',
      '\t/usr/local/lib/present.dylib (compatibility version 1.0.0, current version 1.0.0)',
      '',
    ].join('\n');
    const exists = (p: string) => p === '/usr/local/lib/present.dylib';
    expect(missingDylibsFromOtool('/x/anvil', out, exists)).toEqual(['/opt/weird/lib/libusb-1.0.0.dylib']);
  });

  it('realUserHome: 不看 $HOME (干净 HOME 下仍是账号真实 HOME)', () => {
    const real = realUserHome({ HOME: '/definitely/not/a/home' });
    expect(real).not.toBe('/definitely/not/a/home');
    expect(real).toBe(os.userInfo().homedir);
  });

  it('defaultAnvilBin: ANVIL_BIN 优先; 没有时探测真实账号 HOME 的 ~/.foundry/bin/anvil', () => {
    expect(defaultAnvilBin({ ANVIL_BIN: '/custom/anvil' })).toBe('/custom/anvil');
    expect(defaultAnvilBin({ HOME: '/nonexistent-home' }))
      .toBe(path.join(realUserHome({ HOME: '/nonexistent-home' }), '.foundry', 'bin', 'anvil'));
  });
});

describe('anvil 子进程 env — 显式白名单 (PATH / HOME / DYLD_LIBRARY_PATH 必须在)', () => {
  const probed = (): DylibProbeResult => {
    const userHome = tmp('bolloon-env-userhome-');
    putDylib(path.join(userHome, '.local', 'lib'));
    return probeMacosDylibs({
      anvilBin: '/fake/bin/anvil', env: { HOME: '/nonexistent-home' }, userHome, otool: saidOtool,
    });
  };

  it('★ 白名单明文包含 PATH / HOME / DYLD_LIBRARY_PATH', () => {
    expect(ANVIL_ENV_WHITELIST).toContain('PATH');
    expect(ANVIL_ENV_WHITELIST).toContain('HOME');
    expect(ANVIL_ENV_WHITELIST).toContain('DYLD_LIBRARY_PATH');
    expect(ANVIL_ENV_PREFIXES).toContain('DYLD_');
  });

  it('★ 透传这三项, 且 DYLD_LIBRARY_PATH = 探测结果 (不是 null / 不是过期的原值)', () => {
    const p = probed();
    expect(p.dyldLibraryPath).toBeTruthy();
    const child = buildAnvilChildEnv(p, {
      PATH: '/usr/bin:/bin', HOME: '/nonexistent-home', LANG: 'zh_CN.UTF-8',
      DYLD_LIBRARY_PATH: '/stale/value', FOUNDRY_PROFILE: 'ci', DYLD_PRINT_LIBRARIES: '1',
      BOLLOON_WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),   // 红线: 链私钥不许进 anvil 进程
      BOLLOON_CHAIN_RPC_URL: 'http://127.0.0.1:8545',
      UNRELATED_VAR: 'nope',
    });
    expect(child.PATH).toBe('/usr/bin:/bin');
    expect(child.HOME).toBe('/nonexistent-home');
    expect(child.DYLD_LIBRARY_PATH).toBe(p.dyldLibraryPath);
    expect(String(child.DYLD_LIBRARY_PATH)).toContain(p.dirs[0]);
    // 前缀白名单 (foundry 自己的配置 / dyld 调试开关) 照旧透传
    expect(child.FOUNDRY_PROFILE).toBe('ci');
    expect(child.DYLD_PRINT_LIBRARIES).toBe('1');
    // 白名单外的: 一律不透传 (尤其链私钥/链配置)
    expect(child.BOLLOON_WALLET_PRIVATE_KEY).toBeUndefined();
    expect(child.BOLLOON_CHAIN_RPC_URL).toBeUndefined();
    expect(child.UNRELATED_VAR).toBeUndefined();
  });

  it('base 里没有 HOME 时补账号真实 HOME (anvil 也要能找到自己的配置)', () => {
    const child = buildAnvilChildEnv(probed(), { PATH: '/usr/bin' });
    expect(child.HOME).toBe(realUserHome({}));
  });
});

describe('startIsolatedDevChain — 起链前的可操作报错 (不把真因拖成 30s 超时)', () => {
  it('anvil 文件不存在 → 点名路径 + 怎么修, 不炸进程', async () => {
    await expect(startIsolatedDevChain({ anvilBin: '/definitely/not/here/anvil' }))
      .rejects.toThrow(/找不到 anvil[\s\S]*ANVIL_BIN/);
  });
});

// ── 本机真 anvil 的正向探测 (不存在 otool/库就自动跳过; 不绑定任何机器) ────────
const REAL_ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), '.foundry', 'bin', 'anvil');
const realProbe: DylibProbeResult | null = fs.existsSync(REAL_ANVIL)
  ? probeMacosDylibs({ anvilBin: REAL_ANVIL })
  : null;

describe('本机真 anvil (有就验, 没有就跳过)', () => {
  it('真 otool 认出的缺失库, 真能被候选目录补上', () => {
    if (!realProbe || realProbe.error) {
      console.log(`  [跳过] 本机真 anvil 探测不出可用结果: ${realProbe?.error ?? 'anvil 不存在'}`);
      return;
    }
    // 缺什么就必须在 dirs 里真能找到同名库; 且传下去的值必须含那个目录
    for (const n of realProbe.neededNames) {
      const provider = realProbe.dirs.find((d) => fs.existsSync(path.join(d, n)));
      expect(provider, `neededNames=${n} dirs=${realProbe.dirs.join(',')}`).toBeTruthy();
      expect(String(realProbe.dyldLibraryPath).split(':')).toContain(provider);
    }
    console.log(`  [本机] anvil=${realProbe.anvilBin} 缺失=${realProbe.missing.join(',') || '(无)'} → DYLD_LIBRARY_PATH=${realProbe.dyldLibraryPath ?? '(空)'}`);
  });
});
