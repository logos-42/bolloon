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
  const shown = items.slice(0, MAX_ROWS);
  const innerW = Math.max(width - 2, 10);
  return (
    <Box flexDirection="column" width={width}>
      <Text color="cyan" bold>{`╭─ ${title} ${'─'.repeat(Math.max(2, innerW - dispWidth(title) - 4))}╮`}</Text>
      {loading && items.length === 0 ? (
        <Text color="dim">│ 扫描中...</Text>
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
        <Text color="dim">│ 还有 {items.length - MAX_ROWS} 项...</Text>
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
  const [msgs, setMsgs] = useState<string[]>([]);
  const [status, setStatus] = useState(initialStatus);
  const { exit } = useApp();

  const [thinking, setThinking] = useState(false);
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
  const agentCache = useRef<MentionItem[] | null>(null);
  const skillCache = useRef<MentionItem[] | null>(null);
  const pluginCache = useRef<MentionItem[] | null>(null);

  // 加载当前 mention 的候选 (agent/command 缓存一次; file 每次打开重扫)
  useEffect(() => {
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
        .then(list => { if (!cancelled) { setItems(list); setLoadingFiles(false); } })
        .catch(() => { if (!cancelled) { setItems([]); setLoadingFiles(false); } });
    }
    setSel(0);
    return () => { cancelled = true; };
  }, [mentionKey, dismissed]);

  // 按查询过滤 + 排序
  const filtered = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    if (!q) return items;
    if (mention.kind === 'file') {
      return items
        .filter(it => matchFileScore(it.label.toLowerCase(), q) >= 0)
        .sort((a, b) => matchFileScore(a.label.toLowerCase(), q) - matchFileScore(b.label.toLowerCase(), q));
    }
    return items.filter(it => it.label.toLowerCase().includes(q));
  }, [items, mention]);

  const popupOpen = !!(mention && dismissed !== mentionKey);
  const safeSel = Math.min(sel, Math.max(0, filtered.length - 1));

  const popupTitle = mention?.kind === 'agent' ? '@ 智能体'
    : mention?.kind === 'file' ? '# 文件'
    : '/ 命令 · 技能 · 插件';

  // 接受当前选中项 → 替换 token 插入输入
  const acceptMention = useCallback((it: MentionItem) => {
    if (!mention) return;
    let insertText: string;
    if (it.kind === 'agent') insertText = '@' + it.insert + ' ';
    else if (it.kind === 'file') insertText = '#' + it.insert + ' ';
    else if (it.kind === 'skill') insertText = 'use_skill ' + it.insert + ' ';
    else insertText = '/' + it.insert + ' ';
    setInput(input.slice(0, mention.start) + insertText);
    setDismissed(null);
  }, [input, mention]);

  // TextInput 内部 cursorOffset 在 focus 切换时不重置 (2026-08-05 实测),
  // 弹出窗关闭后继续输入会插到旧光标位置 → 用 key 强制重挂载
  const [tiKey, setTiKey] = useState(0);
  useEffect(() => {
    if (!popupOpen) setTiKey(k => k + 1);
  }, [popupOpen]);

  // 全局: 思考动画控制
  useEffect(() => {
    (globalThis as any).__inkSetThinking = (v: boolean) => setThinking(v);
    (globalThis as any).__inkAppend = (line: string) => {
      setMsgs(prev => [...prev, line]);
    };
    (globalThis as any).__inkSetStatus = (s: string) => {
      setStatus(s);
    };
    return () => {
      delete (globalThis as any).__inkAppend;
      delete (globalThis as any).__inkSetStatus;
      delete (globalThis as any).__inkSetThinking;
    };
  }, []);

  const onSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setInput('');
    // 用户消息由 processInput 统一通过 appendLine(renderUserMessage) 显示
    onPrompt(trimmed);
  }, [onPrompt]);

  useInput((_input, key) => {
    (globalThis as any).__inkOnKey?.({ input: _input, codes: Array.from(_input).map(c => c.charCodeAt(0)), backspace: key.backspace, del: key.delete, tab: key.tab, ret: key.return, esc: key.escape, name: (key as any).name });
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

    // ── 弹出窗打开: 全键接管 (TextInput focus=false 不处理) ──
    if (popupOpen && mention) {
      if (key.upArrow) { setSel(s => Math.max(0, s - 1)); return; }
      if (key.downArrow) { setSel(s => Math.min(filtered.length - 1, s + 1)); return; }
      if ((key.tab || key.return) && filtered.length > 0) {
        const it = filtered[safeSel];
        if (it) acceptMention(it);
        return;
      }
      if (key.escape) { setDismissed(mentionKey); return; }
      if (key.backspace || key.delete) { setInput(input.slice(0, -1)); return; }
      // 粘贴/连发 chunk: Ink 把一次 stdin read 当单个 keypress (2026-08-05 实测)
      //   ① 连续退格 (\x7f×N) → 删 N 个字符
      //   ② 控制字符 chunk → 忽略 (TextInput 时代同样的坑, 这里防御)
      //   ③ 可打印 chunk (CJK/粘贴) → 整串追加
      if (/^\x7f+$/.test(_input)) { setInput(input.slice(0, -_input.length)); return; }
      if (/[\x00-\x1f\x7f]/.test(_input)) return;
      if (_input && !key.ctrl && !key.meta) { setInput(input + _input); return; }
      return; // 其余键忽略
    }

    // ── 正常模式 ──
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
    //   \x7f×N → 删 N 个真实字符; 其他控制 chunk → 撤销 TextInput 的垃圾追加
    if (/^\x7f+$/.test(_input)) { setInput(input.slice(0, -_input.length)); return; }
    if (/[\x00-\x1f\x7f]/.test(_input)) { setInput(input); return; }
    // TextInput handles actual input; useInput only for Ctrl+C / Esc
  });

  // 自动更新状态栏 (每秒)
  useEffect(() => {
    const timer = setInterval(() => {
      const s = getStatusUpdate();
      if (s) setStatus(s);
    }, 1000);
    return () => clearInterval(timer);
  }, [getStatusUpdate]);

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
      </Box>

      {/* 分隔线 (全宽) */}
      <Box>
        <Text bold color="white">{'─'.repeat(terminalW)}</Text>
      </Box>

      {/* 状态栏 */}
      <Box>
        <Text>{status}</Text>
      </Box>

      {/* 输入栏分隔线 (全宽) */}
      <Box>
        <Text bold color="white">{'─'.repeat(terminalW)}</Text>
      </Box>

      {/* 弹出选择窗 (输入栏上方, 弹出页) */}
      {popupOpen && mention && (
        <MentionPopup
          title={popupTitle}
          items={filtered}
          sel={safeSel}
          width={terminalW}
          loading={loadingFiles}
        />
      )}

      {/* 输入栏 */}
      <Box>
        <Text bold color="green">❯ </Text>
        <TextInput
          key={tiKey}
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          focus={!popupOpen}
          placeholder="输入消息... @智能体 /命令 #文件 · Esc 双击退出 · /queue 排队 · !终端命令"
        />
      </Box>

      {/* 底部分界线 (全宽) */}
      <Box>
        <Text bold color="white">{'─'.repeat(terminalW)}</Text>
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
      patchConsole: false, // 关键: 阻止 Ink 劫持 console.log
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

export function inkSetStatus(s: string): void {
  const fn = (globalThis as any).__inkSetStatus;
  if (fn) fn(s);
}

export function inkSetThinking(v: boolean): void {
  const fn = (globalThis as any).__inkSetThinking;
  if (fn) fn(v);
}
