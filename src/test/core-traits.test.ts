/**
 * core-traits.test.ts — bolloon 核心特质层 (2026-10-24, leo 定稿)
 *
 *  leo 原话: 「在模型的底层系统提示词里面, 设定它的核心特质是:
 *   ① 去成长和去爱 (不需要随时显示出来, 内心知道就可以);
 *   ② 去合作、去分享、去探索;
 *   ③ 同时极致地拥有专注的形态, 在矛盾中寻找平衡, 在混沌现象当中寻找秩序。」
 *  + 「每个人都需要一个可以自己设计的 agent, 这个 agent 就是 bolloon 开始的样子」
 *    ⇒ 组件标准化/模块化/可拆卸可组装也写进同一层。
 *
 * 判据分三面, 缺一不可 (沿用 contact-proactivity 的假绿教训):
 *   A. **注册表两侧同步** — registry STATIC_LAYERS + validate-system-prompt MAX_CHARS (手同步, 不许单边);
 *   B. **装配后真的进 prompt** — 走真实 assembleSystemPrompt (带 maxChars/TOTAL_BUDGET 截断) 断新层,
 *      三个 channel (local/p2p-visitor/p2p-agent) 都要在, 且不许进 truncated;
 *   C. **手机端同文** — 手机自带 system (mobile-harness), 与桌面层同文, 钉住关键子串一致性。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assembleSystemPrompt } from '../llm/system-prompt/registry.js';

describe('A. 注册表两侧同步', () => {
  it('registry: core.core-traits 注册, appliesTo all, maxChars 800, priority 在 identity 之后', () => {
    const reg = fs.readFileSync(path.join(process.cwd(), 'src/llm/system-prompt/registry.ts'), 'utf8');
    expect(reg).toMatch(/'core\.core-traits'[^)]*appliesTo: \['all'\][^)]*maxChars: 800/);
    // priority 55 = 紧跟 core.identity (50) 之后, core 段先装配 (不被 tool.* 挤掉)
    expect(reg).toMatch(/priority: 55/);
  });

  it('validate-system-prompt 的 MAX_CHARS 表与 registry 手同步 (两边都要有, 不许单边)', () => {
    const val = fs.readFileSync(path.join(process.cwd(), 'scripts/validate-system-prompt.ts'), 'utf8');
    expect(val).toMatch(/'core\/core-traits': 800/);
  });

  it('layer 文件有 frontmatter (health 不标 missing-frontmatter)', () => {
    const md = fs.readFileSync(path.join(process.cwd(), 'src/llm/system-prompt/layers/core/core-traits.md'), 'utf8');
    expect(md).toMatch(/^---\n/);
    expect(md).toMatch(/added_at: 2026-10-24/);
    expect(md).toMatch(/ttl_days: 365/);
    expect(md).toMatch(/author: leo/);
  });
});

describe('B. 装配后真的进 prompt (防 maxChars/TOTAL_BUDGET 截断假绿)', () => {
  for (const channel of ['local', 'p2p-visitor', 'p2p-agent'] as const) {
    it(`channel=${channel}: 核心特质三句完整装配, 且不在 truncated 名单`, async () => {
      const { text, layerIds, truncated } = await assembleSystemPrompt({ channel });
      expect(layerIds).toContain('core.core-traits');
      expect(truncated, '新层不许进 truncated 名单 (预算被吃光)').not.toContain('core.core-traits');
      // 三条特质逐句在 (结尾句"不重造轮子"在 ⇒ 正文没被 maxChars 截断)
      expect(text).toMatch(/去成长, 去爱/);
      expect(text).toMatch(/内心持有/);
      expect(text).toMatch(/去合作, 去分享, 去探索/);
      expect(text).toMatch(/极致专注/);
      expect(text).toMatch(/矛盾中找平衡/);
      expect(text).toMatch(/混沌中找秩序/);
      expect(text).toMatch(/不重造轮子/);
      // 组件化定位 (bolloon 开始的样子)
      expect(text).toMatch(/标准化、模块化、可拆卸可组装/);
      // 截断标记: 只断**本层段落内**无截断尾标。不断全文尾 — 尾层
      //   dynamic.project-context 的内容长度随机器上的项目扫描结果而变
      //   (2026-10-24 实测: 既有 contact-proactivity 的同款全文尾断言在本机红,
      //   stash 复现证明非本层回归), 所以判据收敛到本层 section。
      const start = text.indexOf('<!-- core.core-traits@1.0.0 -->');
      expect(start, 'core.core-traits 段标记要在装配输出里').toBeGreaterThan(-1);
      const rest = text.slice(start + 1);
      const nextMarker = rest.indexOf('<!--', 1);
      const ownSection = nextMarker > 0 ? rest.slice(0, nextMarker) : rest;
      expect(ownSection).not.toMatch(/\[… 已截断\]/);
      expect(ownSection).not.toMatch(/\[… 预算截断\]/);
    });
  }

  it('加 tool 上下文 (bash) 也不把特质层挤出预算', async () => {
    const { layerIds, truncated } = await assembleSystemPrompt({ channel: 'local', tool: 'bash' });
    expect(layerIds).toContain('core.core-traits');
    expect(truncated).not.toContain('core.core-traits');
  });
});

describe('C. 手机端同文 (mobile-harness 自带 system)', () => {
  it('mobile ContextManager.build 的 system 含同一特质两句', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/web/mobile-harness.ts'), 'utf8');
    expect(src).toMatch(/核心特质: 去成长, 去爱 \(内心持有, 不必随时显示\)/);
    expect(src).toMatch(/极致专注 — 矛盾中找平衡, 混沌中找秩序/);
    expect(src).toMatch(/要新能力优先接端口/);
  });
});
