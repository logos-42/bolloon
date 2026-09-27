/**
 * model-selector.ts — `/model` 的分步选择器 (2026-09-26)
 *
 * 流程 (与命令面同一条路, 只是把参数逐步问出来):
 *
 * ```
 * 1 选择供应商 → 2 未配置则输 API key → 3 选择模型 (模糊搜索) → 4 reasoning/temperature
 *   → 5 Session 还是 Global → 6 测试连接 → 7 确认切换
 * ```
 *
 * ## 两条硬纪律
 *
 * ① **切换只有一次写盘动作, 且只走统一入口**。本文件不碰配置文件、不碰模型运行时 ——
 *    前面六步全部是"收集意图", 第七步把收集到的东西**一次性**交给
 *    `selectModel()` (`src/llm/model-selection.ts`)。理由: P0 之前 CLI 那条路
 *    "只改配置文件不重建运行时", 于是出现"切了不生效"; 选择器如果自己写配置就会分叉出第二条路。
 *    可核证据: `src/test/model-selector.test.ts` 有一条源码级门 —— 本文件里出现
 *    `updateProvider(` / `setActiveProvider(` / `initMinimax(` / 直接写配置文件 就判红。
 *
 * ② **API key 只在内存里活到第七步**: 不打印、不回显、不落盘到别处 (第 2 步只回显尾 4 位),
 *    由 `selectModel()` 在它自己的写盘路径里落进全局配置。用户在第二~六步取消 → 一个字节都没写。
 *
 * ## 元数据从哪来
 *
 * 列表与能力字段全部由 `src/llm/model-catalog.ts` 给 (那里定义了唯一填充点)。本文件**只做
 * 三态到人话的翻译与排版**, 一个能力值都不产生 —— 拿不到真数据时列表上写的是"未知",
 * 而不是一个看起来像真的常量。
 */

import {
  buildProviderSummaries, listModelsFor, formatProviderLine, formatModelLine, formatModelMenuRow,
  providerGroupSummary,
  unknownFootnote, searchModelEntries, capabilityZh, resolvedApiKeyOf,
  type ModelEntry, type ProviderSummary,
} from '../llm/model-catalog.js';
import {
  selectModel, probeSelection, credentialFingerprintOf, envKeyNamesOf as envKeysOf,
  type EffectiveModelConfig, type SelectionFailureClass,
  type SelectModelRequest,
} from '../llm/model-selection.js';
import { admitManualModel } from '../llm/model-discovery.js';
import type { TuiTone } from './tui-select.js';

// ============================================================
// IO
// ============================================================

/** 一个可选项 (结构化选择器用) */
export interface SelectorChoice {
  value: string;
  label: string;
  hint?: string;
  /** 分组标题 (同一个分组只印一次; 用于"可用 / 未配置凭据"这类分段) */
  group?: string;
  /** 颜色调子 (第二通道; 拿掉颜色也有符号在, 语义不丢) */
  tone?: TuiTone;
}

/** 选择器的输入输出口。会话内只注入 `choose` (没有文本输入与隐藏输入能力) */
export interface ModelSelectorIO {
  print(line: string): void;
  /**
   * 文本输入 (TTY 场景)。
   * **返回 `null` = 输入流结束了 (EOF / Ctrl-D / 管道读完)** —— 不是"用户输了空串"。
   * 两者必须分开: 空串 = 回车 = 取默认; `null` = 只能取消 (没有可读的输入了)。
   */
  ask?(q: string, opts?: { default?: string }): Promise<string | null>;
  /** 隐藏输入 —— **只用于 API key**; 返回 null 同 `ask` (EOF) */
  askHidden?(q: string): Promise<string | null>;
  /** 结构化选择 (回车/↑↓ 那种); 返回 null = 用户取消 */
  choose?(items: SelectorChoice[], title: string): Promise<string | null>;
  /**
   * 这个 `choose` 实现**自带实时筛选** (全屏 TUI 的 `/` 与逐字过滤)。
   * 有它时选择器**不再单独问一遍"搜索模型"** —— 同一件事问两遍就是冗余 (用户要减到必要)。
   */
  filterable?: boolean;
}

