/**
 * verify-model-policy.ts — P7「长期任务 / Supervisor 的模型策略」真跑验收 (2026-09-26)
 *
 * 判据 (与计划 P7 逐条对齐, 全部真跑):
 *   [1] 在跑的 Run: 用户切 Global **不自动改写**它 (真 startRun + 真切全局 + 真读回盘上的快照)
 *   [2] 新 Run: 默认用**最新 Global** (真 startRun 用决定里的快照, 真读回)
 *   [3] `pinned`: 全局切成别的, 新 Run 仍用固定 provider/model/baseUrl
 *   [4] `session`: 无会话绑定 → 不被 Global 带走; 有会话绑定 → 跟随会话
 *   [5] Supervisor 备用模型: `auto` + 模型相关失败类别 → 用候选; `pinned` / 非模型相关类别 → 拒绝且说清原因
 *   [6] 切换**写 Run 事件**: `modelSwitches` 账本 + `harness` 镜像 (outcome/guardsCarried 都落盘)
 *   [7] **非幂等负控制** (真 agent + 真模型服务 + 真工具): 模型切换后, 下一个 Run 重放同一副作用动作
 *       **不得真的重做** (探针文件字节数不变, 步骤记为"恢复保护")
 *   [8] [7] 的**敏感性对照**: 不带守卫时同一动作**真的会重做** (探针 +1 字节)
 *       —— 没有这一条, [7] 的"没重做"可能只是探针不灵敏
 *
 * 真跑的含义: 起**真 HTTP 服务器**扮演模型服务 (会返回真 tool_calls), 用**真 agent 会话**驱动
 * **真工具** (`terminal` 往探针文件追加), 断言读的是**盘上的 Run 记录**与**探针文件字节数** ——
 * 不是查内存字段。
 *
 * 用法: npx tsx scripts/verify-model-policy.ts    (前台跑, 约 1.5~2 分钟: 每建一个 agent 会话 ~11s)
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

const REAL_HOME = os.homedir();                     // 必须在覆盖 HOME 之前取
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-model-policy-verify-'));
const HOME = path.join(TMP_ROOT, 'home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.BOLLOON_HOME;                    // 必须不设: resolveBolloonHome 优先 BOLLOON_HOME
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_SUPERVISOR = '0';
process.env.BOLLOON_RUN_MAX_STEPS = process.env.BOLLOON_RUN_MAX_STEPS || '8';
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });

/** 探针文件放在 HOME **之外** (工具的护栏会挡写 ~/.bolloon 数据) */
const PROBE = path.join(TMP_ROOT, 'side-effect.txt');

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n[${t}]`); }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 假模型服务 (真 HTTP): /models 供探测, /chat/completions 第一次给 tool_call, 之后给结论 ──

interface Hit { url: string; model: string; msgs: number; toolResult: boolean }
interface Stub { port: number; label: string; model: string; hits: Hit[]; close: () => Promise<void> }

function startStub(opts: { label: string; basePath: string; model: string; key: string; toolCmd?: string }): Promise<Stub> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url || '';
      if (req.method === 'GET' && url === `${opts.basePath}/models`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: opts.model, object: 'model' }] }));
        return;
      }
      if (req.method === 'POST' && url === `${opts.basePath}/chat/completions`) {
        const auth = String(req.headers.authorization || '');
        if (auth !== `Bearer ${opts.key}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        let body: any = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* 记录空 */ }
        const msgs = body.messages || [];
        const hasToolResult = msgs.some((m: any) => m.role === 'tool');
        hits.push({ url, model: String(body.model || ''), msgs: msgs.length, toolResult: hasToolResult });
        if (!hasToolResult && opts.toolCmd) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'stub-tool', object: 'chat.completion',
            choices: [{
              index: 0, finish_reason: 'tool_calls',
              message: {
                role: 'assistant', content: '',
                tool_calls: [{
                  id: 'call-p7', type: 'function',
                  function: { name: 'terminal', arguments: JSON.stringify({ command: opts.toolCmd }) },
                }],
              },
            }],
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'stub-text', object: 'chat.completion',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `${opts.label} 完成 <final gen>` } }],
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no route ${url}` } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as any).port, label: opts.label, model: opts.model, hits,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function probeBytes(): number {
  try { return fs.readFileSync(PROBE).length; } catch { return -1; }
}

async function main(): Promise<void> {
  // 初始化硬门禁: 隔离 HOME 必须"真的 ready"(复制真实 LLM 配置 + 身份 + 引导状态)
  try {
    const { makeSetupReady } = await import('./lib/make-setup-ready.js');
    const r = makeSetupReady(path.join(HOME, '.bolloon'), { realHome: REAL_HOME });
    console.log(`[setup-ready] ${r.ok ? 'LLM 配置已就绪' : '⚠ 无可用 LLM 配置'} · ${r.notes.length} 步`);
  } catch (e) { console.log('[setup-ready] 失败:', (e as Error)?.message); }

  const MP: any = await import('../src/agents/model-policy.js');
  const RS: any = await import('../src/agents/run-store.js');
  const G: any = await import('../src/agents/goal-store.js');
  const MS: any = await import('../src/llm/model-selection.js');
  const { createAgentSession } = await import('../src/agents/pi-sdk.js');

  const KEY_A = 'k-verify-a', KEY_B = 'k-verify-b';
  const A = await startStub({ label: 'A', basePath: '/v1', model: 'stubA-1', key: KEY_A, toolCmd: `printf x >> ${PROBE}` });
  const B = await startStub({ label: 'B', basePath: '/v1', model: 'stubB-1', key: KEY_B, toolCmd: `printf x >> ${PROBE}` });

  const selA = await MS.selectModel({ provider: 'deepseek', model: A.model, baseUrl: `http://127.0.0.1:${A.port}/v1`, apiKey: KEY_A, scope: 'global' });
  ok('全局默认切到服务 A (真探测通过)', selA.ok === true, selA.message || '');

  // ═══════════════════════════════════════════════════════════
  section('1 在跑的 Run: 切 Global 不改写它');

  const goal = await G.createGoal({ objective: 'P7 策略验收: 一次真实副作用 + 模型切换', channelId: 'ch-p7', agentId: 'ag-p7', createdBy: 'verify-model-policy' });
  const snapA = await MS.captureRunModelConfig();
  const run1 = await RS.startRun({ surface: 'cli', goalId: goal.goalId, goal: goal.objective, modelConfig: snapA });
  ok('Run1 建好并带快照', run1.modelConfig?.provider === 'deepseek' && run1.modelConfig?.model === A.model, JSON.stringify(run1.modelConfig));

  const selB = await MS.selectModel({ provider: 'deepseek', model: B.model, baseUrl: `http://127.0.0.1:${B.port}/v1`, apiKey: KEY_B, scope: 'global' });
  ok('执行中把全局默认切到服务 B', selB.ok === true && selB.effective?.model === B.model, selB.message || '');
  ok('全局默认真的变了 (hash 不同)', selB.effective?.configHash !== snapA.configHash, `${selB.effective?.configHash} vs ${snapA.configHash}`);

  const cur = await MP.resolveCurrentRunModel(run1.runId, { record: true });
  ok('在跑的 Run 仍返回自己的快照 (provider/model/baseUrl/hash 全等)',
    cur?.decision.config?.configHash === snapA.configHash
    && cur?.decision.config?.model === A.model
    && cur?.decision.config?.baseUrl === snapA.baseUrl,
    JSON.stringify(cur?.decision.config || null));
  ok('这条决定被标成"冻结"且理由是"不改写在跑的 Run"', cur?.decision.frozen === true && /不自动改写/.test(String(cur?.decision.reason)), String(cur?.decision.reason));
  const run1Back = await RS.readRun(run1.runId);
  ok('盘上 Run1 的快照**一个字节都没变**', JSON.stringify(run1Back.modelConfig) === JSON.stringify(snapA), JSON.stringify(run1Back.modelConfig));

  // ═══════════════════════════════════════════════════════════
  section('2 新 Run: 默认用最新 Global');

  const next = await MP.resolveNextRunModel({ prevRunId: run1.runId, goalId: goal.goalId });
  ok('auto 策略取到"最新 Global" (service B 的模型)', next.decision.source === 'global' && next.decision.config?.model === B.model, MP.formatModelDecision(next.decision));
  ok('承认"换了"(旧快照 hash ≠ 新快照 hash)', next.decision.switched === true && next.decision.config?.configHash !== snapA.configHash, `${next.decision.config?.configHash} vs ${snapA.configHash}`);
  ok('没声明策略时 origin=default (不假装用户设过)', next.policyOrigin === 'default', next.policyOrigin);
  const run2 = await RS.startRun({ surface: 'cli', goalId: goal.goalId, goal: goal.objective, modelConfig: next.startRunModelConfig });
  const run2Back = await RS.readRun(run2.runId);
  ok('新 Run 的盘上快照就是新模型', run2Back.modelConfig?.model === B.model && run2Back.modelConfig?.configHash === next.decision.config?.configHash, JSON.stringify(run2Back.modelConfig));

  // ═══════════════════════════════════════════════════════════
  section('3 pinned: 全局切了也不换');

  const pinGoal = await G.createGoal({ objective: 'P7 pinned 验收', channelId: 'ch-p7', createdBy: 'verify-model-policy' });
  const pinWrite = await MP.writeGoalModelPolicy(pinGoal.goalId, {
    mode: 'pinned',
    pin: { provider: 'deepseek', model: A.model, baseUrl: `http://127.0.0.1:${A.port}/v1` },
  }, { updatedBy: 'verify-model-policy' });
  ok('pinned 策略落盘', pinWrite.ok === true, pinWrite.reason || JSON.stringify(pinWrite.policy));
  const pinRun1 = await RS.startRun({ surface: 'cli', goalId: pinGoal.goalId, goal: 'pinned 第一条', modelConfig: snapA });
  const pinNext = await MP.resolveNextRunModel({ prevRunId: pinRun1.runId, goalId: pinGoal.goalId });
  ok('pinned: 新 Run 用固定三元组 (source=goal_pin)', pinNext.decision.source === 'goal_pin' && pinNext.decision.config?.model === A.model, MP.formatModelDecision(pinNext.decision));
  ok('pinned 的 hash = 固定三元组算出来的 hash',
    pinNext.decision.config?.configHash === MS.configHashOf({ provider: 'deepseek', model: A.model, baseUrl: `http://127.0.0.1:${A.port}/v1` }),
    String(pinNext.decision.config?.configHash));
  ok('pinned 策略读取来源是 sidecar', pinNext.policyOrigin === 'sidecar', pinNext.policyOrigin);
  // 固定策略与"在跑的快照"冲突时: 只留冲突事实, 不在跑动中换
  const conflict = await MP.resolveCurrentRunModel(run2.runId, { policy: { mode: 'pinned', pin: { provider: 'deepseek', model: A.model, baseUrl: `http://127.0.0.1:${A.port}/v1` } }, record: true });
  ok('冲突被点名 (model 一侧不符) 且不改写在跑的 Run',
    (conflict?.decision.conflict || []).some((c: any) => c.field === 'model') && conflict?.decision.config?.model === B.model,
    JSON.stringify(conflict?.decision.conflict || []));

  // ═══════════════════════════════════════════════════════════
  section('4 session: 只跟随当前交互会话');

  const sessGoal = await G.createGoal({ objective: 'P7 session 验收', channelId: 'ch-p7', createdBy: 'verify-model-policy' });
  await MP.writeGoalModelPolicy(sessGoal.goalId, { mode: 'session' }, { updatedBy: 'verify-model-policy' });
  const sessRun1 = await RS.startRun({ surface: 'cli', goalId: sessGoal.goalId, goal: 'session 第一条', sessionKey: 'sess-p7', modelConfig: snapA });
  const sessNoBind = await MP.resolveNextRunModel({ prevRunId: sessRun1.runId, goalId: sessGoal.goalId, sessionKey: 'sess-p7-no-binding' });
  ok('session 无会话绑定: 沿用上一条 Run 的快照 (Global 的新默认不传播)', sessNoBind.decision.config?.configHash === snapA.configHash && sessNoBind.decision.config?.model === A.model, MP.formatModelDecision(sessNoBind.decision));
  ok('session 无绑定这条被标冻结 (不擅自跟随)', sessNoBind.decision.frozen === true, String(sessNoBind.decision.reason));

  await MS.writeSessionSelection('sess-p7-bound', { provider: 'deepseek', model: B.model, baseUrl: `http://127.0.0.1:${B.port}/v1` });
  const sessBound = await MP.resolveNextRunModel({ prevRunId: sessRun1.runId, goalId: sessGoal.goalId, sessionKey: 'sess-p7-bound' });
  ok('session 有会话绑定: 用会话那一份 (source=session)', sessBound.decision.source === 'session' && sessBound.decision.config?.model === B.model, MP.formatModelDecision(sessBound.decision));

  // ═══════════════════════════════════════════════════════════
  section('5 Supervisor 备用模型: 按失败类别');

  const fbAlt = MP.runConfigOf({ provider: 'openai', model: 'gpt-5.6', baseUrl: 'https://api.openai.com/v1', selectionScope: 'global' });
  const fbCurrent = await MS.captureRunModelConfig();          // 当前生效的那一份 (候选里放它 = 验"同一份不算备用")
  const fbAllowed = await MP.resolveNextRunModel({ prevRunId: run1.runId, goalId: goal.goalId, policy: { mode: 'auto' }, errorClass: 'transient', fallbackCandidates: [fbCurrent, fbAlt] });
  ok('auto + transient: 允许挑备用, 且跳过"与当前相同的那一份"选了候选',
    fbAllowed.decision.source === 'supervisor_fallback'
    && fbAllowed.decision.config?.configHash === fbAlt.configHash
    && fbAllowed.decision.config?.configHash !== fbCurrent.configHash,
    MP.formatModelDecision(fbAllowed.decision));
  const fbDeniedByClass = await MP.resolveNextRunModel({ prevRunId: run1.runId, goalId: goal.goalId, policy: { mode: 'auto' }, errorClass: 'bad_args', fallbackCandidates: [fbAlt] });
  ok('auto + bad_args (与模型无关): 拒绝换, 理由里点名失败类别', fbDeniedByClass.decision.source !== 'supervisor_fallback' && /bad_args/.test(String(fbDeniedByClass.decision.reason)), String(fbDeniedByClass.decision.reason));
  const fbDeniedByPolicy = await MP.resolveNextRunModel({ prevRunId: pinRun1.runId, goalId: pinGoal.goalId, errorClass: 'auth', fallbackCandidates: [fbAlt] });
  ok('pinned + auth: 拒绝换 (固定就要可追溯)', fbDeniedByPolicy.decision.source !== 'supervisor_fallback' && /不许挑备用模型/.test(String(fbDeniedByPolicy.decision.reason)), String(fbDeniedByPolicy.decision.reason));

  // ═══════════════════════════════════════════════════════════
  section('6 切换事件真落盘');

  const events = (await RS.readRun(run1.runId)).modelSwitches || [];
  ok('Run1 上的切换事件按发生顺序落盘 (第 1 条=当前 Run 被冻结, 第 2 条=新 Run 换到 B)',
    events.length >= 2 && events[0].outcome === 'frozen' && events[1].outcome === 'switched',
    JSON.stringify(events.map((e: any) => e.outcome)));
  ok('事件带 from/to 两份快照 (hash 都能对上)',
    events[1]?.from?.configHash === snapA.configHash && events[1]?.to?.configHash === selB.effective?.configHash,
    `${events[1]?.from?.configHash} → ${events[1]?.to?.configHash}`);
  ok('事件记了策略模式与来源层', events[1]?.mode === 'auto' && events[1]?.source === 'global', `mode=${events[1]?.mode} source=${events[1]?.source}`);
  const harnessMirror = ((await RS.readRun(run1.runId)).harness || []).filter((e: any) => e.event === 'model.switch');
  ok('harness 审计账本上也有逐条镜像 (冻结=deny, 真换=note)',
    harnessMirror.length === events.length && harnessMirror[0].kind === 'deny' && harnessMirror[1].kind === 'note',
    JSON.stringify(harnessMirror.map((e: any) => e.kind)));
  const conflictRun = await RS.readRun(run2.runId);
  ok('冲突事件写成了 outcome=conflict (不算成功切换)', (conflictRun.modelSwitches || []).some((e: any) => e.outcome === 'conflict'), JSON.stringify((conflictRun.modelSwitches || []).map((e: any) => e.outcome)));

  // ═══════════════════════════════════════════════════════════
  section('7 非幂等负控制 (真 agent + 真工具): 模型切换后不重跑副作用');

  const proxyGoal = await G.createGoal({ objective: `把字符串追加进 ${PROBE} (非幂等副作用)`, channelId: 'ch-p7-agent', agentId: 'ag-p7', createdBy: 'verify-model-policy' });

  // 回到服务 A, 让"第一条 Run"真跑出一次副作用
  await MS.selectModel({ provider: 'deepseek', model: A.model, baseUrl: `http://127.0.0.1:${A.port}/v1`, apiKey: KEY_A, scope: 'global' });
  const snaps = await MS.captureRunModelConfig();
  const agent1: any = await createAgentSession({ cwd: process.cwd(), peerId: `p7-verify-1:${Date.now()}`, channelId: 'ch-p7-agent' } as any, true);
  agent1.setGoalId?.(proxyGoal.goalId);
  await agent1.prompt(`请用 terminal 执行: printf x >> ${PROBE}`);
  const agentRun1 = agent1.getLastRunId?.() || agent1.getRunId?.();
  const rec1 = agentRun1 ? await RS.readRun(agentRun1) : null;
  const realWrites = (rec1?.steps || []).filter((s: any) => s.ok && s.tool === 'terminal' && !String(s.summary || '').startsWith('[恢复保护]'));
  ok('第一条 Run 真跑了非幂等工具 (盘上步骤 + 探针文件出现)', !!rec1 && realWrites.length >= 1 && probeBytes() === 1,
    `run=${agentRun1} steps=${JSON.stringify((rec1?.steps || []).map((s: any) => [s.tool, s.ok]))} probe=${probeBytes()}B`);
  ok('第一条 Run 的模型快照 = 服务 A', rec1?.modelConfig?.model === A.model && rec1?.modelConfig?.configHash === snaps.configHash, JSON.stringify(rec1?.modelConfig));

  // 用户切默认模型 (A → B), 然后为**下一个 Run** 解析策略
  await MS.selectModel({ provider: 'deepseek', model: B.model, baseUrl: `http://127.0.0.1:${B.port}/v1`, apiKey: KEY_B, scope: 'global' });
  const cont = await MP.resolveNextRunModel({ prevRunId: agentRun1, goalId: proxyGoal.goalId });
  ok('模型切换被承认, 且守卫带过来了', cont.decision.config?.model === B.model && cont.decision.switched === true
    && cont.continuation.guards.some((g: any) => g.tool === 'terminal') && cont.continuation.guardsDropped === 0,
    `${MP.formatModelDecision(cont.decision)} · guards=${JSON.stringify(cont.continuation.guards.map((g: any) => g.tool))} dropped=${cont.continuation.guardsDropped}`);

  const hitsBBefore = B.hits.length;
  const agent2: any = await createAgentSession({ cwd: process.cwd(), peerId: `p7-verify-2:${Date.now()}`, channelId: 'ch-p7-agent' } as any, true);
  agent2.setGoalId?.(proxyGoal.goalId);
  agent2.setContinuationGuards?.(cont.continuation.guards);       // 走真执行链的守卫入口 (与 Supervisor/CLI 同一处)
  await agent2.prompt(`继续这个目标 (不要重头开始): 再用 terminal 执行 printf x >> ${PROBE}`);
  const agentRun2 = agent2.getLastRunId?.() || agent2.getRunId?.();
  const rec2 = agentRun2 ? await RS.readRun(agentRun2) : null;
  const guardedSteps = (rec2?.steps || []).filter((s: any) => s.tool === 'terminal' && String(s.summary || '').startsWith('[恢复保护]'));
  ok('第二条 Run 真的用了新模型 (服务 B 收到请求)', B.hits.length > hitsBBefore, `B.hits=${B.hits.length - hitsBBefore} model=${B.hits.at(-1)?.model}`);
  ok('副作用**没有重做**: 探针文件仍是 1 字节', probeBytes() === 1, `probe=${probeBytes()}B`);
  ok('这一步在盘上记为"恢复保护"(跳过而非执行)', guardedSteps.length >= 1, JSON.stringify((rec2?.steps || []).map((s: any) => [s.tool, String(s.summary || '').slice(0, 24)])));
  const contEvent = ((await RS.readRun(agentRun1)).modelSwitches || []).at(-1);
  ok('事件里记了这次切换带过去几条守卫', contEvent?.outcome === 'switched' && contEvent?.guardsCarried >= 1, JSON.stringify(contEvent));

  // ═══════════════════════════════════════════════════════════
  section('8 敏感性对照: 不带守卫时同一动作**真会**重做');

  const agent3: any = await createAgentSession({ cwd: process.cwd(), peerId: `p7-verify-3:${Date.now()}`, channelId: 'ch-p7-agent' } as any, true);
  agent3.setGoalId?.(proxyGoal.goalId);
  agent3.setContinuationGuards?.([]);                              // 故意不带守卫
  await agent3.prompt(`再用 terminal 执行 printf x >> ${PROBE}`);
  const agentRun3 = agent3.getLastRunId?.() || agent3.getRunId?.();
  const rec3 = agentRun3 ? await RS.readRun(agentRun3) : null;
  ok('不带守卫 → 副作用真的又发生了一次 (探针 2 字节)', probeBytes() === 2, `probe=${probeBytes()}B run=${agentRun3} steps=${JSON.stringify((rec3?.steps || []).map((s: any) => s.tool))}`);
  ok('这一条证明第 7 节的"没重做"来自守卫, 不是探针不灵敏', probeBytes() === 2 && guardedSteps.length >= 1, `guarded=${guardedSteps.length}`);

  // ═══════════════════════════════════════════════════════════
  console.log(`\n════════ P7 真跑验收: PASS ${passed} / FAIL ${failed} ════════`);
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log(`  · ${f}`); }
  console.log(`产物: 探针 ${PROBE} = ${probeBytes()} 字节 · 事件账本 ${(await RS.readRun(run1.runId)).modelSwitches?.length} 条`);
  A.close(); B.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本自身抛错:', e); process.exit(2); });
