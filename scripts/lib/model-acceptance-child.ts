/**
 * model-acceptance-child.ts — 模型切换验收 (P8) 用的**独立进程** (2026-09-26)
 *
 * 为什么必须是真进程, 而不是主进程里连调两次:
 *   · 「重启 CLI 后仍生效」只有在**新进程**里读同一份文件才算数;
 *   · 「两个进程同时切配置不互相覆盖」只有在两个真进程真并发写时才暴露丢失更新;
 *   · 「CLI `/model` 切完, 下一次请求命中新端点」必须证明**同一个进程内**的运行时实例
 *     真被换掉了 —— 这是 P0 修的那个硬缺陷 (配置文件已改、内存实例还是旧的), 同进程才验得到。
 *
 * 用法: npx tsx scripts/lib/model-acceptance-child.ts '<json>'
 *   json = { home, bolloonHome, mode, ...参数 }
 *   mode:
 *     effective                     读当前有效模型配置
 *     call <label>                  按当前有效配置装配运行时 → 打一次真模型请求 (回 reply)
 *     session-switch <arg>          会话内 `/model <arg...>` 的形状 (runModelCommand) → 再打一次真请求
 *     legacy-switch <target>        **反事实臂**: 只写配置文件、**不重建运行时** → 再打一次真请求
 *                                   (= P0 修之前 CLI `/model` 的行为)
 *     select <target>               走统一入口做一次切换
 *     holdwrite <fields>            在(或不在)跨进程锁里做一次 read-modify-write (中间故意拉窗口)
 *     install-run <runId>           按这个 Run 的快照装配运行时 (恢复路径那一步) → 再打一次真请求
 *
 * 输出: 单行 `CHILD:<json>` (父进程按前缀解析)。
 * 本文件只写"发生了什么": 谁先应答由 reply 里的假上游标签给出 —— 父进程据此判定命中了哪台。
 */

const raw = process.argv[2] || '{}';
let arg: any = {};
try { arg = JSON.parse(raw); } catch { /* 下面报错退出 */ }

process.env.HOME = String(arg.home || '');
process.env.USERPROFILE = String(arg.home || '');
process.env.BOLLOON_HOME = String(arg.bolloonHome || `${arg.home}/.bolloon`);
delete process.env.BOLLOON_MODEL_SKIP_PROBE;

function emit(obj: unknown): void {
  process.stdout.write(`CHILD:${JSON.stringify(obj)}\n`);
}

/** 一次真模型请求 (真 HTTP 出去, 打到假上游; reply 里带假上游自己的标签) */
async function callOnce(label: string): Promise<{ reply?: string; error?: string }> {
  try {
    const { getMinimax } = await import('../../src/llm/pi-ai.js');
    const r: any = await getMinimax().chat(`probe-${label}`);
    return { reply: String(r?.reply ?? '') };
  } catch (e: any) {
    return { error: String(e?.message || e).slice(0, 240) };
  }
}

