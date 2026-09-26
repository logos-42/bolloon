/**
 * onboard.ts — 可恢复的 Onboard 执行器 (Phase 2/4/6, 2026-09-16)
 *
 * 把"边问边写"的顺序脚本改成**阶段执行器**:
 *   load state → 显示已有输入 → 收集本次修改 → 本地校验 → 必要时真实验证
 *   → **原子提交该阶段结果** → 评估推进 → 下一阶段
 *
 * 失败一律: 保留已完成步骤 · 不清空旧配置 · 标记失败阶段与错误分类 ·
 *          给"重试/修改/返回上一步/修复"入口 · **不显示配置完成** · 不允许 Agent 执行。
 *
 * 阶段 (与 setup-store 的状态机 1:1):
 *   env → identity → provider → credential → model → connectivity → runtime → commit
 *
 * 对照 Hermes (`/Users/apple/Downloads/hermes/hermes_cli/setup.py`):
 *   - **独立 section + 左箭头回退重放**: 回到上一步会重放此前选择 (这里用"已完成输入摘要 + 可改"实现同一效果);
 *   - `--reconfigure` 只补/改缺失项 (`_skip_configured_section`);
 *   - `setup_summary.py` 的逐能力 readiness 行 —— 这里落到 `describeSetup()` + readinessWhy。
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  CANONICAL_CONFIG_FILE, LEGACY_CONFIG_FILE, type ConfigFacts, type ErrorClass, type Evaluation,
  type SetupStage, type SetupState, describeSetup, evaluateSetup, readConfigFacts, readSetupState,
  recordSetupFailure, recordSetupStage, refreshSetupState, resolveBolloonHome,
} from './setup-store.js';

// ── IO 抽象 (CLI 交真实终端; Web/测试交脚本化实现) ───────────────────────────

export interface OnboardChoice { value: string; label: string; hint?: string }

export interface OnboardIO {
  print(msg: string): void;
  ask(question: string, opts?: { defaultValue?: string; validate?: (v: string) => { ok: boolean; error?: string } }): Promise<string>;
  askHidden(question: string): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  select(question: string, choices: OnboardChoice[]): Promise<string>;
}

export type OnboardMode = 'setup' | 'resume' | 'repair' | 'reconfigure' | 'test' | 'status';

export interface StepReport {
  id: OnboardStepId;
  title: string;
  status: 'done' | 'skipped' | 'failed';
  note?: string;
  errorClass?: ErrorClass;
  ms?: number;
}

export interface OnboardResult {
  ok: boolean;
  mode: OnboardMode;
  stage: SetupState['stage'];
  gate: Evaluation['gate'];
  completed: SetupStage[];
  steps: StepReport[];
  failedStage?: OnboardStepId;
  errorClass?: ErrorClass;
  message?: string;
  /** 失败后可做的事 (重试/修改/返回上一步/修复) */
  actions: string[];
  state: SetupState;
  summary: string;
}

export type OnboardStepId = 'env' | 'identity' | 'provider' | 'credential' | 'model' | 'connectivity' | 'runtime';

interface StepCtx {
  home: string;              // 用户 HOME (身份文件在 $HOME/.bolloon/user.json)
  bolloonHome: string;
  io: OnboardIO;
  mode: OnboardMode;
  state: SetupState;
  facts: ConfigFacts;
  env: NodeJS.ProcessEnv;
  /** reconfigure: 用户明确想改的项 (provider/key/model/identity) */
  targets: OnboardStepId[];
}

type StepOutcome =
  | { ok: true; patch?: { inputs?: SetupState['inputs']; checks?: SetupState['checks'] }; note?: string }
  | { ok: false; errorClass: ErrorClass; message: string; retryable?: boolean };

// ── 错误分类 (timeout/auth/network/model/config/runtime) ────────────────────

export function classifyOnboardError(err: any): ErrorClass {
  const m = String(err?.message || err || '');
  if (/abort|timeout|timed out|ETIMEDOUT|超时/i.test(m)) return 'timeout';
  if (/401|403|invalid.*key|unauthor|api key/i.test(m)) return 'auth';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network|EAI_AGAIN|socket/i.test(m)) return 'network';
  if (/404|not found|baseUrl|endpoint/i.test(m)) return 'config';
  if (/model/i.test(m)) return 'model';
  if (/ENOSPC|EACCES|EPERM|EIO|write/i.test(m)) return 'io';
  return 'unknown';
}

