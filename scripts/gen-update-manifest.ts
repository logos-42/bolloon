/**
 * 生成 Tauri v2 更新清单 (latest.json)
 *
 * 用法:
 *   npx tsx scripts/gen-update-manifest.ts \
 *     --bundle-dir rust/app-tauri/src-tauri/target/release/bundle \
 *     --version 0.6.15 \
 *     --notes "修复更新流程" \
 *     --base-url https://releases.bolloon.app/update \
 *     [--out latest.json] [--date 2026-10-29T12:00:00Z]
 *
 * 它会递归扫描 --bundle-dir 下所有 *.sig 文件, 每个 .sig 对应一个更新包 (去掉 .sig 即为产物本体),
 * 据此推断 Tauri 的 platform key ({target}-{arch}), 读取 .sig 内容作为 signature,
 * 并把 url 拼成 <base-url>/<产物相对路径>.
 *
 * 清单格式 (Tauri v2 updater 要求):
 *   { "version","notes","pub_date","platforms": { "<target>-<arch>": { "signature","url" } } }
 *
 * 平台键约定 (必须与 tauri.conf.json 的 target/arch 对齐):
 *   darwin-aarch64 / darwin-x86_64 / darwin-universal
 *   linux-x86_64 / linux-aarch64
 *   windows-x86_64 / windows-aarch64 (NSIS 更新包)
 */
import * as fs from 'fs';
import * as path from 'path';

interface Args {
  bundleDir: string;
  version: string;
  notes: string;
  baseUrl: string;
  out: string;
  date?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([\w-]+)$/);
    if (m) { a[m[1]] = argv[i + 1]; i++; }
  }
  const need = (k: string) => { if (!a[k]) throw new Error(`缺少必需参数 --${k}`); return a[k]; };
  return {
    bundleDir: a['bundle-dir'] || 'rust/app-tauri/src-tauri/target/release/bundle',
    version: a['version'] || '',
    notes: a['notes'] || '',
    baseUrl: (a['base-url'] || 'https://releases.bolloon.app/update').replace(/\/$/, ''),
    out: a['out'] || 'latest.json',
    date: a['date'],
  };
}

/** 从产物路径推断 Tauri platform key。返回 null 表示无法识别 (跳过并告警)。 */
export function inferPlatformKey(rel: string): string | null {
  const lower = rel.toLowerCase().replace(/\\/g, '/');
  let target: string | null = null;
  if (lower.includes('/macos/') || lower.endsWith('.app.tar.gz') || lower.includes('.app.')) target = 'darwin';
  else if (lower.includes('/nsis/') || lower.endsWith('.nsis') || lower.includes('-setup')) target = 'windows';
  else if (lower.includes('/appimage/') || lower.endsWith('.appimage')) target = 'linux';
  if (!target) return null;

  let arch = 'x86_64';
  if (/aarch64/.test(lower)) arch = 'aarch64';
  else if (/arm64/.test(lower)) arch = 'aarch64'; // Tauri 用 aarch64 这个写法
  else if (/x64/.test(lower) || /x86_64/.test(lower)) arch = 'x86_64';
  else if (/universal/.test(lower)) return 'darwin-universal';
  return `${target}-${arch}`;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) {
    // 默认从 tauri.conf.json 读 version
    try {
      const conf = JSON.parse(fs.readFileSync('rust/app-tauri/src-tauri/tauri.conf.json', 'utf8'));
      args.version = conf.version;
    } catch { /* ignore */ }
  }
  if (!args.version) throw new Error('无法确定版本: 传 --version 或在 tauri.conf.json 提供');

  const all = walk(args.bundleDir).filter((f) => f.endsWith('.sig'));
  const platforms: Record<string, { signature: string; url: string }> = {};
  const warnings: string[] = [];

  for (const sig of all) {
    const artifact = sig.slice(0, -4); // 去掉 ".sig"
    if (!fs.existsSync(artifact)) { warnings.push(`跳过: 找不到产物本体 ${artifact}`); continue; }
    const key = inferPlatformKey(path.relative(args.bundleDir, artifact));
    if (!key) { warnings.push(`跳过: 无法推断平台键 ${artifact}`); continue; }
    const signature = fs.readFileSync(sig, 'utf8').trim();
    const url = `${args.baseUrl}/${path.relative(args.bundleDir, artifact).replace(/\\/g, '/')}`;
    platforms[key] = { signature, url };
    console.error(`  + ${key} -> ${url}`);
  }

  const keys = Object.keys(platforms);
  if (keys.length === 0) {
    throw new Error('未在 bundle 目录找到任何 .sig 更新包。请先 `cargo tauri build` 且配置了 plugins.updater。');
  }

  const manifest = {
    version: args.version,
    notes: args.notes,
    pub_date: args.date || new Date().toISOString(),
    platforms,
  };
  fs.writeFileSync(args.out, JSON.stringify(manifest, null, 2) + '\n');
  console.error(`\n✓ 清单已写入 ${args.out} (${keys.length} 个平台: ${keys.join(', ')})`);
  if (warnings.length) { console.error('⚠ 警告:'); warnings.forEach((w) => console.error('   ' + w)); }
  console.error('\n下一步: 把 latest.json 与各平台产物本体 (app.tar.gz/nsis/AppImage) 一起托管到');
  console.error(`      ${args.baseUrl}/  (与 tauri.conf.json 的 endpoints 对齐)`);
}

// 仅当本脚本被直接执行时才跑 main() (被测试 import 时不跑)
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].includes('gen-update-manifest')) {
  main();
}
