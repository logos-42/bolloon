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
// 2026-09-27: 启动期"续跑前言"闸门 (默认不上屏 → 面板一行 + 显式查询命令; verbose 逐字回流)
import { noticeLine as startupNotice, startupPreambleVisible, flushStartupNotices } from './startup-notice.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { llmConfigStore, PROVIDER_INFO, DEFAULT_PROVIDER_CONFIGS, type ModelProvider } from '../llm/config-store.js';
import {
  selectModel, resetModelSelection, probeSelection,
  effectiveModelConfig, formatEffectiveModel, protocolOf,
  normalizeBaseUrl, validateBaseUrlShape, currentSessionKey,
  type EffectiveModelConfig, type SelectionFailureClass,
} from '../llm/model-selection.js';
import {
  buildProviderSummaries, formatProviderLine, formatProviderMenuRow, providerGroupSummary,
  orderProvidersForMenu,
  type ProviderSummary,
} from '../llm/model-catalog.js';
import { runModelSelector, type SelectorChoice, type ModelSelectorResult } from './model-selector.js';
// 着色判据只有一处 (`theme.ts`) —— 主屏与全屏选择器共用
import { colorEnabled } from './theme.js';
import {
  refreshModelDiscovery, clearDiscoveryCache, listModelCatalog,
  admitManualModel, formatCatalogLine, formatListingSummary,
} from '../llm/model-discovery.js';

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

/**
 * 一次性隐藏输入 —— **带回 EOF 判定**。
 *
 * 为什么要把"EOF/Ctrl-D"与"用户输入了空串"分开: 空串在分步选择器里是**回车 = 取默认**,
 * 而输入流结束 (管道读完 / Ctrl-D) 只可能取消 —— 混成一件事会让 `printf '\x04' | bolloon model`
 * 把"没有输入了"读成"用户选了第 1 项"并继续往下走 (真实踩过)。
 * readline 在输入流结束时不一定回调 `question`, 所以另挂 `close` 兜底。
 */
export async function askHiddenLineEof(question: string): Promise<{ value: string; eof: boolean }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise<{ value: string; eof: boolean }>((resolve) => {
    let settled = false;
    const finish = (value: string, eof: boolean) => { if (!settled) { settled = true; resolve({ value, eof }); } };
    rl.once('close', () => finish('', true));
    const anyRl = rl as any;
    const orig = anyRl._writeToOutput?.bind(anyRl);
    anyRl._writeToOutput = function (s: string) { if (String(s).includes(question)) process.stdout.write(s); };
    rl.question(`${question} `, (ans) => {
      if (orig) anyRl._writeToOutput = orig;
      process.stdout.write('\n');
      finish(String(ans ?? '').trim(), false);
      rl.close();
    });
  });
}

/** 一次性隐藏输入 (`bolloon model key <provider>` 用; 单独开 readline, 用完即关, 不回显) */
export async function askHiddenLine(question: string): Promise<string> {
  return (await askHiddenLineEof(question)).value;
}

/**
 * 一次性普通输入 —— **带回 EOF 判定** (理由见 `askHiddenLineEof`)。
 * 有默认值时回车即取默认; EOF 时 `eof=true` (调用方必须当成取消, 不许当成回车)。
 */
export async function askLineEof(question: string, opts: { default?: string } = {}): Promise<{ value: string; eof: boolean }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise<{ value: string; eof: boolean }>((resolve) => {
    let settled = false;
    const finish = (value: string, eof: boolean) => { if (!settled) { settled = true; resolve({ value, eof }); } };
    rl.once('close', () => finish('', true));
    const prompt = `${question}${opts.default !== undefined ? ` [${opts.default}]` : ''} `;
    rl.question(prompt, (ans) => {
      const v = String(ans ?? '').trim();
      finish(v === '' && opts.default !== undefined ? String(opts.default) : v, false);
      rl.close();
    });
  });
}

