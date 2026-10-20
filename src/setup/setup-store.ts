/**
 * setup-store.ts — 初始化的**唯一事实来源** (M0/M1 + Phase 1 事实来源统一, 2026-09-16)
 *
 * 职责边界 (冻结):
 *   ① **只汇总不新增配置库**: 身份看 `user.json`; LLM 看 `bolloon-config.json`
 *      (**旧 `llm-config.json` 只作迁移输入**, 2026-08-07 已改名); 技能看 `skills-registry.json`;
 *      长期执行看 `supervisor.json` + runs/goals 目录; `setup-state.json` 只存引导进度/校验结果/readiness,
 *      永不存 apiKey 明文。
 *   ② 冻结初始化状态机 + 启动门禁结论 (ready/setup/repair/blocked)。
 *   ③ readiness 四层是**真实检查结果**:
 *        basic   = identity + provider + credential + model + connectivity + runtime
 *        agent   = basic + PiAgentHarness + 技能健康 (skillsOk 未知 **不算通过**)
 *        durable = agent + RunStore/GoalStore + Supervisor runner 可解析 + lease 可写
 *        network = P2P/Kubo (optional, 不阻塞基础对话)
 *
 * 不可混淆 (Phase 1): Provider 已选择 ≠ 凭证已可用 · 凭证存在 ≠ 模型可用 ·
 *                     模型可用 ≠ 运行时已初始化 · runtime ready ≠ 长期执行 ready
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

// ── 路径统一 (所有入口走这一个解析, 不在模块顶层永久缓存 HOME) ──────────────

export function resolveBolloonHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const explicit = env.BOLLOON_HOME?.trim();
  if (explicit) return explicit;
  return path.join(env.HOME || home, '.bolloon');
}

export function setupStatePath(bolloonHome: string = resolveBolloonHome()): string {
  return path.join(bolloonHome, 'setup-state.json');
}

/** 正式配置文件 (config-store 写这个) */
export const CANONICAL_CONFIG_FILE = 'bolloon-config.json';
/** 迁移期旧文件: **只作输入** */
export const LEGACY_CONFIG_FILE = 'llm-config.json';

// ── 状态机 ──────────────────────────────────────────────────────────────────

export const SETUP_STAGES = [
  'uninitialized', 'identity_pending', 'provider_pending', 'credential_pending',
  'model_pending', 'connectivity_pending', 'runtime_pending', 'ready',
] as const;

export type SetupStage = typeof SETUP_STAGES[number];
export type SetupFaultStage = 'needs_repair' | 'blocked';
export type ErrorClass = 'config' | 'auth' | 'network' | 'timeout' | 'io' | 'model' | 'runtime' | 'unknown';

export interface SetupReadiness { basic: boolean; agent: boolean; durable: boolean; network: boolean }

export interface SetupState {
  schema: 'bolloon-setup/1';
  stage: SetupStage | SetupFaultStage;
  completed: SetupStage[];
  inputs: { name?: string; provider?: string; model?: string; hasApiKey?: boolean; identityDid?: string };
  checks: {
    identity?: boolean; providerSelected?: boolean; credentialPresent?: boolean; providerUsable?: boolean;
    modelPresent?: boolean; modelVerified?: boolean; connectivityOk?: boolean; connectivityAt?: string;
    connectivityErrorClass?: ErrorClass; runtimeInitialized?: boolean; harnessOk?: boolean;
    skillsOk?: boolean; skillsInvalid?: number; runStoreOk?: boolean; goalStoreOk?: boolean;
    supervisorResolvable?: boolean; leaseOk?: boolean; networkOk?: boolean;
    configSource?: 'canonical' | 'legacy' | 'missing';
  };
  readiness: SetupReadiness;
  readinessWhy: { basic: string[]; agent: string[]; durable: string[]; network: string[] };
  allow: { cli: boolean; web: boolean; supervisor: boolean; agent: boolean };
  lastError?: { at: string; stage: string; errorClass: ErrorClass; message: string };
  lastAttemptAt?: string;
  actions: string[];
  configVersion?: number;
  configHash?: string;
  updatedAt: string;
}