/** 走到了哪一步 (诊断/验收用) */
export type SelectorStep =
  | 'provider' | 'key' | 'model' | 'params' | 'scope' | 'test' | 'commit' | 'done';

export interface ModelSelectorResult {
  ok: boolean;
  /** 用户自己退出 (Esc/取消) —— 与"切换失败"要分开说 */
  cancelled?: boolean;
  reachedStep: SelectorStep;
  /** 本次流程打印的每一行 (界面可整段回显; 验收直接读它) */
  lines: string[];
  effective?: EffectiveModelConfig;
  failureClass?: SelectionFailureClass;
  message?: string;
  checks?: string[];
}

export interface RunModelSelectorOptions {
  sessionKey?: string;
  /** 供应商步的默认选中项 (会话内默认 = 当前生效的那家) */
  initialProvider?: string;
  /**
   * 是否做连通校验 (默认 true)。`false` 时**第 6 步预检与第 7 步切换前校验一起关**
   * —— 这是 `--no-verify` 的语义, 只给离线自测用。
   */
  verify?: boolean;
  /** 只跳过第 6 步预检, 第 7 步的切换前校验仍在 (细粒度开关) */
  skipProbe?: boolean;
  /** 第 7 步不再问一遍"确认吗" (脚本化调用用) */
  assumeYes?: boolean;
  /** 最多允许重试几次输入 (防止脚本喂进死循环) */
  maxRetries?: number;
  /**
   * 打内部细节 (目录新鲜度 / 分组计数 / 逐步事实 / 未知字段脚注)。
   * 默认 **不打**: 主屏只留必要信息 (2026-09-27 版面简化)。交互里 `?` 也能看。
   */
  verbose?: boolean;
}

// ============================================================
// 选择原语 (choose → ask → 放弃)
// ============================================================

function makeCtx(io: ModelSelectorIO, lines: string[]) {
  const push = (s: string) => { for (const l of String(s).split('\n')) { lines.push(l); io.print(l); } };

  /**
   * 把候选**逐条印出来再问** (leo 2026-09-27 硬要求)。
   *
   * 为什么单列一个函数: 曾经这里只印一句 `选择 (序号/值, 回车=1)`, 用户**无从知道 1 是谁** ——
   * 序号与选项必须一起出现, 否则提示是空承诺。序号右对齐两位, 分组标题只在切换分组时印一次,
   * 每条的 `label` 自带状态标记 (● 可用 / ○ 未配置凭据 / ← 当前), 不在这一层另编状态。
   */
  const printOptions = (items: SelectorChoice[], title: string): void => {
    push(title);
    let lastGroup: string | undefined;
    items.forEach((c, i) => {
      if (c.group && c.group !== lastGroup) { push(`  ── ${c.group}`); lastGroup = c.group; }
      push(`  ${String(i + 1).padStart(2)}) ${c.label}${c.hint ? ` — ${c.hint}` : ''}`);
    });
    push(`  [${items.length}]`);
  };

  /**
   * 让用户从候选里挑一个; 返回 null = 取消 (或输入流结束)。
   *
   * 非法的输入**要说清为什么**再重问 (序号越界 → 报范围; 字母前缀没命中 → 报实际命中数),
   * 而不是笼统一句"没对上"。**EOF (Ctrl-D)** 与"用户取消"分开: 前者印一行明确的取消理由。
   */
  const pick = async (items: SelectorChoice[], title: string): Promise<string | null> => {
    if (!items.length) return null;
    // 结构化选择器 (会话内 Ink) 自己渲染选项列表与当前光标 —— 这里不重复印一遍, 否则双份。
    if (io.choose) return await io.choose(items, title);
    if (!io.ask) return null;
    printOptions(items, title);
    for (let tries = 0; tries < 3; tries++) {
      const ans = await io.ask(CH_PICK);
      if (ans === null) { push(EOF_CANCEL); return null; }
      const raw = ans.trim();
      if (raw === '') return items[0].value;
      if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        const hit = items[n - 1];
        if (hit) return hit.value;
        push(`  ✗ 序号 ${n} 超出范围 (这里只有 1~${items.length} 项) — 重问`);
        continue;
      }
      const exact = items.find((c) => c.value === raw);
      if (exact) return exact.value;
      const lo = raw.toLowerCase();
      const pref = items.filter((c) => c.value.toLowerCase().startsWith(lo) || c.label.includes(raw));
      if (pref.length === 1) return pref[0].value;
      if (pref.length > 1) {
        push(`  ✗ '${raw}' 对上 ${pref.length} 个候选, 请给序号: ${pref.slice(0, 6).map((c) => c.value).join(', ')}${pref.length > 6 ? ' …' : ''} — 重问`);
        continue;
      }
      push(`  ✗ 没有候选的值或名字匹配 '${raw}' (可用值见上表) — 重问`);
    }
    push('  ✗ 连试 3 次都没对上 → 取消 (未改动任何配置)');
    return null;
  };

  /** 是非确认 (一律先把两个选项印出来再问) */
  const confirm = async (q: string, def = true): Promise<boolean> => {
    const opts: SelectorChoice[] = [
      { value: 'yes', label: def ? '确认 (默认)' : '确认' },
      { value: 'no', label: def ? '取消' : '取消 (默认)' },
    ];
    if (io.ask) {
      push(q);
      opts.forEach((c, i) => push(`  ${i + 1}) ${c.label}`));
      const ans = await io.ask(`${q} (y/n, 回车=${def ? 'y' : 'n'})`, { default: def ? 'y' : 'n' });
      if (ans === null) { push(EOF_CANCEL); return false; }
      const a = ans.trim().toLowerCase();
      return a === '' ? def : /^(y|yes|1|true|是|好|确认)$/.test(a);
    }
    if (io.choose) {
      const v = await io.choose(opts, q);
      return v === 'yes';
    }
    return false;
  };

  /** 文本输入 (没有该能力 → 返回 null, 由调用方决定退化行为; EOF 也返回 null) */
  const text = async (q: string, def?: string): Promise<string | null> => {
    if (!io.ask) return null;
    const ans = await io.ask(q, def !== undefined ? { default: def } : undefined);
    if (ans === null) return null;
    return ans.trim();
  };

  return { push, pick, confirm, text, printOptions };
}