/** 一次性普通输入 (分步选择器的搜索/参数输入用; 有默认值时回车即取默认) */
export async function askLine(question: string, opts: { default?: string } = {}): Promise<string> {
  return (await askLineEof(question, opts)).value;
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
  /**
   * **启动期**调用 (`bolloon --cli` 的续跑引导) 时置 true: 向导的"续跑前言"默认不上屏
   * (那个初始化框 / `Onboard 模式: …` / 每步 ✓✗ / 收尾就绪度报告), 改走 `startup-notice.ts`:
   *    · 默认: 进缓冲 + 落启动日志 —— **打完命令直接看到面板** (leo 2026-09-27);
   *    · `--verbose` / `BOLLOON_VERBOSE=1` / `BOLLOON_STARTUP_PREAMBLE=1`: 逐字打回 stderr;
   *    · **要人当场回答**(下面 ask/askHidden/confirm/select 之前) 或 **真跑了步骤 / 失败** → 先 flush 再继续,
   *      绝不把"要人下手的事"吞进缓冲 (这是硬规矩, 不是优化)。
   * 用户显式敲 `bolloon setup` 时**不要**置它 —— 那时向导的输出就是用户要的交付物。
   */
  quietStartup?: boolean;
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
  const mode: OnboardMode = (opts as any).mode || 'setup';

  // ── 启动期 vs 显式运行 (2026-09-27) ──────────────────────────────────────
  //   启动期 (`bolloon --cli` 的续跑引导): 续跑前言默认**不上屏** —— 收进缓冲 + 落启动日志,
  //   面板那边会给一行就绪度; 失败/要人回答时下面的 `flushQuiet()` 会先把缓冲打出来。
  //   判据只有一处 (`startupPreambleVisible()`): verbose / BOLLOON_VERBOSE / BOLLOON_STARTUP_PREAMBLE=1
  //   任一为真 → 与修前逐字一致地全量输出 (也是验收门的"修前对照")。
  const quiet = !!opts.quietStartup && !startupPreambleVisible();
  const quietBuf: string[] = [];
  const P = (s: string) => { if (quiet) quietBuf.push(s); else io.print(s); };
  // 要人当场回答 → 先把**所有**攒着的前言落屏: 向导自己的续跑框 + `startup-notice` 那边
  //   攒的初始门禁报告 (缺什么/下一步)。少了后一半就等于"把失败原因吞了" —— 人正要就着它做决定。
  //   (两次调用幂等: 两边缓冲都是取走即清。)
  const flushQuiet = () => { flushStartupNotices(); for (const l of quietBuf.splice(0)) startupNotice(l, { visible: true }); };

  P('');
  P('╭─ Bolloon 初始化 (可中断, 下次从失败阶段继续) ─────╮');
  P('│ 身份 → 供应商 → 凭证 → 模型 → 连通性 → 运行时   │');
  P('╰──────────────────────────────────────────────────╯');

  // 参数式输入 (非交互/脚本): 先落盘再跑阶段, 保证"输入已保存"
  try {
    if (opts.name) await writeUserIdentity(opts.name, home);
    const prov = (opts as any).provider;
    if (prov) {
      // 2026-09-26 (P6): 参数式输入也是一次**切换**, 走统一入口 (校验 / 落盘 / 重建运行时都在它里面)。
      //   此前这里自己 updateProvider + setActiveProvider = 第二条切换实现 (而且不重建运行时)。
      //   `verify:false`: 脚本/CI 场景不在这里打上游 —— 紧随其后的 onboard 连通性阶段才是实测处
      //   (只有 skipTest 才真跳过)。
      const { selectModel: selectFromParams } = await import('../llm/model-selection.js');
      const r = await selectFromParams({
        provider: prov,
        model: (opts as any).model,
        apiKey: (opts as any).apiKey,
        scope: 'global',
        verify: false,
      });
      if (!r.ok) return { ok: false, error: `参数落盘失败 [${r.failureClass}]: ${r.message}` };
    }
  } catch (e: any) {
    return { ok: false, error: `参数落盘失败: ${String(e?.message || e).slice(0, 160)}` };
  }

  // 启动期静默: onboard 的 io 全部收进缓冲; 一旦**要人当场回答** → 先把缓冲打出来再问
  const baseOnboardIO = onboardIO(io);
  const wrappedOnboardIO: OnboardIO = quiet ? {
    ...baseOnboardIO,
    print: (m: string) => P(m),
    ask: async (q, o) => { flushQuiet(); return baseOnboardIO.ask(q, o); },
    askHidden: async (q) => { flushQuiet(); return baseOnboardIO.askHidden(q); },
    confirm: async (q, d) => { flushQuiet(); return baseOnboardIO.confirm(q, d); },
    select: async (q, c) => { flushQuiet(); return baseOnboardIO.select(q, c); },
  } : baseOnboardIO;

  const res = await runOnboard({
    mode,
    io: wrappedOnboardIO,
    home,
    bolloonHome,
    targets: (opts as any).targets,
    skipSteps: opts.skipTest ? ['connectivity'] : undefined,
    oneShot: opts.interactive === false,
  });

  // 真干了活 (有步骤不是 skipped) 或没走通 → 前言必须先落屏: 那是"发生了什么/哪儿卡住"的唯一上下文
  if (quiet && (!res.ok || res.steps.some((s) => s.status !== 'skipped'))) flushQuiet();

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

export interface ModelCommandIO {
  /** 需要收 API key 时使用的隐藏输入 (会话内没有此能力 → 不传); 返回 null = 输入流结束 (EOF) */
  askHidden?: (q: string) => Promise<string | null>;
  /** 普通文本输入 (分步选择器的搜索/温度输入用; TTY 场景才传); 返回 null = 输入流结束 (EOF) */
  ask?: (q: string, opts?: { default?: string }) => Promise<string | null>;
  /** 结构化选择器 (会话内的渲染层选择器; 传了就优先用它) */
  choose?: (items: SelectorChoice[], title: string) => Promise<string | null>;
  /** 这个 `choose` 自带实时筛选 (全屏 TUI 的 `/`) → 选择器不再单独问一遍"搜索模型" */
  filterable?: boolean;
  /** 打内部细节 (目录新鲜度/逐步事实/未知字段脚注); 默认不打 (`--verbose`) */
  verbose?: boolean;
  /**
   * 交互式 (真终端) 场景: 选择器的每一步**当场打到终端**, 而不是等整轮结束才一次性回显。
   *
   * 为什么单列一个开关: 非交互调用方 (会话内 Ink / 验收脚本) 要的是"整段文本", 它们自己决定怎么呈现;
   * 而命令行交互时不印出来 = 用户看不见选项 (曾经只有一句光秃秃的 `选择 (序号/值, 回车=1)`)。
   */
  live?: boolean;
  /** `live` 时的逐行出口 (默认 `process.stdout`)。每行进来就打, 不回显缓冲。 */
  print?: (line: string) => void;
  /** 输出口支持 ANSI 颜色 (真终端 + 没设 `NO_COLOR`); 判据来自 `theme.ts` 的 `colorEnabled` */
  color?: boolean;
}

/** 切换失败的机器可读分类 → 人话 (不许只回"切换成功"/"失败了") */
const FAILURE_ZH: Record<SelectionFailureClass, string> = {
  invalid_provider: '供应商不存在',
  invalid_model: '模型名为空',
  invalid_url: 'API 地址非法',
  missing_api_key: '缺少 API key',
  credential_scope_conflict: '会话级切换不允许写凭证',
  auth_failed: '凭证被拒 (401/403)',
  provider_unreachable: '服务不可达',
  model_not_found: '服务不认识这个模型',
  protocol_mismatch: '协议不匹配',
  invalid_temperature: 'temperature 越界 (只接受 0~2)',
  timeout: '连接超时',
  // 2026-09-26 (接线收口): 探测原语第 ⑥ 步确认工具调用能力时可能报这一类 —— 入口必须认它,
  //   否则这类失败会在映射时被丢进别的类 (用户就看不到"是工具调用声明被端点拒了")
  tool_call_unsupported: '模型/端点不接受工具调用声明 (这个模型不能用于 Agent 执行)',
  // 写盘阶段的两类 (写盘失败 / 写成功了但重建运行时失败), 分开报, 不再合成一句"切换失败"
  persist_failed: '写配置失败 (已回滚, 盘上仍是旧配置)',
  runtime_rebuild_failed: '配置写成功但重建模型运行时失败 (已回滚)',
  // 理论上不可达: 探测报了一个映射表还没覆盖的新类目 (宁可露出原文类名, 也不糊成一句"失败")
  probe_failure_unmapped: '探测类目未被映射表覆盖 (按原文类名报出)',
  // 2026-09-27 (目录驱动): 目录里有些家要专用鉴权 (云签名/OAuth) —— 本运行时发不出它们的请求。
  //   必须与"凭证被拒"分开说: 前者要换路, 后者换 key 就行。
  provider_auth_unsupported: '这家需要专用鉴权 (本版本未支持)',
};

function flagValue(parts: string[], i: number, name: string): string | undefined {
  const p = parts[i];
  if (p === name) return parts[i + 1];
  if (p.startsWith(`${name}=`)) return p.slice(name.length + 1);
  return undefined;
}

/** `/model` 的解析结果 (纯数据, 好测) */
export interface ParsedModelCommand {
  action: 'status' | 'test' | 'reset' | 'key' | 'select' | 'pick' | 'refresh' | 'admit' | 'catalog';
  /**
   * `/model list` 标记。**action 仍是 `status`** —— 老门禁钉着 `parseModelCommand('list').action === 'status'`
   * (`list` 在无参时与 `status` 同类: 都是"看, 不改")。区别只在输出: 带这个标记就把 P5 的
   * 发现目录清单打出来, 而不是打当前生效配置。
   */
  list?: boolean;
  /**
   * `/model catalog [status|list|refresh]` 的子动作 (目录驱动, 2026-09-27)。
   *   · `status`  —— 这份目录是几号的 / 新鲜还是陈旧 / 有哪些族 (默认);
   *   · `list`    —— 逐家列 (**默认列全部**, 含"需专用鉴权 (未支持)/ 无 api 基址"并如实标原因;
   *                  `--usable` 才只看真能打的那些 —— 藏家数是不许的, 少列要靠显式开关);
   *   · `refresh` —— 运行期真拉一次公开源, 落盘 `provider-catalog.json` (0600) 并打印来源/字节数/时间/家数。
   */
  catalogSub?: 'status' | 'list' | 'refresh';
  /** `/model catalog list <筛选词>` 的筛选词 (匹配 id / 名字) */
  filter?: string;
  /** `/model catalog list --all` = 全部 (2026-09-27 起**这就是默认**; 留着只为老命令不报错) */
  all?: boolean;
  /** `/model catalog list --usable` 只看"有 api 基址 + 鉴权受支持 + 配了环境变量"的家 */
  usableOnly?: boolean;
  /** `/model catalog list --family <族>` 只看某一族 */
  family?: string;
  /** `/model refresh --clear` — 清发现缓存而不是重取 */
  clear?: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  scope: 'global' | 'session';
  verify: boolean;
  json: boolean;
  errors: string[];
}

export function parseModelCommand(arg: string): ParsedModelCommand {
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
  const out: ParsedModelCommand = { action: 'status', scope: 'global', verify: true, json: false, errors: [] };
  const positional: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '--json') { out.json = true; continue; }
    if (p === '--no-verify') { out.verify = false; continue; }
    if (p === '--clear') { out.clear = true; continue; }
    // `/model catalog list --all | --usable | --family <族>` (目录驱动的筛选; 不认识的族名留给展示层如实报)
    if (p === '--all') { out.all = true; continue; }
    if (p === '--usable' || p === '--only-usable') { out.usableOnly = true; continue; }
    const fam = flagValue(parts, i, '--family');
    if (fam !== undefined) {
      if (!p.includes('=')) i++;
      out.family = String(fam).toLowerCase();
      continue;
    }
    if (p === '--session' || p === '--scope=session') { out.scope = 'session'; continue; }
    if (p === '--global' || p === '--scope=global') { out.scope = 'global'; continue; }
    if (p === '--scope') {
      const v = parts[i + 1];
      if (v === 'session' || v === 'global') { out.scope = v; i++; continue; }
      out.errors.push(`--scope 只接受 session|global, 收到 '${v ?? ''}'`);
      i++;
      continue;
    }
    const bu = flagValue(parts, i, '--base-url') ?? flagValue(parts, i, '--url');
    if (bu !== undefined) {
      const consumedEq = p.includes('=');
      if (!consumedEq) i++;
      const shape = validateBaseUrlShape(bu);
      if (!shape.ok) out.errors.push(`--base-url 非法: ${shape.reason}`);
      else out.baseUrl = shape.url;
      continue;
    }
    if (p.startsWith('--')) { out.errors.push(`未知选项 ${p}`); continue; }
    positional.push(p);
  }

  const sub = (positional[0] || '').toLowerCase();
  if (!sub || sub === 'status') { out.action = 'status'; return out; }
  // `/model catalog [status|list|refresh]` — 供应商目录层 (目录驱动): 看它是几号的 / 逐家列 / 真拉一次最新。
  if (sub === 'catalog') {
    out.action = 'catalog';
    const csub = (positional[1] || '').toLowerCase();
    out.catalogSub = csub === 'list' ? 'list' : csub === 'refresh' ? 'refresh' : 'status';
    if (out.catalogSub === 'list') {
      // 筛选词可以是第 3 段; 但要先跳过 `--family <值>` 这种"值也算一段"的写法
      const rest = positional.slice(2).filter((s, i, arr) => arr[i - 1] !== '--family');
      out.filter = rest[0]?.toLowerCase();
    }
    return out;
  }
  // `/model list [provider]` — 看 P5 的发现目录 (不写配置)。action 仍是 status (见 list 字段注释)。
  if (sub === 'list') { out.action = 'status'; out.list = true; out.provider = positional[1]?.toLowerCase(); return out; }
  // `/model refresh [provider]` — 真去上游重取一次目录 (P5 的能力); `--clear` 改成清缓存。
  if (sub === 'refresh' || sub === 'discover') { out.action = 'refresh'; out.provider = positional[1]?.toLowerCase(); return out; }
  // 手输模型: 把一个上游目录里没有的模型名记进这家供应商的发现缓存 (不是"切换")。
  if (sub === 'admit') {
    out.action = 'admit';
    out.provider = positional[1]?.toLowerCase();
    out.model = positional[2];
    if (!out.provider || !out.model) out.errors.push('用法: /model admit <provider> <model>');
    return out;
  }
  if (sub === 'pick' || sub === 'wizard') { out.action = 'pick'; return out; }
  if (sub === 'test') { out.action = 'test'; out.provider = positional[1]?.toLowerCase(); return out; }
  if (sub === 'reset') { out.action = 'reset'; return out; }
  if (sub === 'key' || sub === 'auth') {
    out.action = 'key';
    out.provider = positional[1]?.toLowerCase();
    out.apiKey = positional[2];
    if (!out.provider) out.errors.push('用法: /model key <provider>');
    return out;
  }
  out.action = 'select';
  out.provider = sub;
  out.model = positional[1];
  return out;
}