export function emptySetupState(now = new Date()): SetupState {
  return {
    schema: 'bolloon-setup/1', stage: 'uninitialized', completed: [], inputs: {}, checks: {},
    readiness: { basic: false, agent: false, durable: false, network: false },
    readinessWhy: { basic: ['还没有开始初始化'], agent: ['基础层未就绪'], durable: ['agent 层未就绪'], network: ['P2P/Kubo 未检测 (optional)'] },
    allow: { cli: true, web: false, supervisor: false, agent: false },
    actions: ['运行 `bolloon setup` 完成初始化 (身份 → 供应商 → 密钥 → 模型 → 连通性 → 运行时)'],
    updatedAt: now.toISOString(),
  };
}

export async function readSetupState(bolloonHome: string = resolveBolloonHome()): Promise<SetupState | null> {
  try {
    const raw = JSON.parse(await fs.readFile(setupStatePath(bolloonHome), 'utf8')) as SetupState;
    if (!raw || raw.schema !== 'bolloon-setup/1') return null;
    const base = emptySetupState();
    return {
      ...base, ...raw,
      readiness: { ...base.readiness, ...(raw.readiness || {}) },
      readinessWhy: { ...base.readinessWhy, ...(raw.readinessWhy || {}) },
      checks: { ...(raw.checks || {}) },
      inputs: { ...(raw.inputs || {}) },
      allow: { ...base.allow, ...(raw.allow || {}) },
    };
  } catch { return null; }
}

