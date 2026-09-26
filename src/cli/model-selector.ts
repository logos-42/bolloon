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
  buildProviderSummaries, listModelsFor, formatProviderLine, formatModelLine,
  unknownFootnote, searchModelEntries, capabilityZh, resolvedApiKeyOf,
  type ModelEntry, type ProviderSummary,
} from '../llm/model-catalog.js';
import {
  selectModel, probeSelection,
  type EffectiveModelConfig, type SelectionFailureClass,
  type SelectModelRequest,
} from '../llm/model-selection.js';
import { admitManualModel } from '../llm/model-discovery.js';

// ============================================================
// IO
// ============================================================

/** 一个可选项 (结构化选择器用) */
export interface SelectorChoice {
  value: string;
  label: string;
  hint?: string;
}

/** 选择器的输入输出口。会话内只注入 `choose` (没有文本输入与隐藏输入能力) */
export interface ModelSelectorIO {
  print(line: string): void;
  /** 文本输入 (TTY 场景) */
  ask?(q: string, opts?: { default?: string }): Promise<string>;
  /** 隐藏输入 —— **只用于 API key** */
  askHidden?(q: string): Promise<string>;
  /** 结构化选择 (回车/↑↓ 那种); 返回 null = 用户取消 */
  choose?(items: SelectorChoice[], title: string): Promise<string | null>;
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
}

// ============================================================
// 选择原语 (choose → ask → 放弃)
// ============================================================

