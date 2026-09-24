/**
 * setup-wizard.ts — 初始化引导 + 模型供应商 API 配置流程
 *
 * 两个入口共用这一个模块:
 *   ① `bolloon setup`  首次运行向导: 用户称呼 → 供应商 → API key → 模型 → 连通性测试 → 落盘
 *   ② `bolloon model`  日常切换/查看/测试 (无参列表 / <provider> [model] / key <provider> / test)
 *
 * 设计要点:
 *   - API key 只在**隐藏输入**里收 (不回显、不回读、不写日志), 存 ~/.bolloon/bolloon-config.json (永不入 git)
 *   - 非交互模式 (--provider/--api-key/--model/--name) 供脚本/自动化用, 与交互式同一套写盘路径
 *   - 用户身份写 ~/.bolloon/identity/user.json (DID 首次生成后复用, 与 Web 端同一文件同一 schema)
 *   - io 可注入 → 单测不碰真实 stdin/stdout
 */

import * as readline from 'readline';
import {
  evaluateSetup, providerUsable, readConfigFacts, refreshSetupState, resolveBolloonHome,
  type ErrorClass as SetupErrorClass,
} from '../setup/setup-store.js';
import { runOnboard, type OnboardIO, type OnboardMode } from '../setup/onboard.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { llmConfigStore, PROVIDER_INFO, DEFAULT_PROVIDER_CONFIGS, type ModelProvider } from '../llm/config-store.js';

/** 向导推荐的供应商顺序 (第一个是最省事的国内直连) */
export const RECOMMENDED_PROVIDERS: ModelProvider[] = [
  'deepseek', 'minimax', 'openai', 'anthropic', 'openrouter', 'gemini',
  'kimi', 'glm', 'qwen', 'grok', 'mimo', 'ollama', 'local',
];

export interface WizardIO {
  print(line: string): void;
  /** hidden=true 时输入不回显 (API key 用) */
  ask(q: string, opts?: { hidden?: boolean; default?: string }): Promise<string>;
}

export function defaultWizardIO(): WizardIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return {
    print: (line: string) => { process.stdout.write(line + '\n'); },
    ask: (q: string, opts: { hidden?: boolean; default?: string } = {}) =>
      new Promise<string>((resolve) => {
        const prompt = `${q}${opts.default ? ` [${opts.default}]` : ''} `;
        if (!opts.hidden || !process.stdout.isTTY) {
          rl.question(prompt, (ans) => resolve(String(ans ?? '').trim()));
          return;
        }
        // 隐藏输入: 临时吞掉回显 (提示行本身仍要显示)
        const anyRl = rl as any;
        const orig = anyRl._writeToOutput?.bind(anyRl);
        anyRl._writeToOutput = function (s: string) { if (s.includes(q) || s.includes('[')) process.stdout.write(s); };
        rl.question(prompt, (ans) => {
          if (orig) anyRl._writeToOutput = orig;
          process.stdout.write('\n');
          resolve(String(ans ?? '').trim());
        });
      }),
    };
}

/** 一次性隐藏输入 (bolloon model key <provider> 用; 单独开 readline, 用完即关, 不回显) */
export async function askHiddenLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise<string>((resolve) => {
    const anyRl = rl as any;
    const orig = anyRl._writeToOutput?.bind(anyRl);
    anyRl._writeToOutput = function (s: string) { if (String(s).includes(question)) process.stdout.write(s); };
    rl.question(`${question} `, (ans) => {
      if (orig) anyRl._writeToOutput = orig;
      process.stdout.write('\n');
      rl.close();
      resolve(String(ans ?? '').trim());
    });
  });
}

// ---------------------------------------------------------------- 用户身份

export function getUserIdentityFile(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'identity', 'user.json');
}

export interface UserIdentity {
  did: string;
  didShort?: string;
  publicKeyHex: string;
  name: string;
  createdAt?: string;
}