// ── 阶段定义 ────────────────────────────────────────────────────────────────

export interface OnboardStep {
  id: OnboardStepId;
  title: string;
  stage: SetupStage;
  /** 这一步现在该不该跑 (已满足 → 跳过并保留输入) */
  shouldRun(c: StepCtx): boolean;
  run(c: StepCtx): Promise<StepOutcome>;
}

async function configStore(): Promise<any> {
  const mod: any = await import('../llm/config-store.js');
  return mod.llmConfigStore;
}

const stepEnv: OnboardStep = {
  id: 'env', title: '环境检查', stage: 'uninitialized',
  shouldRun: () => true,
  async run(c) {
    const major = Number(process.versions.node.split('.')[0]);
    if (Number.isFinite(major) && major < 18) return { ok: false, errorClass: 'runtime', message: `Node 版本过低 (${process.versions.node}), 需要 >=18` };
    try {
      await fs.mkdir(c.bolloonHome, { recursive: true });
      const probe = path.join(c.bolloonHome, '.onboard-probe');
      await fs.writeFile(probe, 'ok', 'utf8');
      await fs.rm(probe, { force: true });
    } catch (err) {
      return { ok: false, errorClass: 'io', message: `配置目录不可写 (${c.bolloonHome}): ${String((err as Error)?.message || err).slice(0, 120)}` };
    }
    return { ok: true, note: `Node ${process.versions.node} · 配置目录可写` };
  },
};

const stepIdentity: OnboardStep = {
  id: 'identity', title: '用户身份', stage: 'identity_pending',
  shouldRun: (c) => c.mode === 'reconfigure' ? c.targets.includes('identity') : !c.state.checks.identity,
  async run(c) {
    const { readUserIdentity, writeUserIdentity } = await import('../cli/setup-wizard.js');
    const existing = await readUserIdentity(c.home);
    if (existing?.did && c.mode !== 'reconfigure') {
      c.io.print(`已有身份: ${existing.name || '(未命名)'} · DID ${String(existing.did).slice(0, 18)}… (复用, 不重新生成)`);
      return { ok: true, patch: { inputs: { name: existing.name, identityDid: existing.did }, checks: { identity: true } }, note: '复用已有 DID' };
    }
    const name = await c.io.ask('你的称呼 (显示用, 40 字内)', { validate: (v) => (String(v || '').trim() ? { ok: true } : { ok: false, error: '不能为空' }) });
    const res = await writeUserIdentity(name, c.home);
    return {
      ok: true,
      patch: { inputs: { name: res.identity.name, identityDid: res.identity.did }, checks: { identity: true } },
      note: `${res.created ? '生成新 DID' : '更新称呼 (DID 未变)'}: ${String(res.identity.did).slice(0, 18)}…`,
    };
  },
};

const stepProvider: OnboardStep = {
  id: 'provider', title: '模型供应商', stage: 'provider_pending',
  shouldRun: (c) => c.mode === 'reconfigure' ? c.targets.includes('provider') : !c.state.checks.providerSelected,
  async run(c) {
    const mod: any = await import('../llm/config-store.js');
    const info = mod.PROVIDER_INFO || {};
    const store = mod.llmConfigStore;
    await store.initialize?.();
    const current = c.state.inputs.provider || (await store.getActiveProvider?.());
    const choices: OnboardChoice[] = Object.entries<any>(info).map(([value, v]) => ({
      value,
      label: `${v.name || value}${v.requiresApiKey === false ? ' (无需 key)' : ' (需要 key)'}`,
      hint: v.description || (v.models?.[0] ? `默认模型 ${v.models[0]}` : undefined),
    }));
    c.io.print(`供应商选择${current ? ` (当前 ${current}, 直接回车保留)` : ''} — 显示是否需要 key / 默认模型 / 来源`);
    let picked = await c.io.select('选择模型供应商', choices);
    if (!picked && current) picked = current;
    if (!picked) return { ok: false, errorClass: 'config', message: '没有选择供应商' };
    if (Object.keys(info).length > 0 && !info[picked]) {
      return { ok: false, errorClass: 'config', message: `未知供应商 "${picked}" (可选: ${Object.keys(info).slice(0, 8).join(', ')}…)` };
    }
    try {
      await store.updateProvider(picked, { enabled: true });
      // 2026-09-26 (P6): 这里**不再**直接 `setActiveProvider` —— 激活是"切换", 只能走统一入口,
      //   而且必须等 key/模型齐了、连通实测过了才切 (见 stepConnectivity 的成功分支)。
      //   早切的问题: 那时还没有 key, 切过去等于把 effective 配置指到一个用不了的供应商。
    } catch (err) {
      return { ok: false, errorClass: 'io', message: `写配置失败: ${String((err as Error)?.message || err).slice(0, 120)}` };
    }
    return {
      ok: true,
      patch: { inputs: { provider: picked }, checks: { providerSelected: true } },
      note: `${picked} 已 ${c.mode === 'reconfigure' ? '标记为候选 (测试通过后切换)' : '标记为待启用 (连通实测通过后由统一入口切换)'}`,
    };
  },
};

