/**
 * env-loader.ts — 集中环境变量解析
 *
 * 两条硬不变量:
 *   1. **密钥在 `.env`, 设置在 config** —— 密钥不进配置文件明文。
 *      `~/.bolloon/.env` (0600) 放密钥, `bolloon-config.json` 只放设置。
 *   2. **home 统一解析** (profile-safe, 不硬编码 `~/.bolloon`)。
 *      `$BOLLOON_HOME` 一处解析 (bolloonHome), 全仓复用 —— 桌面版据此把数据目录
 *      指到各系统规范位置 (macOS Application Support / Windows %APPDATA% / Linux XDG)。
 *
 * 本模块提供:
 *   - `bolloonHome()`      — 统一 home 解析 (env BOLLOON_HOME → HOME/.bolloon)
 *   - `loadDotEnvSync()`   — 启动时把 `<home>/.env` 加载进 process.env (不覆盖已有值)
 *   - `envStr()`           — 类型安全读取 (默认值 + 去空白)
 *
 * 约定: `.env` 按 `KEY=VALUE` 解析 (忽略空行/注释/引号), 幂等 (只加载一次)。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 统一 home 解析: `$BOLLOON_HOME` 优先, 否则 `<HOME>/.bolloon` */
export function bolloonHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.BOLLOON_HOME?.trim();
  if (explicit) return explicit;
  return path.join(env.HOME || os.homedir() || '/tmp', '.bolloon');
}

/** 类型安全读取: 空串/未定义 → 默认值 */
export function envStr(key: string, fallback = '', env: NodeJS.ProcessEnv = process.env): string {
  const v = env[key];
  return v !== undefined && v.trim() !== '' ? v.trim() : fallback;
}

/** 解析单行 `KEY=VALUE` (支持引号包裹与 # 注释) */
export function parseDotEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = trimmed.slice(eq + 1).trim();
  // 剥掉匹配的引号
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  // 行内注释 (引号外)
  const hash = value.indexOf(' #');
  if (hash > 0) value = value.slice(0, hash).trim();
  return { key, value };
}

let _loaded = false;

/**
 * 启动时调用: 读 `<home>/.env` (0600), 把 KEY=VALUE 灌入 process.env。
 * 不覆盖已存在的环境变量 (真实 shell env 优先于 .env 文件, 对标 dotenv 默认行为)。
 * 幂等: 进程内只加载一次; 文件不存在静默跳过。
 */
export function loadDotEnvSync(home?: string, env: NodeJS.ProcessEnv = process.env): number {
  if (_loaded) return 0;
  _loaded = true;
  const dir = home ?? bolloonHome();
  const dotEnvPath = path.join(dir, '.env');
  let raw: string;
  try {
    raw = fs.readFileSync(dotEnvPath, 'utf8');
  } catch {
    return 0; // 无 .env 静默
  }
  let loaded = 0;
  for (const line of raw.split('\n')) {
    const parsed = parseDotEnvLine(line);
    if (!parsed) continue;
    if (env[parsed.key] === undefined || env[parsed.key] === '') {
      env[parsed.key] = parsed.value;
      loaded++;
    }
  }
  return loaded;
}

/** 允许测试重置幂等标记 */
export function __resetDotEnvLoaded(): void {
  _loaded = false;
}