/**
 * 供应商列表 —— 每一行就是选择器第一步看到的那种行 (`● 供应商 · N models`)。
 * 数字与状态全部来自 `model-catalog`: 有真来源的给真值, 拿不到目录的写"无内置目录"
 * (而不是 0 个模型), 未配置凭证的写清要哪个环境变量。
 */
async function providerLines(sessionKey?: string): Promise<string[]> {
  const summaries = await buildProviderSummaries({ sessionKey });
  // 2026-09-27 (目录驱动, 二改): 这里**列全量** (内置 13 + 自定义 + 目录全部), 并按第 1 步同一套
  //   分组优先级排序, **不再带分组分隔条** (全平铺)。纯文本这条路没有视窗/折叠 (那是全屏选择器的事), 所以逐行列全 ——
  //   门禁钉着"不许只给计数": 任何一家都要能在这份输出里被看见。
  const lines: string[] = [];
  const ordered = orderProvidersForMenu(summaries);
  for (const s of ordered) {
    lines.push(`  ${formatProviderMenuRow(s)}`);
  }
  lines.push(`  ${providerGroupSummary(summaries)}`);
  lines.push(...await providerCatalogLines());
  return lines;
}

/**
 * `/model catalog [status|list|refresh]` — 供应商目录层 (目录驱动, 2026-09-27)。
 *
 * 三件事, 全部输出都由 `provider-catalog.ts` 生成 (不在这里另造一套说法):
 *   · 默认/`status` —— 这份目录**是几号的、是不是刚刷的** (陈旧必如实标), 各族多少家;
 *   · `list`        —— 逐家列 (**默认全量**: 连"需专用鉴权/无 api 基址"的也列并标清原因; `--usable` 才只看能用的);
 *   · `refresh`     —— 运行期真拉一次公开源, 落盘 `${BOLLOON_HOME}/provider-catalog.json` (0600),
 *                      打印来源 URL / 字节数 / sha256 / 拉到时间 / 家数。
 */