const stepCredential: OnboardStep = {
  id: 'credential', title: 'API 凭证', stage: 'credential_pending',
  shouldRun: (c) => {
    if (c.mode === 'reconfigure') return c.targets.includes('credential');
    const p = c.state.inputs.provider || c.facts.activeProvider;
    if (!p) return false;
    const cfg = c.facts.providers?.[p];
    return !cfg?.apiKey && cfg?.requiresApiKey !== false;
  },
  async run(c) {
    const store = await configStore();
    const provider = c.state.inputs.provider || c.facts.activeProvider;
    if (!provider) return { ok: false, errorClass: 'config', message: '还没选供应商, 无法配置凭证' };
    const existing = c.facts.providers?.[provider];
    if (existing?.apiKey && c.mode !== 'reconfigure') {
      c.io.print(`已存在 ${provider} 的 key (尾号 ****${String(existing.apiKey).slice(-4)}) — 复用, 不覆盖`);
      return { ok: true, patch: { inputs: { hasApiKey: true }, checks: { credentialPresent: true, providerUsable: true } }, note: '复用已有 key' };
    }
    c.io.print(`API key 只在隐藏输入里收, **不写状态文件、不落日志**; 目录: ~/.bolloon/${CANONICAL_CONFIG_FILE}`);
    const key = (await c.io.askHidden(`${provider} 的 API key`)).trim();
    if (!key) return { ok: false, errorClass: 'auth', message: '没有填 API key (Provider 已选择 ≠ 凭证已可用)' };
    try {
      await store.updateProvider(provider, { apiKey: key });
    } catch (err) {
      return { ok: false, errorClass: 'io', message: `写配置失败: ${String((err as Error)?.message || err).slice(0, 120)}` };
    }
    return {
      ok: true,
      patch: { inputs: { hasApiKey: true }, checks: { credentialPresent: true, providerUsable: true } },
      note: `key 已写入 (尾号 ****${key.slice(-4)})`,
    };
  },
};

const stepModel: OnboardStep = {
  id: 'model', title: '模型', stage: 'model_pending',
  shouldRun: (c) => {
    if (c.mode === 'reconfigure') return c.targets.includes('model');
    const p = c.state.inputs.provider || c.facts.activeProvider;
    const cfg = p ? c.facts.providers?.[p] : undefined;
    return !cfg?.model;                 // 没显式配过模型 → 让用户确认 (留空用默认)
  },
  async run(c) {
    const store = await configStore();
    const mod: any = await import('../llm/config-store.js');
    const provider = c.state.inputs.provider || c.facts.activeProvider;
    if (!provider) return { ok: false, errorClass: 'config', message: '还没选供应商' };
    const info = mod.PROVIDER_INFO?.[provider] || {};
    const def = info.models?.[0];
    c.io.print(`默认模型: ${def || '(该供应商未声明默认模型, 必须指定)'}${info.models?.length ? ` · 可选: ${info.models.slice(0, 5).join(', ')}` : ''}`);
    const model = (await c.io.ask('模型名 (留空用默认)', { defaultValue: def || '' })).trim() || def || '';
    if (!model) return { ok: false, errorClass: 'model', message: '没有可用模型名 (供应商未声明默认, 也没有手动指定)' };
    const custom = !(info.models || []).includes(model);
    try { await store.updateProvider(provider, { model }); }
    catch (err) { return { ok: false, errorClass: 'io', message: `写配置失败: ${String((err as Error)?.message || err).slice(0, 120)}` }; }
    return {
      ok: true,
      patch: { inputs: { model }, checks: { modelPresent: true, modelVerified: !custom } },
      note: `${model}${custom ? ' (自定义: 未经过供应商模型列表验证)' : ''}`,
    };
  },
};

