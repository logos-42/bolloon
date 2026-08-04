/**
 * ink-app.tsx — Ink (React for CLI) 渲染入口
 *
 * 用 Yoga flexbox 布局实现: 内容置顶, 输入栏固定底部, 状态栏固定
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { brandArtLines, boxTop, boxRow, boxBottom, dispWidth } from './loading-tui.js';
import type { ToolCallListItem } from './loading-tui.js';

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

      {/* 输入栏 */}
      <Box>
        <Text bold color="green">❯ </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder="输入消息...  Esc 双击退出 · /queue 排队 · !终端命令"
        />
      </Box>

      {/* 底部分界线 (全宽) */}
      <Box>
        <Text bold color="white">{'─'.repeat(terminalW)}</Text>
      </Box>
    </Box>
  );
};

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