export async function formatProviderCatalog(parsed: ParsedModelCommand): Promise<string> {
  const pc: any = await import('../llm/provider-catalog.js');
  await pc.initializeProviderCatalog();
  const sub = parsed.catalogSub || 'status';

  // ── 真拉一次最新 (运行期刷新: 不只在构建期烤死那份) ──────────────
  if (sub === 'refresh') {
    const rep: any = await pc.refreshProviderCatalog(parsed.baseUrl ? { url: parsed.baseUrl } : {});
    if (parsed.json) return JSON.stringify(rep, null, 2);
    const lines: string[] = [`目录刷新: ${rep.ok ? '✅ 成功' : '✗ 失败'}`];
    lines.push(`  源 URL: ${rep.sourceUrl}`);
    lines.push(`  字节数: ${rep.sourceBytes} · sha256: ${String(rep.sourceSha256 || '').slice(0, 16)}`);
    lines.push(`  拉到时间: ${rep.fetchedAt} · 家数: ${rep.providerCount} (有 api 基址 ${rep.stats?.withApi ?? 0}) · 模型 ${rep.modelCount}`);
    lines.push(`  落盘: ${rep.path || '(未落盘)'} (权限 ${rep.fileMode || '未写'})`);
    if (rep.error) lines.push(`  ⚠ ${rep.error}`);
    for (const n of rep.notes || []) lines.push(`  · ${n}`);
    lines.push('');
    lines.push(pc.catalogStatusLine());
    return lines.join('\n');
  }

  // ── 逐家列 (**默认全部** —— 折/藏家数是这条线要修的病) ─────────────
  if (sub === 'list') {
    const fams: string[] = pc.CATALOG_FAMILIES;
    if (parsed.family && !fams.includes(parsed.family)) {
      return `未知协议族 '${parsed.family}' —— 目录只分这几族: ${fams.join(' / ')} (没编别的)`;
    }
    const all: any[] = pc.catalogProviders();
    const envOn = (v: any) => !!(v.auth?.envVar && String(process.env[String(v.auth.envVar)] || '').trim());
    let rows = all.filter((v) => (parsed.family ? v.family === parsed.family : true));
    if (parsed.filter) {
      const q = parsed.filter;
      rows = rows.filter((v) => v.id.includes(q) || String(v.name || '').toLowerCase().includes(q));
    }
    const usable = rows.filter((v) => v.speakable);
    // 默认 = 全部匹配 (含不能用但如实标了原因的); `--usable` 才是"只看能用的"
    const shown = parsed.usableOnly ? usable : rows;
    const lines: string[] = [
      `${pc.catalogStatusLine()}`,
      `  匹配 ${rows.length} 家 (列出全部 · 目录里共 ${all.length} 家` +
        ` · 真能打 ${usable.length} 家${parsed.usableOnly ? ' (--usable: 只列这些)' : ''})`
        + `${parsed.filter ? ` · 筛选 '${parsed.filter}'` : ''}${parsed.family ? ` · 族 ${parsed.family}` : ''}`,
    ];
    if (!shown.length) {
      lines.push('  (没有匹配的家 —— 换个筛选词, 或去掉 --family / --usable)');
    }
    // 已配置凭证的排前面 (用户最可能想用这些)
    for (const v of [...shown].sort((a, b) => Number(envOn(b)) - Number(envOn(a)) || String(a.id).localeCompare(String(b.id)))) {
      lines.push(`  ${pc.formatCatalogProviderLine(v, { envConfigured: envOn(v) })}`);
    }
    lines.push('');
    lines.push(`  用起来: /model <家> <模型> [--base-url <地址>] · 看模型: /model list <家> · 刷新目录: /model catalog refresh`);
    lines.push(`  注意: 只有"有 api 基址 + 鉴权形状受支持 + 你配了该家声明的环境变量"的家能真发请求 —— 其余如实标未支持, 不假装可用`);
    return lines.join('\n');
  }

  // ── 默认: 这份目录是几号的 / 新鲜度 / 分布 ──────────────────────
  const load: any = pc.catalogLoad();
  const stats: any = pc.catalogStats();
  if (parsed.json) return JSON.stringify({ load, stats }, null, 2);
  const lines: string[] = [
    pc.catalogStatusLine(),
    `  ${pc.catalogGroupLine()}`,
    `  本运行时真能打的家 (有 api 基址 + 鉴权受支持): ${stats.speakable} / ${stats.providers}`
      + ` · 需专用鉴权 (未支持): ${stats.specialAuth} · 无 api 基址: ${stats.noBaseUrl}`,
    `  源: ${load.provenance?.sourceUrl || pc.CATALOG_SOURCE_URL} · 来源: ${load.source === 'runtime' ? `运行期文件 ${load.path}` : '构建期烘焙数据 (离线可用)'}`,
    '',
    '  用法: /model catalog list [筛选词] [--usable] [--family <族>]   (默认**全量**列出, 不藏家数)',
    '        /model catalog refresh [--url <地址>]   (真拉最新, 落盘 0600, 记来源与时间)',
    '',
    `  目录里的家直接用: /model <家> <模型> —— 只要你有该家声明的环境变量, 不用改代码就能用`,
  ];
  for (const w of load.warnings || []) lines.push(`  ⚠ ${w}`);
  return lines.join('\n');
}

