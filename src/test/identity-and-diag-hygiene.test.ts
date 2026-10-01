/**
 * 两条"不该上屏 / 不该编假 DID"的回归 (2026-10-01, 用户实测贴出的屏)。
 *
 * ① `[parseToolCall diag]` 原先无条件打 —— 它在 parseToolCall **热路径**上且直写 stdout,
 *    用户每轮都被刷屏 (仓规: 内部运行日志不进用户可见的回复流)。现在必须**默认关**,
 *    要排障显式开 BOLLOON_PARSE_DIAG=1 / BOLLOON_VERBOSE=1。
 * ② `createDefaultIdentity()` 原先自造 `did:pi:<peerId>` —— 不是有效 DID (仓里 server.ts
 *    自己就把 did:pi: 当"待升级"占位)。现在必须用真身份生成器; 失败时留空, **不许再编假 DID**。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

describe('不该上屏 / 不该编假 DID', () => {
  it('① parseToolCall diag 必须被开关挡住 (默认关)', () => {
    const src = read('src/agents/parse-tool-call.ts');
    expect(src).toContain('const PARSE_DIAG_ON =');
    expect(src).toContain("process.env.BOLLOON_PARSE_DIAG === '1'");
    // 打印那行必须在守卫之内 (用 if (PARSE_DIAG_ON) try { 包住)
    const i = src.indexOf('if (PARSE_DIAG_ON) try {');
    const j = src.indexOf("'[parseToolCall diag] rawLen='");
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
  });

  it('② 不许再出现自造的 did:pi: 默认身份', () => {
    const src = read('src/agents/pi-sdk.ts');
    expect(src).not.toContain('did:pi:${this.peerId');
    expect(src).toContain('loadOrCreateAgentIdentity(scope)');
    // 失败时留空而不是编一个
    expect(src).toMatch(/did: ''/);
  });
});
