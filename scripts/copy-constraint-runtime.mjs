/**
 * 把 constraint-runtime workspace 的编译产物复制到主 dist/constraint-runtime.
 *
 * 背景 (2026-08-04): pi-sdk-tools 用相对路径 import '../constraint-runtime/dist/...'
 *  (wallet / polymarket / safe 工具动态导入), 但主 tsconfig exclude 了 workspace,
 *  主 tsc 不编译它 → dist/constraint-runtime 缺失 → 编译版 (全局安装 / 发布包) 里
 *  wallet/polymarket 工具全部模块缺失. build:main 后执行本脚本补齐.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'constraint-runtime', 'dist');
const dest = path.join(root, 'dist', 'constraint-runtime');

if (!fs.existsSync(src)) {
  console.warn(`[copy-constraint-runtime] 源不存在: ${src} (先跑 npm run build --workspaces)`);
  process.exit(0);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[copy-constraint-runtime] ${src} → ${dest}`);