/** 供应商列表末尾的目录状态行 (status / 选择器第一步共用; 陈旧必如实标) */
export async function providerCatalogLines(): Promise<string[]> {
  const pc: any = await import('../llm/provider-catalog.js');
  await pc.initializeProviderCatalog();
  const load: any = pc.catalogLoad();
  return [
    '',
    `${pc.catalogStatusLine()}`,
    `  ${pc.catalogGroupLine()}`,
    `  看目录: /model catalog · 筛: /model catalog list <筛选词> · 拉最新: /model catalog refresh`,
    ...(load.warnings || []).map((w: string) => `  ⚠ ${w}`),
  ];
}

/**
 * `/model list [provider]` — 把 P5 的发现目录打成人看的清单。
 * 明细/汇总/来源中文全部复用 model-discovery 自己的格式化函数 (不在这里再写一套说法)。
 */
export async function formatCatalogListing(provider?: string, json = false): Promise<string> {
  if (provider) {
    const one = await listModelCatalog(provider);
    const entry = one.entries[0];
    const unavailable = one.unavailable.find((u) => u.provider === provider);
    if (json) return JSON.stringify({ ok: !unavailable, listing: one, entry: entry || null }, null, 2);
    const lines: string[] = [`${provider} 的模型目录:`];
    if (entry) {
      lines.push(`  ${formatCatalogLine(entry)}`);
      for (const m of entry.models) lines.push(`    · ${m}${entry.modelOrigins?.[m] ? `  (${entry.modelOrigins[m]})` : ''}`);
      if (!entry.models.length) lines.push('    (目录里一个模型都没有 — 用 /model admit 手输, 或 /model refresh 重取)');
    } else {
      lines.push(`  ⚠ 这家这一轮拿不到目录${unavailable?.failureClass ? ` (${unavailable.failureClass})` : ''}: ${String(unavailable?.reason ?? '未发现').slice(0, 160)}`);
    }
    for (const n of one.notes || []) lines.push(`  · ${n}`);
    return lines.join('\n');
  }
  const listing = await listModelCatalog();
  if (json) return JSON.stringify({ ok: listing.unavailable.length === 0, listing }, null, 2);
  const lines: string[] = [...formatListingSummary(listing)];
  for (const c of listing.entries) lines.push(`  ${formatCatalogLine(c)}`);
  lines.push('  细节: /model list <provider> · 重取: /model refresh [provider] · 清缓存: /model refresh --clear');
  return lines.join('\n');
}