function makeCtx(io: ModelSelectorIO, lines: string[]) {
  const push = (s: string) => { for (const l of String(s).split('\n')) { lines.push(l); io.print(l); } };

  /** 让用户从候选里挑一个; 返回 null = 取消 */
  const pick = async (items: SelectorChoice[], title: string): Promise<string | null> => {
    if (!items.length) return null;
    if (io.choose) return await io.choose(items, title);
    if (!io.ask) return null;
    push(title);
    items.forEach((c, i) => push(`  ${String(i + 1).padStart(2)}) ${c.label}${c.hint ? ` — ${c.hint}` : ''}`));
    for (let tries = 0; tries < 3; tries++) {
      const raw = String(await io.ask('选择 (序号/值, 回车=1)') ?? '').trim();
      if (raw === '') return items[0].value;
      if (/^\d+$/.test(raw)) {
        const hit = items[Number(raw) - 1];
        if (hit) return hit.value;
      }
      const exact = items.find((c) => c.value === raw);
      if (exact) return exact.value;
      const lo = raw.toLowerCase();
      const pref = items.filter((c) => c.value.toLowerCase().startsWith(lo) || c.label.includes(raw));
      if (pref.length === 1) return pref[0].value;
      push(`  ✗ 没对上 (${pref.length} 个候选), 再来一次`);
    }
    return null;
  };

  /** 是非确认 */
  const confirm = async (q: string, def = true): Promise<boolean> => {
    if (io.ask) {
      const a = String(await io.ask(`${q} (y/n)`, { default: def ? 'y' : 'n' })).trim().toLowerCase();
      return a === '' ? def : /^(y|yes|1|true|是|好|确认)$/.test(a);
    }
    if (io.choose) {
      const v = await io.choose(
        [{ value: 'yes', label: '确认' }, { value: 'no', label: '取消' }],
        q,
      );
      return v === 'yes';
    }
    return false;
  };

  /** 文本输入 (没有该能力 → 返回 null, 由调用方决定退化行为) */
  const text = async (q: string, def?: string): Promise<string | null> => {
    if (!io.ask) return null;
    return String(await io.ask(q, def !== undefined ? { default: def } : undefined) ?? '').trim();
  };

  return { push, pick, confirm, text };
}

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

  push('模型选择 (分步): 供应商 → 凭证 → 模型 → 生成参数 → 作用域 → 测试 → 确认');

  // ── 1) 供应商 ────────────────────────────────────────────
  let summaries: ProviderSummary[];
  try {
    summaries = await buildProviderSummaries({ sessionKey: opts.sessionKey });
  } catch (e: any) {
    return done({ ok: false, reachedStep: 'provider', message: `读供应商列表失败: ${String(e?.message || e).slice(0, 160)}` });
  }
  const live = summaries.filter((s) => s.configured);
  const unconfigured = summaries.filter((s) => !s.configured);
  push(`供应商 (${live.length} 家可用 / ${summaries.length} 家登记):`);
  for (const s of live) push(`  ${formatProviderLine(s)}`);
  for (const s of unconfigured) push(`  ${formatProviderLine(s)}`);
  if (!summaries.length) return done({ ok: false, reachedStep: 'provider', message: '没有任何登记在册的供应商' });

  const providerChoices: SelectorChoice[] = [
    ...summaries.filter((s) => s.current),
    ...live.filter((s) => !s.current),
    ...unconfigured,
  ].map((s) => ({
    value: s.id,
    label: formatProviderLine(s),
    hint: `${s.name}${s.providerReasoning === 'yes' ? ' · 登记支持 reasoning' : ''}${s.configuredModel ? ` · 配置里 model=${s.configuredModel}` : ''}`,
  }));
  const providerId = await pick(providerChoices, '选择供应商');
  if (!providerId) return done({ ok: false, cancelled: true, reachedStep: 'provider', message: '已取消, 未改动任何配置' });
  const summary = summaries.find((s) => s.id === providerId)!;
  push(`已选供应商: ${providerId} (${summary.name})`);

  // ── 2) 凭证 ──────────────────────────────────────────────
  let pendingKey: string | undefined;
  if (summary.requiresApiKey && summary.keyState === 'missing') {
    if (!io.askHidden) {
      return done({
        ok: false,
        reachedStep: 'key',
        failureClass: 'missing_api_key',
        message: `${providerId} 还没有凭证, 且当前环境不能安全地收 key —— 请在系统终端执行 \`bolloon model key ${providerId}\` (或打开 Web 配置页) 后再选。未改动任何配置。`,
      });
    }
    const k = String(await io.askHidden(`粘贴 ${providerId} API key (输入不回显)`) ?? '').trim();
    if (!k) return done({ ok: false, cancelled: true, reachedStep: 'key', message: '没有收到 key, 未改动任何配置' });
    pendingKey = k;
    // 只回显尾 4 位 —— 全文不进任何输出/日志/报告
    push(`已收到 key (尾号 ****${k.slice(-4)}) — 只在本次切换的最后一步落盘, 中途取消则一个字节都不写`);
  } else if (summary.keyState === 'env') {
    push(`凭证来自环境变量 (authRef=env), 不需要手输`);
  } else {
    push(`凭证来源: ${summary.keyState === 'not_required' ? '该供应商免 key' : '已配置'}`);
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
  push(`模型 (${providerId}, ${entries.length} 个候选${summary.modelCountOrigin === 'unavailable' ? ' · 无内置目录, 只列配置里和当前生效的那个' : ' · 内置目录'}):`);
  for (const e of entries) push(`  ${formatModelLine(e)}`);
  for (const f of unknownFootnote(entries)) push(`  ${f}`);

  let candidates = entries;
  let manualModel: string | undefined;
  if (io.ask && entries.length > 3) {
    const q = await text('搜索模型 (模糊, 留空 = 全部)');
    if (q === null) return done({ ok: false, cancelled: true, reachedStep: 'model', message: '已取消, 未改动任何配置' });
    if (q) {
      const hit = searchModelEntries(entries, q);
      push(`搜索 '${q}' → ${hit.length} 个命中`);
      for (const e of hit) push(`  ${formatModelLine(e)}`);
      candidates = hit;
      if (!hit.length) {
        // 自定义模型允许手动输入 (目录里没有不等于不能用) —— 但要说清"未在目录里"
        const manual = await text(`目录里没有匹配项。直接输入 ${providerId} 的原始 model ID (留空=取消)`);
        if (!manual) return done({ ok: false, cancelled: true, reachedStep: 'model', message: '已取消, 未改动任何配置' });
        manualModel = manual;
        push(`使用手工输入的 model ID: ${manual} (不在目录里, 元数据一律按未知处理; 切换前的探测仍会真跑一次)`);
        // 手输的模型顺手记进发现缓存 (`admitManualModel` 是唯一那处实现) —— 下次搜它就能搜到。
        // 记不上不影响这次切换 (缓存是次要的, 切换才是主要动作), 所以失败只提一句。
        try {
          const admitted = await admitManualModel(providerId, manual);
          push(admitted.ok
            ? `已记进 ${providerId} 的发现缓存 (手输), 下次可直接搜到`
            : `· 手工模型没记进缓存: ${admitted.reason} (不影响这次切换)`);
        } catch (e) {
          push(`· 手工模型没记进缓存: ${(e as Error).message} (不影响这次切换)`);
        }
      }
    }
  }

  const modelId = manualModel ?? await pick(
    candidates.map((e) => ({ value: e.id, label: formatModelLine(e), hint: e.current ? '当前生效' : e.origin })),
    '选择模型',
  );
  if (!modelId) return done({ ok: false, cancelled: true, reachedStep: 'model', message: '已取消, 未改动任何配置' });
  const entry = candidates.find((e) => e.id === modelId) || entries.find((e) => e.id === modelId);
  push(`已选模型: ${modelId}${entry ? ` (工具调用=${capabilityZh(entry.toolCalling)}, reasoning=${capabilityZh(entry.reasoning)}, 上下文=${entry.contextLength === null ? '未知' : entry.contextLength})` : ''}`);

  // ── 4) 生成参数 (reasoning / temperature) ────────────────
  const params: { temperature?: number; reasoningMode?: boolean } = {};
  // reasoning: 只有"登记为支持"时才提供开关; 能力未知就不给这一项 (不猜)
  if (summary.providerReasoning === 'yes') {
    const r = await pick([
      { value: 'unset', label: '不设 (沿用配置里的值)' },
      { value: 'on', label: '开 (请求推理/思考模式)' },
      { value: 'off', label: '关' },
    ], `${providerId} 登记支持 reasoning — 要不要开? (这是本机偏好, 不是模型能力数据)`);
    if (r === 'on') params.reasoningMode = true;
    else if (r === 'off') params.reasoningMode = false;
    push(`reasoning 偏好: ${params.reasoningMode === undefined ? '不设' : params.reasoningMode ? '开' : '关'}`);
  } else {
    push(`reasoning: 该供应商的模型级能力**未知** (内置目录只有模型 ID) → 本步不提供开关, 也不写默认值`);
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
    if (raw === null || raw === '') {
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
  for (let round = 0; round < 2; round++) {
    const s = await pick([
      { value: 'global', label: '全局默认 (影响新会话 + 未绑定模型的任务)' },
      { value: 'session', label: '仅当前会话 (不动全局默认)' },
    ], '这次切换的作用域?');
    if (s === null) return done({ ok: false, cancelled: true, reachedStep: 'scope', message: '已取消, 未改动任何配置' });
    scope = s === 'session' ? 'session' : 'global';
    if (scope === 'session' && pendingKey) {
      push('✗ 这次带了新 key: 凭证是**全局**概念, 会话级切换只做路由、不写凭证 (credential_scope_conflict)。');
      push('  要么改成全局默认, 要么先 `bolloon model key ' + providerId + '` 配好凭证再回来只切路由。');
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

  return await commit(done, push, confirm, {
    providerId, summary, pendingKey, modelId, baseUrl: summary.baseUrl, opts, params, scope,
  });
}

// ============================================================
// 6) 测试连接 → 7) 确认切换 (唯一写盘点)
// ============================================================

interface CommitArgs {
  providerId: string;
  summary: ProviderSummary;
  pendingKey?: string;
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
  a: CommitArgs,
): Promise<ModelSelectorResult> {
  const params = a.params || {};
  const scope = a.scope || 'global';

  // ── 6) 测试连接 (对**候选**配置探测; 不写任何东西) ─────────
  if (a.opts.verify === false) {
    push('已按 --no-verify 跳过连通探测 (第 6 步预检与第 7 步切换前校验都关) —— 离线自测用');
  } else if (!a.opts.skipProbe) {
    // 预检必须用**和落盘时同一份凭证**: 本次新输入的 key 优先, 否则用该供应商已配置/环境变量里的那一份。
    //   (拿不到 key 就不带鉴权头 —— 那确实是"这个供应商现在用不了", 如实报 401, 不假装探测通过。)
    const probeKey = a.pendingKey || await resolvedApiKeyOf(a.providerId).catch(() => undefined);
    const t0 = Date.now();
    const probe = await probeSelection({ provider: a.providerId, model: a.modelId, baseUrl: a.baseUrl, apiKey: probeKey });
    const ms = Date.now() - t0;
    push(`测试连接 (${a.providerId}/${a.modelId} @ ${a.baseUrl}): ${probe.ok ? '✅ 通过' : '✗ 失败'} — ${probe.detail} (${ms} ms)`);
    if (!probe.ok) push(`失败分类: ${probe.failureClass || '未知'} — 第 6 步只是预检; 继续也不会跳过第 7 步切换前的校验。`);
    const proceed = a.opts.assumeYes
      ? true
      : await confirm(probe.ok ? '探测通过, 确认按上面的配置切换?' : '探测没通过, 还要继续尝试切换吗? (不推荐)', probe.ok);
    if (!proceed) {
      return done(probe.ok
        ? { ok: false, cancelled: true, reachedStep: 'test', message: '已取消, 未改动任何配置' }
        : {
          ok: false, reachedStep: 'test', failureClass: probe.failureClass,
          message: `连通测试未通过, 已放弃切换 (配置与运行时原样未动): ${probe.detail}`,
        });
    }
  } else {
    push('已跳过第 6 步预检 (skipProbe) —— 第 7 步的切换前校验仍在');
  }

  // ── 7) 唯一写盘点 ───────────────────────────────────────
  const req: SelectModelRequest = {
    provider: a.providerId,
    model: a.modelId,
    baseUrl: a.baseUrl,
    scope,
    ...(a.pendingKey ? { apiKey: a.pendingKey } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.reasoningMode !== undefined ? { reasoningMode: params.reasoningMode } : {}),
    ...(a.opts.sessionKey ? { sessionKey: a.opts.sessionKey } : {}),
    ...(a.opts.verify === false ? { verify: false } : {}),
  };
  push('交给统一入口 selectModel() (它负责写配置 + 更新作用域 + 重建运行时 + 更新会话)');
  const r = await selectModel(req);
  for (const c of r.checks || []) push(`  ${c}`);
  if (!r.ok) {
    return done({
      ok: false, reachedStep: 'commit', failureClass: r.failureClass,
      message: r.message || '切换失败', checks: r.checks,
    });
  }
  push(`✅ 已切换 — ${scope === 'global' ? '全局默认 (新会话生效)' : '仅当前会话'}`);
  return done({ ok: true, reachedStep: 'done', effective: r.effective, checks: r.checks });
}
