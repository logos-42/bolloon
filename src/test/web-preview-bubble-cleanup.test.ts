/**
 * web 渲染: preview 气泡回收 (2026-10-02 修「UI 回复有两层」)
 *
 * 病: `.message-ai.preview` 是 pivot loop 每 iter 推的**瞬时**气泡。旧实现**只在 `ai` 事件里**清它 ——
 *   一轮若以 `done`(或 `error`) 收尾而**没有** `ai`, preview 会残留, 与最终答复**同文并存**
 *   ⇒ 用户看到"同一段回复两层"(带虚线描边的那层就是 preview)。
 *
 * 这条门只做一件事: **所有终态分支都必须回收它**, 且不许再出现散落的内联清理副本。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = () => fs.readFileSync(path.join(process.cwd(), 'src/web/client.ts'), 'utf8');

describe('web 渲染门: preview 气泡必须被**每个终态**回收', () => {
  it('① 助手存在, 且四个分支 (ai / reply-preview / done / error) 都调它', () => {
    const s = src();
    expect(s).toContain('function retirePreviewBubbles(');
    expect((s.match(/retirePreviewBubbles\(/g) || []).length).toBeGreaterThanOrEqual(5);   // 1 定义 + 4 调用

    const branch = (marker: string, len = 700) => {
      const i = s.indexOf(marker);
      expect(i, `没找到分支: ${marker}`).toBeGreaterThan(-1);
      return s.slice(i, i + len);
    };
    expect(branch("} else if (data.type === 'ai') {")).toContain('retirePreviewBubbles(container)');
    expect(branch("} else if (data.type === 'reply-preview') {")).toContain('retirePreviewBubbles(container)');
    expect(branch("} else if (data.type === 'done') {")).toContain('retirePreviewBubbles(container)');
    expect(branch("} else if (data.type === 'error') {")).toContain('retirePreviewBubbles(container)');
  });

  it('② 判别力: `.message-ai.preview` 的清理**只许在助手内部出现一次** (不许散落内联副本)', () => {
    const s = src();
    // 去掉注释行再数, 否则会数上解释它的注释
    const code = s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const hits = code.match(/querySelectorAll\('\.message-ai\.preview'\)/g) || [];
    expect(hits).toHaveLength(1);
    // 而且它必须在助手函数体内
    const helperAt = code.indexOf('function retirePreviewBubbles(');
    expect(helperAt).toBeGreaterThan(-1);
    expect(code.slice(helperAt, helperAt + 300)).toContain("querySelectorAll('.message-ai.preview')");
  });

  it('③ 产物的 bundle 里必须能搜到 (dist 由 build:web 生成, 不许手改)', () => {
    const p = path.join(process.cwd(), 'dist/web/client.js');
    if (!fs.existsSync(p)) return;   // 未构建时跳过 (CI 里会先 build)
    expect(fs.readFileSync(p, 'utf8')).toContain('retirePreviewBubbles');
  });
});