/**
 * `/model status` — 一律先给**当前真实生效**的那一份 (provider/model/base URL/协议/凭证来源/作用域),
 * 再给候选列表。用户问"现在到底在用哪个"必须能一眼答上。
 */
export async function formatProviderStatus(sessionKey?: string): Promise<string> {
  const eff = await effectiveModelConfig({ sessionKey });
  const key = sessionKey || currentSessionKey();
  const lines: string[] = [
    `当前生效: ${eff.provider}/${eff.model}`,
    `  ${formatEffectiveModel(eff)}`,
    `  会话键: ${key}`,
    '',
    '供应商 (**全部**列出 · 分组标题带家数 · ● 可用 / ○ 未配置; 一屏放得下的交互版走 `/model pick`):',
  ];
  lines.push(...await providerLines(sessionKey));
  lines.push('');
  lines.push('用法: /model pick 分步选择 (供应商→凭证→模型→参数→作用域→测试→确认)');
  lines.push('      /model <provider> [model] [--base-url <url>] [--session] · /model test [provider] · /model status · /model reset · /model key <provider>');
  lines.push('      /model list [provider] 看模型发现目录 · /model refresh [provider] 重取 · /model refresh --clear 清缓存 · /model admit <provider> <model> 手输模型');
  lines.push('      /model catalog 看供应商目录 (是几号的/新鲜度) · /model catalog list [筛选词] [--usable] · /model catalog refresh 拉最新');
  lines.push('      --session 只影响当前会话 (不动全局默认) · --no-verify 跳过切换前连通探测 (不推荐)');
  return lines.join('\n');
}

/**
 * 分步选择器的薄包装: 把界面给的选择/输入能力交给它, 结果整理成可打印文本。
 * 这里**不看配置、不写配置** —— 全部动作都在选择器内部走到 `selectModel()` 那一个点。
 */
export async function runModelPicker(
  io: ModelCommandIO = {},
  opts: { sessionKey?: string; skipProbe?: boolean; verify?: boolean; assumeYes?: boolean; initialProvider?: string } = {},
): Promise<{ text: string; tail: string; live: boolean; result: ModelSelectorResult }> {
  const collected: string[] = [];
  // 交互式 (live): 每行**当场**打到终端, 同时仍收进 `collected` 作为完整回执。
  //   非交互: 只收进 `collected`, 由调用方决定怎么呈现 (会话内 Ink / 验收脚本读整段)。
  const liveSink = io.live ? (io.print ?? ((l: string) => process.stdout.write(l + '\n'))) : null;
  const res = await runModelSelector(
    {
      print: (l) => { collected.push(l); liveSink?.(l); },
      ...(io.ask ? { ask: io.ask } : {}),
      ...(io.askHidden ? { askHidden: io.askHidden } : {}),
      ...(io.choose ? { choose: io.choose } : {}),
      ...(io.filterable ? { filterable: true } : {}),
      // 七步主屏也走 bolloon 色系 (真终端才上; `lines` 里仍是原文)
      ...(io.color ? { color: true } : {}),
    },
    { ...opts, ...(io.verbose ? { verbose: true } : {}) },
  );
  const tailLines = res.ok
    ? [`✅ 当前生效: ${formatEffectiveModel(res.effective!)}`]
    : [res.cancelled ? `· ${res.message}` : `✗ 切换未完成${res.failureClass ? ` [${FAILURE_ZH[res.failureClass]}]` : ''}: ${res.message}`];
  // 已经当场印过的部分不再回放 (live 时只回执尾行); 非 live 时整段文本原样返回。
  return {
    text: [...collected, ...tailLines].join('\n'),
    tail: tailLines.join('\n'),
    live: !!liveSink,
    result: res,
  };
}

/**
 * 真终端下的模型选择器 IO: **全屏光标选择器 + 掩码隐藏输入** (2026-09-27)。
 *
 * 为什么单列一个工厂: 交互能力必须**同一份**递给所有步骤 (供应商/凭证/模型/参数/作用域/确认都用
 * 同一个 `tuiSelect`), 否则就会出现"某一步退化成文本问答"。
 *
 * 能力/降级说得明明白白:
 *   · `tuiCapable()` 为假 (非 TTY / 终端太矮 / `BOLLOON_NO_TUI=1`) → 调用方**不要**用这个工厂,
 *     退回逐行问答 (管道输出仍可读, 一个字节不变);
 *   · 拿不到 raw mode 时掩码输入**如实降级**成 readline 隐藏输入 (同样不回显明文), 绝不静默明文回显;
 *   · 颜色按 `NO_COLOR` / `TERM=dumb` / isTTY 三判据关掉 —— 但符号 (`●`/`○`/`← 当前`/`special`) 永远在,
 *     无色终端一样分得清。
 */
