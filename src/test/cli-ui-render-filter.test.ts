/**
 * cli-ui-render-filter.test.ts — CLI 对话流的**渲染过滤** (2026-10-02 leo: 「cli 的 UI 需要有渲染过滤」)
 *
 * 真机污染样本 (逐行取自用户贴的原文): `⚠ [identity] …` · `[pi-ai timing] …` · `📚 复盘: …` ·
 *   `✗ [session-note] …` · `[PiAgent] reviewFinal …`(含被截断的 prompt 片段) ·
 *   `[react-harness] …` / `[kv-server] …` / `[loadSkills] …` / `[DocumentStore] …`。
 *
 * 判据三段:
 *   A. 污染样本**必须**被判为内部诊断 (含带 ANSI 染色的变体);
 *   B. **反例**: 真用户内容 / 需人介入 / 产品状态行 / 可行动提示**不许**被吞 (误吞比漏吞更糟 —— 那是把问题藏起来);
 *   C. 接线 (源级): 三个咽喉都接上了 (console 两路 + `writeOut`) · `📚 复盘` 那条状态已改成只落盘。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isInternalChatter } from '../cli/log-gate.js';

const readSrc = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('CLI 渲染过滤-A. 污染样本必须被过滤 (逐行取自真机)', () => {
  const polluted = [
    '⚠ [identity] channel=ch_1790846608783_8znre9 · 查到=yes · channel.agentId=agent-233 · channel.did=did:key:z6MkoievnV5rpWrX6r · 分支=channel自带 · 结果 did=did:key:z6MkoievnV5rpWrX6r name=小龙',
    '[pi-ai timing] total=1143ms attempt=1 fetch=381ms parse=731ms reply=45B toolCalls=0 model=deepseek-flash prompt=37509B',
    '📚 复盘: 开始(换了任务 ⇒ 立刻复盘)',
    '✗ [session-note] 已更新: 用 edit_file 将 k7Probe 由',
    '[PiAgent] reviewFinal (K4-B 恢复调用, 判定不参与流程): {"kind":"continue-review","reason":"1/2 完成度自查"',
    '[react-harness] session start, channel=n/a, currentGate=0',
    '[kv-server] purpose=main-agent cached=40832 prompt=41567 hit=98.2%',
    '[loadSkills] 已加载 1311 个 skill from /Users/apple/.bolloon/skills',
    '[DocumentStore] Initialized at /Users/apple/.bolloon/documents/received',
    '[PiAgent] 推理适配器 = kernel-model-runtime (只读 acquire 租约)',
    '\x1b[33m[pi-ai timing]\x1b[0m total=1ms',                          // 带 ANSI 染色
    '    [v3-async] 处理 agent.manifest.exchange 失败: 连接不存在',      // 允许 0~8 空格缩进
    // 2026-10-02 leo 追加: 「✅ 最终回复 (质量 8.5/10) · 🔄 循环 N/10 这类也去掉」
    '✅ 最终回复 (质量 8.5/10)',
    '✅ 检测到最终回复 (质量: 8.5/10)',
    '🔄 循环 2/10',
    '🔍 任务复杂度: moderate (预估 3 步)',
    '⚙️ 动态配置: 2 个工具组',
    '⏹️ pivot loop 结束',
    '工具执行完成继续循环',
    '继续总结上一段',
  ];
  it.each(polluted)('过滤: %s', (line) => {
    expect(isInternalChatter(line)).toBe(true);
  });
});

describe('CLI 渲染过滤-B. 反例: 用户内容 / 需人介入 / 产品行 不许被吞', () => {
  const keep = [
    '你好！我是小龙，跑在你这台 Mac 上的 bolloon 本地实例。有什么我可以帮你的吗？',
    '⛔ loop 自动重试 3 次后仍失败',
    '🔎 ✅ 类型检查通过 (tsc --noEmit, 本回合改过 TS 后自动跑)',
    '🔎 类型检查被门拒绝, 未执行: 被策略拒了',
    '✅ 结果已保存到: /tmp/x.log',
    '⚠️ 守护进程启动超时, 可稍后手动运行 ipfs daemon',        // 仓里既有的"可行动提示"反例
    '│ 你好                 │',
    '──────── · ────────',
    '智能体列表: (当前: 233)',
    '',                                                       // 空行不算冲突
    '[这是用户自己写的一行，带中文方括号]',                    // 中文标签不在内部清单里 ⇒ 不吞
    '好的, 继续总结一下',                                      // 只锚行首 ⇒ 句子中间出现"继续总结"不许被吞
  ];
  it.each(keep)('放行: %s', (line) => {
    expect(isInternalChatter(line)).toBe(false);
  });
});

describe('CLI 渲染过滤-D. Ink 折行续行碎片防护 (2026-10-19, leo: 「修复里面的 cache_prompt=-, 加防护过滤」)', () => {
  it('内部诊断行不进 Ink 消息流 (只落 startup.log) —— 折行续行 `cache_prompt=-` 因此永不上屏', async () => {
    // 实证链路 (真机 startup.log): `[pi-ai] ▶ … toolsHash=0ac2a0b9a78e cache_prompt=-` 有 136 字符,
    //   超过终端宽 (130 列) ⇒ Ink <Static> 按终端宽折行 ⇒ 续行 `cache_prompt=-` **丢掉模块标签**
    //   ⇒ 闸门的逐行判据 (isInternalChatter) 不再认识它 ⇒ 被当成用户内容上屏 ✗。
    //   修在发送点: console 拦截器认识内部行 ⇒ 不进消息流 (连折行的机会都没有)。
    const { installConsoleIntercept, uninstallConsoleIntercept } = await import('../cli/ink-app.js');
    const { transcriptStore } = await import('../cli/stores.js');

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-intercept-'));
    const savedHome = process.env.BOLLOON_HOME;
    const savedVerbose = process.env.BOLLOON_VERBOSE;
    delete process.env.BOLLOON_VERBOSE;
    process.env.BOLLOON_HOME = home;   // logStartupLine 无闸门时落这里 (不碰真 ~/.bolloon)
    installConsoleIntercept();
    try {
      transcriptStore.set([]);
      console.log('[pi-ai] ▶ purpose=main-agent source=pivot-loop model=glm-5.3-flash messages=3 promptChars=43668 tools=202 toolsHash=0ac2a0b9a78e cache_prompt=-');
      const msgs = transcriptStore.get();
      expect(msgs.some((m) => m.includes('[pi-ai] ▶'))).toBe(false);          // 整行不进消息流
      expect(msgs.some((m) => m.includes('cache_prompt'))).toBe(false);      // 折行续行更不可能
      // 但"搬走不是删掉": 同一行原文落 startup.log (grep 得回来)
      const logFile = path.join(home, 'logs', 'startup.log');
      expect(fs.existsSync(logFile)).toBe(true);
      expect(fs.readFileSync(logFile, 'utf8')).toContain('[pi-ai] ▶ purpose=main-agent');
    } finally {
      uninstallConsoleIntercept();
      process.env.BOLLOON_HOME = savedHome;
      if (savedVerbose !== undefined) process.env.BOLLOON_VERBOSE = savedVerbose;
    }
  });

  it('非内部行照旧进消息流 (误吞比漏吞更糟)', async () => {
    const { installConsoleIntercept, uninstallConsoleIntercept } = await import('../cli/ink-app.js');
    const { transcriptStore } = await import('../cli/stores.js');
    installConsoleIntercept();
    try {
      transcriptStore.set([]);
      console.log('主题: bolloon-agent-harness');       // 无模块标签的用户可见叙述
      console.warn('本地 IPNS 发布失败');                // warn 级可行动提示
      const msgs = transcriptStore.get();
      expect(msgs.some((m) => m === '主题: bolloon-agent-harness')).toBe(true);
      expect(msgs.some((m) => m.includes('⚠ 本地 IPNS 发布失败'))).toBe(true);
    } finally {
      uninstallConsoleIntercept();
    }
  });

  it('verbose 模式下内部行原样进消息流 (诊断能力一点不丢)', async () => {
    const { installConsoleIntercept, uninstallConsoleIntercept } = await import('../cli/ink-app.js');
    const { transcriptStore } = await import('../cli/stores.js');
    const savedVerbose = process.env.BOLLOON_VERBOSE;
    process.env.BOLLOON_VERBOSE = '1';
    installConsoleIntercept();
    try {
      transcriptStore.set([]);
      console.log('[pi-ai timing] total=1143ms attempt=1');
      expect(transcriptStore.get().some((m) => m.includes('[pi-ai timing]'))).toBe(true);
    } finally {
      uninstallConsoleIntercept();
      if (savedVerbose !== undefined) process.env.BOLLOON_VERBOSE = savedVerbose;
      else delete process.env.BOLLOON_VERBOSE;
    }
  });
});

describe('CLI 渲染过滤-E. 空回复不出空框 (2026-10-19, leo: 「还有一些空回复的问题」)', () => {
  it('空正文/纯空白/纯 ANSI → 一行如实说明, 不是 `│  │` 空框', async () => {
    const { renderAgentMessage } = await import('../cli/loading-tui.js');
    for (const empty of ['', '   \n  ', '\x1b[2m\x1b[0m']) {
      const plain = renderAgentMessage(empty).replace(/\x1b\[[0-9;]*m/g, '');
      expect(plain).toContain('本轮无文本回复');
      expect(plain).not.toContain('│');                 // 没有对话框边框 = 没有空框
    }
  });

  it('正常正文照旧出完整回复框 (不压缩, 标题 Bolloon Agent)', async () => {
    const { renderAgentMessage } = await import('../cli/loading-tui.js');
    const out = renderAgentMessage('这是正常回复');
    expect(out).toContain('Bolloon Agent');
    expect(out).toContain('这是正常回复');
  });
});

describe('CLI 渲染过滤-C. 接线 (源级): 三个咽喉都接上, 复盘状态已改只落盘', () => {
  it('console 两路 + writeOut 都过判据; 内部行优先于"需人介入"判定', () => {
    const gate = readSrc('src/cli/log-gate.ts');
    // console.log/info/... 那路: 内部诊断优先判
    const idxInternal = gate.indexOf('if (isInternalChatter(line)) {');
    const idxSignal = gate.indexOf('} else if (carriesHumanSignal(line)) {');
    expect(idxInternal).toBeGreaterThan(0);
    expect(idxSignal).toBeGreaterThan(idxInternal);            // 内部判**在**人味信号之前
    // console.error 那路: 文件全留, 只有 stderr 过过滤
    expect(gate).toMatch(/const passToScreen = lines\.filter\(/);
    // 统计分开计数 (便于诊断)
    expect(gate).toMatch(/internalSuppressed/);
    const index = readSrc('src/index.ts');
    expect(index).toMatch(/if \(isInternalChatter\(String\(line\)\)\) \{ bootLogOnly\(line\); return; \}/);
    expect(index).toMatch(/isInternalChatter, logStartupLine/);   // 已从 log-gate 导入
  });

  it('`📚 复盘` 那条**状态事件**已改成只落盘 (不再作为用户可见内容) + 反向断言', () => {
    const sdk = readSrc('src/agents/pi-sdk.ts');
    expect(sdk).toMatch(/console\.log\(`📚 复盘: \$\{m\}`\)/);
    expect(sdk, '复盘不许再作为 status 事件进对话流').not.toMatch(/eventSink\?\.\(\{ type: 'status', content: `📚 复盘/);
  });
});
