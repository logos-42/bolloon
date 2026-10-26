//! scroll.rs — 正文区滚动的键位表与位移 (纯函数)
//!
//! **复用 TS 原文** `src/cli/keymap.ts` (Hermes 学习 #7): 键→意图映射集中在一张表里,
//!   便于单测与扩展; 滚动位移也是纯函数 (`applyScroll`), 便于断言。
//!
//! 纪律: **仅在 scrollable 时**响应滚动 (正文没超一屏就别动, 否则看着像"页面在跳")。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NormalAction {
    None,
    ScrollUp,
    ScrollDown,
    ScrollHome,
    ScrollEnd,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RawKey {
    pub ctrl: bool,
    pub meta: bool,
    pub page_up: bool,
    pub page_down: bool,
    pub home: bool,
    pub end: bool,
    pub up_arrow: bool,
    pub down_arrow: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct NormalCtx {
    /** transcript 可滚动 (行总高 > 可视区) */
    pub scrollable: bool,
    /** 捕获的原始字符 (用于 ctrl+<letter>) */
    pub input: char,
}

/** 纯函数绑定表: 键 -> 意图 (仅在 scrollable 时响应) */
pub fn resolve_normal_key(key: &RawKey, ctx: &NormalCtx) -> NormalAction {
    if !ctx.scrollable {
        return NormalAction::None;
    }
    let ch = ctx.input.to_ascii_lowercase();
    // 上滚: Ctrl+U / PgUp / Alt+↑
    if (key.ctrl && ch == 'u') || key.page_up || (key.meta && key.up_arrow) {
        return NormalAction::ScrollUp;
    }
    // 下滚: Ctrl+D / PgDn / Alt+↓
    if (key.ctrl && ch == 'd') || key.page_down || (key.meta && key.down_arrow) {
        return NormalAction::ScrollDown;
    }
    // 顶部: Home / Ctrl+A
    if key.home || (key.ctrl && ch == 'a') {
        return NormalAction::ScrollHome;
    }
    // 底部: End / Ctrl+E
    if key.end || (key.ctrl && ch == 'e') {
        return NormalAction::ScrollEnd;
    }
    NormalAction::None
}

/**
 * 把意图映射成 scrollTop 平移量 (纯函数)。
 *
 * `stick` = 是否**贴底跟随**: 滚到底就该继续跟着新输出走; 上滚则**暂停跟随**
 * (leo 口径: 跟随可暂停, End 回底恢复)。
 */
pub fn apply_scroll(act: NormalAction, cur: usize, page: usize, max_top: usize) -> ScrollMove {
    match act {
        NormalAction::ScrollUp => ScrollMove {
            next: cur.saturating_sub(page).min(max_top),
            stick: false,
        },
        NormalAction::ScrollDown => {
            let nx = (cur + page).min(max_top);
            ScrollMove { next: nx, stick: nx >= max_top }
        }
        NormalAction::ScrollHome => ScrollMove { next: 0, stick: false },
        NormalAction::ScrollEnd => ScrollMove { next: max_top, stick: true },
        NormalAction::None => ScrollMove { next: cur, stick: false },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollMove {
    pub next: usize,
    pub stick: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 不可滚 ⇒ 一律不动 (看着像"页面在跳"的根源就是这个判据)
    #[test]
    fn not_scrollable_means_no_action() {
        let ctx = NormalCtx { scrollable: false, input: 'u' };
        let key = RawKey { ctrl: true, ..Default::default() };
        assert_eq!(resolve_normal_key(&key, &ctx), NormalAction::None);
    }

    #[test]
    fn ctrl_u_and_pgup_scroll_up() {
        let ctx = NormalCtx { scrollable: true, input: 'u' };
        assert_eq!(
            resolve_normal_key(&RawKey { ctrl: true, ..Default::default() }, &ctx),
            NormalAction::ScrollUp
        );
        assert_eq!(
            resolve_normal_key(&RawKey { page_up: true, ..Default::default() }, &ctx),
            NormalAction::ScrollUp
        );
    }

    #[test]
    fn ctrl_d_and_pgdn_scroll_down() {
        let ctx = NormalCtx { scrollable: true, input: 'd' };
        assert_eq!(
            resolve_normal_key(&RawKey { ctrl: true, ..Default::default() }, &ctx),
            NormalAction::ScrollDown
        );
    }

    #[test]
    fn home_end_and_ctrl_a_e() {
        let ctx = NormalCtx { scrollable: true, input: 'a' };
        assert_eq!(
            resolve_normal_key(&RawKey { home: true, ..Default::default() }, &ctx),
            NormalAction::ScrollHome
        );
        let ctx_e = NormalCtx { scrollable: true, input: 'e' };
        assert_eq!(
            resolve_normal_key(&RawKey { ctrl: true, ..Default::default() }, &ctx_e),
            NormalAction::ScrollEnd
        );
    }

    /// 位移: 上滚**不贴底** (暂停跟随), 滚到底**恢复跟随**
    #[test]
    fn apply_scroll_stick_semantics() {
        let up = apply_scroll(NormalAction::ScrollUp, 10, 5, 100);
        assert_eq!((up.next, up.stick), (5, false));

        let down = apply_scroll(NormalAction::ScrollDown, 96, 5, 100);
        assert_eq!((down.next, down.stick), (100, true)); // 到底 = 恢复跟随

        let home = apply_scroll(NormalAction::ScrollHome, 50, 5, 100);
        assert_eq!((home.next, home.stick), (0, false));

        let end = apply_scroll(NormalAction::ScrollEnd, 50, 5, 100);
        assert_eq!((end.next, end.stick), (100, true));

        let none = apply_scroll(NormalAction::None, 7, 5, 100);
        assert_eq!((none.next, none.stick), (7, false));
    }

    /// 上滚不越过 0
    #[test]
    fn scroll_up_clamps_at_zero() {
        let m = apply_scroll(NormalAction::ScrollUp, 2, 5, 100);
        assert_eq!(m.next, 0);
    }
}
