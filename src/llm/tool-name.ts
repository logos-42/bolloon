/**
 * tool-name.ts — 工具名「出网前的唯一净化边界」(2026-09-26)
 *
 * 为什么要这个文件:
 *   OpenAI 兼容 API 对 `tools[i].function.name` 有硬约束 —— 必须匹配
 *   `^[a-zA-Z0-9_-]{1,64}$`. 只要**第 121 个**工具的名字里有一个非法字符 (`.` `:` `/`
 *   空格 / 中文 ...), 整个请求就被 400 拒掉:
 *
 *     Invalid 'tools[120].function.name': string does not match pattern.
 *     Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.
 *
 *   表现是「网页端明明配好了 API, 一跑就失败」—— 根因在**发包形状**, 不在凭据。
 *   本仓曾注册 6 个带点的工具名 (`contact.list_authorized` 一族), 命中这个坑。
 *
 * 设计铁律:
 *   1. **唯一边界**: 净化只在 `pi-ai.ts` 的 `generateText()` 里做一次 (那里是全仓唯一
 *      产出 wire 形状 tools 数组的地方). 业务代码一个都不许自己做净化 —— 否则同一次改动
 *      要有 N 个调用点跟着改, 迟早漏一个.
 *   2. **确定性, 不是随机**: 非法字符 → `_`; 超长 → 前 55 字符 + `_` + 原名 sha256 前 8 位
 *      (同一次运行里同一原名永远得到同一个 API 名).
 *   3. **派发不断**: 净化时把 `原名 → API 名` 同时反向登记 (原名 ↔ API 名双射), 回程
 *      (`resolveApiToolName`) 把 LLM 回吐的 API 名还原成原名, 再交给 `this.tools.get()`.
 *      LLM 也可能照 system prompt 里的原名回吐 —— 原名在表里就直接穿透.
 *   4. **碰撞不许静默**: 两个**不同**原名净化后同名 → 抛 `ToolNameCollisionError`, 消息里
 *      把两个原名都点名. 绝不悄悄合并或悄悄改名 (那会让 LLM 调到的工具和它以为的不是一个).
 *   5. **不猜**: 没有名字 / 空名字的工具也是非法形状 → 抛错点名, 不静默丢掉.
 *
 * 真正「覆盖所有入口」的依据: CLI / Web / MCP / 技能 / 子 Agent / 长期任务全都走
 * `getMinimax().chat(..., tools)` → `PiAIModel.generateText()` → `callOpenAI()`,
 * 全仓只有这一条产出 tools 的路径 (见 `scripts/verify-tool-names.ts` 的源码级断言).
 */

import * as crypto from 'crypto';

/** OpenAI 兼容 API 对 function.name 的硬约束 */
export const TOOL_NAME_MAX_LENGTH = 64;

/** 允许的字符集: 字母 / 数字 / 下划线 / 连字符 */
export const TOOL_NAME_CHAR_CLASS = 'a-zA-Z0-9_-';

/** 完整形状约束 (1..64, 只含安全字符) */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** 太长时的截断长度: 55 + '_' + 8 位 hash = 64, 正好贴着上限 */
const TRUNCATE_KEEP = 55;

/** 严格形状校验 (不做任何修补) */
export function isValidToolName(name: string): boolean {
  return typeof name === 'string' && TOOL_NAME_PATTERN.test(name);
}

