/**
 * wallet-table.ts — `/wallet` 的钱包表格渲染 (leo 2026-09-30: 「钱包格式也统一一个表格」)
 *
 * 为什么单独抽出来: 表格的**对齐/裁宽**必须能确定性验证 —— 之前它内联在 CLI 的 /wallet 分支里,
 *   只能靠 PTY 抓包看 (那工具这轮抽风 6 次只成 2 次), 验证变成了碰运气。
 *   抽成纯函数 (进 list, 出 string[] 无 ANSI) ⇒ 可以直接跑、直接看列宽对不对 (含中文名列)。
 *
 * 与 `/sessions` 同一套口径: 列宽按终端宽动态分配; 中文按**显示宽**对齐 (dispWidth);
 *   地址优先给满 42 字符 (能直接复制), 列宽不足才退回缩写 (0x1234…abcd) —— 不截半截地址。
 */

import { dispWidth, truncate } from './loading-tui.js';
import type { WalletRec } from './wallet-store.js';

export interface WalletTableOpts {
  /** 终端列数 (termWidth()) */
  width: number;
  /** 地址缩写函数 (列宽不够时用) */
  shortAddr: (a: string) => string;
  /** 表头语言: 默认中文表头 */
  lang?: 'zh' | 'en';
}

/**
 * 返回表格行 (无 ANSI): [表头, 分隔线, ...数据行]
 * 调用方负责加颜色前缀/缩进。
 */
export function renderWalletTable(list: WalletRec[], opts: WalletTableOpts): string[] {
  const zh = opts.lang !== 'en';
  const PAD = (v: string, w: number) => v + ' '.repeat(Math.max(0, w - dispWidth(v)));
  const avail = Math.max(60, opts.width - 2);
  const wN = 3, wChain = 8, wSrc = 6, wDate = 10;
  const fixed = wN + wChain + wSrc + wDate + 5;          // 5 = 列间空格
  const wAddr = Math.max(13, Math.min(42, Math.floor((avail - fixed) * 0.55)));
  const wName = Math.max(12, avail - fixed - wAddr);
  const cols = [wN, wName, wAddr, wChain, wSrc, wDate];
  const hdr = [
    PAD('#', wN),
    PAD(zh ? '名字' : 'Name', wName),
    PAD(zh ? '地址' : 'Address', wAddr),
    PAD(zh ? '链' : 'Chain', wChain),
    PAD(zh ? '来源' : 'Source', wSrc),
    PAD(zh ? '建立' : 'Created', wDate),
  ].join(' ');
  const rule = cols.map(w => '─'.repeat(w)).join(' ');
  const rows = list.map((w, k) => {
    const addr = wAddr >= 42 ? w.address : opts.shortAddr(w.address);
    return [
      PAD(String(k + 1), wN),
      PAD(truncate(w.name, wName), wName),
      PAD(truncate(addr, wAddr), wAddr),
      PAD(truncate(w.network || '—', wChain), wChain),
      PAD(w.source === 'imported' ? (zh ? '导入' : 'imported') : (zh ? '生成' : 'created'), wSrc),
      PAD(String(w.createdAt).slice(0, 10), wDate),
    ].join(' ');
  });
  return [hdr, rule, ...rows];
}