/** 选择提示语 (每一步都用同一句, 方便验收按它数步骤) */
const CH_PICK = '选择 (序号/值, 回车=1)';
/** 输入流结束时的统一口径 (必须是"干净取消", 且不许写任何东西) */
const EOF_CANCEL = '· 输入已结束 (Ctrl-D / EOF) → 取消本次切换, 一个字节都没写';

// ============================================================
// 主流程
// ============================================================

/**
 * 跑一次分步选择器。**任何一步取消都不写任何东西**; 只有第 7 步会调 `selectModel()`。
 */
export async function runModelSelector(
  io: ModelSelectorIO,
  opts: RunModelSelectorOptions = {},
): Promise<ModelSelectorResult> {
  const lines: string[] = [];
  const { push, pick, confirm, text } = makeCtx(io, lines);
  const done = (r: Omit<ModelSelectorResult, 'lines'>): ModelSelectorResult => ({ ...r, lines });
  /** 细节只给想看的人: 默认主屏不放 (`--verbose` 或交互里 `d` 才出) */
  const verbose = (s: string) => { try { if (opts.verbose) push(s); } catch { /* 细节打不出不该中断主流程 */ } };

  // ── 1) 供应商 ────────────────────────────────────────────
  // 版面 (2026-09-27 简化): 主屏 = **一行标题 + 候选列表 + 一行提示**。
  //   分组计数/目录新鲜度/目录分组/三条教程行 全部退到 `--verbose` 或交互里的 `?` 帮助 ——
  //   用户不需要在主屏上读内部账本。
  let summaries: ProviderSummary[];
  try {
    summaries = await buildProviderSummaries({ sessionKey: opts.sessionKey });
  } catch (e: any) {
    return done({ ok: false, reachedStep: 'provider', message: `读供应商列表失败: ${String(e?.message || e).slice(0, 160)}` });
  }
  const live = summaries.filter((s) => s.configured);
  const unconfigured = summaries.filter((s) => !s.configured);
  push(`步骤 1/7 供应商 (${live.length} 家可用 / ${summaries.length} 家登记)`);
  verbose(`  ${providerGroupSummary(summaries)}`);
  try {
    // 动态 import: 选择器 → provider-catalog 是单向的 (目录层不 import 选择器), 不构成环;
    // 用动态是为了让"目录读盘失败"不影响选择器本身能用。
    const pc: any = await import('../llm/provider-catalog.js');
    await pc.initializeProviderCatalog();
    verbose(`  ${pc.catalogStatusLine()}`);
    verbose(`  ${pc.catalogGroupLine()}`);
    verbose('  看目录: /model catalog · 筛: /model catalog list <筛选词> · 拉最新: /model catalog refresh');
  } catch (e: any) {
    verbose(`  ⚠ 目录状态读不出来: ${String(e?.message || e).slice(0, 120)} (目录层的问题, 不影响下面的选择)`);
  }
  if (!summaries.length) return done({ ok: false, reachedStep: 'provider', message: '没有任何登记在册的供应商' });

  const ordered = [
    ...summaries.filter((s) => s.current),
    ...live.filter((s) => !s.current),
    ...unconfigured,
  ];
  const providerChoices: SelectorChoice[] = ordered.map((s) => ({
    value: s.id,
    label: formatProviderLine(s),
    hint: `${s.name}${s.providerReasoning === 'yes' ? ' · 登记支持 reasoning' : ''}${s.configuredModel ? ` · 配置里 model=${s.configuredModel}` : ''}`,
    // 分组标题只在切换分组时印一次: 当前 → 可用 → 未配置凭据 (序号是全局连续的)
    group: s.current ? '当前生效' : (s.configured ? '可用 (有凭证)' : '未配置凭据 (选了会先要 key)'),
    // 颜色只做**第二通道**: 语义本体是 label 里的符号 (●/○) 与分组标题
    tone: s.current ? 'accent' : s.configured ? 'ok' : 'dim',
  }));
  const providerId = await pick(providerChoices, '选择供应商 (序号 / 供应商 id):');
  if (!providerId) return done({ ok: false, cancelled: true, reachedStep: 'provider', message: '已取消, 未改动任何配置' });
  const summary = summaries.find((s) => s.id === providerId)!;
  push(`已选供应商: ${providerId} (${summary.name})`);

  // ── 2) 凭证 ──────────────────────────────────────────────
  // 版面: 一行状态 + **四条路** (保持现有 / 替换 / 清除 / 改用环境变量)。有 key 也**不许静默跳过** ——
  // 跳过时必须显式说"沿用现有 key (指纹 fp:xxxx)"。指纹只含长度+哈希, **不含明文**, 也不进日志。
  let pendingKey: string | undefined;
  let credentialAction: 'keep' | 'replace' | 'clear' | 'env' = 'keep';
  const fp = await credentialFingerprintOf(providerId).catch(() => undefined);
  const keyZh = summary.keyState === 'not_required' ? '免 key'
    : summary.keyState === 'missing' ? '缺 key'
      : summary.keyState === 'env' ? '来自环境变量' : '已配置';
  const envKeys = envKeysOf(providerId);
  push(`步骤 2/7 凭证 — ${providerId}: ${keyZh}${fp ? ` (指纹 ${fp})` : ''}`);
  if (summary.requiresApiKey && io.askHidden) {
    const choices: SelectorChoice[] = [];
    if (summary.keyState !== 'missing') choices.push({ value: 'keep', label: `保持现有 (${fp || '已配置'})`, hint: '一个字节都不动', tone: 'ok' });
    // 四条路的名字**在两种状态下保持一致** (只是 hint 不同): 用户/脚本答"替换"永远命中同一件事
    choices.push({ value: 'replace', label: '替换 (重新输入, 掩码)', hint: summary.keyState === 'missing' ? '现在输入一个 key' : '覆盖存盘的这一份', tone: 'accent' });
    if (summary.keyState === 'configured') choices.push({ value: 'clear', label: '清除存盘的 key', hint: '删掉配置里这一格', tone: 'warn' });
    if (envKeys.length) choices.push({ value: 'env', label: `改用环境变量 (${envKeys[0]})`, hint: '不存盘, 从环境读' });
    choices.push({ value: 'cancel', label: '取消 (什么都不改)', tone: 'dim' });
    const act = await pick(choices, `凭证怎么处理 (${choices.length} 选 1):`);
    // 未知答案一律当取消 —— 凭证这条路**只认四个明确动作**, 不猜
    const known = act === 'keep' || act === 'replace' || act === 'clear' || act === 'env';
    if (!act || !known) return done({ ok: false, cancelled: true, reachedStep: 'key', message: '已取消, 未改动任何配置' });
    if (act === 'replace') {
      const ans = await io.askHidden(`粘贴 ${providerId} API key (输入掩码显示, 不回显明文)`);
      if (ans === null) { push(EOF_CANCEL); return done({ ok: false, cancelled: true, reachedStep: 'key', message: '输入已结束 (EOF/Ctrl-D) —— 未改动任何配置' }); }
      const k = ans.trim();
      if (!k) return done({ ok: false, cancelled: true, reachedStep: 'key', message: '没有收到 key, 未改动任何配置' });
      pendingKey = k;
      // 只回显尾 4 位 —— 全文不进任何输出/日志/报告
      push(`已收到 key (****${k.slice(-4)}) — 只在第 7 步落盘, 中途取消则一个字节都不写`);
    } else {
      credentialAction = act as 'keep' | 'clear' | 'env';
      push(act === 'keep' ? `沿用现有 key (指纹 ${fp || '已配置'})`
        : act === 'clear' ? '将清除存盘的 key (改用环境变量; 没有环境变量则这一步会拦下)'
          : `改用环境变量 (${envKeys[0] || 'env'})`);
    }
  } else if (summary.requiresApiKey && summary.keyState === 'missing' && !io.askHidden) {
    // 真缺凭证**且**这个环境收不了 key → 只能明说怎么办 (不再假装能继续)
    return done({
      ok: false,
      reachedStep: 'key',
      failureClass: 'missing_api_key',
      message: `${providerId} 还没有凭证, 且当前环境不能安全地收 key —— 请在系统终端执行 \`bolloon model key ${providerId}\` (或打开 Web 配置页) 后再选。未改动任何配置。`,
    });
  } else if (summary.requiresApiKey) {
    push(`沿用现有 key (指纹 ${fp || '已配置'})`);
  }

  // ── 3) 模型 (模糊搜索 + 当前置顶) ─────────────────────────
  let entries: ModelEntry[];
  try {
    entries = await listModelsFor(providerId, { sessionKey: opts.sessionKey });
  } catch (e: any) {
    return done({ ok: false, reachedStep: 'model', message: `读模型列表失败: ${String(e?.message || e).slice(0, 160)}` });
  }
  if (!entries.length) {
    return done({
      ok: false, reachedStep: 'model',
      message: `${providerId} 没有可用模型 (无内置目录且配置为空) —— 请用 \`/model ${providerId} <model>\` 直接指定, 或先配好目录`,
    });
  }
  push(`步骤 3/7 模型 — ${providerId}, ${entries.length} 个候选`);
  for (const f of unknownFootnote(entries)) verbose(`  ${f}`);

  let candidates = entries;
  let manualModel: string | undefined;
  // 交互式 TUI 自带 `/` 实时筛选 —— 这里再问一句"搜索模型"就是同一件事问两遍 (用户要减到必要);
  // 只有纯文本问答那条路 (io.ask) 才需要先问一次搜索词。
  if (io.ask && !io.filterable && entries.length > 3) {
    const q = await text('搜索模型 (模糊, 留空 = 全部)');
    if (q === null) { push(EOF_CANCEL); return done({ ok: false, cancelled: true, reachedStep: 'model', message: '输入已结束 (EOF/Ctrl-D) —— 未改动任何配置' }); }
    if (q) {
      const hit = searchModelEntries(entries, q);
      verbose(`筛选 '${q}' → ${hit.length} 个`);
      candidates = hit;
    }
  }
  if (!candidates.length) {
    // 目录里没有匹配项也**允许手输** (实测: 目录不是可用模型的全集, 手输的名字常常真能用)
    const manual = await text(`清单里没有匹配项。直接输入 ${providerId} 的原始 model ID (留空=取消)`);
    if (manual === null) { push(EOF_CANCEL); return done({ ok: false, cancelled: true, reachedStep: 'model', message: '输入已结束 (EOF/Ctrl-D) —— 未改动任何配置' }); }
    if (!manual) return done({ ok: false, cancelled: true, reachedStep: 'model', message: '已取消, 未改动任何配置' });
    manualModel = manual;
    // 手输的模型顺手记进发现缓存 (`admitManualModel` 是唯一那处实现) —— 下次搜它就能搜到。
    try {
      const admitted = await admitManualModel(providerId, manual);
      verbose(admitted.ok ? `已记进 ${providerId} 的发现缓存 (手输)` : `· 手工模型没记进缓存: ${admitted.reason}`);
    } catch (e) { verbose(`· 手工模型没记进缓存: ${(e as Error).message}`); }
  }

  const modelId = manualModel ?? await pick(
    [
      ...candidates.map((e) => ({
        value: e.id,
        label: formatModelMenuRow(e),
        hint: e.current ? '当前生效' : undefined,
        // 上游目录里没有的名字: 只作**提示**色, 不是拒用 (实测它常真能用)
        tone: (e.upstreamSeen === false ? 'warn' : e.current ? 'accent' : 'plain') as TuiTone,
      })),
      // 清单里没有的模型也能手输 (实测目录不是全集) —— 末行固定放, 与其它步骤的"取消"行同一形态
      ...(io.ask ? [{ value: '__manual__', label: '手输一个 model ID', hint: '目录没列出的名字也能试' }] : []),
    ],
    `选择模型 (${providerId})`,
  );
  if (!modelId) return done({ ok: false, cancelled: true, reachedStep: 'model', message: '已取消, 未改动任何配置' });
  if (modelId === '__manual__') {
    const manual = await text(`输入 ${providerId} 的原始 model ID (留空=取消)`);
    if (manual === null) { push(EOF_CANCEL); return done({ ok: false, cancelled: true, reachedStep: 'model', message: '输入已结束 (EOF/Ctrl-D) —— 未改动任何配置' }); }
    if (!manual) return done({ ok: false, cancelled: true, reachedStep: 'model', message: '已取消, 未改动任何配置' });
    manualModel = manual;
    try { await admitManualModel(providerId, manual); } catch { /* 缓存记不上不影响切换 */ }
  }
  const chosenModelId = manualModel ?? modelId;
  const entry = candidates.find((e) => e.id === chosenModelId) || entries.find((e) => e.id === chosenModelId);
  // 只回显**这一条真有**的事实; 未知的一律不写 (页脚统一说, 不逐行复读)。
  //   来源一定要标出来 (live / 上游未见 / 手输) —— 用户要能看出"这个模型是从哪来的"。
  const srcTag = manualModel ? ' · 手输 (目录未列出, 探测仍真跑一次)'
    : entry?.upstreamSeen === false ? ' · 上游目录未列出 (探测仍真跑一次)'
      : entry?.upstreamSeen === true ? ` · ${entry.upstreamOrigin === 'live' ? '上游目录' : '上游目录(缓存)'}`
        : '';
  push(`已选模型: ${chosenModelId}${srcTag}`);

  // ── 4) 生成参数 (reasoning / temperature) ────────────────
  const params: { temperature?: number; reasoningMode?: boolean } = {};
  push('步骤 4/7 生成参数');
  // reasoning: 只有"登记为支持"时才提供开关; 能力未知就不给这一项 (不猜)
  if (summary.providerReasoning === 'yes') {
    const r = await pick([
      { value: 'unset', label: '不设 (沿用配置里的值)' },
      { value: 'on', label: '开 (请求推理/思考模式)' },
      { value: 'off', label: '关' },
    ], `${providerId} 登记支持 reasoning — 要不要开? (本机偏好, 不是模型能力数据)`);
    if (r === 'on') params.reasoningMode = true;
    else if (r === 'off') params.reasoningMode = false;
  } else {
    verbose(`reasoning: 该供应商的模型级能力未知 → 不提供开关, 也不写默认值`);
  }

  const temp = await pick([
    { value: 'skip', label: '不设 (沿用配置里的值)' },
    { value: '0', label: 'temperature = 0' },
    { value: '0.3', label: 'temperature = 0.3' },
    { value: '0.7', label: 'temperature = 0.7' },
    { value: '1.0', label: 'temperature = 1.0' },
    { value: '1.5', label: 'temperature = 1.5' },
    ...(io.ask ? [{ value: '__custom__', label: '手工输入 (0~2)' }] : []),
  ], 'temperature (0~2)');
  if (temp === null) return done({ ok: false, cancelled: true, reachedStep: 'params', message: '已取消, 未改动任何配置' });
  if (temp === '__custom__') {
    const raw = await text('temperature (0~2)', '0.7');
    if (raw === null) { push(EOF_CANCEL); return done({ ok: false, cancelled: true, reachedStep: 'params', message: '输入已结束 (EOF/Ctrl-D) —— 未改动任何配置' }); }
    if (raw === '') {
      push('没输入 → 本项不设');
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        return done({ ok: false, reachedStep: 'params', failureClass: 'invalid_temperature', message: `temperature 只接受 0~2 的数字, 收到 '${raw}' — 未改动任何配置` });
      }
      params.temperature = n;
    }
  } else if (temp !== 'skip') {
    params.temperature = Number(temp);
  }
  push(`temperature: ${params.temperature === undefined ? '不设' : params.temperature}`);

  // ── 5) 作用域 ────────────────────────────────────────────
  let scope: 'global' | 'session' = 'global';
  push('步骤 5/7 作用域');
  for (let round = 0; round < 2; round++) {
    const s = await pick([
      { value: 'global', label: '全局默认 (影响新会话 + 未绑定模型的任务)' },
      { value: 'session', label: '仅当前会话 (不动全局默认)' },
    ], '这次切换的作用域?');
    if (s === null) return done({ ok: false, cancelled: true, reachedStep: 'scope', message: '已取消, 未改动任何配置' });
    scope = s === 'session' ? 'session' : 'global';
    if (scope === 'session' && pendingKey) {
      push('✗ 会话级切换只做路由、不写凭证 —— 要么改成全局默认, 要么先 `bolloon model key ' + providerId + '` 再回来只切路由。');
      continue;
    }
    break;
  }
  if (scope === 'session' && pendingKey) {
    return done({
      ok: false, reachedStep: 'scope', failureClass: 'credential_scope_conflict',
      message: '会话级切换不写凭证 — 未改动任何配置 (请先配全局凭证, 再用 --session 只切路由)',
    });
  }
  push(`作用域: ${scope === 'global' ? '全局默认' : '仅当前会话'}`);

  return await commit(done, push, confirm, verbose, {
    providerId, summary, pendingKey, credentialAction, modelId: chosenModelId, baseUrl: summary.baseUrl, opts, params, scope,
  });
}