/** 原子写 (tmp + rename) —— 半份状态文件比没有状态文件更危险 */
export async function writeSetupState(state: SetupState, bolloonHome: string = resolveBolloonHome()): Promise<void> {
  await fs.mkdir(bolloonHome, { recursive: true });
  const p = setupStatePath(bolloonHome);
  const tmp = `${p}.tmp`;
  const next = { ...state, updatedAt: new Date().toISOString() };
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

/** 配置指纹 (缺文件本身也是状态, 不碰密钥值) */
export async function hashConfigFiles(bolloonHome: string = resolveBolloonHome()): Promise<{ hash: string; version?: number }> {
  const files = [CANONICAL_CONFIG_FILE, LEGACY_CONFIG_FILE, path.join('identity', 'user.json'), 'user.json'];
  const h = crypto.createHash('sha256');
  let version: number | undefined;
  for (const f of files) {
    try {
      const buf = await fs.readFile(path.join(bolloonHome, f));
      h.update(f).update('\0').update(buf);
      if (f === CANONICAL_CONFIG_FILE) {
        try { version = Number(JSON.parse(buf.toString('utf8'))?.version) || undefined; } catch { /* 无版本字段 */ }
      }
    } catch { h.update(f).update('\0').update('<missing>'); }
  }
  return { hash: h.digest('hex').slice(0, 32), version };
}

// ── 配置事实来源 (Phase 1: bolloon-config.json 唯一; llm-config.json 仅迁移输入) ──

export interface ConfigFacts {
  source: 'canonical' | 'legacy' | 'missing';
  activeProvider?: string;
  providers: Record<string, { apiKey?: string; model?: string; baseUrl?: string; enabled?: boolean; requiresApiKey?: boolean }>;
  legacyPresent: boolean;
  raw?: any;
}

export async function readConfigFacts(bolloonHome: string = resolveBolloonHome()): Promise<ConfigFacts> {
  const canonical = path.join(bolloonHome, CANONICAL_CONFIG_FILE);
  const legacy = path.join(bolloonHome, LEGACY_CONFIG_FILE);
  let canonicalRaw: any = null;
  let canonicalError: any = null;
  try { canonicalRaw = JSON.parse(await fs.readFile(canonical, 'utf8')); }
  catch (err: any) { if (err?.code !== 'ENOENT') canonicalError = err; }
  let legacyRaw: any = null;
  try { legacyRaw = JSON.parse(await fs.readFile(legacy, 'utf8')); } catch { /* 旧文件不存在/坏 = 没有 */ }
  if (canonicalError) throw canonicalError;   // 存在但坏了 → 上层分类 config → needs_repair
  const chosen = canonicalRaw || legacyRaw;
  return {
    source: canonicalRaw ? 'canonical' : (legacyRaw ? 'legacy' : 'missing'),
    activeProvider: chosen?.activeProvider || chosen?.provider,
    providers: chosen?.providers || {},
    legacyPresent: !!legacyRaw,
    raw: chosen || undefined,
  };
}

export function providerUsable(p: { enabled?: boolean; apiKey?: string; requiresApiKey?: boolean } | undefined): boolean {
  if (!p) return false;
  if (p.enabled === false) return false;
  if (p.apiKey) return true;
  return p.requiresApiKey === false;
}

/** 该 provider 是否还需要 key (缺省视为需要) */
export function providerNeedsKey(p: { requiresApiKey?: boolean; apiKey?: string } | undefined): boolean {
  if (!p) return true;
  if (p.apiKey) return false;
  return p.requiresApiKey !== false;
}

// ── 评估 ────────────────────────────────────────────────────────────────────

export interface EvaluateOptions {
  bolloonHome?: string;
  light?: boolean;
  homeWritableProbe?: () => Promise<boolean>;
  readIdentity?: () => Promise<{ did?: string; name?: string } | null>;
  readConfig?: () => Promise<ConfigFacts>;
  readSkills?: () => Promise<{ total: number; invalid: number } | null>;
  runtimeReady?: () => Promise<boolean>;
  supervisorStatus?: () => Promise<{ resolvable: boolean; reason?: string } | null>;
  providerDefaults?: Record<string, { model?: string }>;
  sessionStoreOk?: () => Promise<boolean>;
  connectivityTtlMs?: number;
  now?: () => number;
}

export interface Evaluation {
  state: SetupState;
  gate: 'ready' | 'setup' | 'repair' | 'blocked';
  reasons: string[];
  nextActions: string[];
}

export function deriveStage(c: {
  identity: boolean; providerSelected: boolean; credentialOk: boolean; modelOk: boolean; connectivity: boolean; runtime: boolean;
}): SetupStage {
  if (!c.identity) return 'identity_pending';
  if (!c.providerSelected) return 'provider_pending';
  if (!c.credentialOk) return 'credential_pending';
  if (!c.modelOk) return 'model_pending';
  if (!c.connectivity) return 'connectivity_pending';
  if (!c.runtime) return 'runtime_pending';
  return 'ready';
}

function stageIndex(s: SetupStage | SetupFaultStage): number {
  if (s === 'needs_repair' || s === 'blocked') return -1;
  return SETUP_STAGES.indexOf(s as SetupStage);
}

function setupHasPriorState(prev: SetupState): boolean {
  return prev.completed.length > 0 || !!prev.inputs.provider || !!prev.inputs.identityDid || prev.stage !== 'uninitialized';
}

export function nextActionsFor(
  stage: SetupStage | SetupFaultStage,
  c: { identity: boolean; providerSelected: boolean; credentialOk: boolean; modelOk: boolean; connectivity: boolean; runtime: boolean; configError?: ErrorClass; source?: ConfigFacts['source'] },
): string[] {
  const migrate = c.source === 'legacy' ? ['检测到旧 `llm-config.json`: `bolloon setup --repair` 会迁移到 `bolloon-config.json` (旧文件保留)'] : [];
  switch (stage) {
    case 'identity_pending': return [...migrate, '生成/填写身份 (姓名) — 已有 DID 会复用, 不会重复生成'];
    case 'provider_pending': return [...migrate, c.configError === 'config'
      ? '`bolloon-config.json` 损坏或缺失 → `bolloon setup --repair` (不重置身份, 不清 key)'
      : '选择模型供应商 — 会显示是否需要 key / 默认模型 / 配置来源'];
    case 'credential_pending': return ['填该 provider 的 apiKey (隐藏输入, 不落日志/不写状态文件)', 'Provider 已选择 ≠ 凭证已可用'];
    case 'model_pending': return ['指定模型名 (留空用默认模型)', '自定义模型会标"未经过供应商模型列表验证"'];
    case 'connectivity_pending': return ['跑真实连通性测试 (`bolloon setup --test`) — 用最终保存的 provider/key/baseUrl/model', '超时/401/404/限流/网络错误分别显示; 超时可重试, 不当成功'];
    case 'runtime_pending': return ['真实初始化运行时 (initMinimax + 建 session + 最小模型调用) — 只检查 singleton 不算通过'];
    case 'needs_repair': return ['配置损坏 → `bolloon setup --repair` (就地修, 不回退成默认配置假装正常)', '修完再启动; 期间只允许诊断'];
    case 'blocked': return ['配置根目录不可写 → 检查磁盘/权限后 `bolloon setup --status`'];
    default: return ['已就绪'];
  }
}

export function gateFor(stage: SetupStage | SetupFaultStage, readiness: SetupReadiness): Evaluation['gate'] {
  if (stage === 'ready' && readiness.basic) return 'ready';
  if (stage === 'needs_repair') return 'repair';
  if (stage === 'blocked') return 'blocked';
  return 'setup';
}

export async function evaluateSetup(opts: EvaluateOptions = {}): Promise<Evaluation> {
  const bolloonHome = opts.bolloonHome ?? resolveBolloonHome();
  const prev = (await readSetupState(bolloonHome)) || emptySetupState();
  const reasons: string[] = [];
  const why: SetupState['readinessWhy'] = { basic: [], agent: [], durable: [], network: [] };
  const checks: SetupState['checks'] = { ...prev.checks };

  // 1) 身份
  try {
    const identity = opts.readIdentity ? await opts.readIdentity() : await defaultReadIdentity(bolloonHome);
    checks.identity = !!(identity && (identity.did || identity.name));
  } catch (err) { checks.identity = false; reasons.push(`身份读取失败: ${msg(err)}`); }
  if (!checks.identity) why.basic.push('缺身份 (user.json 无 did/name)');

  // 2) LLM 配置: 供应商 / 凭证 / 模型
  let cfgErr: ErrorClass | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let hasKey = false;
  let providerSelected = false;
  let credentialOk = false;
  let modelOk = false;
  try {
    const facts = opts.readConfig ? await opts.readConfig() : await readConfigFacts(bolloonHome);
    checks.configSource = facts.source;
    provider = facts.activeProvider;
    providerSelected = !!provider;
    const p = provider ? facts.providers?.[provider] : undefined;
    hasKey = !!p?.apiKey;
    credentialOk = providerSelected && (!providerNeedsKey(p) || hasKey);
    const defaults = opts.providerDefaults ?? await defaultProviderDefaults();
    model = p?.model || (provider ? defaults?.[provider]?.model : undefined);
    modelOk = !!model;
    checks.modelVerified = !!p?.model;
    if (!providerSelected) {
      reasons.push(facts.source === 'missing'
        ? `还没有 LLM 配置 (${CANONICAL_CONFIG_FILE} 不存在) → 未选择模型供应商`
        : `配置里没有 activeProvider → 未选择模型供应商`);
      why.basic.push('未选择模型供应商');
    } else if (!credentialOk) {
      reasons.push(`供应商 ${provider} 需要 apiKey 但没配 (Provider 已选择 ≠ 凭证已可用)`);
      why.basic.push(`供应商 ${provider} 缺 apiKey`);
    } else if (!modelOk) {
      reasons.push(`供应商 ${provider} 没有可用模型名`);
      why.basic.push(`供应商 ${provider} 缺模型名`);
    }
    if (facts.source === 'legacy') reasons.push(`当前配置来自旧文件 ${LEGACY_CONFIG_FILE} (未迁移) → 建议 \`bolloon setup --repair\``);
  } catch (err) {
    cfgErr = 'config';
    reasons.push(`LLM 配置不可读: ${msg(err)}`);
    why.basic.push('bolloon-config.json 损坏或不可读 (→ --repair)');
  }
  checks.providerSelected = providerSelected;
  checks.credentialPresent = hasKey;
  checks.providerUsable = providerSelected && credentialOk;
  checks.modelPresent = modelOk;

  // 3) 连通性 (2026-10-13 重构: 结论有效期 = 「测过 + 配置没变」, 不再只看墙钟 24h)
  //   - 旧逻辑: 24h 墙钟一到就过期, 即使 provider/key/baseUrl/model 一个没动 → 用户隔天启动必见
  //     「未就绪」, 被迫重测 (体验债: 配置没变重测无意义, 且评估会把 connectivityOk 覆盖成 false 落盘,
  //     于是「测过」这个事实被销毁, 更修不回来)。
  //   - 新语义: connectivityAt 存在(测过) 且 配置指纹一致(配置没变) ⇒ 结论仍有效; 只有配置真变了才重测。
  const connAt = checks.connectivityAt ? Date.parse(checks.connectivityAt) : 0;
  const hadConnTest = !!connAt;
  // 配置指纹: 当前配置 vs 上次通过时的配置 —— 相同则连通性结论仍有效 (provider/key/baseUrl/model 都没变)
  let configUnchanged = false;
  try {
    const { hash: curHash } = await hashConfigFiles(bolloonHome);
    configUnchanged = !!prev.configHash && prev.configHash === curHash;
  } catch { configUnchanged = false; }
  let connectivityOk = false;
  if (hadConnTest && configUnchanged) {
    // 测过 + 配置没变 ⇒ 结论有效 (即使墙钟过了 24h)
    connectivityOk = true;
    checks.connectivityOk = true;   // 救回被旧逻辑覆盖的 false
  } else if (hadConnTest && !configUnchanged) {
    // 测过但配置变了 (或 configHash 缺失) ⇒ 需要重测
    connectivityOk = false;
    checks.connectivityOk = false;
    reasons.push('LLM 配置已变化 → 需要重新测试连通性');
  }
  if (!connectivityOk) why.basic.push(hadConnTest && !configUnchanged ? '配置变化, 连通性需重测' : '还没做过连通性测试');

  // 4) 运行时 (真实: initMinimax + session; 不是"singleton 存在")
  let runtimeOk = checks.runtimeInitialized === true;
  if (!opts.light) {
    try { runtimeOk = opts.runtimeReady ? await opts.runtimeReady() : await defaultRuntimeReady(); } catch { runtimeOk = false; }
  }
  checks.runtimeInitialized = runtimeOk;
  if (!runtimeOk) why.basic.push('运行时未初始化 (initMinimax/session 不可用)');

  const basic = !!(checks.identity && providerSelected && credentialOk && modelOk && connectivityOk && runtimeOk);
  if (!basic && why.basic.length === 0) why.basic.push('基础层未就绪');

  // 5) agent 层
  let harnessOk = checks.harnessOk;
  if (!opts.light) {
    try { harnessOk = await defaultHarnessReady(); } catch { harnessOk = false; }
  }
  checks.harnessOk = harnessOk;
  if (!harnessOk) why.agent.push('PiAgentHarness 不可用 (约束层加载失败)');
  let skillsOk = checks.skillsOk;
  if (!opts.light) {
    try {
      const s = opts.readSkills ? await opts.readSkills() : await defaultReadSkills(bolloonHome);
      skillsOk = s ? s.invalid === 0 : undefined;
      checks.skillsInvalid = s?.invalid;
      if (s && s.invalid > 0) why.agent.push(`有 ${s.invalid} 个技能不合格 → \`bolloon skills\` 看具体技能`);
    } catch { skillsOk = undefined; }
  }
  if (skillsOk === undefined) why.agent.push('技能健康度未知 (registry 不可读, 不能当作通过)');
  checks.skillsOk = skillsOk;
  const agentReady = !!(basic && harnessOk && skillsOk === true);
  if (!agentReady && why.agent.length === 0) why.agent.push('agent 层未就绪');

  // 6) durable 层
  let runStoreOk = checks.runStoreOk;
  let goalStoreOk = checks.goalStoreOk;
  let leaseOk = checks.leaseOk;
  let supervisorResolvable = checks.supervisorResolvable;
  if (!opts.light) {
    const p = await probeDurable(bolloonHome, opts);
    runStoreOk = p.runStoreOk; goalStoreOk = p.goalStoreOk; leaseOk = p.leaseOk; supervisorResolvable = p.supervisorResolvable;
    if (!runStoreOk) why.durable.push('runs 目录不可读写');
    if (!goalStoreOk) why.durable.push('goals 目录不可读写');
    if (!leaseOk) why.durable.push('goal lease 文件不可写 (无法跨进程排他)');
    if (!supervisorResolvable) why.durable.push(p.supervisorReason || 'Supervisor runner 无法解析');
  }
  checks.runStoreOk = runStoreOk; checks.goalStoreOk = goalStoreOk; checks.leaseOk = leaseOk; checks.supervisorResolvable = supervisorResolvable;
  const durableReady = !!(agentReady && runStoreOk && goalStoreOk && leaseOk && supervisorResolvable);
  if (!durableReady && why.durable.length === 0) why.durable.push('durable 层未就绪');

  // 7) network 层 (optional)
  const networkOk = checks.networkOk === true;
  if (!networkOk) why.network.push('P2P/Kubo 未确认可用 (optional, 不阻塞基础对话)');

  const readiness: SetupReadiness = { basic, agent: agentReady, durable: durableReady, network: networkOk };
  const stage = deriveStage({ identity: !!checks.identity, providerSelected, credentialOk, modelOk, connectivity: connectivityOk, runtime: runtimeOk });

  const completed: SetupStage[] = [];
  for (const s of SETUP_STAGES) { if (s !== 'uninitialized' && stageIndex(stage) > stageIndex(s)) completed.push(s); }

  let homeWritable = true;
  try { homeWritable = opts.homeWritableProbe ? await opts.homeWritableProbe() : await probeHomeWritable(bolloonHome); } catch { homeWritable = false; }
  if (!homeWritable) reasons.push(`配置根目录不可写: ${bolloonHome}`);

  let gate: Evaluation['gate'];
  if (readiness.basic && stage === 'ready') gate = 'ready';
  else if (!homeWritable) gate = 'blocked';
  else if (cfgErr === 'config' && (setupHasPriorState(prev) || !!checks.identity)) gate = 'repair';   // 盘上已有身份 = 有历史 → 就地修, 不要从零再来
  else gate = 'setup';

  const state: SetupState = {
    ...prev,
    schema: 'bolloon-setup/1',
    stage, completed,
    inputs: { ...prev.inputs, provider: provider ?? prev.inputs.provider, model: model ?? prev.inputs.model, hasApiKey: hasKey || prev.inputs.hasApiKey },
    checks, readiness, readinessWhy: why,
    allow: { cli: true, web: gate === 'ready', supervisor: gate === 'ready' && readiness.durable, agent: gate === 'ready' && readiness.basic },
    actions: nextActionsFor(stage, { identity: !!checks.identity, providerSelected, credentialOk, modelOk, connectivity: connectivityOk, runtime: runtimeOk, configError: cfgErr, source: checks.configSource }),
    updatedAt: new Date().toISOString(),
  };
  const fp = await hashConfigFiles(bolloonHome);
  state.configHash = fp.hash; state.configVersion = fp.version;
  if (gate !== 'ready' && cfgErr) state.lastError = { at: new Date().toISOString(), stage, errorClass: cfgErr, message: reasons[0] || '配置不完整' };
  return { state, gate, reasons, nextActions: state.actions };
}

// ── 默认探测 ────────────────────────────────────────────────────────────────

/**
 * 身份事实来源: **`~/.bolloon/identity/user.json`** (setup-wizard 的真实写入路径) —— 2026-09-16 修:
 * 之前这里读 `user.json` / `identity.json`, 与真实路径不一致 → 明明配好了身份却被判未配置
 * (与 bolloon-config.json / llm-config.json 同类问题, Phase 1 一并修掉)。
 */
async function defaultReadIdentity(bolloonHome: string): Promise<{ did?: string; name?: string } | null> {
  const candidates = [
    path.join('identity', 'user.json'),
    'user.json',
    'identity.json',
  ];
  for (const f of candidates) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(bolloonHome, f), 'utf8'));
      if (j?.did || j?.name || j?.identity?.did || j?.identity?.name) {
        return { did: j.did || j.identity?.did, name: j.name || j.identity?.name };
      }
    } catch { /* 下一个 */ }
  }
  return null;
}

