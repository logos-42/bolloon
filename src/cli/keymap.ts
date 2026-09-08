// ─── 输入层 keymap (Hermes 学习 #7) ────────────────────────────────────────
//   正常模式按键绑定表 + 纯函数 resolver: useInput 只做分发, 键->意图映射集中在这,
//   便于单测与扩展 (新增 Ctrl/Meta 组合不再改 useInput 巨块).
//   注: OSC52 剪贴板 / 精确滚轮 依赖终端能力, Ink useInput 不暴露, 不在本表范围.

export type NormalAction = 'none' | 'scrollUp' | 'scrollDown' | 'scrollHome' | 'scrollEnd';

export interface RawKey {
  ctrl?: boolean;
  meta?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  escape?: boolean;
}

export interface NormalCtx {
  /** transcript 可滚动 (行总高 > 可视区) */
  scrollable: boolean;
  /** useInput 捕获的原始字符 (用于 ctrl+<letter>) */
  input: string;
}

/** 纯函数绑定表: 键 -> 意图 (仅在 scrollable 时响应滚动) */
export function resolveNormalKey(key: RawKey, ctx: NormalCtx): NormalAction {
  if (!ctx.scrollable) return 'none';
  const ch = ctx.input.toLowerCase();
  // 上滚: Ctrl+U / PgUp / Alt+↑
  if (key.ctrl && ch === 'u' || key.pageUp || key.meta && key.upArrow) return 'scrollUp';
  // 下滚: Ctrl+D / PgDn / Alt+↓
  if (key.ctrl && ch === 'd' || key.pageDown || key.meta && key.downArrow) return 'scrollDown';
  // 顶部: Home / Ctrl+Home
  if (key.home || key.ctrl && ch === 'a') return 'scrollHome';
  // 底部: End / Ctrl+End
  if (key.end || key.ctrl && ch === 'e') return 'scrollEnd';
  return 'none';
}

/** 把意图映射成 scrollTop 平移量 (纯函数, 便于断言) */
export function applyScroll(act: NormalAction, cur: number, page: number, maxTop: number): { next: number; stick: boolean } {
  switch (act) {
    case 'scrollUp':   return { next: Math.max(0, Math.min(cur - page, maxTop)), stick: false };
    case 'scrollDown': { const nx = Math.min(cur + page, maxTop); return { next: nx, stick: nx >= maxTop }; }
    case 'scrollHome': return { next: 0, stick: false };
    case 'scrollEnd':  return { next: maxTop, stick: true };
    default:           return { next: cur, stick: false };
  }
}
