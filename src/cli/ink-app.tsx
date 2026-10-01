/**
 * ink-app.tsx — Ink (React for CLI) 渲染入口
 *
 * 用 Yoga flexbox 布局实现: 内容置顶, 输入栏固定底部, 状态栏固定
 *
 * 2026-08-05: @ / # 弹出选择窗 — 输入 @ 命中智能体, / 命中命令+技能+插件, # 命中文件
 *   ↑/↓ 导航, Tab/Enter 选中, Esc 关闭, 弹出窗打开时 TextInput 让出焦点 (focus=false)
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ruleFor } from './status-segments.js';
import { loadInputHistory, appendInputHistory, MEMORY_CAP } from './input-history.js';
import * as fs from 'fs';
import { Static, render, Box, Text, useInput, useApp, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { dispWidth, LOADING_FRAMES as KAOMOJI } from './loading-tui.js';
import type { ToolCallListItem } from './loading-tui.js';
import { THEME, fg } from './theme.js';
import { COMPOSER_PLACEHOLDER, CHAR_EXIT_HINT, POPUP_TITLE_TAB, POPUP_TITLE_AGENT, POPUP_TITLE_FILE, POPUP_TITLE_COMMAND } from './content.js';
import { DOUBLE_ESC_MS, STATUS_TICK_MS, THINK_FRAME_MS } from './timing.js';
import { resolveNormalKey, applyScroll } from './keymap.js';
import { useWidgets } from './widget-host.js';
import { useStore, transcriptStore, uiStore, appendMsg, replaceLastMsg, replaceMarkerMsg, setUiStatus, setUiThinking, setUiTransient } from './stores.js';
import {
  loadAgents,
  loadCommands,
  loadSkills,
  loadPlugins,
  loadFiles,
  getMention,
  matchFileScore,
  type MentionItem,
} from './mention-data.js';

// ─── 组件: 消息列表 ──────────────────────────────────────────────────────────

/** 消息显示行数 (ANSI 剥离后按宽度 wrap 估行; 与 Ink 按父宽 wrap 近似一致) */
function msgVisualLines(text: string, width: number): number {
  let n = 0;
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  for (const line of clean.split('\n')) {
    const w = dispWidth(line);
    n += Math.max(1, Math.ceil(w / Math.max(10, width - 1)));
  }
  return n;
}

/**
 * 分区账本 (2026-09-27 leo 口径: **面板高度必须确立 + 底部输入框打字不许抖**) ——
 * 一屏就是终端的真实行数, 且**每一块的行数是常数**:
 *
 *   行 1 … history                 ← 历史区 (占满剩余高度; 消息窗口 + 弹层都在这里面)
 *   行 history+1                   ← 活动行 (思考/自动整理/暂停跟随提示; **固定预留 1 行**)
 *   行……                           ← 分隔线 / 状态栏 / 分隔线 / 输入栏 / 分隔线 (固定 5 行)
 *
 * 三条硬边界:
 *   · 几何恒定: 打字 / 提示出现 / 补全弹窗出现或消失, **输入行所在行号与其余区域位置一个字不动**
 *     (弹窗**覆盖**在历史区底部 —— 从 history 里扣, 不与固定栏抢位置);
 *   · **渲染总行数 == 终端高** —— 消息窗口切片 + 根容器 `overflow="hidden"` 兜底。
 *     (注: 修前帧高忽高忽低, 一旦某帧 > 终端高, Ink 的 `shouldClearTerminalForFrame` 会在**之后每一帧**
 *      发 `ESC[2J ESC[3J ESC[H` —— 连回滚缓冲一起清, 于是"选不中 / 滚不回"同时出现。帧高恒定 = 那些清屏不再发。)
 *   · 暂停跟随时冻结整帧 (状态栏时钟也不 tick) ⇒ 帧字节不变 ⇒ 终端里的框选/复制不被打断。
 */
const CHROME_LINES = 5;    // 3 条全宽分隔线 + 状态栏 + 输入栏
const ACTIVITY_LINES = 1;  // 活动行 (固定预留, 免得状态一变就推挤历史区)
const RESERVED_LINES = CHROME_LINES + ACTIVITY_LINES;
const MIN_HISTORY_LINES = 1;
/** 弹层最多占几行 (给历史区留出至少 1 行消息, 免得弹窗把历史区吃光) */
const POPUP_MAX_ROWS = 8;

/** 一屏布局账本 (纯函数 —— 验收门直接喂尺寸复核) */
/**
 * 启动面板最多能占几行 = 消息窗口真高 (与渲染同一套预算; 面板按它裁, 免得高过窗口).
 *   2026-09-30: 面板高过窗口时 Ink 清不掉上一帧 ⇒ 退化成"追加", 顶框被反复重画.
 */
export function bootPanelMaxLines(rows: number, cols: number): number {
  const b = layoutBudget({ rows: Math.max(8, Math.floor(rows || 24) - 2), cols: Math.floor(cols || 80) });
  return Math.max(4, b.msgH);
}

/** 面板区高度 (窗口的 60%; 会话区永远留 >=3 行) —— 给启动面板建盒子时对齐用 */
export function bootPanelRegionLines(rows: number, cols: number): number {
  const b = layoutBudget({ rows: Math.max(8, Math.floor(rows || 24) - 2), cols: Math.floor(cols || 80) });
  return Math.max(4, Math.min(Math.floor(b.msgH * 0.6), b.msgH - 3));
}

export function layoutBudget(opts: { rows: number; cols: number; popupRows?: number }): {
  rows: number; cols: number; chrome: number; activity: number; history: number;
  msgH: number; popupRows: number;
} {
  const rows = Math.max(RESERVED_LINES + MIN_HISTORY_LINES, Math.floor(opts.rows || 24));
  const cols = Math.max(20, Math.floor(opts.cols || 80));
  const history = Math.max(MIN_HISTORY_LINES, rows - RESERVED_LINES);
  const popupRows = Math.max(0, Math.min(Math.floor(opts.popupRows || 0), POPUP_MAX_ROWS, Math.max(0, history - MIN_HISTORY_LINES)));
  return {
    rows, cols,
    chrome: CHROME_LINES, activity: ACTIVITY_LINES,
    history, msgH: history - popupRows, popupRows,
  };
}