async function defaultProviderDefaults(): Promise<Record<string, { model?: string }>> {
  try {
    const mod: any = await import('../llm/config-store.js');
    const info = mod.PROVIDER_INFO || {};
    const out: Record<string, { model?: string }> = {};
    for (const [k, v] of Object.entries<any>(info)) out[k] = { model: v?.models?.[0] };
    return out;
  } catch { return {}; }
}

async function defaultRuntimeReady(): Promise<boolean> {
  try {
    const mod: any = await import('../constraints/index.js');
    if (typeof mod.initMinimax === 'function') mod.initMinimax();
    if (typeof mod.getMinimax === 'function') mod.getMinimax();
    return true;
  } catch { return false; }
}

async function defaultHarnessReady(): Promise<boolean> {
  try {
    const mod: any = await import('../agents/pi-harness.js');
    return typeof mod.PiAgentHarness === 'function';
  } catch { return false; }
}

async function defaultReadSkills(bolloonHome: string): Promise<{ total: number; invalid: number } | null> {
  try {
    const { SkillsManager } = await import('../agents/skills-manager.js');
    const sm = new SkillsManager({ home: path.dirname(bolloonHome), cwd: process.cwd() });
    const h = await sm.health({ home: path.dirname(bolloonHome) });
    return { total: h.total, invalid: h.invalid.length };
  } catch { return null; }
}