const stepConnectivity: OnboardStep = {
  id: 'connectivity', title: '连通性实测', stage: 'connectivity_pending',
  shouldRun: (c) => c.mode === 'test' || c.mode === 'repair' ? true : !c.state.checks.connectivityOk || c.mode === 'reconfigure',
  async run(c) {
    const store = await configStore();
    const provider = c.state.inputs.provider || c.facts.activeProvider || (await store.getActiveProvider?.());
    if (!provider) return { ok: false, errorClass: 'config', message: '还没选供应商, 无法测试' };
    c.io.print(`用最终保存的 provider/key/baseUrl/model 真实测试 ${provider} …`);
    const res = await store.testProvider(provider);
    if (res?.success) {
      // 2026-09-26 (P6): 测试通过之后**才**真正切换 —— 而且只有一处实现: 统一入口 `selectModel()`。
      //   此前 setup 模式在 stepProvider 里直接 `setActiveProvider` (那时还没有 key, 也没探测过),
      //   reconfigure 模式则根本不切换 —— 两个都不算"同一语义"。
      //   这里 `verify:false`: 刚在上面真测过一次, 入口不用再打一次上游 (重复探测是浪费, 不是严谨)。
      try {
        const { selectModel } = await import('../llm/model-selection.js');
        const sw = await selectModel({ provider, model: c.state.inputs.model, scope: 'global', verify: false });
        if (!sw.ok) {
          return {
            ok: false,
            errorClass: sw.failureClass === 'missing_api_key' ? 'auth' : 'config',
            message: `连接是通的, 但切换没有落盘 [${sw.failureClass}]: ${sw.message}`,
            retryable: false,
          };
        }
        return {
          ok: true,
          patch: { checks: { connectivityOk: true, connectivityAt: new Date().toISOString(), connectivityErrorClass: undefined } },
          note: `通过 (${res.latency ?? '?'}ms) · 已由统一入口切到 ${sw.effective!.provider}/${sw.effective!.model}`,
        };
      } catch (err) {
        return { ok: false, errorClass: 'runtime', message: `连通但切换失败: ${String((err as Error)?.message || err).slice(0, 160)}` };
      }
    }
    const raw = String(res?.error || '未知错误');
    const cls: ErrorClass = /401|403|key/i.test(raw) ? 'auth' : /429|限流/i.test(raw) ? 'network' : /404|端点|baseUrl/i.test(raw) ? 'config' : /timeout|超时/i.test(raw) ? 'timeout' : /fetch|network|ECONN/i.test(raw) ? 'network' : 'unknown';
    // 记录失败 (不写成功)
    await recordSetupStage('connectivity_pending', { checks: { connectivityOk: false, connectivityErrorClass: cls } }, c.bolloonHome);
    return { ok: false, errorClass: cls, message: `连通性测试失败 [${cls}]: ${raw.slice(0, 200)}`, retryable: cls === 'timeout' || cls === 'network' || cls === 'unknown' };
  },
};

