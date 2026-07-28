/**
 * error-classifier 单元测试
 * 运行: npx vitest run --reporter=verbose src/test/error-classifier.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  classifyError,
  buildObservation,
  buildReflection,
  formatObservationWithReflection,
} from '../agents/error-classifier.js';

describe('classifyError', () => {
  it('tool_not_found', () => {
    const r = classifyError('未知工具: fake_tool');
    expect(r.cls).toBe('tool_not_found');
    expect(r.recoverable).toBe(true);
  });
  it('network_error', () => {
    const r = classifyError('connect ECONNREFUSED 127.0.0.1:8080');
    expect(r.cls).toBe('network_error');
    expect(r.recoverable).toBe(true);
  });
  it('timeout', () => {
    const r = classifyError('Operation timed out after 5000ms');
    expect(r.cls).toBe('timeout');
  });
  it('bad_input (ENOENT)', () => {
    const r = classifyError('ENOENT: no such file or directory');
    expect(r.cls).toBe('bad_input');
  });
  it('api_error (401)', () => {
    const r = classifyError('401 Unauthorized: API key invalid');
    expect(r.cls).toBe('api_error');
    expect(r.recoverable).toBe(false);
  });
  it('permission_denied', () => {
    const r = classifyError('PreToolUse 拒绝: 危险命令');
    expect(r.cls).toBe('permission_denied');
    expect(r.recoverable).toBe(false);
  });
  it('unknown fallback', () => {
    const r = classifyError('some random error without patterns');
    expect(r.cls).toBe('unknown');
    expect(r.recoverable).toBe(true);
  });
});

describe('buildObservation', () => {
  it('success builds correct summary', () => {
    const obs = buildObservation('shell_exec', { command: 'ls' }, { success: true, output: 'file1\nfile2' });
    expect(obs.summary).toContain('shell_exec 成功');
    expect(obs.output).toBe('file1\nfile2');
  });
  it('failure classifies error', () => {
    const obs = buildObservation('read_file', { path: '/nonexistent' }, { success: false, error: 'ENOENT: no such file' });
    expect(obs.summary).toContain('read_file 失败');
    expect(obs.errorClass).toBe('bad_input');
  });
  it('empty output still shows size', () => {
    const obs = buildObservation('shell_exec', { command: 'true' }, { success: true });
    expect(obs.summary).toContain('shell_exec 成功');
    expect(obs.output).toBe('(无输出)');
  });
});

describe('buildReflection', () => {
  it('gives change_tool for unknown tool', () => {
    const ref = buildReflection('fake_tool', '未知工具', 1, 0);
    expect(ref[0]?.action).toBe('change_tool');
  });
  it('gives abandon after 3 same-tool failures', () => {
    const ref = buildReflection('shell_exec', 'ETIMEDOUT', 3, 3);
    expect(ref[0]?.action).toBe('abandon');
  });
  it('gives simplify_goal after 5+ total errors', () => {
    const ref = buildReflection('shell_exec', 'ENOENT', 6, 2);
    expect(ref[0]?.action).toBe('simplify_goal');
  });
  it('returns at most 2 suggestions', () => {
    const ref = buildReflection('read_file', 'ENOENT', 1, 0);
    expect(ref.length).toBeLessThanOrEqual(2);
  });
});

describe('formatObservationWithReflection', () => {
  it('includes tool result and strategy', () => {
    const obs = buildObservation('shell_exec', { command: 'ls /root' }, { success: false, error: 'permission denied' });
    const ref = buildReflection('shell_exec', 'permission denied', 1, 0);
    const text = formatObservationWithReflection(obs, ref);
    expect(text).toContain('shell_exec 失败');
    expect(text).toContain('推荐策略');
    expect(text).toContain('change_tool');
  });
  it('success path omits strategy', () => {
    const obs = buildObservation('read_file', { path: 'x' }, { success: true, output: 'ok' });
    const text = formatObservationWithReflection(obs, []);
    expect(text).toContain('read_file 成功');
    expect(text).not.toContain('推荐策略');
  });
});