async function probeDirWritable(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.rm(probe, { force: true });
    return true;
  } catch { return false; }
}

async function probeHomeWritable(bolloonHome: string): Promise<boolean> { return probeDirWritable(bolloonHome); }

async function probeDurable(bolloonHome: string, opts: EvaluateOptions) {
  const runStoreOk = await probeDirWritable(path.join(bolloonHome, 'runs'));
  const goalStoreOk = await probeDirWritable(path.join(bolloonHome, 'goals'));
  let leaseOk = false;
  try {
    const leasePath = path.join(bolloonHome, 'goals', '.lease-probe');
    await fs.mkdir(path.dirname(leasePath), { recursive: true });
    const fh = await fs.open(leasePath, 'wx'); await fh.close();
    await fs.rm(leasePath, { force: true });
    leaseOk = true;
  } catch { leaseOk = false; }
  let supervisorResolvable = false;
  let supervisorReason: string | undefined;
  try {
    if (opts.supervisorStatus) {
      const s = await opts.supervisorStatus();
      supervisorResolvable = !!s?.resolvable; supervisorReason = s?.reason;
    } else {
      const js = JSON.parse(await fs.readFile(path.join(bolloonHome, 'supervisor.json'), 'utf8'));
      const res = js?.lastResolution;
      if (res && typeof res.ok === 'boolean') {
        supervisorResolvable = res.ok === true;
        supervisorReason = res.ok ? undefined : `上次执行器解析失败: ${res.reason || res.failedStage || '未知原因'}`;
      } else {
        supervisorResolvable = opts.sessionStoreOk ? await opts.sessionStoreOk() : true;
        supervisorReason = supervisorResolvable ? undefined : '缺少可用的 session store';
      }
    }
  } catch {
    supervisorResolvable = opts.sessionStoreOk ? await opts.sessionStoreOk() : true;
  }
  return { runStoreOk, goalStoreOk, leaseOk, supervisorResolvable, supervisorReason };
}

