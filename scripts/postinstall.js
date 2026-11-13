/**
 * Postinstall 脚本 (npm 安装后自动执行)
 *
 * 职责**只有**三件小事 (其余交给 CLI: `bolloon setup` / `bolloon doctor`):
 *   1. 确保 `~/.bolloon` 与必要子目录存在
 *   2. 首次安装才创建 `~/.bolloon/config.json`; 已存在时**只补缺失字段**, 不改用户值
 *   3. 平台上的 bin 可执行位
 *
 * **修正的历史残留 (2026-09-19)**:
 *   - 旧版把 `version: '0.1.12'` 写死进配置 (与当时实际版本 0.4.x 差 30+ 个版本) ——
 *     现在 version 字段一律来自**本包的 package.json**, 且版本事实只认
 *     `package.json` / `bolloon --version` (config.json 里的 version 只是元数据, 不当事实源)。
 *   - 旧版 writeFileSync 直接覆盖写入 —— 现在走**原子写 (tmp + rename)**,
 *     并且**绝不**覆盖已存在的配置 (用户配置优先级最高)。
 *   - 新增的更新开关 (checkUpdates/autoInstall/autoRestart) 只"补缺", 不覆盖已有值。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function log(msg, color = RESET) {
  console.log(color + msg + RESET);
}

/** 本包真实版本 (唯一来源: package.json) —— 绝不再写死。 */
function ownVersion() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    return raw.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function initUserDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const bolloonDir = path.join(home, '.bolloon');

  for (const dir of [bolloonDir, path.join(bolloonDir, 'sessions'), path.join(bolloonDir, 'peer-store')]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log(`  ✓ 创建目录: ${dir}`, GREEN);
    }
  }

  const version = ownVersion();
  const configPath = path.join(bolloonDir, 'config.json');

  if (!fs.existsSync(configPath)) {
    atomicWriteJson(configPath, {
      version,
      initializedAt: new Date().toISOString(),
      updateChannel: 'stable',
      // 2026-09-19 默认: 检查开 / 自动装关 / 自动重启关 (只通知, 不打断长期任务)
      checkUpdates: true,
      autoInstall: false,
      autoRestart: false,
      defaults: { port: 54188, theme: 'dark', autoConnect: true },
      providers: { minimax: { enabled: false }, openai: { enabled: false }, anthropic: { enabled: false } },
    });
    log(`  ✓ 创建配置: ${configPath} (v${version})`, GREEN);
  } else {
    // 已存在: 绝不覆盖用户值, 只补缺失的更新开关 + 刷新 version 元数据
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      log(`  ⚠ 配置存在但无法解析, 保持原样不动 (${err.message})`, YELLOW);
      return bolloonDir;
    }
    let changed = [];
    if (cfg.version !== version) { cfg.version = version; changed.push('version'); }
    if (typeof cfg.checkUpdates !== 'boolean') { cfg.checkUpdates = true; changed.push('checkUpdates'); }
    if (typeof cfg.autoInstall !== 'boolean') { cfg.autoInstall = false; changed.push('autoInstall'); }
    if (typeof cfg.autoRestart !== 'boolean') { cfg.autoRestart = false; changed.push('autoRestart'); }
    if (typeof cfg.updateChannel !== 'string') { cfg.updateChannel = 'stable'; changed.push('updateChannel'); }
    if (changed.length) {
      atomicWriteJson(configPath, cfg);
      log(`  ✓ 配置补齐字段 (未改用户已有值): ${changed.join(', ')}`, GREEN);
    } else {
      log('  ✓ 配置已存在且完整, 未修改', GREEN);
    }
  }

  return bolloonDir;
}

/**
 * 运行时检测 (Phase 7): postinstall **不偷偷安装系统软件** (那需要管理员权限,
 * 由 `bolloon runtime install yes` 在用户知情下做), 但**必须检测 Git/Python**,
 * 不满足就明确把安装标成"未完成", 而不是打印一句"安装完成"。
 */
