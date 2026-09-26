/**
 * model-entrypoint-child.ts — 「入口」验收用的**独立进程** (2026-09-26, P6)
 *
 * 为什么要独立进程: "三个入口得到同一份配置"这件事必须跨进程才算数 —— 同进程里连调三次
 * 会共享内存缓存, 读回来的当然是同一份, 那样的"绿"什么也证明不了。
 *
 * 用法: npx tsx scripts/lib/model-entrypoint-child.ts <HOME> <BOLLOON_HOME> <mode> [args...]
 *   session <arg...>        走**会话内 `/model`** 的调用形状 (index.ts 的 `/model` 段就是
 *                           逐字调 `runModelCommand(arg, { choose })`; 这里同样只给 `choose`,
 *                           且给一个"选择器不可用"的 choose —— 会话里按 Esc 就是这条路)
 *   effective               读当前有效模型配置 (JSON)
 *   discover <arg...>       走会话内 `/model` 的发现子命令 (refresh / list / admit)
 *   resume <runId>          真跑恢复路径里"按 Run 快照装配运行时"那一步 (不是整条 resumeRun)
 *
 * 输出: 单行 `CHILD:<json>`。父进程按前缀解析 (同 `model-selection-child.ts` 的约定)。
 */

// argv: <HOME> <BOLLOON_HOME> <mode> [args...]
//   两个都要: 配置目录看 BOLLOON_HOME, 而 `run-store` 的 runs 目录是 `os.homedir()/.bolloon/runs`
//   (2026-09-26 真跑踩到: 只给 BOLLOON_HOME 时, 恢复路径读的是另一个 home 下的 runs → "没有模型快照")。
const home = process.argv[2] || '';
const bolloonHome = process.argv[3] || `${home}/.bolloon`;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.BOLLOON_HOME = bolloonHome;

function emit(obj: unknown): void {
  process.stdout.write(`CHILD:${JSON.stringify(obj)}\n`);
}

(async () => {
  const mode = process.argv[4];
  const rest = process.argv.slice(5);

  if (mode === 'session' || mode === 'discover') {
    const { runModelCommand } = await import('../../src/cli/setup-wizard.js');
    const arg = rest.join(' ');
    const printed = await runModelCommand(arg, {
      // 会话内的 io 形状: 只有渲染层给的选择器。这里给"不可用"的实现 —— 与用户在会话里按 Esc 同路
      // (切换类命令不需要选择器; 需要选择器的分步流程会走到"当前环境没有交互能力"的明确文案)。
      choose: async () => null,
    });
    emit({ ok: true, mode, arg, printed });
    process.exit(0);
  }

  if (mode === 'effective') {
    const MS: any = await import('../../src/llm/model-selection.js');
    const eff = await MS.effectiveModelConfig({});
    emit({ ok: !!eff, effective: eff });
    process.exit(eff ? 0 : 1);
  }

  // 恢复路径的装配那一步: 真调 `applyRunModelConfigToRuntime` (resumeRun 内部同一条)
  if (mode === 'resume') {
    const MS: any = await import('../../src/llm/model-selection.js');
    const runId = rest[0];
    const drift = await MS.detectRunConfigDrift(runId);
    if (!drift) { emit({ ok: false, reason: '这个 Run 没有模型快照 (或读不到)' }); process.exit(2); }
    const eff = await MS.applyRunModelConfigToRuntime(drift.snapshot);
    emit({
      ok: true,
      drift: { verified: drift.verified, drifted: drift.drifted, message: drift.message, fields: drift.fields },
      snapshot: drift.snapshot,
      applied: eff,
    });
    process.exit(0);
  }

  emit({ ok: false, message: `未知 mode ${mode}` });
  process.exit(2);
})().catch((e) => {
  emit({ ok: false, message: String(e?.message || e).slice(0, 400) });
  process.exit(3);
});