/** 名字里的非法字符 (去重, 按出现顺序) —— 给探针/门报「违规字符是什么」用 */
export function illegalCharsOf(name: string): string[] {
  const out: string[] = [];
  for (const ch of String(name ?? '')) {
    if (!/[a-zA-Z0-9_-]/.test(ch) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

/** 原名指纹 (sha256 前 8 位 hex) —— 超长截断的去碰撞后缀 */
export function toolNameFingerprint(name: string): string {
  return crypto.createHash('sha256').update(String(name), 'utf8').digest('hex').slice(0, 8);
}

/**
 * 纯函数净化: 非法字符 → `_`; 超长 → 截断 + 稳定 hash 后缀.
 * 已经是合法名的原样返回 (幂等, 再跑一次不变).
 */
export function sanitizeToolName(name: string): string {
  const raw = String(name ?? '');
  let s = raw.replace(new RegExp(`[^${TOOL_NAME_CHAR_CLASS}]`, 'g'), '_');
  if (s.length > TOOL_NAME_MAX_LENGTH) {
    s = `${s.slice(0, TRUNCATE_KEEP)}_${toolNameFingerprint(raw)}`;
  }
  // 空名 / 全非法字符且被清空 (理论上不会, 上面都是替换成 '_') —— 兜底成可派发的稳定名
  if (s.length === 0) s = `tool_${toolNameFingerprint(raw)}`;
  return s;
}

/** 两个不同原名净化后撞名 —— 点名两方, 拒绝发包 */
export class ToolNameCollisionError extends Error {
  readonly apiName: string;
  readonly names: string[];

  constructor(apiName: string, names: string[]) {
    super(
      `工具名净化后撞名: ${names.map((n) => `"${n}"`).join(' 与 ')} 都会净化为 "${apiName}" —— ` +
        `拒绝发包 (两个不同工具共用一个 API 名会让 LLM 调到的实现不可知). ` +
        `请给其中一个改名, 只剩安全字符 [${TOOL_NAME_CHAR_CLASS}] 且 ≤64 字符.`
    );
    this.name = 'ToolNameCollisionError';
    this.apiName = apiName;
    this.names = names;
  }
}

export interface ToolNameMapping {
  /** 业务侧 / 注册表里的真名 */
  original: string;
  /** 真正写到 wire 上的名字 */
  api: string;
  /** 是否被改写过 */
  changed: boolean;
}

/**
 * 原名 ↔ API 名 双射表.
 *   正向: 出网时把原名登记进来拿 API 名 (碰撞 → 抛错, 不静默).
 *   反向: 回程把 LLM 回吐的 API 名还原成原名 (未知名原样穿透, 由业务侧报「未知工具」).
 */
export class ToolNameRouteTable {
  private readonly byApi = new Map<string, string>();
  private readonly byOriginal = new Map<string, string>();

  /** 登记一个原名, 返回它的 API 名. 撞名 → ToolNameCollisionError. */
  register(original: string): string {
    const orig = String(original ?? '');
    if (isValidToolName(orig)) {
      // 合法名不动: 但也要防「另一个原名净化成它」的撞名 (下面 byApi 会处理)
      const api = orig;
      const holder = this.byApi.get(api);
      if (holder !== undefined && holder !== orig) {
        throw new ToolNameCollisionError(api, [holder, orig]);
      }
      this.byApi.set(api, orig);
      this.byOriginal.set(orig, api);
      return api;
    }
    const api = sanitizeToolName(orig);
    const holder = this.byApi.get(api);
    if (holder !== undefined && holder !== orig) {
      throw new ToolNameCollisionError(api, [holder, orig]);
    }
    this.byApi.set(api, orig);
    this.byOriginal.set(orig, api);
    return api;
  }

  /** 批量登记 */
  registerAll(originals: string[]): string[] {
    return originals.map((n) => this.register(n));
  }

  /** 原名 → API 名 (没登记过就现算, 不登记 —— 给纯查询用) */
  apiNameOf(original: string): string {
    const known = this.byOriginal.get(String(original ?? ''));
    if (known !== undefined) return known;
    return isValidToolName(original) ? original : sanitizeToolName(original);
  }

  /**
   * API 名 → 原名 (回程派发用).
   * 不在表里 (LLM 照 system prompt 里的原名回吐 / 编了个名字) → 原样返回,
   * 交给业务侧 `tools.get()` 走「未知工具」分支 — 不在这里吞掉.
   */
  resolveToOriginal(apiName: string): string {
    const hit = this.byApi.get(String(apiName ?? ''));
    return hit !== undefined ? hit : String(apiName ?? '');
  }

  /** 是否知道这个 API 名 */
  knows(apiName: string): boolean {
    return this.byApi.has(String(apiName ?? ''));
  }

  /** 全部映射 (原名 → API 名), 按登记顺序 */
  get mappings(): ToolNameMapping[] {
    const seen = new Set<string>();
    const out: ToolNameMapping[] = [];
    for (const [api, original] of this.byApi.entries()) {
      if (seen.has(original)) continue;
      seen.add(original);
      out.push({ original, api, changed: original !== api });
    }
    return out;
  }

  /** 被改写过的部分 (改名清单) */
  get changed(): ToolNameMapping[] {
    return this.mappings.filter((m) => m.changed);
  }

  /** 表里已知的原名个数 */
  get size(): number {
    return this.byApi.size;
  }

  /** 清空 (测试用; 业务路径不该调) */
  clear(): void {
    this.byApi.clear();
    this.byOriginal.clear();
  }
}

/**
 * 进程级单例: 出网净化与回程派发共用同一张表.
 * (出网在 pi-ai.ts, 派发在 pi-sdk.ts / workflow-pivot-loop.ts —— 只有共享一份才保证还原得到真名)
 */
export const globalToolNameRoutes = new ToolNameRouteTable();

interface WireToolLike {
  type?: string;
  function?: { name?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * **唯一**的出网净化入口: 把 wire 形状的 tools 数组里的 `function.name` 逐个净化,
 * 顺便把映射登记进 `globalToolNameRoutes` 供回程派发还原.
 *
 * - 不改入参 (返回新数组 / 新对象), 调用方拿去发包即可;
 * - 没名字 / 空名字 → 抛错 (说不出名字的工具本来就是坏形状, 不许静默丢);
 * - 撞名 → ToolNameCollisionError (点名两个原名).
 */
export function sanitizeToolsForApi<T = WireToolLike>(tools: T[], table: ToolNameRouteTable = globalToolNameRoutes): T[] {
  if (!Array.isArray(tools)) return tools;
  const out: T[] = new Array(tools.length);
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i] as any;
    const original = tool?.function?.name;
    if (typeof original !== 'string' || original.length === 0) {
      throw new Error(
        `工具 #${i} 没有可用的 function.name (拿到 ${JSON.stringify(original)}) —— 拒绝发包: ` +
          `OpenAI 兼容 API 要求每个工具都有 name 且匹配 /^[a-zA-Z0-9_-]{1,64}$/`
      );
    }
    const api = table.register(original);
    out[i] = api === original ? tool : ({ ...tool, function: { ...tool.function, name: api } } as T);
  }
  return out;
}

/** 回程: LLM 回吐的名字 → 注册表真名 (未知名原样穿透) */
export function resolveApiToolName(apiName: string, table: ToolNameRouteTable = globalToolNameRoutes): string {
  return table.resolveToOriginal(apiName);
}

/**
 * 给「文本解析」路径用的已知名集合: 原名 + 它们的 API 名.
 * LLM 在文本里回吐的可能是净化后的名字 (prompt/工具面里给的是 API 名),
 * 只用原名集合过滤会把这类调用直接丢掉.
 */
export function expandKnownToolNames(names: Iterable<string>, table: ToolNameRouteTable = globalToolNameRoutes): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    out.add(n);
    const api = table.apiNameOf(n);
    out.add(api);
    // 预登记, 保证回程还原得到
    try {
      table.register(n);
    } catch {
      // 撞名: 交给出网时的 sanitizeToolsForApi 抛 (那里能给出「拒绝发包」的上下文)
    }
  }
  return out;
}