export async function readUserIdentity(home: string = os.homedir()): Promise<UserIdentity | null> {
  try {
    const raw = await fs.readFile(getUserIdentityFile(home), 'utf-8');
    const p = JSON.parse(raw);
    if (p && typeof p.did === 'string' && p.did) return p as UserIdentity;
    return null;
  } catch { return null; }
}

/**
 * 写用户身份 (没有就生成 DID, 有就只改名字)。返回是否新建。
 * 与 Web 端 /api/user/identity 同一文件、同一 schema。
 */
export async function writeUserIdentity(
  name: string,
  home: string = os.homedir(),
): Promise<{ identity: UserIdentity; created: boolean; file: string }> {
  const file = getUserIdentityFile(home);
  const clean = String(name || '').trim().slice(0, 40);
  const existing = await readUserIdentity(home);
  let identity: UserIdentity;
  let created = false;
  if (existing) {
    identity = { ...existing, name: clean || existing.name };
  } else {
    const { KeyManager } = await import('@diap/sdk');
    const kp = KeyManager.generate();
    identity = {
      did: kp.did,
      didShort: kp.did.split(':').pop()?.slice(0, 8),
      publicKeyHex: Buffer.from(kp.publicKey as any).toString('hex'),
      name: clean || 'bolloon-user',
      createdAt: new Date().toISOString(),
    };
    created = true;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(identity, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return { identity, created, file };
}

// ---------------------------------------------------------------- 本机 DIAP 身份 (非交互)

/** 本机 DIAP 身份文件 —— 与 index.ts `bootstrapIdentity()` / local-signer / network-pulse 同源 */
export function getLocalIdentityFile(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'identity.json');
}

export interface LocalIdentityResult {
  ok: boolean;
  /** 'created' = 这次新建; 'reused' = 早就有了, 一个字没改 */
  action: 'created' | 'reused' | 'refused';
  file: string;
  did?: string;
  /** 文件权限 (八进制字符串, 例如 '600') */
  mode?: string;
  reason?: string;
}

/**
 * **非交互**建本机 DIAP 身份 (2026-09-24)。给新机器 / 第二实例用 ——
 * `bolloon setup` 是 readline 交互向导, 在没有 TTY 的环境里会 `readline was closed`
 * (ERR_USE_AFTER_CLOSE), 于是自动化流程根本建不出身份。
 *
 * 三条硬纪律:
 *   ① **复用现有生成逻辑**, 不新写一套密钥学 —— 走 `KeyManager.generate()` +
 *      `KeyManager.saveToFile()` (与 `src/index.ts:bootstrapIdentity` 完全同一条路径),
 *      落盘字段因此天然一致: `{ keyType:'Ed25519', privateKey, publicKey, did, createdAt, version }`,
 *      文件模式 `0600`。
 *   ② **幂等**: 已存在且能解析出 did → 不动、`action:'reused'` (调用方 exit 0)。
 *      文件存在但**读不出 did** (损坏) → `action:'refused'` 并**拒绝覆盖** ——
 *      静默盖掉一个可能还能救的身份是丢钥匙, 比失败糟得多; 要重来必须显式 `force`
 *      (覆盖前先把老文件备份成 `identity.json.bak-<时间戳>`)。
 *   ③ **绝不打印/返回私钥**: 返回体里只有 did / 文件路径 / 权限。
 */
export async function initLocalIdentity(home: string = os.homedir(), opts: { force?: boolean } = {}): Promise<LocalIdentityResult> {
  const file = getLocalIdentityFile(home);
  const readDid = async (): Promise<string | null> => {
    try {
      const j = JSON.parse(await fs.readFile(file, 'utf-8'));
      return j && typeof j.did === 'string' && j.did ? j.did : null;
    } catch { return null; }
  };

  const exists = await fs.stat(file).then(() => true).catch(() => false);
  if (exists) {
    const did = await readDid();
    if (did && !opts.force) {
      return { ok: true, action: 'reused', file, did, mode: await fileMode(file) };
    }
    if (!did && !opts.force) {
      return {
        ok: false, action: 'refused', file,
        reason: `${file} 已存在但读不出 did (损坏?) → **不覆盖** (那可能是丢钥匙)。确认要重建再加 --force (会先备份成 .bak-<时间戳>)`,
      };
    }
    // force: 先备份再重建 (备份失败 → 不重建)
    try {
      await fs.copyFile(file, `${file}.bak-${Date.now()}`);
    } catch (e: any) {
      return { ok: false, action: 'refused', file, reason: `--force 下备份老文件失败, 拒绝重建: ${String(e?.message || e).slice(0, 160)}` };
    }
  }

  const { KeyManager } = await import('@diap/sdk');
  const kp = KeyManager.generate();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await (KeyManager as any).saveToFile(kp, file);   // 同 bootstrapIdentity: 0600 + 6 字段
  try { await fs.chmod(file, 0o600); } catch { /* 某些平台/文件系统 no-op */ }
  return { ok: true, action: 'created', file, did: String(kp.did || ''), mode: await fileMode(file) };
}

/** 文件权限 (八进制字符串; 读不到 → undefined) */
async function fileMode(file: string): Promise<string | undefined> {
  try { return ((await fs.stat(file)).mode & 0o777).toString(8); } catch { return undefined; }
}

// ---------------------------------------------------------------- 首次运行判断

// providerUsable 只有一份实现 (setup-store)

/** 首次运行: 没有可用供应商, 或还没有用户身份 */
export async function isFirstRun(home: string = os.homedir()): Promise<boolean> {
  // 2026-09-16 (Phase 1/3): 不再有独立判断 —— 是否"需要引导"由 setup-store 唯一决定。
  //   fail-closed: 评估不出来 → 视为"需要引导"。
  try {
    const ev = await evaluateSetup({ bolloonHome: resolveBolloonHome(process.env, home), light: true });
    return ev.gate !== 'ready';
  } catch (e: any) {
    console.warn('[setup] 初始化状态评估失败, 按"需要引导"处理 (fail-closed):', String(e?.message || e).slice(0, 160));
    return true;
  }
}

// ---------------------------------------------------------------- 向导

export interface SetupOptions {
  interactive?: boolean;
  provider?: string;
  apiKey?: string;
  model?: string;
  name?: string;
  home?: string;
  io?: WizardIO;
  /** 跳过连通性测试 */
  skipTest?: boolean;
}

export interface SetupResult {
  ok: boolean;
  userName?: string;
  provider?: string;
  model?: string;
  identityFile?: string;
  identityCreated?: boolean;
  test?: { success: boolean; latency?: number; error?: string };
  error?: string;
}

/** WizardIO → OnboardIO 适配 (select/confirm 用编号或值回答) */
function onboardIO(io: WizardIO): OnboardIO {
  return {
    print: (m: string) => io.print(m),
    ask: async (q, opts) => {
      for (let i = 0; i < 3; i++) {
        const v = await io.ask(q, opts?.defaultValue ? { default: opts.defaultValue } : undefined);
        const val = String(v ?? '').trim() || String(opts?.defaultValue ?? '');
        if (!opts?.validate) return val;
        const r = opts.validate(val);
        if (r.ok) return val;
        io.print(`  ✗ ${r.error || '输入无效'}`);
      }
      return String(opts?.defaultValue ?? '');
    },
    askHidden: async (q) => {
      const { askHiddenLine } = await import('./setup-wizard.js').catch(() => ({ askHiddenLine: null })) as any;
      return io.ask(q, { hidden: true });   // WizardIO 已支持 hidden (不回显)
    },
    confirm: async (q, d = true) => {
      const a = String(await io.ask(`${q} (y/n)`, { default: d ? 'y' : 'n' })).trim().toLowerCase();
      return a === '' ? d : /^(y|yes|1|true|是)$/.test(a);
    },
    select: async (q, choices) => {
      io.print(q);
      choices.forEach((c, i) => io.print(`  ${i + 1}) ${c.label}${c.hint ? ` — ${c.hint}` : ''}`));
      const a = String(await io.ask(`选择 (序号或名称)`, { default: '1' })).trim();
      if (!a) return choices[0]?.value || '';
      if (/^\d+$/.test(a) && choices[Number(a) - 1]) return choices[Number(a) - 1].value;
      const hit = choices.find((c) => c.value === a) || choices.find((c) => a && c.value.startsWith(a)) || choices.find((c) => a && c.label.includes(a));
      return hit?.value || a;
    },
  };
}

/**
 * 运行初始化向导 —— 现在是**可恢复阶段执行器**的薄包装 (Phase 2):
 *   load state → 显示已有 → 收集修改 → 校验 → 真实验证 → 原子提交阶段 → 推进
 * 失败: 保留已完成步骤 · 不清配置 · 标失败分类 · 给重试/修改/回退入口 · **不显示配置完成**
 */
export async function runSetupWizard(opts: SetupOptions = {}): Promise<SetupResult> {
  const io = opts.io ?? defaultWizardIO();
  const home = opts.home ?? os.homedir();
  const bolloonHome = resolveBolloonHome(process.env, home);
  const P = (s: string) => io.print(s);
  const mode: OnboardMode = (opts as any).mode || 'setup';

  P('');
  P('╭─ Bolloon 初始化 (可中断, 下次从失败阶段继续) ─────╮');
  P('│ 身份 → 供应商 → 凭证 → 模型 → 连通性 → 运行时   │');
  P('╰──────────────────────────────────────────────────╯');

  // 参数式输入 (非交互/脚本): 先落盘再跑阶段, 保证"输入已保存"
  try {
    if (opts.name) await writeUserIdentity(opts.name, home);
    const prov = (opts as any).provider;
    if (prov) {
      const store: any = llmConfigStore;
      await store.initialize();
      await store.updateProvider(prov, { enabled: true });
      if ((opts as any).apiKey) await store.updateProvider(prov, { apiKey: (opts as any).apiKey });
      if ((opts as any).model) await store.updateProvider(prov, { model: (opts as any).model });
      if (mode !== 'reconfigure') await store.setActiveProvider(prov);
    }
  } catch (e: any) {
    return { ok: false, error: `参数落盘失败: ${String(e?.message || e).slice(0, 160)}` };
  }

  const res = await runOnboard({
    mode,
    io: onboardIO(io),
    home,
    bolloonHome,
    targets: (opts as any).targets,
    skipSteps: opts.skipTest ? ['connectivity'] : undefined,
    oneShot: opts.interactive === false,
  });

  const cfg = await readConfigFacts(bolloonHome).catch(() => null);
  return {
    ok: res.ok,
    userName: res.state.inputs.name,
    provider: res.state.inputs.provider,
    model: res.state.inputs.model,
    identityFile: getUserIdentityFile(home),
    identityCreated: !!res.state.inputs.identityDid,
    test: res.state.checks.connectivityOk ? { success: true } : { success: false, error: res.state.lastError?.message },
    error: res.ok ? undefined : (res.message || res.actions[0]),
    // 新增: 结构化状态 (旧调用方看不到也不影响)
    ...( { gate: res.gate, stage: res.state.stage, summary: res.summary } as any ),
  };
}

export async function formatProviderStatus(): Promise<string> {
  await llmConfigStore.initialize();
  const cfg = await llmConfigStore.getConfig();
  const providers = cfg.providers as unknown as Record<string, any>;
  const lines: string[] = [`模型供应商 (当前: ${cfg.activeProvider})`];
  for (const p of RECOMMENDED_PROVIDERS) {
    const st = providers[p];
    if (!st) continue;
    const info = (PROVIDER_INFO as any)[p] || {};
    const active = p === cfg.activeProvider ? '●' : '○';
    const keyState = st.apiKey ? '🔑' : (st.requiresApiKey === false ? '免key' : '—');
    const flag = providerUsable(st) ? '' : ' (未启用)';
    lines.push(`  ${active} ${p.padEnd(11)} ${String(info.name || '').padEnd(16)} ${keyState.padEnd(6)} model: ${st.model || '(默认)'}${flag}`);
  }
  lines.push('用法: /model <provider> [model] 切换 · /model test [provider] 测连通 · /model status 状态');
  return lines.join('\n');
}

export interface ModelCommandIO {
  /** 需要收 API key 时使用的隐藏输入 (会话内没有此能力 → 不传) */
  askHidden?: (q: string) => Promise<string>;
}

/**
 * `/model` / `bolloon model` 命令实现。
 * 参数为空 = 状态; `<provider> [model]` = 切换; `test [provider]` = 测试; `key <provider>` = 设 key。
 */
export async function runModelCommand(arg: string, io: ModelCommandIO = {}): Promise<string> {
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
  await llmConfigStore.initialize();

  if (parts.length === 0 || parts[0] === 'status' || parts[0] === 'list') {
    return formatProviderStatus();
  }

  const sub = parts[0].toLowerCase();

  // key <provider> [key]
  if (sub === 'key' || sub === 'auth') {
    const provider = (parts[1] || '').toLowerCase();
    if (!provider) return '用法: /model key <provider> (随后会提示粘贴 API key, 输入不回显)';
    const cfg = await llmConfigStore.getConfig();
    if (!(cfg.providers as any)[provider]) return `未知供应商 '${provider}'. 可用: ${Object.keys(cfg.providers).join(', ')}`;
    let key = parts[2] || '';
    if (!key) {
      if (!io.askHidden) {
        return [
          `在会话内不收取 API key (避免留在会话记录里)。请在系统终端执行:`,
          `  bolloon model key ${provider}`,
          `或打开 Web 配置页 (bolloon --web) 填 key。`,
        ].join('\n');
      }
      key = await io.askHidden(`粘贴 ${provider} API key`);
    }
    if (!key) return '未输入 key, 未改动配置';
    await llmConfigStore.updateProvider(provider as ModelProvider, { enabled: true, apiKey: key });
    await llmConfigStore.setActiveProvider(provider as ModelProvider);
    const tail = key.slice(-4);
    return `✅ 已配置并启用 ${provider} (key 尾号 ****${tail}, 已写入 ~/.bolloon/bolloon-config.json, 不会进 git)`;
  }

  // test [provider]
  if (sub === 'test') {
    const provider = (parts[1] || (await llmConfigStore.getActiveProvider())).toLowerCase();
    const r = await llmConfigStore.testProvider(provider as ModelProvider);
    return r.success
      ? `✅ ${provider} 连通 (${r.latency ?? '?'} ms)`
      : `⚠ ${provider} 测试失败: ${String(r.error || '').slice(0, 300)}`;
  }

  // <provider> [model]
  const provider = sub;
  const cfg = await llmConfigStore.getConfig();
  const st = (cfg.providers as any)[provider];
  if (!st) return `未知供应商 '${provider}'. 可用: ${Object.keys(cfg.providers).join(', ')}`;
  if (st.requiresApiKey !== false && !st.apiKey) {
    return `${provider} 还没有 API key — 用 /model key ${provider} 配置 (或 bolloon setup 走向导)`;
  }
  const patch: Record<string, any> = { enabled: true };
  if (parts[1]) patch.model = parts[1];
  await llmConfigStore.updateProvider(provider as ModelProvider, patch);
  await llmConfigStore.setActiveProvider(provider as ModelProvider);
  return `✅ 已切换到 ${provider}${parts[1] ? ` (model=${parts[1]})` : ''}`;
}