(async () => {
  const mode = String(arg.mode || '');
  const MS: any = await import('../../src/llm/model-selection.js');
  const CS: any = await import('../../src/llm/config-store.js');

  if (mode === 'effective') {
    const eff = await MS.effectiveModelConfig({ ...(arg.sessionKey ? { sessionKey: arg.sessionKey } : {}) });
    emit({ ok: true, effective: eff });
    process.exit(0);
  }

  if (mode === 'call') {
    await MS.applyEffectiveToRuntime(arg.sessionKey);
    const r = await callOnce(String(arg.label || 'call'));
    emit({ ok: !r.error, ...r });
    process.exit(r.error ? 1 : 0);
  }

  if (mode === 'session-switch') {
    const { runModelCommand } = await import('../../src/cli/setup-wizard.js');
    const printed = await runModelCommand(String(arg.arg || ''), { choose: async () => null });
    const r = await callOnce(String(arg.label || 'session'));
    emit({ ok: !r.error, printed, ...r });
    process.exit(r.error ? 1 : 0);
  }

  // ── 反事实臂: 旧行为 (写配置 + 换 activeProvider, 但不重建运行时) ──
  if (mode === 'legacy-switch') {
    const t = arg.target || {};
    // 先把运行时按**当前**配置 (旧端点) 装好 —— 真实会话启动时就是这一步
    await MS.applyEffectiveToRuntime();
    const boot = await MS.effectiveModelConfig({});
    // 然后只改配置 (旧 CLI `/model` 的做法: updateProvider + setActiveProvider, 不重建实例)
    const patch: any = { enabled: true, model: t.model, baseUrl: t.baseUrl };
    if (t.apiKey) patch.apiKey = t.apiKey;
    await CS.llmConfigStore.updateProvider(t.provider, patch);
    await CS.llmConfigStore.setActiveProvider(t.provider);
    const after = await MS.effectiveModelConfig({});
    const r = await callOnce(String(arg.label || 'legacy'));
    emit({
      ok: !r.error,
      bootedWith: `${boot.provider}/${boot.model}@${boot.baseUrl}`,
      nowEffective: `${after.provider}/${after.model}@${after.baseUrl}`,
      ...r,
    });
    process.exit(r.error ? 1 : 0);
  }

  // ── 两个进程争同一个文件: 先到屏障报到, 父进程"发令"后**同时**做 read-modify-write ──
  //     (真并发: 不是靠 sleep 猜时机 —— 两边都在同一个瞬间进 read→write 窗口)
  if (mode === 'select-race') {
    const t = arg.target || {};
    const fsMod: any = await import('fs');
    fsMod.writeFileSync(String(arg.readyPath), 'ready');
    const deadline = Date.now() + 15000;
    while (!fsMod.existsSync(String(arg.goPath))) {
      if (Date.now() > deadline) { emit({ ok: false, message: '等不到发令文件 (屏障超时)' }); process.exit(4); }
      await new Promise((r) => setTimeout(r, 5));
    }
    const res = await MS.selectModel({
      provider: t.provider, model: t.model, baseUrl: t.baseUrl, apiKey: t.apiKey,
      scope: t.scope || 'global',
    });
    emit({ ok: res.ok, failureClass: res.failureClass, message: res.message, effective: res.effective });
    process.exit(res.ok ? 0 : 1);
  }

  if (mode === 'select') {
    const t = arg.target || {};
    const res = await MS.selectModel({
      provider: t.provider, model: t.model, baseUrl: t.baseUrl, apiKey: t.apiKey,
      scope: t.scope || 'global',
      ...(t.sessionKey ? { sessionKey: t.sessionKey } : {}),
      ...(t.verify === false ? { verify: false } : {}),
    });
    emit({ ok: res.ok, failureClass: res.failureClass, message: res.message, effective: res.effective });
    process.exit(res.ok ? 0 : 1);
  }

  // ── 两个进程同时改配置: 带锁 vs **不带锁** (反事实) ──
  if (mode === 'holdwrite') {
    const t = arg.target || {};
    const holdMs = Number(arg.holdMs || 0);
    const useLock = arg.lock !== false;
    const fsMod: any = await import('fs');
    let t0 = 0;
    let t1 = 0;
    const rmw = async (): Promise<void> => {
      t0 = Date.now();
      // 临界区里先落一个"我正持锁"的标记 (父进程据此确认窗口真的开始了)
      if (arg.markerPath) fsMod.writeFileSync(String(arg.markerPath), String(process.pid));
      CS.llmConfigStore.invalidate();
      await CS.llmConfigStore.initialize();
      if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
      await CS.llmConfigStore.updateProvider(t.provider, { model: t.model, enabled: true });
      t1 = Date.now();
    };
    const before = Date.now();
    if (useLock) await MS.withConfigLock(rmw);
    else await rmw();
    emit({ ok: true, provider: t.provider, model: t.model, lock: useLock, t0, t1, enteredAt: before, releasedAt: Date.now() });
    process.exit(0);
  }

  // ── 恢复路径: 按 Run 自己的快照装配运行时 → 再打一次真请求 ──
  if (mode === 'install-run') {
    const drift = await MS.detectRunConfigDrift(String(arg.runId || ''));
    if (!drift) { emit({ ok: false, reason: '这个 Run 没有模型快照 (或读不到)' }); process.exit(2); }
    const applied = await MS.applyRunModelConfigToRuntime(drift.snapshot);
    const r = await callOnce(String(arg.label || 'resume'));
    emit({
      ok: !r.error,
      snapshot: drift.snapshot,
      applied,
      drifted: drift.drifted,
      ...r,
    });
    process.exit(r.error ? 1 : 0);
  }

  emit({ ok: false, message: `未知 mode ${mode}` });
  process.exit(2);
})().catch((e) => {
  emit({ ok: false, message: String(e?.stack || e?.message || e).slice(0, 600) });
  process.exit(3);
});