const stepRuntime: OnboardStep = {
  id: 'runtime', title: '运行时初始化', stage: 'runtime_pending',
  shouldRun: (c) => c.mode === 'test' || c.mode === 'repair' ? true : !c.state.checks.runtimeInitialized,
  async run(c) {
    // 真实执行: initMinimax + 建 session + 最小模型调用 (不是"检查 singleton 存在")
    c.env.BOLLOON_SETUP_IN_PROGRESS = '1';   // 初始化期间允许自身调用模型 (不触发执行门禁)
    const details: string[] = [];
    try {
      const mod: any = await import('../llm/pi-ai.js');
      // 2026-09-26 (P6): 运行时**只由统一入口装配** —— `installRuntime` 是唯一那个 initMinimax 调用点,
      //   这里不再自己 `initMinimax()` (那会让"按配置文件装配"和"按有效配置装配"分叉成两条)。
      const { applyEffectiveToRuntime } = await import('../llm/model-selection.js');
      const eff = await applyEffectiveToRuntime();
      const model = mod.getMinimax?.() || mod.getModel?.();
      if (!model) return { ok: false, errorClass: 'runtime', message: '统一入口装配之后仍拿不到模型对象' };
      details.push(`统一入口装配 ✓ (${eff.provider}/${eff.model})`);

      const chat = model.chat || model.generate || model.complete || model.call;
      if (typeof chat !== 'function') {
        return { ok: false, errorClass: 'runtime', message: '运行时对象没有可调用的 chat/generate 接口 —— 只有 singleton 不算 ready' };
      }
      const t0 = Date.now();
      const out: any = await Promise.race([
        chat.call(model, [{ role: 'user', content: 'ping' }], { maxTokens: 4 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: 最小模型调用 20s 未返回')), 20_000)),
      ]);
      const text = typeof out === 'string' ? out : (out?.content || out?.text || '');
      if (out == null) return { ok: false, errorClass: 'runtime', message: '最小模型调用没有返回结果' };
      details.push(`最小模型调用 ✓ (${Date.now() - t0}ms, ${String(text).slice(0, 20) || '空回复'})`);

      // session 创建 (真实)
      try {
        const { createAgentSession } = await import('../agents/pi-sdk-session-factory.js');
        const { readUserIdentity } = await import('../cli/setup-wizard.js');
        const id = await readUserIdentity(c.home);
        const sess: any = await createAgentSession({ cwd: process.cwd(), identityDoc: id ? ({ did: id.did, name: id.name } as any) : undefined } as any, true);
        if (sess) details.push('session 创建 ✓');
        else return { ok: false, errorClass: 'runtime', message: 'session 创建返回空 (运行时不可用)' };
      } catch (err) {
        return { ok: false, errorClass: 'runtime', message: `session 创建失败: ${String((err as Error)?.message || err).slice(0, 140)}` };
      }
    } catch (err) {
      return { ok: false, errorClass: classifyOnboardError(err), message: `运行时初始化失败: ${String((err as Error)?.message || err).slice(0, 160)}` };
    } finally {
      delete c.env.BOLLOON_SETUP_IN_PROGRESS;
    }
    return { ok: true, patch: { checks: { runtimeInitialized: true } }, note: details.join(' · ') };
  },
};

export const ONBOARD_STEPS: OnboardStep[] = [stepEnv, stepIdentity, stepProvider, stepCredential, stepModel, stepConnectivity, stepRuntime];

// ── 迁移 / 修复 (Phase 6) ───────────────────────────────────────────────────

export interface RepairReport { migrated: boolean; backedUpCorrupt?: string; notes: string[]; ok: boolean }

/**
 * 修复: ① 旧 `llm-config.json` → 迁移到 `bolloon-config.json` (迁移逻辑复用 config-store.initialize);
 *      ② 正式文件损坏 → **备份** 坏文件 (不静默丢弃) 后按默认重建, 并如实标注"配置被重置为默认"。
 */
export async function repairConfig(bolloonHome: string = resolveBolloonHome(), env: NodeJS.ProcessEnv = process.env): Promise<RepairReport> {
  const notes: string[] = [];
  let migrated = false;
  let backedUpCorrupt: string | undefined;
  const canonical = path.join(bolloonHome, CANONICAL_CONFIG_FILE);
  const legacy = path.join(bolloonHome, LEGACY_CONFIG_FILE);

  // 正式文件是否存在且可解析
  let canonicalOk = false;
  let canonicalBad = false;
  try { JSON.parse(await fs.readFile(canonical, 'utf8')); canonicalOk = true; }
  catch (err: any) { if (err?.code === 'ENOENT') canonicalOk = false; else canonicalBad = true; }

  if (canonicalBad) {
    const bak = `${canonical}.corrupt-${Date.now()}`;
    await fs.rename(canonical, bak);
    backedUpCorrupt = bak;
    notes.push(`正式配置损坏 → 已备份到 ${path.basename(bak)} 并按默认重建 (不假装原配置仍有效)`);
  }

  let legacyPresent = false;
  try { await fs.access(legacy); legacyPresent = true; } catch { legacyPresent = false; }

  if (!canonicalOk && legacyPresent) {
    // 直接文件迁移 (不依赖 config-store 的单例缓存 —— 修复操作必须是确定性的, 旧文件保留作备份)
    try {
      const legacyText = await fs.readFile(legacy, 'utf8');
      const parsed = JSON.parse(legacyText);
      if (!parsed || typeof parsed !== 'object') throw new Error('旧配置不是对象');
      const tmp = `${canonical}.migrating`;
      await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, canonical);
      migrated = true;
      notes.push(`${LEGACY_CONFIG_FILE} → ${CANONICAL_CONFIG_FILE} 已迁移 (旧文件保留)`);
      // 让 config-store 下次重新读盘 (它有自己的 initialized/config 缓存)
      try {
        const mod: any = await import('../llm/config-store.js');
        if (mod.llmConfigStore) { mod.llmConfigStore.initialized = false; mod.llmConfigStore.config = null; }
      } catch { /* 缓存失效失败不影响迁移结果 */ }
    } catch (err) {
      notes.push(`迁移失败: ${String((err as Error)?.message || err).slice(0, 120)}`);
    }
  } else if (!canonicalOk && !legacyPresent) {
    notes.push('没有可迁移的旧配置 (将按新配置流程走)');
  }
  const ok = await (async () => { try { JSON.parse(await fs.readFile(canonical, 'utf8')); return true; } catch { return !!backedUpCorrupt ? false : true; } })();
  return { migrated, backedUpCorrupt, notes, ok };
}

// ── 执行器 ──────────────────────────────────────────────────────────────────

export interface OnboardOptions {
  mode?: OnboardMode;
  io: OnboardIO;
  home?: string;
  bolloonHome?: string;
  env?: NodeJS.ProcessEnv;
  /** reconfigure: 要改哪些 (默认 provider+credential+model) */
  targets?: OnboardStepId[];
  /** 只跑一次 (不循环重试) —— Web/测试用 */
  oneShot?: boolean;
  /** 显式跳过的步骤 (如 --no-test 跳过连通性: 跳过 ≠ 通过, 门禁仍不会 ready) */
  skipSteps?: OnboardStepId[];
}

function stepIndexById(id: OnboardStepId): number { return ONBOARD_STEPS.findIndex((s) => s.id === id); }

/** 从状态推导"该从哪一步开始" (resume 的语义: 从第一个未完成阶段继续) */
export function startStepFor(state: SetupState): OnboardStepId {
  const c = state.checks;
  if (!c.identity) return 'identity';
  if (!c.providerSelected) return 'provider';
  if (!c.providerUsable) return 'credential';
  if (!c.modelPresent) return 'model';
  if (!c.connectivityOk) return 'connectivity';
  if (!c.runtimeInitialized) return 'runtime';
  return 'runtime';
}

export async function runOnboard(opts: OnboardOptions): Promise<OnboardResult> {
  const mode: OnboardMode = opts.mode || 'setup';
  const env = opts.env || process.env;
  const home = opts.home || env.HOME || os.homedir();
  const bolloonHome = opts.bolloonHome || resolveBolloonHome(env, home);
  const io = opts.io;
  const steps: StepReport[] = [];
  const targets = opts.targets || ['provider', 'credential', 'model'];
  const skip = new Set(opts.skipSteps || []);

  // status: 只读
  if (mode === 'status') {
    const ev = await evaluateSetup({ bolloonHome });
    io.print(describeSetup(ev));
    return { ok: ev.gate === 'ready', mode, stage: ev.state.stage, gate: ev.gate, completed: ev.state.completed, steps, actions: ev.state.actions, state: ev.state, summary: describeSetup(ev) };
  }

  // repair 前处理: 迁移 / 备份坏文件
  if (mode === 'repair') {
    io.print('开始修复: 检查配置文件 (旧文件迁移 / 损坏备份)');
    const rep = await repairConfig(bolloonHome, env);
    for (const n of rep.notes) io.print(`  · ${n}`);
    if (rep.backedUpCorrupt) io.print(`  · 已备份损坏文件: ${path.basename(rep.backedUpCorrupt)}`);
  }

  let state = (await readSetupState(bolloonHome)) || (await refreshSetupState({ bolloonHome })).state;
  let facts: ConfigFacts;
  try { facts = await readConfigFacts(bolloonHome); }
  catch (err) {
    // 正式配置损坏且不修 → 如实报错, 不进 ready
    const st = await recordSetupFailure('provider', 'config', String((err as Error)?.message || err).slice(0, 200), bolloonHome);
    return { ok: false, mode, stage: st.stage, gate: 'repair', completed: st.completed, steps, failedStage: 'provider', errorClass: 'config', message: '配置文件损坏 (可用 `--repair` 就地修复)', actions: st.actions, state: st, summary: describeSetup({ state: st, gate: 'repair', reasons: [], nextActions: st.actions }) };
  }

  const startAt = (mode === 'setup' || mode === 'resume') ? stepIndexById(startStepFor(state)) : 0;
  io.print(`Onboard 模式: ${mode} · 从 ${ONBOARD_STEPS[Math.max(0, startAt)].title} 开始 · 已完成: ${state.completed.join(' → ') || '(无)'}`);

  let failedStage: OnboardStepId | undefined;
  let failedClass: ErrorClass | undefined;
  let failedMessage: string | undefined;

  for (let i = 0; i < ONBOARD_STEPS.length; i++) {
    const step = ONBOARD_STEPS[i];
    if (i < startAt && mode !== 'repair' && mode !== 'reconfigure' && mode !== 'test') continue;

    if (skip.has(step.id)) { steps.push({ id: step.id, title: step.title, status: 'skipped', note: '按参数跳过 (跳过 ≠ 通过, 门禁不会 ready)' }); continue; }
    let ctx: StepCtx = { home, bolloonHome, io, mode, state, facts, env, targets };
    let should = step.shouldRun(ctx);
    if (!should) { steps.push({ id: step.id, title: step.title, status: 'skipped', note: '当前状态已满足' }); continue; }

    const t0 = Date.now();
    let outcome: StepOutcome;
    try { outcome = await step.run(ctx); }
    catch (err) { outcome = { ok: false, errorClass: classifyOnboardError(err), message: String((err as Error)?.message || err).slice(0, 200) }; }

    if (outcome.ok) {
      // 原子提交该阶段 (只有成功才写)
      await recordSetupStage(step.stage === 'uninitialized' ? 'uninitialized' : step.stage, outcome.patch || {}, bolloonHome);
      steps.push({ id: step.id, title: step.title, status: 'done', note: outcome.note, ms: Date.now() - t0 });
      io.print(`  ✓ ${step.title}: ${outcome.note || '完成'}`);
      // 重新评估 (每一步后刷新事实, 后面的步骤看到最新输入)
      const ev = await refreshSetupState({ bolloonHome, light: true });
      state = ev.state;
      try { facts = await readConfigFacts(bolloonHome); } catch { /* 保留旧 facts */ }
      continue;
    }

    // 失败: 记录 + 停在这里 (保留已完成步骤, 不清配置, 不显示完成)
    const st = await recordSetupFailure(step.id, outcome.errorClass, outcome.message, bolloonHome);
    steps.push({ id: step.id, title: step.title, status: 'failed', note: outcome.message, errorClass: outcome.errorClass, ms: Date.now() - t0 });
    failedStage = step.id; failedClass = outcome.errorClass; failedMessage = outcome.message;
    io.print(`  ✗ ${step.title}: ${outcome.message}`);
    state = st;
    if (opts.oneShot) break;
    // 交互模式: 给"重试 / 修改 / 返回上一步 / 停止" (恢复路径)
    const action = await io.select('这一步失败了, 怎么办?', [
      { value: 'retry', label: '重试这一步' },
      { value: 'edit', label: '修改输入后重试' },
      { value: 'back', label: '返回上一步' },
      { value: 'repair', label: '进入修复 (迁移/备份坏文件)' },
      { value: 'stop', label: '先停在这里 (下次 `bolloon setup` 从这里继续)' },
    ]);
    if (action === 'retry' || action === 'edit') { i--; failedStage = undefined; continue; }
    if (action === 'back') { i = Math.max(startAt - 1, 0) - 1; failedStage = undefined; continue; }
    if (action === 'repair') { const r = await repairConfig(bolloonHome, env); r.notes.forEach((n) => io.print(`  · ${n}`)); i--; failedStage = undefined; continue; }
    break;
  }

  // 最终 commit: 只有门禁 ready 才算成功
  const finalEv = await refreshSetupState({ bolloonHome });
  const ok = finalEv.gate === 'ready';
  const summary = describeSetup(finalEv);
  io.print(ok ? '✅ 初始化完成 (config + 状态都已提交)' : '⛔ 初始化未完成 (不会显示"配置完成", Agent 也不会执行)');
  io.print(summary);
  return {
    ok,
    mode,
    stage: finalEv.state.stage,
    gate: finalEv.gate,
    completed: finalEv.state.completed,
    steps,
    failedStage,
    errorClass: failedClass,
    message: failedMessage,
    actions: finalEv.state.actions,
    state: finalEv.state,
    summary,
  };
}

// ── 脚本化 IO (Web / 测试共用: 按顺序喂答案, 不阻塞) ────────────────────────

export class ScriptedIO implements OnboardIO {
  readonly log: string[] = [];
  private answers: string[];
  private stepAnswers: Record<string, string> = {};
  constructor(answers: (string | { select: string })[] = []) {
    this.answers = answers.map((a) => (typeof a === 'string' ? a : a.select));
  }
  print(msg: string): void { this.log.push(msg); }
  async ask(_q: string, opts?: { defaultValue?: string }): Promise<string> {
    const a = this.answers.shift();
    if (a === undefined) return opts?.defaultValue ?? '';
    return a;
  }
  async askHidden(): Promise<string> { return this.answers.shift() ?? ''; }
  async confirm(_q: string, d = true): Promise<boolean> { const a = this.answers.shift(); return a === undefined ? d : /^(y|yes|1|true|是)$/i.test(a); }
  async select(q: string, choices: OnboardChoice[]): Promise<string> {
    const a = this.answers.shift();
    if (a !== undefined && choices.some((c) => c.value === a)) return a;
    if (a !== undefined && /^\d+$/.test(a)) { const idx = Number(a) - 1; if (choices[idx]) return choices[idx].value; }   // 1-based, 与界面提示一致
    if (a !== undefined && a !== '') return a;          // 未匹配 → 原样返回, 由阶段自己做校验 (不静默回退到第一个选项)
    return choices[0]?.value || '';
  }
}

// ── 下一步要问什么 (Web 表单 / CLI 提示共用, 避免两处重复逻辑) ───────────────

export interface NextStepInfo {
  step: OnboardStepId;
  title: string;
  /** 需要什么输入: identity=name · provider=选择 · credential=key(隐藏) · model=模型名 · 其他=无输入 */
  needs: 'name' | 'provider' | 'credential' | 'model' | 'none';
  question: string;
  choices?: OnboardChoice[];
  defaultValue?: string;
}

export async function nextStepInfo(state: SetupState, facts?: ConfigFacts): Promise<NextStepInfo> {
  const step = startStepFor(state);
  const f = facts || (await readConfigFacts().catch(() => ({ source: 'missing', providers: {}, legacyPresent: false } as ConfigFacts)));
  switch (step) {
    case 'identity':
      return { step, title: '用户身份', needs: 'name', question: '你的称呼 (显示用, 已有 DID 会复用)' };
    case 'provider': {
      let choices: OnboardChoice[] = [];
      try {
        const mod: any = await import('../llm/config-store.js');
        choices = Object.entries<any>(mod.PROVIDER_INFO || {}).map(([value, v]) => ({
          value, label: `${v.name || value}${v.requiresApiKey === false ? ' (无需 key)' : ' (需要 key)'}`, hint: v.models?.[0] ? `默认模型 ${v.models[0]}` : undefined,
        }));
      } catch { /* 无 provider 列表也能继续 */ }
      return { step, title: '模型供应商', needs: 'provider', question: '选择模型供应商', choices, defaultValue: state.inputs.provider };
    }
    case 'credential':
      return { step, title: 'API 凭证', needs: 'credential', question: `${state.inputs.provider || f.activeProvider || 'provider'} 的 API key (不回显, 不写状态文件)` };
    case 'model':
      return { step, title: '模型', needs: 'model', question: '模型名 (留空用默认)', defaultValue: state.inputs.model };
    case 'connectivity':
      return { step, title: '连通性实测', needs: 'none', question: '用最终保存的配置做真实连通性测试' };
    default:
      return { step: 'runtime', title: '运行时初始化', needs: 'none', question: '真实 initMinimax + 建 session + 最小模型调用' };
  }
}
