/**
 * ink-popup-harness.tsx — 弹出窗 pty 测试轻量 harness
 *
 * 只渲染真实 InkApp (含 @ / # 弹出窗), 不启动 agent/P2P/web server.
 * 配合 scripts/mention-popup-test.py 驱动验证弹出窗行为.
 * 用法: npx tsx scripts/ink-popup-harness.tsx
 */

import React from 'react';
import { render } from 'ink';
import { InkApp } from '../src/cli/ink-app.js';

// 输入状态钩子: 每次 input 变化打印到 stderr (pty 测试可读)
(globalThis as any).__inkOnInput = (value: string) => {
  process.stderr.write(`\n[INPUT] ${JSON.stringify(value)}\n`);
};
(globalThis as any).__inkOnPopup = (p: any) => {
  process.stderr.write(`\n[POPUP] ${JSON.stringify(p)}\n`);
};
(globalThis as any).__inkOnKey = (k: any) => {
  process.stderr.write(`\n[KEY] ${JSON.stringify(k)}\n`);
};

render(
  <InkApp
    onPrompt={(text) => {
      // 测试模式: 提交内容打印到 stderr (python 侧可读)
      process.stderr.write(`\n[SUBMIT] ${text}\n`);
    }}
    initialStatus="popup-harness"
    getStatusUpdate={() => ''}
    terminalW={80}
    terminalH={24}
  />,
  {
    stdout: process.stdout,
    stdin: process.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  }
);

// 保持进程存活 (Ink 不退出)
