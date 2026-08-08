import { describe, it, expect } from 'vitest';
import React from 'react';
// ink 7 不再导出 renderToString (ink 4 API) → 用 react-dom/server 渲染组件树
//   (ink 组件本质是 React 组件, SSR 渲染 ink-box 标记 + 文本, 足够锁定渲染不崩 + 关键文案)
import { renderToString } from 'react-dom/server';
import { InkApp } from '../cli/ink-app.js';

describe('ink7 + react19 smoke', () => {
  it('renders InkApp without crashing', () => {
    const out = renderToString(
      React.createElement(InkApp, {
        onPrompt: () => {},
        initialStatus: 'test-status',
        getStatusUpdate: () => 'tick',
        terminalW: 80,
        terminalH: 24,
      })
    );
    expect(out).toContain('test-status');
    expect(out).toContain('Bolloon Agent');
    expect(out).toContain('输入消息');
    expect(out).toBeTruthy();
  });
});
