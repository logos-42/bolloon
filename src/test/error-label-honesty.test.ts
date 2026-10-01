/**
 * 错误提示不许用泛化标签盖住真原因 (2026-10-01, 用户实测)。
 * 症状: list_files '~/.bolloon' 报 ENOENT, 却显示「参数错误 — Error: ENOENT: no such file…」✗ ——
 *   真原因明明拿到了, 被标签盖住; 还有一类直接显示「未知错误 — …」✗。
 */
import { describe, it, expect } from 'vitest';
import { classifyError, buildObservation, buildReflection } from '../agents/error-classifier.js';

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


describe('退出码非零 ≠ 任务失败 (用户报: 提交成功却写着 ❌ terminal 失败)', () => {
  it('terminal 退出码非零时, 总结必须要求**核事实**, 不许直接下"失败"结论', () => {
    const obs = buildObservation('terminal', {}, { success: false, error: ' — exit 1: Command failed: git commit -m x && git log --oneline -3' } as any);
    expect(obs.summary).toContain('退出码 1');
    expect(obs.summary).toContain('不等于任务失败');
    expect(obs.summary).toContain('核事实');
  });
  it('没有退出码的失败(如 read_file ENOENT) 不受影响', () => {
    const obs = buildObservation('read_file', {}, { success: false, error: 'ENOENT: no such file or directory' } as any);
    expect(obs.summary).not.toContain('不等于任务失败');
  });
});


describe('反思模式的四类错误 (用户: 「完整看一下这个反思模式，为啥一直出错？」)', () => {
  it('① 成功也带内容预览 —— 不再只有字节数(否则模型只能猜)', () => {
    const obs = buildObservation('terminal', {}, { success: true, output: 'On branch master\nnothing to commit, working tree clean' } as any);
    expect(obs.summary).toContain('成功');
    expect(obs.summary).toContain('nothing to commit');
  });
  it('② 退出码非零 ⇒ 不写"失败", 而是"结果待核"', () => {
    const obs = buildObservation('terminal', {}, { success: false, error: ' - exit 1: Command failed: git commit -m x', output: 'lefthook hook 输出' } as any);
    expect(obs.summary).not.toMatch(/❌.*失败/);
    expect(obs.summary).toContain('结果待核');
  });
  it('③ 失败附输出尾部 —— 原来只截错误前 120 字符, 恰好丢掉"到底干了什么"', () => {
    const obs = buildObservation('terminal', {}, { success: false, error: 'boom', output: 'A'.repeat(300) + ' 关键尾部FF' } as any);
    expect(obs.summary).toContain('输出尾部');
    expect(obs.summary).toContain('关键尾部FF');
  });
  it('④ 反思建议: 退出码非零 ⇒ 先核事实(不是重试)', () => {
    const r = buildReflection('terminal', ' - exit 1: Command failed: git commit', 1, 1);
    expect(r[0].detail).toContain('核事实');
    expect(r[0].reason).toContain('不等于失败');
  });
});
