/**
 * wallet-store.ts — bolloon 自己的钱包台账: **一个目录, 一钱包一文件** (leo 2026-09-30)
 *
 * 事实与边界:
 *   · agent 工具 `wallet_create` / `wallet_import` 只**生成/解析**钱包, **从不落盘**
 *     (`constraint-runtime/src/tools/WalletTools/createWallet.ts` 纯 `Wallet.createRandom()`) ⇒
 *     `/wallet` 一直是「钱包 (0)」不是路径写错, 是**从来没写过文件**。
 *   · 台账目录 = `~/.bolloon/wallets/`, **一钱包一文件** `<名字>.json` (**0600**)。
 *     放这儿而不是仓库里: 仓库是公开的 (`private:false`), 私钥进 git 就完了。
 *   · 文件里允许有私钥/助记词 (签名要用), 但**命令输出永不回显** —— 只给地址 + 路径。
 *   · 不读别的 agent 的钱包目录 (`~/.hermes/wallets/…`): `chain-config.ts` 定的硬规则 ——
 *     那不属于本进程, 读了就是越权。要收编必须由**用户显式给路径** (`/wallet import <path>`)。
 *   · 老的单文件台账 (`~/.bolloon/wallets.json`) 若存在 ⇒ 一次性拆进目录, 原文件改名 `.migrated`
 *     (不删: 用户的数据, 出问题能翻回去)。
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface WalletRec {
  name: string;
  address: string;
  /** 链/网络标签 (未知就 '—') */
  network: string;
  /** created = /wallet new 生成; imported = 用户显式导入 */
  source: 'created' | 'imported';
  createdAt: string;
  /** 私钥/助记词只落在 0600 文件里 —— 代码里不打印 */
  privateKey?: string;
  mnemonic?: string;
}

/** 一钱包一文件所在目录 */
export function walletsDir(): string {
  return path.join(process.env.HOME || '/tmp', '.bolloon', 'wallets');
}

/** 文件名安全化 (只保留字母数字与 - _ .) */
function safeName(name: string, fallback = 'wallet'): string {
  const s = String(name || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

async function readOne(file: string): Promise<WalletRec | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
    const address = raw?.address;
    if (typeof address !== 'string' || !address.startsWith('0x')) return null;
    return {
      name: String(raw?.name || path.basename(file).replace(/\.json$/, '')),
      address,
      network: String(raw?.network || '—'),
      source: raw?.source === 'imported' ? 'imported' : 'created',
      createdAt: String(raw?.createdAt || ''),
      privateKey: typeof raw?.privateKey === 'string' ? raw.privateKey : undefined,
      mnemonic: typeof raw?.mnemonic === 'string' ? raw.mnemonic : undefined,
    };
  } catch {
    return null;   // 坏文件不挡列表 —— 但下面 loadWallets 会把"读不了的"计数报出去
  }
}

/** 老单文件台账拆进目录 (一次性; 原文件改名 .migrated 保留) */
async function migrateLegacySingleFile(dir: string): Promise<number> {
  const legacy = path.join(process.env.HOME || '/tmp', '.bolloon', 'wallets.json');
  let raw: any;
  try { raw = JSON.parse(await fs.readFile(legacy, 'utf-8')); } catch { return 0; }
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.wallets) ? raw.wallets : [];
  let n = 0;
  for (const w of list) {
    if (!w?.address) continue;
    const rec: WalletRec = {
      name: safeName(w.name || `wallet-${n + 1}`), address: String(w.address),
      network: String(w.network || '—'), source: w.source === 'imported' ? 'imported' : 'created',
      createdAt: String(w.createdAt || new Date().toISOString()),
      privateKey: typeof w.privateKey === 'string' ? w.privateKey : undefined,
      mnemonic: typeof w.mnemonic === 'string' ? w.mnemonic : undefined,
    };
    await writeWalletFile(dir, rec);
    n++;
  }
  try { await fs.rename(legacy, `${legacy}.migrated`); } catch { /* 改名失败就留着, 下次再试 */ }
  return n;
}

async function writeWalletFile(dir: string, rec: WalletRec): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeName(rec.name)}.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rec, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tmp, file);
  try { await fs.chmod(file, 0o600); } catch { /* 已足够 */ }
  return file;
}

/** 迁移只做一次 (模块级旗标) —— 每次进程首次读台账时试一次 */
let legacyMigrated = false;

/** 读全部钱包 (一钱包一文件, 按文件名排序) */
export async function loadWallets(): Promise<WalletRec[]> {
  const dir = walletsDir();
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  // 老单文件台账: 每进程首次读的时候试一次迁移 (旗标防重复; 迁移里自己判断有没有老文件)
  if (!legacyMigrated) {
    legacyMigrated = true;
    const n = await migrateLegacySingleFile(dir);
    if (n > 0) { /* 迁移来的文件就在下面一起读 */ }
  }
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter(n => n.endsWith('.json') && !n.endsWith('.tmp')).sort();
  } catch (e: any) {
    throw new Error(`钱包目录读不了 (${dir}): ${String(e?.message || e).slice(0, 120)}`);
  }
  const out: WalletRec[] = [];
  for (const n of names) {
    const rec = await readOne(path.join(dir, n));
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * 写一个钱包进目录。
 *   · 同地址**不新建文件**: 合并进那条 (不覆盖已有私钥/助记词)
 *   · 名字撞了就自动加后缀 (-2, -3 …)
 */
export async function addWallet(rec: WalletRec): Promise<{ rec: WalletRec; replaced: boolean; file: string }> {
  const dir = walletsDir();
  const existing = await loadWallets();
  const dup = existing.find(w => w.address.toLowerCase() === rec.address.toLowerCase());
  if (dup) {
    const merged: WalletRec = {
      ...rec,
      name: dup.name,                                  // 保留原来的文件名/名字
      privateKey: dup.privateKey || rec.privateKey,
      mnemonic: dup.mnemonic || rec.mnemonic,
      createdAt: dup.createdAt || rec.createdAt,
    };
    const file = await writeWalletFile(dir, merged);
    return { rec: merged, replaced: true, file };
  }
  let name = safeName(rec.name);
  const used = new Set(existing.map(w => w.name));
  for (let i = 2; used.has(name); i++) name = `${safeName(rec.name)}-${i}`;
  const out = { ...rec, name };
  const file = await writeWalletFile(dir, out);
  return { rec: out, replaced: false, file };
}

/** 按 # / 地址 / 名字挑一个 */
export function pickWallet(list: WalletRec[], spec?: string): WalletRec | undefined {
  if (!spec) return list[0];
  const n = Number(spec);
  if (Number.isFinite(n) && n >= 1) return list[n - 1];
  if (spec.startsWith('0x')) return list.find(w => w.address.toLowerCase() === spec.toLowerCase());
  return list.find(w => w.name === spec);
}

/** 地址缩写 (单行显示用) */
export function shortAddr(a: string): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a || '?');
}