export function modelTtyIO(): ModelCommandIO {
  return {
    live: true,
    // ★ 七步主屏也走 bolloon 色系 (leo 2026-09-27: "切换时的颜色变成 bolloon 色系, 不是灰白") ——
    //   判据只有一处 (`theme.ts`: 真终端 + 没设 NO_COLOR + TERM != dumb)。
    color: colorEnabled(!!process.stdout.isTTY),
    print: (l: string) => { try { process.stdout.write(l + '\n'); } catch { /* 管道关了就安静 */ } },
    choose: async (items: SelectorChoice[], title: string) => {
      const tui: any = await import('./tui-select.js');
      const choices = items.map((c) => ({
        value: c.value,
        label: c.label,
        ...(c.hint ? { hint: c.hint } : {}),
        ...(c.group ? { group: c.group } : {}),
        // 分组"默认收起"的标记要原样带过去 (候选集不受影响, 只是排版: 标题照写家数)
        ...(c.groupCollapsed ? { groupCollapsed: true } : {}),
        ...(c.tone ? { tone: c.tone } : {}),
        // 末行"取消 / 手输"与其它步骤同一形态: 把它当取消行, `Esc` 与它同义
        ...(/^取消/.test(c.label) ? { cancel: true } : {}),
      }));
      // 供应商那一步的单位是"家", 其余是"项" (计数行读起来才像话)
      const unit = /供应商/.test(title) ? '家' : '项';
      return await tui.tuiSelect(choices, title, { unit });
    },
    filterable: true,
    askHidden: async (q: string) => {
      const tui: any = await import('./tui-select.js');
      if (tui.tuiCapable()) {
        const r = await tui.tuiAskMasked({ prompt: q.replace(/\(.*?\)\s*$/, '').trim() || q });
        return r.eof ? null : r.value;
      }
      // 拿不到 raw mode: 如实降级到 readline 隐藏输入 (仍然不回显明文, 且明确告知)
      process.stdout.write('· 本终端不支持全屏掩码输入 → 降级为隐藏输入 (同样不回显明文)\n');
      const r = await askHiddenLineEof(q);
      return r.eof ? null : r.value;
    },
    ask: async (q: string, opts?: { default?: string }) => { const r = await askLineEof(q, opts); return r.eof ? null : r.value; },
  };
}

/**
 * `/model` / `bolloon model` 命令实现。
 *
 * 切换类动作**全部**走统一入口 `selectModel()` —— 这里只做参数解析与结果展示,
 * 不自己写配置、不自己重建运行时 (否则又会分叉出第二条路)。
 *
 * 返回**要打印的文本**。⚠️ `io.live === true` (真终端交互) 时返回的**只有尾行** ——
 * 分步选择器的每一步已经当场打给用户了, 调用方别再回放整段 (会刷两遍)。
 * `io.live !== true` 时返回完整文本 (会话内 Ink / 验收脚本 / 管道都要这一份)。
 */
