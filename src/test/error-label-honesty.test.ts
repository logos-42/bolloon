/**
 * 错误提示不许用泛化标签盖住真原因 (2026-10-01, 用户实测)。
 * 症状: list_files '~/.bolloon' 报 ENOENT, 却显示「参数错误 — Error: ENOENT: no such file…」✗ ——
 *   真原因明明拿到了, 被标签盖住; 还有一类直接显示「未知错误 — …」✗。
 */
import { describe, it, expect } from 'vitest';
import { classifyError } from '../agents/error-classifier.js';

describe('错误分类: 真原因优先', () => {
  it('ENOENT ⇒ 「路径/文件不存在」(不是"参数错误")', () => {
    const r = classifyError("Error: ENOENT: no such file or directory, scandir '~/.bolloon'");
    expect(r.label).toContain('路径');
    expect(r.label).not.toBe('参数错误');
    expect(r.label).not.toBe('未知错误');
  });
  it('真·参数错误仍是「参数错误」', () => {
    expect(classifyError('invalid path: bad argument (ERR_INVALID_ARG_TYPE)').label).toBe('参数错误');
  });
  it('识别不出的错误 ⇒ 标签为**空** (宁可只显示原文, 也不写"未知错误"盖住它)', () => {
    const r = classifyError('some totally novel failure xyz');
    expect(r.label).toBe('');
  });
});
