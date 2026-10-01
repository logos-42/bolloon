/**
 * 工具集合的"注入降噪" (2026-10-01, 优化 #2 v2)。
 *
 * 背景: 125 个工具一次性列出 ⇒ **选择过载**(实测两次错工具: terminal 拿去造文件 ✗ / list_files 当搜索 ✗)。
 * 但注意两个约束(实测过):
 *   ① 清单**本来就是紧凑的**(只列 `name(params)`, 不列描述) ⇒ 省上下文的价值有限, 主要价值在**选得准**;
 *   ② 这份清单**被缓存**(每轮重建会顶大 prompt, 还有踩 max_tokens 的历史教训) ⇒ 默认**不做**每轮动态子集。
 * 因此两档:
 *   · 默认档: **分组列 + 末尾一句"未列出的工具也能直接按名字调用"** ⇒ 不丢能力, 且不破坏缓存;
 *   · 开关档 (`BOLLOON_TOOL_SUBSET=on`): 按 intent 只列相关桶 + 永远带 `list_tools` ⇒ 最省认知。
 * 纪律: **执行/校验永远用完整注册表** ⇒ 子集只影响"列给模型看的那份", 不影响能不能调 ✓。
 */

/** 分类: 名字 → 桶 (机械规则, 不猜) */
export function bucketOf(name: string): string {
  const n = name.toLowerCase();
  // 注意顺序: `list_tools` 会被 ^list 抢成"读/找文件" ⇒ 元工具先判 (2026-10-01 门抓到)
  if (/^(get_identity|set_persona|persona|identity|list_tools|bolloon_config)/.test(n)) return '身份/元';
  if (/wallet|chain|token|balance|^tx|polymarket|safe_|x402|erc20|escrow|treasury/.test(n)) return '链上/钱包';
  if (/^(read|list|glob|grep|search|find)/.test(n) || /file|dir|document|doc$/.test(n)) return '读/找文件';
  if (/^(write|edit|mkdir|move|delete|copy|patch|truncate)/.test(n)) return '写/改文件';
  if (/task|plan|todo|goal|^run|queue|operation_log/.test(n)) return '任务/计划';
  if (/peer|channel|friend|send|broadcast|group|inbox|p2p|contact|message/.test(n)) return 'P2P/沟通';
  if (/web|fetch|http|url|search_web/.test(n)) return '网络';
  if (/agent|delegate|registry|spawn|call_/.test(n)) return '智能体';
  return '其它';
}

/** 核心桶: 任何任务都可能用到 ⇒ 默认档全部展开 */
export const CORE_BUCKETS = ['读/找文件', '写/改文件', '任务/计划', '身份/元'];

/** intent 关键词 → 额外展开的桶 */
const INTENT_BUCKETS: Array<[RegExp, string]> = [
  [/钱包|链上|转账|余额|代币|合约|多签|gas|wallet|token|chain|tx/i, '链上/钱包'],
  [/群|频道|好友|发消息|广播|节点|点对点|channel|group|friend|peer|p2p|broadcast/i, 'P2P/沟通'],
  [/网页|抓取|搜索|下载|链接|url|web|fetch|http/i, '网络'],
  [/智能体|子智能体|委派|agent|delegate/i, '智能体'],
];

export interface SubsetOptions {
  /** 是否走"按需子集"档 (默认 false = 分组全列 + 能力提示) */
  subset?: boolean;
  /** 每个桶最多列几个 (默认 14; 只影响展示, 不影响可调) */
  perBucket?: number;
}

export interface SubsetResult {
  text: string;
  shown: number;
  total: number;
}

/**
 * 生成"工具清单"文本。**只影响列出来的那份**; 调用方必须保证执行侧仍用完整注册表。
 */
export function renderToolList(allNames: string[], intentText = '', opts: SubsetOptions = {}): SubsetResult {
  const total = allNames.length;
  const byBucket = new Map<string, string[]>();
  for (const n of allNames) {
    const b = bucketOf(n);
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b)!.push(n);
  }
  const per = Math.max(1, opts.perBucket ?? 14);

  // 哪些桶要"展开列出", 哪些只给名字(折叠)
  const expanded = new Set<string>();
  if (!opts.subset) {
    for (const b of byBucket.keys()) expanded.add(b);
  } else {
    for (const b of CORE_BUCKETS) expanded.add(b);
    for (const [re, b] of INTENT_BUCKETS) if (re.test(intentText)) expanded.add(b);
  }

  const lines: string[] = [];
  let shown = 0;
  const foldedBuckets: string[] = [];
  for (const [b, names] of byBucket) {
    if (!expanded.has(b)) { foldedBuckets.push(`${b}(${names.length})`); continue; }
    const head = names.slice(0, per).sort();
    shown += head.length;
    const rest = names.length - head.length;
    lines.push(`【${b}】${head.join(' ')}${rest > 0 ? ` …还有${rest}个` : ''}`);
  }
  const folded = foldedBuckets.length ? `未列出的分类: ${foldedBuckets.join(' ')}` : '';
  const footer = [
    '**没找到合适的工具 ⇒ 用 `list_tools {keyword:"…"}` 查**; 未列出的工具也**可以直接按名字调用**(名字对了就能跑)。',
    folded,
  ].filter(Boolean).join('\n');
  return { text: [lines.join('\n'), footer].filter(Boolean).join('\n'), shown, total };
}

/**
 * 带参数名的完整清单 (= `getToolDefinitions` 真正注入的那份)。
 * 单独抽出来是为了**可测**: 之前这个拼装写在 pi-sdk 里(私有方法 ✗ 测不到), 于是"渲染得对不对"只能靠眼看。
 */
export function renderToolListWithParams(
  tools: Array<{ name: string; parameters?: Record<string, unknown> }>,
  intentText = '',
  opts: SubsetOptions = {},
): { text: string; shown: number; total: number } {
  const paramOf = new Map(tools.map((t) => [t.name, Object.keys(t.parameters || {}).join(',')]));
  const grouped = renderToolList(tools.map((t) => t.name), intentText, opts);
  const body = grouped.text.split('\n').map((line) => {
    if (!line.startsWith('【')) return line;
    const m = /^【([^】]+)】(.*)$/.exec(line);
    if (!m) return line;
    const [, bucket, rest] = m;
    const more = rest.includes('…') ? rest.slice(rest.indexOf('…')) : '';
    const names = rest.replace(/….*$/, '').trim().split(/\s+/).filter(Boolean);
    return `【${bucket}】` + names.map((n) => `${n}(${paramOf.get(n) ?? ''})`).join(' ') + (more ? ` ${more}` : '');
  }).join('\n');
  return { text: body, shown: grouped.shown, total: grouped.total };
}
