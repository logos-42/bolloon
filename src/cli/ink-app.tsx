/**
 * ink-app.tsx — Ink (React for CLI) 渲染入口
 *
 * 用 Yoga flexbox 布局实现: 内容置顶, 输入栏固定底部, 状态栏固定
 *
 * 2026-08-05: @ / # 弹出选择窗 — 输入 @ 命中智能体, / 命中命令+技能+插件, # 命中文件
 *   ↑/↓ 导航, Tab/Enter 选中, Esc 关闭, 弹出窗打开时 TextInput 让出焦点 (focus=false)
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { brandArtLines, boxTop, boxRow, boxBottom, dispWidth } from './loading-tui.js';
import type { ToolCallListItem } from './loading-tui.js';
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

// ─── 组件: Logo Box ──────────────────────────────────────────────────────────

const LogoBox: React.FC<{ width: number }> = ({ width }) => {
  const art = brandArtLines();
  const mw = Math.max(40, ...art.map(l => dispWidth(l))) + 4;
  const bw = Math.min(width - 2, mw);
  const rows: string[] = [boxTop('Bolloon Agent', bw)];
  for (const l of art) rows.push(boxRow(l, bw, 'center'));
  rows.push(boxBottom(bw));
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => <Text key={i}>{r}</Text>)}
    </Box>
  );
};

// ─── 组件: 消息列表 ──────────────────────────────────────────────────────────

const Messages: React.FC<{ msgs: string[] }> = ({ msgs }) => (
  <Box flexDirection="column" flexGrow={1} justifyContent="flex-start">
    {msgs.map((m, i) => {
      const clean = m.replace(/\x1b\[[0-9;]*m/g, '');
      return clean.trim() ? <Text key={i}>{clean ? m : ''}</Text> : null;
    })}
  </Box>
);

// ─── 组件: 弹出选择窗 ────────────────────────────────────────────────────────

interface MentionPopupProps {
  title: string;
  items: MentionItem[];
  sel: number;
  width: number;
  loading?: boolean;
}

const MentionPopup: React.FC<MentionPopupProps> = ({ title, items, sel, width, loading }) => {
  const MAX_ROWS = 8;
  // 2026-08-08: 滑动窗口 — 选中项始终可见 (原实现 fix 屏幕顶部, sel 超窗口时无高亮行)
  const offset = Math.max(0, Math.min(sel - Math.floor(MAX_ROWS / 2), Math.max(0, items.length - MAX_ROWS)));
  const shown = items.slice(offset, offset + MAX_ROWS);
  const innerW = Math.max(width - 2, 10);
  return (
    <Box flexDirection="column" width={width}>
      <Text color="cyan" bold>{`╭─ ${title} ${'─'.repeat(Math.max(2, innerW - dispWidth(title) - 4))}╮`}</Text>
      {loading && items.length === 0 ? (
        <Text color="dim">│ 扫描中...</Text>
      ) : !loading && items.length === 0 ? (
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
      {items.length > MAX_ROWS && (
        <Text color="dim">│ {offset + 1}-{offset + shown.length}/{items.length} · 还有 {items.length - (offset + shown.length)} 项...</Text>
      )}
      <Text color="cyan">{`╰${'─'.repeat(innerW)}╯`}</Text>
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
  const [msgs, setMsgs] = useState<string[]>([]);
  const [status, setStatus] = useState(initialStatus);
  const { exit } = useApp();

  const [thinking, setThinking] = useState(false);
  // 2026-08-10: 临时状态行 (自动整理心跳/run-end 经验整理用) — 显示在颜文字行位置,
  //   结束后设 null 即清空 (显示为空). 不进入消息历史, 不会残留显示效果.
  const [transient, setTransient] = useState<string | null>(null);
  const thinkingIdx = useRef(0);

  // 双击 Esc 退出当前进程 (500ms 窗口内第二次按下)
  const lastEscRef = useRef(0);
  const C_WARN_ANSI = '\x1b[38;2;245;158;11m'; // #f59e0b

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
  // 全局钩子: index.ts 命令打开/关闭选择器
  useEffect(() => {
    (globalThis as any).__inkOpenPicker = (itemsArg: MentionItem[], title: string, onPick: (item: MentionItem) => void) => {
      pickerSelRef.current = 0;
      pickerCb.current = onPick;
      setPicker({ title: title || '选择', items: itemsArg, sel: 0 });
      setInput('');
    };
    (globalThis as any).__inkClosePicker = () => { pickerCb.current = null; setPicker(null); };
    return () => { delete (globalThis as any).__inkOpenPicker; delete (globalThis as any).__inkClosePicker; };
  }, []);

  // ── 输入历史 (↑/↓ 切换) ───────────────────────────────────────────────────
  const historyRef = useRef<string[]>([]);
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

  const popupTitle = tabState ? 'Tab 补齐'
    : mention?.kind === 'agent' ? '@ 智能体'
    : mention?.kind === 'file' ? '# 文件'
    : '/ 命令 · 技能 · 插件';

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

  // 全局: 思考动画控制
  useEffect(() => {
    // 2026-08-06: 防御 — 某些环境 (tsx/完整 CLI 初始化) 下 stdin 会处于 paused,
    // 不恢复则 useInput 收不到任何输入 (实测 isPaused=true, listeners=0)
    if ((process.stdin as any).isPaused()) (process.stdin as any).resume();
    (globalThis as any).__inkSetThinking = (v: boolean) => setThinking(v);
    (globalThis as any).__inkAppend = (line: string) => {
      setMsgs(prev => [...prev, line]);
    };
    (globalThis as any).__inkSetStatus = (s: string) => {
      setStatus(s);
    };
    // 2026-08-10: 临时状态行 (自动整理/经验整理): 传字符串显示, 传 null 清空 (显示为空)
    (globalThis as any).__inkSetTransient = (v: string | null) => {
      setTransient(v === undefined ? null : v);
    };
    // 2026-08-12 (Task4): 原地替换最后一条消息 (命令加载态 → 完成态用).
    //   不命中则追加 (兼容旧逻辑).
    (globalThis as any).__inkReplaceLast = (line: string) => {
      setMsgs(prev => {
        if (prev.length === 0) return [...prev, line];
        const next = prev.slice();
        next[next.length - 1] = line;
        return next;
      });
    };
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
    // 入历史 (去重最近一条, 上限 100)
    const hist = historyRef.current;
    if (hist[hist.length - 1] !== trimmed) hist.push(trimmed);
    if (hist.length > 100) hist.shift();
    historyIdxRef.current = -1;
    draftRef.current = '';
    setInput('');
    // 用户消息由 processInput 统一通过 appendLine(renderUserMessage) 显示
    onPrompt(trimmed);
  }, [onPrompt]);

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

    // ── 程序化选择器: 全键接管 (↑↓ 选择, Enter 确认, Esc 关闭) ──
    if (picker) {
      const itemsArg = picker.items;
      if (key.upArrow) { pickerSelRef.current = Math.max(0, pickerSelRef.current - 1); setPicker({ ...picker, sel: pickerSelRef.current }); return; }
      if (key.downArrow) { pickerSelRef.current = Math.min(itemsArg.length - 1, pickerSelRef.current + 1); setPicker({ ...picker, sel: pickerSelRef.current }); return; }
      if ((key.return || key.tab) && itemsArg.length > 0) {
        const it = itemsArg[Math.min(pickerSelRef.current, itemsArg.length - 1)];
        const cb = pickerCb.current;
        pickerCb.current = null;
        setPicker(null);
        cb?.(it);
        return;
      }
      if (key.escape) { pickerCb.current = null; setPicker(null); return; }
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
    if (key.upArrow) {
      const hist = historyRef.current;
      if (hist.length === 0) return;
      if (historyIdxRef.current === -1) draftRef.current = input;
      if (historyIdxRef.current < hist.length - 1) {
        historyIdxRef.current += 1;
        setInput(hist[hist.length - 1 - historyIdxRef.current]);
        setTiKey(k => k + 1);
      }
      return;
    }
    if (key.downArrow) {
      if (historyIdxRef.current === -1) return;
      historyIdxRef.current -= 1;
      if (historyIdxRef.current === -1) setInput(draftRef.current);
      else setInput(historyRef.current[historyRef.current.length - 1 - historyIdxRef.current]);
      setTiKey(k => k + 1);
      return;
    }
    // 双击 Esc 退出当前进程: 第一击提示, 500ms 内第二击退出
    if (key.escape) {
      const now = Date.now();
      if (now - lastEscRef.current < 500) {
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
  //   getStatusUpdate 是 startInk 传入的模块级函数 (引用稳定), 空依赖首渲染捕获即可, 内部实时读.
  useEffect(() => {
    // 挂载时立即同步刷新一次状态栏 (不等 1s 后第一个 tick)
    try {
      const s0 = getStatusUpdate();
      if (s0) setStatus(s0);
    } catch { /* 状态栏更新失败不致命 */ }
    const timer = setInterval(() => {
      try {
        const s = getStatusUpdate();
        if (s) setStatus(s);
      } catch { /* 状态栏更新失败不致命 */ }
    }, 1000);
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

  // 思考动画 — kaomoji 旋转
  const KAOMOJI = ['(｀・ω・´)', '(´･_･`)', '(｡•́︿•̀｡)', 'ᕙ(▀̿̿Ĺ̯̿̿▀̿ ̿)ᕗ', '(◕‿◕)'];
  useEffect(() => {
    if (!thinking) return;
    const timer = setInterval(() => {
      thinkingIdx.current = (thinkingIdx.current + 1) % KAOMOJI.length;
    }, 600);
    return () => clearInterval(timer);
  }, [thinking]);

  return (
    <Box flexDirection="column" height="100%">
      {/* 内容区: 置顶 */}
      <Box flexGrow={1} flexDirection="column" justifyContent="flex-start">
        <LogoBox width={terminalW} />
        <Messages msgs={msgs} />
        {thinking && (
          <Box>
            <Text color="yellow">{KAOMOJI[thinkingIdx.current]} 思考中...</Text>
          </Box>
        )}
        {/* 2026-08-10: 临时状态行 — 复用颜文字行位置 (自动整理/经验整理), 结束后 null 即消失 */}
        {transient && (
          <Box>
            <Text>{transient}</Text>
          </Box>
        )}
      </Box>

      {/* 分隔线 (全宽, bolloon 色系 #c4d640) */}
      <Box>
        <Text bold color="#c4d640">{'─'.repeat(terminalW)}</Text>
      </Box>

      {/* 状态栏 */}
      <Box>
        <Text>{status}</Text>
      </Box>

      {/* 输入栏分隔线 (全宽, bolloon 色系 #c4d640) */}
      <Box>
        <Text bold color="#c4d640">{'─'.repeat(terminalW)}</Text>
      </Box>

      {/* 弹出选择窗 (输入栏上方, 弹出页) */}
      {popupOpen && (tabState || mention) && (
        <MentionPopup
          title={popupTitle}
          items={filtered}
          sel={safeSel}
          width={terminalW}
          loading={loadingFiles}
        />
      )}

      {/* 程序化选择器 (2026-08-06: /login /model 等命令触发) — 复用 MentionPopup 渲染 */}
      {picker && (
        <MentionPopup
          title={picker.title}
          items={picker.items}
          sel={Math.min(picker.sel, picker.items.length - 1)}
          width={terminalW}
        />
      )}

      {/* 输入栏 */}
      <Box>
        <Text bold color="#c4d640">❯ </Text>
        <TextInput
          key={tiKey}
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          focus={!popupOpen && !picker}
          placeholder="输入消息... @智能体 /命令 #文件 · Esc 双击退出 · /queue 排队 · !终端命令"
        />
      </Box>

      {/* 底部分界线 (全宽, bolloon 色系 #c4d640) */}
      <Box>
        <Text bold color="#c4d640">{'─'.repeat(terminalW)}</Text>
      </Box>
    </Box>
  );
};

