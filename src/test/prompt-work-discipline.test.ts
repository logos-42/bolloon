/**
 * 过程纪律必须在系统提示里 (2026-10-01 用户: 智能体回复没有主动性 ⇒ 要求在过程里更主动)。
 * 诊断: 提示里只有反应式循环, 没有"做到底/别先问/换法继续/读回验证/不编结果"这类**可判定**规矩。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PROACTIVE_WORK_DISCIPLINE } from '../agents/pi-sdk.js';

describe('过程纪律 (系统提示的一部分)', () => {
  it('七条都在, 且是"可判定"的表述 (不是"请主动"这种空话)', () => {
    for (const kw of [
      '先动手, 别先问', '做到底', '换法继续', '工具说成功 ≠ 任务成功', '读回',
      '被阻塞就如实说', '每一轮要么用工具推进', '收尾时说三句', '过程中主动考虑', '影响面',
    ]) {
      expect(PROACTIVE_WORK_DISCIPLINE, `缺: ${kw}`).toContain(kw);
    }
  });
  it('明确写了"绝不编造结果" (最难但最重要的一条)', () => {
    expect(PROACTIVE_WORK_DISCIPLINE).toContain('绝不');
    expect(PROACTIVE_WORK_DISCIPLINE).toContain('编造');
  });
  it('**两个**组装点都注入了它 (源级核对, 免得只加了一处)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf-8');
    const n = (src.match(/\$\{PROACTIVE_WORK_DISCIPLINE\}/g) || []).length;
    expect(n, `注入点只有 ${n} 个`).toBeGreaterThanOrEqual(2);
  });
});