function msg(err: unknown): string { return String((err as Error)?.message || err).slice(0, 160); }

// ── 落盘/门禁 ───────────────────────────────────────────────────────────────

export async function refreshSetupState(opts: EvaluateOptions = {}): Promise<Evaluation> {
  const ev = await evaluateSetup(opts);
  await writeSetupState(ev.state, opts.bolloonHome ?? resolveBolloonHome());
  return ev;
}

export async function recordSetupFailure(stage: string, errorClass: ErrorClass, message: string, bolloonHome: string = resolveBolloonHome()): Promise<SetupState> {
  const prev = (await readSetupState(bolloonHome)) || emptySetupState();
  const state: SetupState = {
    ...prev,
    stage: errorClass === 'config' || errorClass === 'io' ? 'needs_repair' : prev.stage,
    lastError: { at: new Date().toISOString(), stage, errorClass, message: String(message).slice(0, 300) },
    lastAttemptAt: new Date().toISOString(),
    actions: [`${stage} 阶段失败 (${errorClass}) → 可以 重试 / 修改 / 返回上一步 / \`bolloon setup --repair\``, '已完成步骤保留; 再次运行 `bolloon setup` 从失败阶段继续'],
    allow: { ...prev.allow, agent: false, supervisor: false, web: false },
    updatedAt: new Date().toISOString(),
  };
  await writeSetupState(state, bolloonHome);
  return state;
}