// 2026-09-08: React.memo — msgs 引用不变时跳过重渲染 (配合虚拟化 slice, status tick 不再整表重绘)
const Messages: React.FC<{ msgs: string[] }> = React.memo(({ msgs }) => (
  <Box flexDirection="column" flexGrow={1} justifyContent="flex-start">
    {msgs.map((m, i) => {
      const clean = m.replace(/\x1b\[[0-9;]*m/g, '');
      return clean.trim() ? <Text key={i}>{clean ? m : ''}</Text> : null;
    })}
  </Box>
));

// ─── 组件: 弹出选择窗 ────────────────────────────────────────────────────────

interface MentionPopupProps {
  title: string;
  items: MentionItem[];
  sel: number;
  width: number;
  loading?: boolean;
  /**
   * 这个弹层**总共占几行** (含上下边框) —— 由 `layoutBudget` 给。
   *
   * 为什么必须给: 弹层画在历史区**内部**(覆盖式), 总行数必须**定死**,
   * 否则"弹窗出现/消失"会改帧高 → 输入行位置跟着动 (leo 报的"打字抖动"就是这一类)。
   */
  maxRows: number;
}

const MentionPopup: React.FC<MentionPopupProps> = ({ title, items, sel, width, loading, maxRows }) => {
  const innerW = Math.max(width - 2, 10);
  // 行账本: 2 行边框 + 正文若干 + (还有更多?1:0) —— 正文裁剪到刚好填满 maxRows
  const totalRows = Math.max(1, maxRows);
  const emptyNote = !loading && items.length === 0;
  let bodyRows = Math.max(0, totalRows - 2 - (emptyNote ? 1 : 0));
  let hasMore = items.length > bodyRows;
  if (hasMore && bodyRows > 0) bodyRows -= 1;   // 给"还有 N 项"让一行
  hasMore = items.length > bodyRows;
  // 2026-08-08: 滑动窗口 — 选中项始终可见 (原实现 fix 屏幕顶部, sel 超窗口时无高亮行)
  const offset = Math.max(0, Math.min(sel - Math.floor(bodyRows / 2), Math.max(0, items.length - bodyRows)));
  const shown = items.slice(offset, offset + bodyRows);
  return (
    <Box flexDirection="column" width={width}>
      <Text color={THEME.accent} bold>{`╭─ ${title} ${'─'.repeat(Math.max(2, innerW - dispWidth(title) - 4))}╮`}</Text>
      {loading && items.length === 0 ? (
        <Text color="dim">│ 扫描中...</Text>
      ) : emptyNote ? (
        <Text color="dim">│ 无匹配</Text>
      ) : (
        shown.map((it, i) => {
          const active = i === sel;
          const label = it.kind === 'file' ? it.label : `${it.kind === 'skill' ? '⚡' : it.kind === 'plugin' ? '🔌' : ''}${it.label}`;
          const hint = it.hint ? `${it.hint}` : it.kind === 'file' ? '文件' : '';
          return (
            <Box key={`${it.kind}:${it.label}`} width={innerW}>
              <Text color={active ? 'black' : undefined} backgroundColor={active ? 'cyan' : undefined}>
                {`${active ? '❯ ' : '  '}${label}`}
              </Text>
              <Text color={active ? 'black' : 'dim'} backgroundColor={active ? 'cyan' : undefined} dimColor={!active}>
                {`  ${hint}`}
              </Text>
            </Box>
          );
        })
      )}
      {hasMore && (
        <Text color="dim">│ {offset + 1}-{offset + shown.length}/{items.length} · 还有 {items.length - (offset + shown.length)} 项...</Text>
      )}
      <Text color={THEME.accent}>{`╰${'─'.repeat(innerW)}╯`}</Text>
    </Box>
  );
};

// ─── 组件: 主应用 ────────────────────────────────────────────────────────────

interface InkAppProps {
  onPrompt: (text: string) => void;
  initialStatus: string;
  getStatusUpdate: () => string;
  terminalW: number;
  terminalH: number;
}

const InkApp: React.FC<InkAppProps> = ({ onPrompt, initialStatus, getStatusUpdate, terminalW, terminalH }) => {
  const [input, setInput] = useState('');
  // 2026-08-07: inputRef 同步镜像 input — useInput 回调拿最新值 (闭包里的 input 是陈旧的)
  const inputRef = useRef('');
  useEffect(() => {
    inputRef.current = input;
  }, [input]);
  // 2026-08-07: 提交防重 (InkApp \n/\r 兜底 + TextInput 双触发场景)
  const lastSubmitRef = useRef({ t: 0, v: '' });
  const msgs = useStore(transcriptStore);        // #2 状态外置: transcript 来自外部 store
  const ui = useStore(uiStore);                  // #2 status/thinking/transient 外置
  const status = ui.status || initialStatus;
  const thinking = ui.thinking;
  const transient = ui.transient;
  // #8 占用槽: 右侧 rails (有 widget 占宽, 无则布局不变)
  const widgets = useWidgets();
  const railNames = Object.keys(widgets);
  const hasRails = railNames.length > 0;
  const { exit } = useApp();

  // 虚拟化滚动: 行窗口 top + 是否跟随底部 (用户上滚后自动跟随关闭, End 恢复)
  const [scrollTop, setScrollTop] = useState(0);
  const stickRef = useRef(true);
  const thinkingIdx = useRef(0);

  // 双击 Esc 退出当前进程 (500ms 窗口内第二次按下)
  const lastEscRef = useRef(0);
  const C_WARN_ANSI = fg(THEME.warn); // #f59e0b

  // ── @ / # 弹出窗状态 ──────────────────────────────────────────────────────
  const mention = useMemo(() => getMention(input), [input]);
  const mentionKey = mention ? `${mention.kind}:${mention.start}` : null;
  const [items, setItems] = useState<MentionItem[]>([]);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  // Tab 补齐弹窗 (非 @ / # 触发的普通 token 补齐): { start, items }
  const [tabState, setTabState] = useState<{ start: number; items: MentionItem[] } | null>(null);
  const agentCache = useRef<MentionItem[] | null>(null);
  const skillCache = useRef<MentionItem[] | null>(null);
  const pluginCache = useRef<MentionItem[] | null>(null);
  const fileCache = useRef<MentionItem[] | null>(null);

  // ── 程序化选择器 (2026-08-06: /login /model 等命令触发, 复用 MentionPopup 渲染) ──
  const [picker, setPicker] = useState<{ title: string; items: MentionItem[]; sel: number } | null>(null);
  const pickerCb = useRef<((item: MentionItem) => void) | null>(null);
  const pickerSelRef = useRef(0);
  /**
   * 2026-09-26: 取消回调。此前 Esc 只把 `pickerCb` 置空并关窗 —— 对"等一个选择结果"的调用方
   * (分步选择器要按步往下走) 来说就是**永远等不到**。现在 Esc/显式关闭都会回调它。
   */
  const pickerCancel = useRef<(() => void) | null>(null);
  // 全局钩子: index.ts 命令打开/关闭选择器
  useEffect(() => {
    (globalThis as any).__inkOpenPicker = (itemsArg: MentionItem[], title: string, onPick: (item: MentionItem) => void, onCancel?: () => void) => {
      pickerSelRef.current = 0;
      pickerCb.current = onPick;
      pickerCancel.current = onCancel ?? null;
      setPicker({ title: title || '选择', items: itemsArg, sel: 0 });
      setInput('');
    };
    (globalThis as any).__inkClosePicker = () => {
      const c = pickerCancel.current;
      pickerCb.current = null;
      pickerCancel.current = null;
      setPicker(null);
      c?.();
    };
    return () => { delete (globalThis as any).__inkOpenPicker; delete (globalThis as any).__inkClosePicker; };
  }, []);

  // ── 输入历史 (↑/↓ 切换) ───────────────────────────────────────────────────
  const historyRef = useRef<string[]>([]);
  // 2026-09-30 (leo: 「输入历史有落盘文件夹吗，要实现一下」): 启动时把落盘历史读回内存 —— 重启后 ↑ 还能翻出来。
  //   异步读, 读回来直接替换 ref (空文件/读失败 = 保持空, 不打扰输入)。
  useEffect(() => {
    let alive = true;
    loadInputHistory().then(h => { if (alive && h.length) historyRef.current = h; }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const historyIdxRef = useRef(-1); // -1 = 正在编辑新草稿
  const draftRef = useRef('');

  // 加载当前 mention 的候选 (agent/command 缓存一次; file 每次打开重扫)
  useEffect(() => {
    if (tabState) { setItems(tabState.items); setSel(0); return; }
    if (!mention || !mentionKey) { setItems([]); return; }
    if (dismissed === mentionKey) { setItems([]); return; }
    let cancelled = false;
    if (mention.kind === 'agent') {
      if (agentCache.current) { setItems(agentCache.current); }
      else {
        loadAgents()
          .then(list => { agentCache.current = list; if (!cancelled) setItems(list); })
          .catch(() => { if (!cancelled) setItems([]); });
      }
    } else if (mention.kind === 'command') {
      // 命令立即显示, 技能/插件异步合并
      const base = loadCommands();
      setItems(base);
      const skillsP = skillCache.current
        ? Promise.resolve(skillCache.current)
        : loadSkills().then(s => { skillCache.current = s; return s; });
      const pluginsP = pluginCache.current
        ? Promise.resolve(pluginCache.current)
        : loadPlugins().then(p => { pluginCache.current = p; return p; });
      Promise.all([skillsP, pluginsP])
        .then(([sk, pl]) => {
          if (cancelled) return;
          const merged = [...base];
          for (const it of [...sk, ...pl]) {
            if (!merged.some(m => m.kind === it.kind && m.label === it.label)) merged.push(it);
          }
          setItems(merged);
        })
        .catch(() => { /* 命令已在 */ });
    } else {
      // file: 每次打开重扫 (cwd 可能变化)
      setLoadingFiles(true);
      loadFiles(mention.query)
        .then(list => { if (!cancelled) { fileCache.current = list; setItems(list); setLoadingFiles(false); } })
        .catch(() => { if (!cancelled) { setItems([]); setLoadingFiles(false); } });
    }
    setSel(0);
    return () => { cancelled = true; };
  }, [mentionKey, dismissed, tabState]);

  // 按查询过滤 + 排序
  const filtered = useMemo(() => {
    if (tabState) return items; // Tab 补齐: 已按前缀过滤好
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    if (!q) return items;
    if (mention.kind === 'file') {
      return items
        .filter(it => matchFileScore(it.label.toLowerCase(), q) >= 0)
        .sort((a, b) => matchFileScore(a.label.toLowerCase(), q) - matchFileScore(b.label.toLowerCase(), q));
    }
    return items.filter(it => it.label.toLowerCase().includes(q));
  }, [items, mention, tabState]);

  const popupOpen = !!(tabState || (mention && dismissed !== mentionKey));
  const safeSel = Math.min(sel, Math.max(0, filtered.length - 1));

  const popupTitle = tabState ? POPUP_TITLE_TAB
    : mention?.kind === 'agent' ? POPUP_TITLE_AGENT
    : mention?.kind === 'file' ? POPUP_TITLE_FILE
    : POPUP_TITLE_COMMAND;

  // 在指定 start 位置插入补齐文本 (函数式更新, 闭包安全)
  const insertAt = useCallback((start: number, it: MentionItem) => {
    setInput(cur => {
      if (start > cur.length) return cur;
      let insertText: string;
      if (it.kind === 'agent') insertText = '@' + it.insert + ' ';
      else if (it.kind === 'file') insertText = '#' + it.insert + ' ';
      else if (it.kind === 'skill') insertText = 'use_skill ' + it.insert + ' ';
      else insertText = '/' + it.insert + ' ';
      return cur.slice(0, start) + insertText;
    });
    // TextInput 内部 cursorOffset 在值被重写后不重置 (2026-08-05 实测),
    // 插入后强制重挂载让光标回到末尾; 仅此一处重挂载, 避免输入丢失窗口
    setTiKey(k => k + 1);
  }, []);

  // 接受当前选中项 → 替换 token 插入输入
  // 函数式更新 + 从最新 state 重新推导 mention (useInput 闭包可能陈旧, 2026-08-05)
  const acceptMention = useCallback((it: MentionItem) => {
    if (tabState) { insertAt(tabState.start, it); setTabState(null); setDismissed(null); return; }
    setInput(cur => {
      const m = getMention(cur);
      if (!m) return cur;
      let insertText: string;
      if (it.kind === 'agent') insertText = '@' + it.insert + ' ';
      else if (it.kind === 'file') insertText = '#' + it.insert + ' ';
      else if (it.kind === 'skill') insertText = 'use_skill ' + it.insert + ' ';
      else insertText = '/' + it.insert + ' ';
      return cur.slice(0, m.start) + insertText;
    });
    setTiKey(k => k + 1);
    setDismissed(null);
  }, [tabState, insertAt]);

  // Tab 命令补齐: 无触发符的普通 token 也补 (命令/技能/插件/智能体/文件)
  const doTabCompletion = useCallback(() => {
    const m = input.match(/(^|\s)([^\s]*)$/);
    if (!m) return;
    const [, pre, token] = m;
    const start = (m.index || 0) + pre.length;
    const q = token.toLowerCase();
    const items: MentionItem[] = [];
    const add = (list: MentionItem[]) => {
      for (const it of list) {
        if (items.some(x => x.kind === it.kind && x.label === it.label)) continue;
        if (it.label.toLowerCase().startsWith(q)) items.push(it);
      }
    };
    if (q) {
      add(loadCommands());
      if (skillCache.current) add(skillCache.current);
      if (pluginCache.current) add(pluginCache.current);
      if (agentCache.current) add(agentCache.current);
      if (fileCache.current) add(fileCache.current);
    } else {
      // 空 token: 命令 + 技能 + 插件
      add(loadCommands());
      if (skillCache.current) add(skillCache.current);
      if (pluginCache.current) add(pluginCache.current);
    }
    if (items.length === 1) {
      insertAt(start, items[0]);
      setTabState(null);
    } else if (items.length > 1) {
      setTabState({ start, items });
      setSel(0);
    }
  }, [input, insertAt]);

  const [tiKey, setTiKey] = useState(0);

  // 2026-09-08 (Hermes TUI 学习落地): 实时终端尺寸 — 原来 terminalW/H 在 mount 时冻结,
  //   终端 resize 后分隔线/logo 宽度全错位 (Hermes 用 resizeCoalescer + 实时 layout)。
  //   订阅 stdout resize, 每次渲染用最新列数。
  const { stdout } = useStdout();
  const [termSize, setTermSize] = useState({ w: terminalW, h: terminalH });
  useEffect(() => {
    // resizeCoalescer (#9): 拖拽终端时会连发 resize — 聚合到 80ms 空闲后一次性应用, 避免中间态跳帧
    let raf: ReturnType<typeof setTimeout> | null = null;
    let pending: { w: number; h: number } | null = null;
    const apply = () => {
      if (pending) { const p = pending; pending = null; setTermSize(p); }
      raf = null;
    };
    const update = () => {
      pending = { w: stdout?.columns || terminalW, h: stdout?.rows || terminalH };
      if (raf) clearTimeout(raf);
      raf = setTimeout(apply, 80);
    };
    update();
    stdout?.on?.('resize', update);
    return () => { stdout?.removeListener?.('resize', update); if (raf) clearTimeout(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);
  const W = termSize.w;

  // 全局: 思考动画控制
  useEffect(() => {
    // 2026-08-06: 防御 — 某些环境 (tsx/完整 CLI 初始化) 下 stdin 会处于 paused,
    // 不恢复则 useInput 收不到任何输入 (实测 isPaused=true, listeners=0)
    if ((process.stdin as any).isPaused()) (process.stdin as any).resume();
    (globalThis as any).__inkSetThinking = (v: boolean) => setUiThinking(v);
    (globalThis as any).__inkAppend = (line: string) => appendMsg(line);
    (globalThis as any).__inkSetStatus = (s: string) => setUiStatus(s);
    // 2026-08-10: 临时状态行 (自动整理/经验整理): 传字符串显示, 传 null 清空 (显示为空)
    (globalThis as any).__inkSetTransient = (v: string | null) => setUiTransient(v);
    // 2026-08-12 (Task4): 原地替换最后一条消息 (命令加载态 → 完成态用). 不命中则追加.
    (globalThis as any).__inkReplaceLast = (line: string) => replaceLastMsg(line);
    // 2026-09-08: 按内容匹配替换 — 占位框可能在 P2P/连接消息之后才被替换,
    //   __inkReplaceLast 会覆盖错一条; 用字符串标记精确定位要替换的消息.
    (globalThis as any).__inkReplaceMatching = (marker: string, line: string) => replaceMarkerMsg(marker, line);
    return () => {
      delete (globalThis as any).__inkAppend;
      delete (globalThis as any).__inkSetStatus;
      delete (globalThis as any).__inkSetThinking;
      delete (globalThis as any).__inkSetTransient;
      delete (globalThis as any).__inkReplaceLast;
    };
  }, []);

  const onSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    // 2026-08-07: 防重 — \n/\r 兜底分支与 TextInput 可能都触发提交, 1.5s 内同值只提交一次
    const now = Date.now();
    if (lastSubmitRef.current.v === trimmed && now - lastSubmitRef.current.t < 1500) return;
    lastSubmitRef.current = { t: now, v: trimmed };
    if (!trimmed) return;
    // 入历史 (去重最近一条) + **落盘** (~/.bolloon/history/input-<渠道>.jsonl, 0600)
    //   秘密形态的输入 (私钥/助记词) 由 appendInputHistory 拦下不写盘 —— 输入历史是纯文本, 写进去就是事故。
    const hist = historyRef.current;
    if (hist[hist.length - 1] !== trimmed) hist.push(trimmed);
    if (hist.length > MEMORY_CAP) hist.shift();
    void appendInputHistory(trimmed);
    historyIdxRef.current = -1;
    draftRef.current = '';
    setInput('');
    // 用户消息由 processInput 统一通过 appendLine(renderUserMessage) 显示
    onPrompt(trimmed);
  }, [onPrompt]);

  /**
   * 输入历史: 上一/下一条。
   *   2026-09-30 (leo: 「历史的上下切换遇到 /session 等指令就无法切换了」) —— 抽出来是因为
   *   历史里一旦出现 `/xxx`, 恢复出来的输入会**打开命令补全弹窗**, 而弹窗把 ↑/↓ 当"移动候选"吃掉
   *   ⇒ 历史再也切不动。现在: **空输入** 或 **已在历史态** 时 ↑/↓ 一律归历史 (见下面优先块)。
   */
  const histUp = useCallback(() => {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (historyIdxRef.current === -1) draftRef.current = inputRef.current;
    if (historyIdxRef.current < hist.length - 1) {
      historyIdxRef.current += 1;
      setInput(hist[hist.length - 1 - historyIdxRef.current]);
      setTiKey(k => k + 1);
    }
  }, []);
  const histDown = useCallback(() => {
    if (historyIdxRef.current === -1) return;
    historyIdxRef.current -= 1;
    if (historyIdxRef.current === -1) setInput(draftRef.current);
    else setInput(historyRef.current[historyRef.current.length - 1 - historyIdxRef.current]);
    setTiKey(k => k + 1);
  }, []);

  useInput((_input, key) => {
    // 退出请求: 通知 startCLI resolve → 走清理 → process.exit (带兜底)
    const requestExit = () => {
      (globalThis as any).__inkRequestExit?.();
      exit();
      // 兜底: 清理路径挂住时 2s 后强制退出
      setTimeout(() => process.exit(0), 2000);
    };
    if (key.ctrl && _input === 'c') {
      requestExit();
      return;
    }

    // ── 输入历史优先 (比补全弹窗更优先) ──
    //   规则: 空输入, 或已经在历史态 (historyIdx !== -1) ⇒ ↑/↓ 归历史, 弹窗/选择器都让路。
    //   只有"用户自己敲了内容且不在历史态"时, 补全弹窗才拥有 ↑/↓。
    if ((key.upArrow || key.downArrow) && (historyIdxRef.current !== -1 || !inputRef.current.trim())) {
      if (key.upArrow) histUp(); else histDown();
      return;
    }

    // ── 程序化选择器: 全键接管 (↑↓ 选择, Enter 确认, Esc 关闭) ──
    if (picker) {
      const itemsArg = picker.items;
      if (key.upArrow) { pickerSelRef.current = Math.max(0, pickerSelRef.current - 1); setPicker({ ...picker, sel: pickerSelRef.current }); return; }
      if (key.downArrow) { pickerSelRef.current = Math.min(itemsArg.length - 1, pickerSelRef.current + 1); setPicker({ ...picker, sel: pickerSelRef.current }); return; }
      if ((key.return || key.tab) && itemsArg.length > 0) {
        const it = itemsArg[Math.min(pickerSelRef.current, itemsArg.length - 1)];
        const cb = pickerCb.current;
        pickerCb.current = null;
        pickerCancel.current = null;
        setPicker(null);
        cb?.(it);
        return;
      }
      if (key.escape) {
        // 取消也要**回调**调用方 (否则等结果的调用方永远挂着)
        const c = pickerCancel.current;
        pickerCb.current = null;
        pickerCancel.current = null;
        setPicker(null);
        c?.();
        return;
      }
      return; // 其余键忽略
    }

    // ── 弹出窗打开: 全键接管 (TextInput focus=false 不处理) ──
    if (popupOpen) {
      if (key.upArrow) { setSel(s => Math.max(0, s - 1)); return; }
      if (key.downArrow) { setSel(s => Math.min(filtered.length - 1, s + 1)); return; }
      if ((key.tab || key.return || /[\n\r]/.test(_input)) && filtered.length > 0) {
        const it = filtered[safeSel];
        if (it) acceptMention(it);
        return;
      }
      if ((key.return || /[\n\r]/.test(_input)) && filtered.length === 0) {
        // 弹窗无匹配项: Enter = 提交当前输入 (否则 /channel 无参 + Enter 永远提交不了 — 2026-08-06)
        const v = input.trim();
        if (v) onSubmit(v);
        else setDismissed(mentionKey);
        return;
      }
      if (key.escape) {
        if (tabState) setTabState(null);
        else setDismissed(mentionKey);
        return;
      }
      if (key.backspace || key.delete) { setInput(cur => cur.slice(0, -1)); return; }
      // 粘贴/连发 chunk: Ink 把一次 stdin read 当单个 keypress (2026-08-05 实测)
      //   ① 连续退格 (\x7f×N) → 删 N 个字符
      //   ② 混合 chunk (退格+控制符, 含 ESC 序列) → 退格部分生效, ESC 序列忽略
      //   ③ 可打印 chunk (CJK/粘贴) → 整串追加
      // 全部用函数式更新 — useInput 闭包可能陈旧 (实测), 函数式取最新 state
      if (/^\x7f+$/.test(_input)) { setInput(cur => cur.slice(0, Math.max(0, cur.length - _input.length))); return; }
      if (/[\x00-\x1f\x7f]/.test(_input)) {
        // 混合 chunk (退格+可打印): 逐字符处理; 含 ESC 序列 → 忽略整块 (箭头等由 TextInput 处理)
        if (_input.includes('\u001b')) return;
        setInput(cur => {
          let out = cur;
          for (const ch of _input) {
            if (ch === '\x7f') out = out.slice(0, -1);
            else if (/[\x00-\x1f]/.test(ch)) continue;
            else out += ch;
          }
          return out;
        });
        return;
      }
      if (_input && !key.ctrl && !key.meta && !key.return) { setInput(cur => cur + _input); return; }
      return; // 其余键忽略 (return/tab/esc 等由 TextInput 或上层处理)
    }

    // ── 正常模式 ──
    // #7 输入层: 滚动键走数据化 keymap (Ctrl+U/D / PgUp/PgDn / Home-End / Alt+↑↓ / Ctrl+Home-End)
    if (false && totalLines > availH) {   // 无限高度: 不再有 app 内虚拟滚动 (PgUp 归终端)
      const pg = Math.max(6, availH - 2);
      const maxT = Math.max(0, totalLines - availH);
      const act = resolveNormalKey(key as any, { scrollable: true, input: _input });
      if (act !== 'none') {
        const r = applyScroll(act, stickRef.current ? maxT : (scrollTop || 0), pg, maxT);
        stickRef.current = r.stick;
        setScrollTop(r.next);
        return;
      }
    }
    // 2026-08-07: Enter 兜底 — pty/管道下 termios 可能把 \r 转 \n 且 node 把整 chunk
    //   当一次 keypress (key.return=false), TextInput 的 onSubmit 永不触发 → 消息发不出去.
    //   应用层把 \n/\r 一律视为提交 (兼容 raw/cooked 两种模式, 不依赖 termios).
    if (/[\n\r]/.test(_input)) {
      const before = String(_input).split(/[\n\r]/)[0];
      const val = inputRef.current + before;
      if (val.trim()) onSubmit(val);
      else setInput('');
      return;
    }
    // Tab 命令补齐 (匹配触发符后的 token 再补)
    if (key.tab) { doTabCompletion(); return; }
    // ↑/↓ 切换输入历史 (TextInput 本身忽略 up/down, 无冲突)
    if (key.upArrow) { histUp(); return; }
    if (key.downArrow) { histDown(); return; }
    // 双击 Esc 退出当前进程: 第一击提示, 500ms 内第二击退出
    //   ⚠ 判据含**字节级兜底** (`_input === '\u001b'`): Ink 对"孤独的 Esc"要先攒 20ms 再吐,
    //   重挂之后实测 `key.escape` 不再为真 —— 与上面 Enter 那条同一个道理 (不依赖 Ink 的键解析)。
    if (key.escape || _input === '\u001b') {
      const now = Date.now();
      if (now - lastEscRef.current < DOUBLE_ESC_MS) {
        requestExit();
      } else {
        lastEscRef.current = now;
        inkAppendLine(`${C_WARN_ANSI}⚠ 再按一次 Esc 退出当前进程\x1b[0m`);
      }
    }
    // 防御: 控制字符 chunk (TextInput 会把整 chunk 当字符追加, 2026-08-05 实测)
    //   setTimeout(0) 保证我们的纠正落在 TextInput 的 onChange 之后 (无论监听器顺序)
    //   \x7f×N → 先剥掉 TextInput 追加的垃圾, 再删 N 个真实字符
    if (/^\x7f+$/.test(_input)) {
      const n = _input.length;
      setTimeout(() => setInput(cur => {
        const cleaned = cur.replace(/[\x00-\x1f\x7f]+$/, '');
        return cleaned.slice(0, Math.max(0, cleaned.length - n));
      }), 0);
      return;
    }
    if (/[\x00-\x1f\x7f]/.test(_input)) {
      setTimeout(() => setInput(cur => cur.replace(/[\x00-\x1f\x7f]+$/, '')), 0);
      return;
    }
    // TextInput handles actual input; useInput only for Ctrl+C / Esc
  });

  // 自动更新状态栏 (每秒)
  // 2026-08-07 修复: 依赖必须为空 [] — [getStatusUpdate] 在渲染间引用变化 (Ink 内部元素重建),
  //   effect 每次渲染 cleanup+setup → setInterval 刚建立就被清除 → 永不 tick → 状态栏恒初始值.
  // 2026-09-27: **暂停跟随时不 tick** —— 用户上滚后整帧冻结 (Ink 的 log-update 在输出相同时
  //   一个字节都不写), 于是终端里的框选/复制不会被打断, 也保证"底部行字节不再变化"。
  useEffect(() => {
    // 挂载时立即同步刷新一次状态栏 (不等 1s 后第一个 tick)
    try {
      const s0 = getStatusUpdate();
      if (s0) setUiStatus(s0);
    } catch { /* 状态栏更新失败不致命 */ }
    const timer = setInterval(() => {
      if (!stickRef.current) return;   // 暂停跟随: 冻结整帧 (回到最底自动恢复)
      try {
        const s = getStatusUpdate();
        if (s) setUiStatus(s);
      } catch { /* 状态栏更新失败不致命 */ }
    }, STATUS_TICK_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 调试/测试钩子: 输入变化时通知外部 (pty 测试用)
  useEffect(() => {
    (globalThis as any).__inkOnInput?.(input);
  }, [input]);

  // 调试/测试钩子: 弹出窗状态 (pty 测试用)
  useEffect(() => {
    (globalThis as any).__inkOnPopup?.({
      open: popupOpen,
      key: mentionKey,
      count: filtered.length,
      items: filtered.slice(0, 5).map(i => i.kind + ':' + i.label),
    });
  }, [popupOpen, mentionKey, filtered]);

  // 思考动画 — kaomoji 旋转 (帧序列单一来源: loading-tui LOADING_FRAMES, 2026-09-08)
  useEffect(() => {
    if (!thinking) return;
    const timer = setInterval(() => {
      thinkingIdx.current = (thinkingIdx.current + 1) % KAOMOJI.length;
    }, THINK_FRAME_MS);
    return () => clearInterval(timer);
  }, [thinking]);

  // ── 虚拟化 transcript (消息级窗口 + 自动跟随底部) ───────────────────────────
  // #1 分区预留: chrome 固定行 = 分隔线×3 + 状态栏 + 输入栏 = 5; transcript 严格不超区
  //   (content Box flexGrow=1 但内容超宽会把 status/composer 挤走 → 可见窗口行数钳制 ≤ availH)
  // 2026-09-27: 高度**全部来自真终端尺寸** (`layoutBudget`) —— 帧高 == 终端高 (常数),
  //   弹层从历史区里扣 (覆盖式, 不推挤固定栏) ⇒ 打字 / 提示出现都不动输入行位置。
  const sticky = stickRef.current;
  const popupOpenNow = !!(popupOpen || picker);
  const budget = layoutBudget({
    // 2026-09-30 (leo 报「顶部重绘」+ 真机日志坐实): 帧高 = 终端行数 - 2.
    //   整帧 == 终端高时, 每次 flush (状态栏每秒一 tick) 都把最上一行滚进 scrollback
    //   ⇒ 面板被一遍遍重复留在屏上 (实测一次运行重画 9 次). 留 2 行余量 (终端可视行数
    //   常比报告值矮 1~2 行) 即根治.
    rows: Math.max(8, termSize.h - 2), cols: W,
    popupRows: popupOpenNow ? POPUP_MAX_ROWS : 0,
  });
  const msgH = budget.msgH;                 // 消息窗口高度 (弹层占的那几行已经扣掉)
  const availH = budget.history;            // 滚动按"历史区总高"算 (含被弹层覆盖的几行)
  const heights = useMemo(() => msgs.map(m => msgVisualLines(m, W)), [msgs, W]);
  const cumulative = useMemo(() => {
    const c = [0];
    for (const h of heights) c.push(c[c.length - 1] + h);
    return c;
  }, [heights]);
  const totalLines = cumulative[cumulative.length - 1] || 0;
  const maxTop = Math.max(0, totalLines - msgH);
  const top = sticky ? maxTop : Math.min(scrollTop, maxTop);
  let start = 0;
  while (start < msgs.length && cumulative[start + 1] <= top + 0.5) start++;
  let end = start;
  // 严格钳制: 端界不越过 msgH, 保证 transcript 内容行数 ≤ 分区高度 (互不覆盖)
  while (end + 1 < msgs.length && cumulative[end + 1] <= top + msgH) end++;
  void start; void end;
  const visible = msgs;   // 2026-09-30 (leo: 「我要无限高度」): 全部内容交给 <Static>, 不再切片
  const scrolledOut = false;   // 虚拟滚动退场 —— 滚动交给终端 scrollback

  // 测试/诊断探针: 把**真实用到的**布局与滚动状态写一份 JSONL (验收门按它做精确断言;
  //   不设 BOLLOON_TUI_PROBE 时零开销 —— 只在渲染后追加一行)。
  //   注: 走静态 import —— dist 是 ESM, 这里 `require()` 不存在 (踩过一次: 探针静默不写 + 树停更)。
  useEffect(() => {
    const p = process.env.BOLLOON_TUI_PROBE;
    if (!p) return;
    try {
      fs.appendFileSync(p, JSON.stringify({
        t: Date.now(), rows: budget.rows, cols: budget.cols, chrome: budget.chrome,
        activity: budget.activity, history: budget.history, msgH, popupRows: budget.popupRows,
        inputLine: budget.rows - 1,      // 输入栏行号 (1-based; 最后一行是底部分隔线)
        totalMsgs: msgs.length, totalLines, top, maxTop, stick: sticky,
        firstVisible: start, lastVisible: end, visibleCount: visible.length,
        input, pausedHint: scrolledOut ? '已暂停跟随 · PgDn/End 回到底部' : '',
      }) + '\n');
    } catch { /* 探针写不进去绝不影响界面 */ }
  });

  return (
    <>
      {/* 2026-09-30 (leo: 「你好像锁死了整个虚拟渲染的高度, 我要无限高度」):
          历史内容改走 Ink 的 <Static> —— 每条消息**只往终端写一次**, 写完永不重绘。于是:
            · 高度**无限**: 内容进的是终端自己的 scrollback, 一路往上推, PgUp 就能看回启动面板
            · 帧里只剩下面这一小块 (活动行 + 3 条分隔线 + 状态 + 输入) ⇒ 帧高恒定, 不再滚屏重画
          代价 (如实说): 历史滚动交给终端自己, 不再有 app 内的"暂停跟随/翻页"那套虚拟滚动。 */}
      <Static items={msgs}>
        {(m, i) => <Text key={`m${i}`}>{m}</Text>}
      </Static>

      {/* 底部固定块 (活的): rails / 弹层 / 活动行 / 分隔线 / 状态 / 输入 */}
      <Box flexDirection="column" width={budget.cols}>
        {hasRails && (
          <Box flexDirection="column">
            {railNames.map((n) => <Text key={n} color={THEME.muted}>{`${n}: ${String(widgets[n] ?? '').replace(/\n/g, ' ')}`}</Text>)}
          </Box>
        )}
        {popupOpenNow && tabState && (
          <MentionPopup title={POPUP_TITLE_TAB} items={filtered} sel={safeSel} width={W} maxRows={budget.popupRows} />
        )}
        {popupOpenNow && !tabState && mention && (
          <MentionPopup title={popupTitle} items={filtered} sel={safeSel} width={W} loading={loadingFiles} maxRows={budget.popupRows} />
        )}
        {popupOpenNow && !tabState && !mention && picker && (
          <MentionPopup title={picker.title} items={picker.items} sel={Math.min(picker.sel, picker.items.length - 1)} width={W} maxRows={budget.popupRows} />
        )}

        <Box height={1} width={budget.cols} overflow="hidden">
          {transient ? (
            <Text>{transient}</Text>
          ) : thinking ? (
            <Text color="yellow">{KAOMOJI[thinkingIdx.current]} 思考中...</Text>
          ) : (
            <Text color={THEME.muted}>{'· 回车发送 · ↑↓ 历史 · PgUp 回看 · Esc 双击退出'}</Text>
          )}
        </Box>

        <Box width={budget.cols} height={1} overflow="hidden">
          <Text bold color={THEME.accent}>{ruleFor(Math.max(10, budget.cols - 1))}</Text>
        </Box>
        <Box height={1} width={budget.cols} overflow="hidden">
          <Text>{status}</Text>
        </Box>
        <Box width={budget.cols} height={1} overflow="hidden">
          <Text bold color={THEME.accent}>{ruleFor(Math.max(10, budget.cols - 1))}</Text>
        </Box>
        <Box width={budget.cols} height={1} overflow="hidden">
          <Text bold color={THEME.accent}>❯ </Text>
          <Box width={Math.max(10, budget.cols - 2)} height={1} overflow="hidden" flexShrink={0}>
            <TextInput
              key={tiKey}
              value={input}
              onChange={setInput}
              onSubmit={onSubmit}
              focus={!popupOpenNow}
              placeholder={COMPOSER_PLACEHOLDER}
            />
          </Box>
        </Box>
        <Box width={budget.cols} height={1} overflow="hidden">
          <Text bold color={THEME.accent}>{ruleFor(Math.max(10, budget.cols - 1))}</Text>
        </Box>
      </Box>
    </>
  );
};

export { InkApp };

// ─── 启动 ────────────────────────────────────────────────────────────────────

let _inkInstance: ReturnType<typeof render> | null = null;
/** 上次 render 的参数 (suspend → resume 要原样重挂, 所以必须留着) */
let _lastInkArgs: { onPrompt: (t: string) => void; initialStatus: string; getStatusUpdate: () => string } | null = null;

export function startInk(
  onPrompt: (text: string) => void,
  initialStatus: string,
  getStatusUpdate: () => string,
): void {
  const tw = process.stdout.columns || 80;
  const th = process.stdout.rows || 24;
  _lastInkArgs = { onPrompt, initialStatus, getStatusUpdate };

  _inkInstance = render(
    <InkApp
      onPrompt={onPrompt}
      initialStatus={initialStatus}
      getStatusUpdate={getStatusUpdate}
      terminalW={tw}
      terminalH={th}
    />,
    {
      stdout: process.stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false, // 重要: 阻止 Ink 劫持 console.log
    }
  );
}

/**
 * 暂时让出终端 (2026-09-27): 会话内 `/model` 要用**与 `bolloon model` 同一个**全屏选择器组件
 * (`tui-select.ts` —— 固定高度视窗 + 跟随 + 折叠 + 搜索 + 光标高亮), 而它自己是 raw-mode
 * 逐键渲染: 两个渲染器同时抢同一个终端必然互相撕。
 *
 * 语义: 先把 Ink 卸掉并清掉它那一帧 (终端干净), 交给选择器画; 用完 `resumeInk()` 原样挂回来。
 * 为什么可以这么做: 会话内容活在**外部 store** (`stores.ts` 的 transcriptStore/uiStore), 不在 React 里,
 * 所以重挂之后历史一字不少 (只丢"输入框草稿"这种真正的临时态)。
 */
export function suspendInk(): void {
  if (!_inkInstance) return;
  try {
    _inkInstance.unmount();
    _inkInstance.clear();
  } catch { /* 卸不掉也让调用方继续 (选择器会自己清干净) */ }
  _inkInstance = null;
}

/** 把 Ink 按上次的参数挂回来 (suspendInk 之后用); 没挂过则忽略 */
export function resumeInk(): void {
  if (_inkInstance || !_lastInkArgs) return;
  const a = _lastInkArgs;
  startInk(a.onPrompt, a.initialStatus, a.getStatusUpdate);
  // ⚠ 必须把 stdin **重新拉起来**: 选择器的 `RawSession.close()` 会 `stdin.pause()`,
  //   而 Ink 挂载时只 `setRawMode(true)`、**自己不会 resume** ⇒ 少这一下, 面板照常重绘,
  //   但按键再也不进来 —— 实测: 打字不回显、Esc 双击退出也没反应 (2026-09-27 验收门抓到)。
  try { (process.stdin as any).resume(); } catch { /* 不支持的宿主, 不影响渲染 */ }
}

export function stopInk(): void {
  if (_inkInstance) {
    _inkInstance.unmount();
    _inkInstance.clear();
    _inkInstance = null;
  }
  _lastInkArgs = null;
}

export function inkAppendLine(line: string): void {
  appendMsg(line);
}

/** 2026-08-12 (Task4): 原地替换最后一条消息 (命令加载态 → 完成态). 无消息时追加. */
export function inkReplaceLastLine(line: string): void {
  replaceLastMsg(line);
}

/** 2026-09-08: 按内容标记原地替换一条消息 (占位框 → 启动面板完整内容). */
export function inkReplaceMatchingLine(marker: string, line: string): void {
  replaceMarkerMsg(marker, line);
}

export function inkSetStatus(s: string): void {
  const fn = (globalThis as any).__inkSetStatus;
  if (fn) fn(s);
}

export function inkSetThinking(v: boolean): void {
  setUiThinking(v);
}

/** 2026-08-10: 设置/清除临时状态行 (自动整理/经验整理). 传 null 清空 → 显示为空 */
export function inkSetTransient(v: string | null): void {
  setUiTransient(v);
}
