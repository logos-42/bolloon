/**
 * status-segments.ts — 状态栏右侧"活数据"段的纯函数 (leo 2026-09-30)
 *
 * 为什么抽出来: 这段原来内联在 `getStatus()` 里, 只能靠 PTY 抓包看 (那工具不稳),
 *   于是"到底什么时候显示什么"变成谁也说不清的事 —— leo 连着问了几次「这些标识没出现」。
 *   抽成纯函数后: 每种状态**直接跑一遍**, 显示什么、什么时候显示, 一张表说清楚。
 *
 * 语义 (刻意的, 不许改着好看):
 *   ◷ 本轮用时     —— 只在**本轮真的在跑**时显示 (有确切起点才有数)
 *   ↑ ≈N t/s       —— 有**实测**吞吐记录才算 (pi-ai 的 reply 字节 / 耗时); 字节折 token ~3.5B 是估, 所以标 ≈
 *   ⚙ N            —— **常显** (0 = 没有在跑的工具; 0 也是真话, 至少让人看出这段功能是活的)
 *   ✓ Ns           —— 只在上一步真有耗时 (>0) 时显示
 *   没有数据的段一律**不显示** —— 绝不编 0 秒 / 假速率
 */

export interface StatusFacts {
  /** 本轮是否在跑 (cliTurnStartedAt > 0) */
  running: boolean;
  /** 本轮已用时 ms (running 时有效) */
  turnElapsedMs: number;
  /** 上一步用时 ms (0 = 还没跑过) */
  lastTurnMs: number;
  /** 上一步回复字节数 (0 = 还没量到) */
  lastTurnReplyBytes: number;
  /** 在跑的工具数 (常显, 0 也显示) */
  toolCount: number;
  /** 最近一次模型调用的实测吞吐 (null = 本进程还没成功调过) */
  aiTiming?: { bytes: number; ms: number; at: number } | null;
  /** 本轮起点 (用于判断 aiTiming 是否属于本轮) */
  turnStartedAt?: number;
  /** 最近一次模型调用的用量 (算缓存命中率 ◎) */
  aiUsage?: { cached: number; prompt: number; at: number } | null;
}

/** 字节 → token 的估算比 (只有这一步是估, 所以显示时标 ≈) */
export const BYTES_PER_TOKEN = 3.5;

/** 返回"标签 值"对 (无 ANSI, 调用方拼颜色) —— 顺序: ◷ ↑ ⚙ ✓ */
export function statusSegments(f: StatusFacts): string[] {
  const out: string[] = [];
  if (f.running) {
    const secs = Math.max(0.1, f.turnElapsedMs / 1000);
    out.push(`◷ ${secs.toFixed(1)}s`);
    const ti = f.aiTiming;
    if (ti && ti.ms > 0 && ti.bytes > 0 && (!f.turnStartedAt || ti.at >= f.turnStartedAt)) {
      const tps = Math.round(ti.bytes / BYTES_PER_TOKEN / (ti.ms / 1000));
      if (tps > 0) out.push(`↑ ≈${tps} t/s`);
    }
  } else if (f.lastTurnMs > 0) {
    out.push(`✓ ${(f.lastTurnMs / 1000).toFixed(1)}s`);
    if (f.lastTurnReplyBytes > 0) {
      const tps = Math.round(f.lastTurnReplyBytes / BYTES_PER_TOKEN / Math.max(0.1, f.lastTurnMs / 1000));
      if (tps > 0) out.push(`↑ ≈${tps} t/s`);
    }
  }
  // ◎ 缓存命中率 = cached / prompt (provider 给的实测值; 没记录/没 prompt 就不显示)
  const u = f.aiUsage;
  if (u && u.prompt > 0) {
    const pct = (u.cached / u.prompt) * 100;
    out.push(`◎ ${pct.toFixed(1)}%`);
  }
  out.push(`⚙ ${f.toolCount}`);        // 常显
  return out;
}

/**
 * 按可用宽度取舍 (2026-09-30, 真机抓包照出来的问题):
 *   整行 ~130 字符, 112 列终端里**右边的段直接被截掉** ⇒ 看着像"没出现"。
 *   规则: 丢的顺序 = ↑ → ◎ → ✓ → ◷ (⚙ 永不丢 —— 它最短, 且"有没有在跑工具"最有信息量);
 *   每一段都按显示宽算 (中文 2 列)。
 */
export function fitSegments(segs: string[], avail: number): string[] {
  const w = (s: string) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  const dropOrder = ['↑', '◎', '✓', '◷'];        // 先丢谁 (从重要性的低到高)
  let cur = [...segs];
  const total = () => cur.reduce((n, s) => n + w(s), 0) + Math.max(0, cur.length - 1) * 3;   // 3 = ' │ '
  for (const tag of dropOrder) {
    if (total() <= avail) break;
    const i = cur.findIndex(s => s.startsWith(tag));
    if (i >= 0) cur.splice(i, 1);
  }
  return cur;
}