export async function recordSetupStage(stage: SetupStage, patch: Partial<Pick<SetupState, 'inputs' | 'checks'>> = {}, bolloonHome: string = resolveBolloonHome()): Promise<SetupState> {
  const prev = (await readSetupState(bolloonHome)) || emptySetupState();
  const completed = Array.from(new Set([...prev.completed, ...(stage === 'uninitialized' ? [] : [stage])]));
  const state: SetupState = {
    ...prev, stage, completed,
    inputs: { ...prev.inputs, ...(patch.inputs || {}) },
    checks: { ...prev.checks, ...(patch.checks || {}) },
    lastAttemptAt: new Date().toISOString(),
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  };
  // 2026-10-13 重构: 补算并落盘配置指纹 —— 与 evaluateSetup (413-414) 同一逻辑。
  //   之前只有 evaluateSetup 落 configHash; 直写路径 (onboard 连通性成功 / 测试模拟) 缺 hash ⇒
  //   连通性判定 (「测过且配置没变 → 结论有效」) 在非 evaluateSetup 路径下永远 configUnchanged=false。
  //   行为不变 (configHash 仍是同一文件的 sha256), 只是所有写 state 的路径都带上指纹。
  try {
    const fp = await hashConfigFiles(bolloonHome);
    state.configHash = fp.hash; state.configVersion = fp.version;
  } catch { /* hash 计算失败不阻塞记录 */ }
  await writeSetupState(state, bolloonHome);
  return state;
}