export { InkApp };

// ─── 启动 ────────────────────────────────────────────────────────────────────

let _inkInstance: ReturnType<typeof render> | null = null;

export function startInk(
  onPrompt: (text: string) => void,
  initialStatus: string,
  getStatusUpdate: () => string,
): void {
  const tw = process.stdout.columns || 80;
  const th = process.stdout.rows || 24;

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

export function stopInk(): void {
  if (_inkInstance) {
    _inkInstance.unmount();
    _inkInstance.clear();
    _inkInstance = null;
  }
}

export function inkAppendLine(line: string): void {
  const fn = (globalThis as any).__inkAppend;
  if (fn) fn(line);
}

/** 2026-08-12 (Task4): 原地替换最后一条消息 (命令加载态 → 完成态). 无消息时追加. */
export function inkReplaceLastLine(line: string): void {
  const fn = (globalThis as any).__inkReplaceLast;
  if (fn) fn(line);
}

export function inkSetStatus(s: string): void {
  const fn = (globalThis as any).__inkSetStatus;
  if (fn) fn(s);
}

export function inkSetThinking(v: boolean): void {
  const fn = (globalThis as any).__inkSetThinking;
  if (fn) fn(v);
}

/** 2026-08-10: 设置/清除临时状态行 (自动整理/经验整理). 传 null 清空 → 显示为空 */
export function inkSetTransient(v: string | null): void {
  const fn = (globalThis as any).__inkSetTransient;
  if (fn) fn(v);
}
