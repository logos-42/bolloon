import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'ink';
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
