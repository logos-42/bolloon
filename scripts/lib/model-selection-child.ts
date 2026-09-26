/**
 * model-selection-child.ts — 模型配置验收用的**独立进程** (2026-09-26)
 *
 * 为什么必须是真的另一个进程 (而不是同一个进程里连调两次):
 *   · "重启 CLI 后配置仍生效" 只有在**新进程**里读同一份文件才算数;
 *   · "两个进程同时切配置不互相覆盖" 只有在两个真进程并发写时才会暴露丢失更新。
 *
 * 用法: npx tsx scripts/lib/model-selection-child.ts <bolloonHome> <cmd> [args...]
 *   effective                                  读当前有效模型配置 (JSON)
 *   select <provider> <model> <baseUrl> [key]  走统一入口做一次切换 (JSON 结果)
 *
 * 输出以 `CHILD:` 前缀的单行 JSON 给出, 父进程按前缀解析。
 */

const home = process.argv[2];
process.env.BOLLOON_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
// 子进程只做配置层验证, 不重复打网络探测 (探测在父进程里真打过)
process.env.BOLLOON_MODEL_SKIP_PROBE = '1';

function emit(obj: unknown): void {
  process.stdout.write(`CHILD:${JSON.stringify(obj)}\n`);
}

(async () => {
  const cmd = process.argv[3];
  const MS: any = await import('../../src/llm/model-selection.js');

  if (cmd === 'effective') {
    const eff = await MS.effectiveModelConfig({});
    emit({ ok: true, effective: eff });
    process.exit(0);
  }

  if (cmd === 'select') {
    const provider = process.argv[4];
    const model = process.argv[5];
    const baseUrl = process.argv[6];
    const apiKey = process.argv[7];
    const r = await MS.selectModel({ provider, model, baseUrl, apiKey, scope: 'global' });
    emit({ ok: r.ok, failureClass: r.failureClass, message: r.message, effective: r.effective });
    process.exit(r.ok ? 0 : 1);
  }

  // 模拟"另一个进程自己改配置": 在跨进程锁里做一次 read-modify-write, 中间**故意拉开窗口**。
  // 有锁 → 并发的统一入口必须等它做完 (于是它能读到对方刚写的改动);
  // 没锁 → 对方会在窗口里写进去, 然后被这一份陈旧快照覆盖 —— 这就是"互相覆盖"。
  if (cmd === 'holdwrite') {
    const provider = process.argv[4];
    const model = process.argv[5];
    const holdMs = Number(process.argv[6] || 0);
    const CS: any = await import('../../src/llm/config-store.js');
    await MS.withConfigLock(async () => {
      CS.llmConfigStore.invalidate();
      await CS.llmConfigStore.initialize();
      if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
      await CS.llmConfigStore.updateProvider(provider, { model, enabled: true });
    });
    emit({ ok: true, provider, model });
    process.exit(0);
  }

  emit({ ok: false, message: `未知命令 ${cmd}` });
  process.exit(2);
})().catch((e) => {
  emit({ ok: false, message: String(e?.message || e) });
  process.exit(3);
});