export function describeSetup(ev: Evaluation): string {
  const s = ev.state;
  const lines = [
    `初始化状态: ${s.stage}   门禁: ${ev.gate}`,
    `就绪度: basic=${s.readiness.basic ? '✓' : '✗'} agent=${s.readiness.agent ? '✓' : '✗'} durable=${s.readiness.durable ? '✓' : '✗'} network=${s.readiness.network ? '✓' : '✗'}`,
    `已完成: ${s.completed.join(' → ') || '(无)'}`,
  ];
  if (s.checks.configSource) lines.push(`配置来源: ${s.checks.configSource}${s.checks.configSource === 'legacy' ? ' (旧文件, 建议 --repair 迁移)' : ''}`);
  if (s.inputs.provider) lines.push(`已存输入: provider=${s.inputs.provider}${s.inputs.model ? ` model=${s.inputs.model}` : ''} key=${s.inputs.hasApiKey ? '有' : '无'}`);
  for (const x of s.readinessWhy.basic) lines.push(`缺 (basic): ${x}`);
  if (!s.readiness.agent) for (const x of s.readinessWhy.agent) lines.push(`缺 (agent): ${x}`);
  if (!s.readiness.durable) for (const x of s.readinessWhy.durable) lines.push(`缺 (durable): ${x}`);
  if (s.lastError) lines.push(`上次错误 [${s.lastError.errorClass}] ${s.lastError.stage}: ${s.lastError.message}`);
  for (const r of ev.reasons) lines.push(`· ${r}`);
  lines.push(`下一步: ${ev.nextActions[0]}`);
  return lines.join('\n');
}

let gateCache: { gate: Evaluation['gate']; at: number; state: SetupState } | null = null;
const GATE_TTL_MS = 30_000;

export async function getSetupGateCached(now = Date.now()): Promise<{ gate: Evaluation['gate']; state: SetupState }> {
  if (gateCache && now - gateCache.at < GATE_TTL_MS) return { gate: gateCache.gate, state: gateCache.state };
  try {
    const ev = await evaluateSetup({ light: true });
    gateCache = { gate: ev.gate, at: now, state: ev.state };
    return { gate: ev.gate, state: ev.state };
  } catch {
    gateCache = { gate: 'blocked', at: now, state: emptySetupState() };
    return { gate: 'blocked', state: gateCache.state };
  }
}

export function resetSetupGateCache(): void { gateCache = null; }
