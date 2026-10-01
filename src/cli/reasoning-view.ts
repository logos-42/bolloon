/**
 * 思考记录的可视化 (2026-10-01, 用户: 「bolloon 智能体思考的记录可以也显示出来吗」)。
 *
 * 现状: 模型那边**是有**思考内容的 (deepseek 思考模式: `reasoning_content`, 非流式攒在
 *   `ChatResult.reasoningContent`, 流式在 delta 里累), 但只被用来回带(wire 协议要求), **没显示** ✗。
 * 规矩: 显示但要**可控** —— 默认开(用户要的), 能一键关(BOLLOON_SHOW_THINKING=0), 且有界(字符/行数封顶,
 *   免得思考本身把屏幕和上下文吃爆)。显示形态是**暗色块**并标明"思考(未验证)", 与正式回答区分开。
 */
export const REASONING_MAX_CHARS = 1500;
export const REASONING_MAX_LINES = 12;

/** 是否显示思考 (默认**开**; BOLLOON_SHOW_THINKING=0/false/off 关) */
export function shouldShowReasoning(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.BOLLOON_SHOW_THINKING ?? '').trim().toLowerCase();
  if (!v) return true;
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** 归一化: 去掉多余空行; 无内容 ⇒ 空串 */
export function normalizeReasoning(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/g, ''))
    .filter((l, i, arr) => !(l.trim() === '' && (i === 0 || arr[i - 1].trim() === '')))
    .join('\n')
    .trim();
}

/**
 * 渲染成给终端的一段 (纯函数, 便于门测)。有界 + 标出被省略的量。
 * 返回空串 = 不该显示 (没内容/被关掉)。
 */
export function formatReasoningForDisplay(
  text: string,
  opts: { enabled?: boolean; maxChars?: number; maxLines?: number } = {},
): string {
  const enabled = opts.enabled ?? shouldShowReasoning();
  if (!enabled) return '';
  const clean = normalizeReasoning(text);
  if (!clean) return '';
  const maxChars = opts.maxChars ?? REASONING_MAX_CHARS;
  const maxLines = opts.maxLines ?? REASONING_MAX_LINES;
  let lines = clean.split('\n');
  let truncated = false;
  if (lines.length > maxLines) { lines = lines.slice(0, maxLines); truncated = true; }
  let out = lines.join('\n');
  if (out.length > maxChars) { out = out.slice(0, maxChars); truncated = true; }
  return truncated ? `${out}\n…[思考已截断]` : out;
}


/* ==================== 2026-10-01 (用户: 「我要的是那种短的思考, 长思考思维链可以并不显示」) ====================
 * 三档 (BOLLOON_SHOW_THINKING):
 *   short (默认) —— 只显示**一句**"在想什么" (单行, ≤120 字): 用户要的形态 ✓
 *   full         —— 显示有界思维链块 (调试用)
 *   off / 0      —— 不显示
 * 形态差别: short ⇒ 单行 dim 文本; full ⇒ 圆角框。
 */
export type ReasoningMode = 'short' | 'full' | 'off' | 'trace';

export function reasoningMode(env: NodeJS.ProcessEnv = process.env): ReasoningMode {
  const v = String(env.BOLLOON_SHOW_THINKING ?? '').trim().toLowerCase();
  if (v === 'full' || v === 'chain' || v === 'long') return 'full';
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return 'off';
  if (v === 'short') return 'short';
  if (v === 'trace') return 'trace';
  // 2026-10-01 (用户: 「这里的思考能不能变成 trace 的执行描述」): 默认 = trace ——
  //   不显示思维流(实测: 英文/重复四遍/还夹着错的推断), 改在工具行写这一步在做什么。
  return 'trace';
}

/** 该模式下是否显示 (兼容旧 API: shouldShowReasoning) */
export function isReasoningVisible(env: NodeJS.ProcessEnv = process.env): boolean {
  const m = reasoningMode(env);
  return m !== 'off' && m !== 'trace';   // trace 模式不显示思维流(由工具行的执行描述替代)
}

/**
 * 把思维链压成**一句** "在想什么" (纯函数)。
 * 规矩: 取第一句人话; 去掉编号/项目符号/引号; 压空白; 超长截断加省略号; 出不来就空串。
 */
export function summarizeReasoning(text: string, maxChars = 120): string {
  const clean = normalizeReasoning(text);
  if (!clean) return '';
  // 2026-10-01 (实跑发现): 第一行往往是**场景铺垫**("注意上下文有点混乱…") ⇒ 用户要的是"**要做什么**"那句。
  //   规则: 跳过以"铺垫词"开头的行 (注意/背景/上下文/现在/刚才/首先看), 取第一行"像是判断/行动"的。
  const SCENERY = /^(?:注意|背景|上下文|现在|刚才|首先看|先看|情况是)/;
  const lines = clean.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const firstLine = lines.find((l) => !SCENERY.test(l)) || lines[0] || '';
  const noBullet = firstLine.replace(/^[-*•\d.、)\s]+/, '').trim();
  // 取第一句 (中英句末都认); 太短就整行
  const m = noBullet.match(/^(.{6,}?[。.!！?？;；])/);
  let gist = (m ? m[1] : noBullet).replace(/\s+/g, ' ').trim();
  if (gist.length > maxChars) gist = `${gist.slice(0, maxChars - 1).trimEnd()}…`;
  return gist;
}

/** 按模式渲染: short ⇒ 单行摘要; full ⇒ 有界块; off ⇒ 空串 */
export function renderReasoning(
  text: string,
  opts: { mode?: ReasoningMode; maxChars?: number; maxLines?: number; summaryChars?: number } = {},
): { mode: ReasoningMode; text: string } {
  const mode = opts.mode ?? reasoningMode();
  // off 与 trace 都不给思维流(trace 的执行描述在工具行上, 见 trace-line.ts)
  if (mode === 'off' || mode === 'trace') return { mode, text: '' };
  if (mode === 'full') return { mode, text: formatReasoningForDisplay(text, { enabled: true, maxChars: opts.maxChars, maxLines: opts.maxLines }) };
  return { mode, text: summarizeReasoning(text, opts.summaryChars ?? 120) };
}