export async function runModelCommand(arg: string, io: ModelCommandIO = {}): Promise<string> {
  const parsed = parseModelCommand(arg);
  if (parsed.errors.length) {
    return [`参数有问题, 未改动任何配置:`, ...parsed.errors.map((e) => `  · ${e}`)].join('\n');
  }

  // ── 分步选择器 (显式 `pick`, 或空参 + 界面能给结构化选择) ───
  //     两种入口都只是"把界面能力递给选择器"; 写配置/重建运行时仍只在 selectModel 一处。
  if (parsed.action === 'pick' || (parsed.action === 'status' && !String(arg || '').trim() && !!io.choose)) {
    if (!io.choose && !io.ask) {
      return [
        '分步选择需要交互能力 (当前环境既没有选择器也没有文本输入)。',
        '  在系统终端跑: bolloon model pick',
        `  或直接一条命令切: /model <provider> [model] [--base-url <url>]`,
      ].join('\n');
    }
    const picked = await runModelPicker(io, { skipProbe: !parsed.verify, verify: parsed.verify });
    // live: 正文已当场印过 → 只回执尾行; 非 live: 整段文本原样交出
    return picked.live ? picked.tail : picked.text;
  }

  // ── 供应商目录 (目录驱动: 不写配置; refresh 是显式拉源) ──────
  if (parsed.action === 'catalog') return formatProviderCatalog(parsed);

  // ── 状态 ─────────────────────────────────────────────────
  if (parsed.action === 'status') {
    // `/model list [provider]` — P5 的发现目录 (只读, 不写配置)
    if (parsed.list) return formatCatalogListing(parsed.provider, parsed.json);
    const eff = await effectiveModelConfig({});
    if (parsed.json) return JSON.stringify({ ok: true, effective: eff }, null, 2);
    return formatProviderStatus();
  }

  // ── 发现目录: 重取 / 清缓存 (P5 的能力挂到命令面) ───────────
  if (parsed.action === 'refresh') {
    if (parsed.clear) {
      const cleared = await clearDiscoveryCache(parsed.provider || undefined);
      if (parsed.json) return JSON.stringify({ ok: true, action: 'clear', provider: parsed.provider || null, cleared }, null, 2);
      return `✅ 已清掉发现缓存${parsed.provider ? ` (${parsed.provider})` : ' (全部)'} — 清了 ${cleared} 条; 下次需要时再真取。`;
    }
    const r = await refreshModelDiscovery(parsed.provider || undefined, { force: true });
    if (parsed.json) return JSON.stringify({ ok: r.failures.length === 0, ...r }, null, 2);
    const lines: string[] = [`模型目录已刷新 (${r.results.length} 家, 失败 ${r.failures.length} 家 · ${r.refreshedAt})`];
    for (const c of r.results) lines.push(`  ${formatCatalogLine(c)}`);
    for (const f of r.failures) lines.push(`  ⚠ ${f.provider} · ${f.failureClass}: ${String(f.reason).slice(0, 160)}`);
    for (const n of r.notes || []) lines.push(`  · ${n}`);
    lines.push('  用 /model list [provider] 看明细');
    return lines.join('\n');
  }

  // ── 手输模型: 记进这一家的发现缓存 (不是"切换"; 切换仍只走 selectModel) ──
  if (parsed.action === 'admit') {
    const provider = parsed.provider!;
    const r = await admitManualModel(provider, parsed.model!);
    if (parsed.json) return JSON.stringify(r, null, 2);
    if (!r.ok) return `✗ ${provider} 手工模型没记上: ${r.reason}`;
    return [
      `✅ 已把 ${provider}/${parsed.model} 记进发现缓存 (手输)`,
      `  ${formatCatalogLine(r.catalog)}`,
      `  切成当前模型: /model ${provider} ${parsed.model}`,
    ].join('\n');
  }

  // ── 重置 (清会话级绑定, 回到全局那一份) ────────────────────
  if (parsed.action === 'reset') {
    const r = await resetModelSelection();
    if (parsed.json) return JSON.stringify(r, null, 2);
    if (!r.ok) return `⚠ 重置失败: ${r.message}`;
    return [
      r.previous?.source === 'session' ? '✅ 已清掉当前会话的模型绑定, 回到全局默认' : '当前会话本来就没有绑定 (全局默认不变)',
      `当前生效: ${formatEffectiveModel(r.effective!)}`,
    ].join('\n');
  }

  // ── 连通测试 ─────────────────────────────────────────────
  if (parsed.action === 'test') {
    const eff = await effectiveModelConfig({});
    const provider = (parsed.provider || eff.provider).toLowerCase();
    const target = provider === eff.provider
      ? { provider, model: eff.model, baseUrl: eff.baseUrl, apiKey: undefined }
      : await (async () => {
        const p = await llmConfigStore.getProvider(provider as ModelProvider);
        if (!p) return null;
        return { provider, model: p.model, baseUrl: normalizeBaseUrl(p.baseUrl), apiKey: p.apiKey };
      })();
    if (!target) return `未知供应商 '${provider}'`;
    const started = Date.now();
    const probe = await probeSelection(target);
    const ms = Date.now() - started;
    if (parsed.json) return JSON.stringify({ ok: probe.ok, provider, model: target.model, baseUrl: target.baseUrl, failureClass: probe.failureClass, detail: probe.detail, ms }, null, 2);
    return probe.ok
      ? `✅ ${provider}/${target.model} 连通 (${ms} ms) — ${probe.detail}`
      : `⚠ ${provider}/${target.model} 测试失败 [${probe.failureClass ? FAILURE_ZH[probe.failureClass] : '未知'}]: ${probe.detail}`;
  }

  // ── 设 key (然后立刻切到该 provider) ────────────────────────
  if (parsed.action === 'key') {
    const provider = parsed.provider!;
    const cfg = await llmConfigStore.getConfig();
    if (!(cfg.providers as any)[provider]) {
      return `未知供应商 '${provider}'. 可用: ${Object.keys(cfg.providers).join(', ')}`;
    }
    let key = parsed.apiKey || '';
    if (!key) {
      if (!io.askHidden) {
        return [
          `在会话内不收取 API key (避免留在会话记录里)。请在系统终端执行:`,
          `  bolloon model key ${provider}`,
          `或打开 Web 配置页 (bolloon --web) 填 key。`,
        ].join('\n');
      }
      const got = await io.askHidden(`粘贴 ${provider} API key`);
      if (got === null) return '输入已结束 (EOF/Ctrl-D) —— 未输入 key, 未改动配置';
      key = got;
    }
    if (!key) return '未输入 key, 未改动配置';

    const r = await selectModel({ provider, apiKey: key, scope: 'global' });
    const tail = key.slice(-4);
    if (!r.ok) {
      // 实情: 统一入口先校验探测再写盘, 所以失败(=探测没过/校验没过)时 **key 与切换都没落盘**,
      //   旧配置与运行时原样。这里不许写成"key 已保存但没切过去" —— 那是另一种状态, 而且不是真的。
      return [
        `⚠ ${provider} 没有配置成功 [${r.failureClass ? FAILURE_ZH[r.failureClass] : '未知'}]: ${r.message}`,
        `  key (尾号 ****${tail}) 与这次切换**都没有落盘**, 旧配置与运行时保持原样。`,
        r.previous ? `当前仍在用: ${formatEffectiveModel(r.previous)}` : '',
      ].filter(Boolean).join('\n');
    }
    return [
      `✅ 已配置并启用 ${provider} (key 尾号 ****${tail}, 写入 ~/.bolloon/bolloon-config.json, 不会进 git)`,
      `当前生效: ${formatEffectiveModel(r.effective!)}`,
    ].join('\n');
  }

  // ── 切换供应商 / 模型 / URL ────────────────────────────────
  const provider = parsed.provider!;
  const r = await selectModel({
    provider,
    model: parsed.model,
    baseUrl: parsed.baseUrl,
    scope: parsed.scope,
    verify: parsed.verify,
  });

  if (parsed.json) return JSON.stringify(r, null, 2);

  if (!r.ok) {
    return [
      `✗ 切换失败 [${r.failureClass ? FAILURE_ZH[r.failureClass] : '未知'}]: ${r.message}`,
      ...(r.checks || []).map((c) => `  ${c}`),
      r.previous ? `配置与运行时均保持原样, 仍在用: ${formatEffectiveModel(r.previous)}` : '',
    ].filter(Boolean).join('\n');
  }

  const scopeZh = parsed.scope === 'session' ? '仅当前会话' : '全局默认 (新会话生效)';
  return [
    `✅ 已切换到 ${provider}${parsed.model ? ` (model=${parsed.model})` : ''} — ${scopeZh}`,
    ...(r.checks || []).map((c) => `  ${c}`),
    `当前生效: ${formatEffectiveModel(r.effective!)}`,
  ].join('\n');
}
