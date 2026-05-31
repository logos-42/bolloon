/**
 * Postinstall 脚本
 * npm 安装后自动执行
 *
 * 主要任务：
 * 1. 确保 bin 目录存在且可执行
 * 2. 初始化本地配置
 * 3. 检查依赖完整性
 */

import * as fs from 'fs';
import * as path from 'path';
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

function initUserDirs() {
  // 创建用户数据目录
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const bolloonDir = path.join(home, '.bolloon');

  const dirs = [
    bolloonDir,
    path.join(bolloonDir, 'sessions'),
    path.join(bolloonDir, 'peer-store'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log(`  ✓ 创建目录: ${dir}`, GREEN);
    }
  }

  // 初始化配置文件
  const configPath = path.join(bolloonDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      version: '0.1.11',
      initializedAt: new Date().toISOString(),
      defaults: {
        port: 54188,
        theme: 'dark',
        autoConnect: true,
      },
      providers: {
        minimax: { enabled: false },
        openai: { enabled: false },
        anthropic: { enabled: false },
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    log(`  ✓ 创建配置: ${configPath}`, GREEN);
  }

  return bolloonDir;
}

function checkNativeDeps() {
  // 检查必要的原生依赖
  const nativeDeps = [
    'libp2p',
    '@diap/sdk',
  ];

  let allOk = true;

  for (const dep of nativeDeps) {
    const depPath = path.join(rootDir, 'node_modules', dep);
    if (!fs.existsSync(depPath)) {
      log(`  ⚠ 缺少依赖: ${dep}`, YELLOW);
      allOk = false;
    }
  }

  return allOk;
}

function setupPlatform() {
  const platform = process.platform;

  log(`\n  平台: ${platform}`, CYAN);

  if (platform === 'win32') {
    // Windows: 确保 .cmd 文件存在
    const binDir = path.join(rootDir, 'bin');
    const cmdPath = path.join(binDir, 'bolloon.cmd');

    if (fs.existsSync(binDir) && !fs.existsSync(cmdPath)) {
      const cmdContent = `@echo off
node "%~dp0..\\dist\\cli.js" %*
`;
      fs.writeFileSync(cmdPath, cmdContent);
      log('  ✓ Windows 入口已创建', GREEN);
    }
  } else {
    // Unix/Linux/Mac: 确保 bin 文件可执行
    const binDir = path.join(rootDir, 'bin');
    const binPath = path.join(binDir, 'bolloon.js');

    if (fs.existsSync(binPath)) {
      try {
        fs.chmodSync(binPath, 0o755);
        log('  ✓ bin/bolloon.js 已设为可执行', GREEN);
      } catch (err) {
        log(`  ⚠ 无法设置执行权限: ${err.message}`, YELLOW);
      }
    }
  }
}

function main() {
  console.log('\n📦 Bolloon 安装后处理...\n');

  try {
    // 1. 初始化用户目录
    const bolloonDir = initUserDirs();
    log(`  ✓ 用户数据目录: ${bolloonDir}`, GREEN);

    // 2. 检查依赖
    const depsOk = checkNativeDeps();
    if (!depsOk) {
      log('\n  ⚠ 部分依赖缺失，建议运行: npm install', YELLOW);
    }

    // 3. 平台特定设置
    setupPlatform();

    console.log('\n✅ 安装完成！\n');
    console.log('  使用方式:');
    console.log('    bolloon              # 启动 GUI');
    console.log('    bolloon --web        # 启动 Web UI');
    console.log('    bolloon --cli        # 命令行模式');
    console.log('    bolloon --help       # 显示帮助\n');
    console.log(`  配置文件: ${path.join(bolloonDir, 'config.json')}\n`);
  } catch (err) {
    console.error('\n❌ 安装后处理失败:', err.message);
    console.error('  这通常不影响基本功能，继续安装...\n');
  }
}

main();