// ============================================================
// 6) 测试连接 → 7) 确认切换 (唯一写盘点)
// ============================================================

interface CommitArgs {
  providerId: string;
  summary: ProviderSummary;
  pendingKey?: string;
  /** 凭证意图 (四路之一): keep / replace / clear / env —— 由第 2 步收集, 这里只是转交给写盘点 */
  credentialAction: 'keep' | 'replace' | 'clear' | 'env';
  modelId: string;
  baseUrl: string;
  params?: { temperature?: number; reasoningMode?: boolean };
  scope?: 'global' | 'session';
  opts: RunModelSelectorOptions;
}

async function commit(
  done: (r: Omit<ModelSelectorResult, 'lines'>) => ModelSelectorResult,
  push: (s: string) => void,
  confirm: (q: string, def?: boolean) => Promise<boolean>,
  verbose: (s: string) => void,
  a: CommitArgs,
): Promise<ModelSelectorResult> {
  const params = a.params || {};
  const scope = a.scope || 'global';

  // ── 6) 测试连接 (对**候选**配置探测; 不写任何东西) ─────────
  // 版面: **失败就直接停**, 一行说清"什么错 + 怎么办" —— 不再问"还要不要继续"
  //   (那种问句按 y 也照样被第 7 步拦下, 是假选择)。
  if (a.opts.verify === false) {
    verbose('步骤 6/7 已按 --no-verify 跳过连通探测 (第 6 步预检与第 7 步切换前校验都关)');
  } else if (!a.opts.skipProbe) {
    // 预检必须用**和落盘时同一份凭证**: 本次新输入的 key 优先, 否则用该供应商已配置/环境变量里的那一份。
    //   (拿不到 key 就不带鉴权头 —— 那确实是"这个供应商现在用不了", 如实报 401, 不假装探测通过。)
    const probeKey = a.pendingKey || await resolvedApiKeyOf(a.providerId).catch(() => undefined);
    const t0 = Date.now();
    const probe = await probeSelection({ provider: a.providerId, model: a.modelId, baseUrl: a.baseUrl, apiKey: probeKey });
    const ms = Date.now() - t0;
    if (!probe.ok) {
      return done({
        ok: false, reachedStep: 'test', failureClass: probe.failureClass,
        message: `连不上/不认识这个模型 (${probe.failureClass || '未知'}): ${probe.detail} — 配置与运行时原样未动。`
          + (probe.failureClass === 'model_not_found' ? ` 换个模型, 或用 \`bolloon model ${a.providerId} <model>\` 直接指定。` : ''),
      });
    }
    push(`步骤 6/7 连通测试通过 (${a.modelId} @ ${a.baseUrl}, ${ms} ms)`
      + (probe.modelAcceptedOutsideCatalog ? ' — 上游目录未列出, 但端点接受' : ''));
    // 第 7 步的"确认"必须先把**要提交的东西**印出来 —— 否则用户是在确认一份看不见的配置。
    //   版面压到最少: 供应商/模型/作用域/参数 (探测结论上一步已说, 不重复; 基址只在 verbose)。
    push('步骤 7/7 确认');
    push(`  ${a.providerId} / ${a.modelId} · ${scope === 'global' ? '全局默认' : '仅当前会话'}`);
    if (params.temperature !== undefined || params.reasoningMode !== undefined) {
      push(`  参数: ${params.temperature === undefined ? '' : `temperature=${params.temperature}`}`
        + `${params.reasoningMode === undefined ? '' : `${params.temperature === undefined ? '' : ' · '}reasoning=${params.reasoningMode ? '开' : '关'}`}`);
    }
    verbose(`  基址: ${a.baseUrl}`);
    verbose(`  凭证: ${a.pendingKey ? '本次新输入的 key (掩码输入, 落盘为全局凭证)' : '沿用已配置 / 环境变量里的那一份'}`);
    const proceed = a.opts.assumeYes ? true : await confirm('确认按上面的配置切换?', true);
    if (!proceed) return done({ ok: false, cancelled: true, reachedStep: 'test', message: '已取消, 未改动任何配置' });
  } else {
    verbose('步骤 6/7 已跳过预检 (skipProbe) —— 第 7 步的切换前校验仍在');
  }

  // ── 7) 唯一写盘点 ───────────────────────────────────────
  const req: SelectModelRequest = {
    provider: a.providerId,
    model: a.modelId,
    baseUrl: a.baseUrl,
    scope,
    ...(a.pendingKey ? { apiKey: a.pendingKey } : {}),
    ...(a.credentialAction !== 'keep' ? { credentialAction: a.credentialAction } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.reasoningMode !== undefined ? { reasoningMode: params.reasoningMode } : {}),
    ...(a.opts.sessionKey ? { sessionKey: a.opts.sessionKey } : {}),
    ...(a.opts.verify === false ? { verify: false } : {}),
  };
  verbose('交给统一入口 selectModel() (写配置 + 更新作用域 + 重建运行时 + 更新会话)');
  const r = await selectModel(req);
  // 逐项 ✓/✗ 事实默认**不刷屏** (成功一行, 失败一行); 想看细节走 `--verbose`。
  for (const c of r.checks || []) verbose(`  ${c}`);
  if (!r.ok) {
    return done({
      ok: false, reachedStep: 'commit', failureClass: r.failureClass,
      message: `${r.message || '切换失败'} — 配置与运行时保持原样`,
      checks: r.checks,
    });
  }
  push(`✓ 已切到 ${r.effective?.provider || a.providerId}/${r.effective?.model || a.modelId}`
    + `${r.effective?.configHash ? ` (hash ${String(r.effective.configHash).slice(0, 12)})` : ''}`
    + ` · ${scope === 'global' ? '全局默认' : '仅当前会话'}`);
  return done({ ok: true, reachedStep: 'done', effective: r.effective, checks: r.checks });
}