function detectRuntime(cmd, args = ['--version']) {
  try {
    const r = child_process.spawnSync(cmd, args, { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0 || !r.stdout) return null;
    const m = String(r.stdout).match(/[0-9]+\.[0-9]+(\.[0-9]+)?/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

function inspectRuntimes() {
  const python = detectRuntime('python3') || detectRuntime('python') || null;
  return {
    node: process.version.replace(/^v/, ''),
    npm: detectRuntime('npm'),
    git: detectRuntime('git'),
    python,
  };
}

function writeIncompleteMarker(bolloonDir, missing, runtimes) {
  try {
    const marker = path.join(bolloonDir, 'install-incomplete.json');
    fs.writeFileSync(marker, JSON.stringify({
      at: new Date().toISOString(),
      missing,
      runtimes,
      howToFix: ['bolloon runtime             # 看四个运行时与能力矩阵',
                 'bolloon runtime install yes # 补装 (不偷偷 sudo)'],
      note: 'npm postinstall 不安装系统软件; 缺 Git/Python 时安装不算完成。修复后运行 bolloon runtime 会自动清掉这个文件。',
    }, null, 2));
    return marker;
  } catch {
    return null;
  }
}

function checkNativeDeps() {
  const nativeDeps = ['libp2p', '@diap/sdk'];
  let allOk = true;
  for (const dep of nativeDeps) {
    if (!fs.existsSync(path.join(rootDir, 'node_modules', dep))) {
      log(`  ⚠ 缺少依赖: ${dep}`, YELLOW);
      allOk = false;
    }
  }
  return allOk;
}

function setupPlatform() {
  log(`\n  平台: ${process.platform}`, CYAN);
  if (process.platform === 'win32') {
    // 入口由 package.json 的 bin 字段生成 (npm 自己写 .cmd), 这里不再手造第二份。
    // 2026-11-13: 本包目前只随附 macOS 原生二进制，以前这里静默 return，
    // Windows 用户装完才知道跑不起来。现在如实给出可执行的源码构建路径。
    log('  ⚠ 本包未随附 win32-x64 原生二进制。', YELLOW);
    log('    从源码构建(会带 diap-backend/dht-backend): scripts\\build-windows.cmd', YELLOW);
    log('    或把已有的 bolloon.exe 通过 BOLLOON_NATIVE_BIN 环境变量指给 CLI。', YELLOW);
    return;
  }
  for (const rel of ['bin/bolloon.js', 'bin/bolloon.cjs']) {
    const p = path.join(rootDir, rel);
    if (fs.existsSync(p)) {
      try {
        fs.chmodSync(p, 0o755);
      } catch (err) {
        log(`  ⚠ 无法设置执行权限 (${rel}): ${err.message}`, YELLOW);
      }
    }
  }
}

function main() {
  console.log('\n📦 Bolloon 安装后处理...\n');
  try {
    const bolloonDir = initUserDirs();
    log(`  ✓ 用户数据目录: ${bolloonDir}`, GREEN);

    if (!checkNativeDeps()) {
      log('\n  ⚠ 部分依赖缺失，建议运行: npm install', YELLOW);
    }

    setupPlatform();

    // Phase 7: Node/npm/Git/Python 不全 → 安装**未完成** (不把半成品说成成功)
    const rt = inspectRuntimes();
    const missing = Object.entries(rt).filter(([, v]) => !v).map(([k]) => k);

    if (missing.length === 0) {
      try { fs.unlinkSync(path.join(bolloonDir, 'install-incomplete.json')); } catch { /* 本来就没有 */ }
      console.log(`\n✅ 安装完成 (v${ownVersion()})！\n`);
      console.log(`  Node.js  ✓  ${rt.node}`);
      console.log(`  npm      ✓  ${rt.npm}`);
      console.log(`  Git      ✓  ${rt.git}`);
      console.log(`  Python   ✓  ${rt.python}\n`);
    } else {
      const marker = writeIncompleteMarker(bolloonDir, missing, rt);
      console.log(`\n⚠️  安装**未完成** (v${ownVersion()}): 缺少 ${missing.join(', ')}\n`);
      console.log(`  Node.js  ${rt.node ? '✓' : '✗'}  ${rt.node || '缺失'}`);
      console.log(`  npm      ${rt.npm ? '✓' : '✗'}  ${rt.npm || '缺失'}`);
      console.log(`  Git      ${rt.git ? '✓' : '✗'}  ${rt.git || '缺失'}`);
      console.log(`  Python   ${rt.python ? '✓' : '✗'}  ${rt.python || '缺失'}\n`);
      console.log('  npm 安装不会偷偷装系统软件 (需要管理员权限的动作必须由你同意)。');
      console.log('  补齐办法:');
      console.log('    bolloon runtime             # 看四个运行时与能力矩阵');
      console.log('    bolloon runtime install yes # 补装 (会先给你看计划; 不偷偷 sudo)');
      if (marker) console.log(`  (已记录: ${marker})`);
      console.log('');
    }

    console.log('  使用方式:');
    console.log('    bolloon --version    # 版本 + 安装方式/目录/入口/运行时/是否最新');
    console.log('    bolloon runtime      # 运行时 (Node/npm/Git/Python) 报告');
    console.log('    bolloon doctor       # 安装是否自洽 (入口/版本/更新/运行时)');
    console.log('    bolloon setup        # 初始化向导 (身份 + 模型 + 密钥)');
    console.log('    bolloon --web        # 启动 Web UI');
    console.log('    bolloon --cli        # 命令行模式\n');
    console.log(`  配置文件: ${path.join(bolloonDir, 'config.json')}\n`);
  } catch (err) {
    console.error('\n❌ 安装后处理失败:', err.message);
    console.error('  这通常不影响基本功能，继续安装...\n');
  }
}

main();
