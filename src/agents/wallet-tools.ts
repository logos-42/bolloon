/**
 * wallet-tools.ts — 钱包工具的**双布局加载器** (2026-09-30)
 *
 * 为什么要有这个文件:
 *   钱包真身是 `constraint-runtime` 里的 `tools/WalletTools/*`。构建 (`npm run build:main` =
 *   `tsc && node scripts/copy-constraint-runtime.mjs`) 把 `src/constraint-runtime/dist/*`
 *   复制成 `dist/constraint-runtime/*` —— **少一层 `dist/`**。于是同一句相对导入:
 *       `../constraint-runtime/dist/tools/WalletTools/createWallet.js`
 *   在源码态 (src/agents) 能解析 ✓, 构建后 (dist/agents) 解析到 `dist/constraint-runtime/dist/…` ✗
 *   ⇒ `wallet_create` 报 `Cannot find module '…/dist/constraint-runtime/src/tools/…'` (leo 2026-09-30 贴的屏),
 *   而 `/wallet` 又因为"从来没写过文件"显示「钱包 (0)」—— 两个毛病叠在一起, 看着像"钱包功能不存在"。
 *
 * 规则: **按存在的路径挑**, 挑不到就抛错并**列出试过的路径** (不许含糊成"未知错误")。
 * 注意: 这里用**变量**给 `import()` ⇒ 不做静态解析 (跨布局本来就不能静态解析)。
 */

import * as path from 'path';
import { pathToFileURL } from 'url';
// 2026-09-30: 不用 import.meta —— 本文件会被 electron 那条 CJS 链间接引到,
//   `tsc -p tsconfig.electron.json` 会报 TS1343 (module: CommonJS 下不允许 import.meta),
//   而 `npm publish` 的 prepublishOnly (build:all → build:electron) 会因此挂住。
//   仓里现成的替代: cjsModuleDir() (CJS/ESM 都能用) + currentPackageRoot() + firstExisting()。
import { cjsModuleDir, firstExisting } from '../utils/module-context.js';
import { currentPackageRoot } from '../utils/version-info.js';

/** constraint-runtime 里可用的钱包相关模块 */
export type WalletToolName =
  | 'createWallet' | 'importWallet' | 'getBalance' | 'signMessage'
  | 'sendTransaction' | 'transferToken' | 'autoPay';

/** 候选路径 (先近后远; 覆盖 dev / dist 两种布局) */
export function walletToolCandidates(name: WalletToolName): string[] {
  const root = (() => { try { return currentPackageRoot(); } catch { return process.cwd(); } })();
  const here = cjsModuleDir() || path.join(root, 'dist', 'agents');   // src/agents 或 dist/agents
  return [
    // ① 构建后布局: dist/constraint-runtime/tools/… (从 dist/agents 出发)
    path.join(here, '..', 'constraint-runtime', 'tools', 'WalletTools', `${name}.js`),
    // ② 源码态布局: src/constraint-runtime/dist/tools/… (从 src/agents 出发)
    path.join(here, '..', 'constraint-runtime', 'dist', 'tools', 'WalletTools', `${name}.js`),
    // ③ 兜底: 从仓根分别按两种布局找
    path.join(root, 'dist', 'constraint-runtime', 'tools', 'WalletTools', `${name}.js`),
    path.join(root, 'src', 'constraint-runtime', 'dist', 'tools', 'WalletTools', `${name}.js`),
  ];
}

/** 加载一个钱包工具模块 (挑第一个真实存在的; 都不在就带着"试过哪些"报错) */
export async function loadWalletTool<T = any>(name: WalletToolName): Promise<T> {
  const tried = walletToolCandidates(name);
  const hit = firstExisting(tried);
  if (hit) return (await import(pathToFileURL(hit).href)) as T;
  throw new Error(`找不到钱包工具 ${name} (试过 ${tried.length} 个路径):\n    ${tried.join('\n    ')}`);
}

/** 给诊断用: 当前各自解析到哪 (打印用的字符串, 不加载) */
export function walletToolLayout(): { pattern: string; exists: boolean }[] {
  const names: WalletToolName[] = ['createWallet', 'getBalance', 'signMessage'];
  const out: { pattern: string; exists: boolean }[] = [];
  for (const n of names) {
    for (const c of walletToolCandidates(n)) {
      if (out.some(o => o.pattern === c)) continue;
      out.push({ pattern: c, exists: firstExisting([c]) !== null });
    }
  }
  return out;
}
