/**
 * call-service.ts — 判断力资产「调用」服务 (外部节点像连 API 一样付费调用)
 *
 *   judgeWithAsset(assetText, question, llm)   基于判断力资产对问题做判断 → JudgmentResult
 *   parseJudgment(text)                        容错解析 LLM 返回 (JSON 块 / 裸 JSON / 带杂讯)
 *
 * 语义: 判断力资产不是静态文件, 是可调用端点 —— 输入问题/场景, 输出该资产的裁决。
 * LLM 是注入的 (函数式), 测试用 stub, 真跑由调用方 (web server / CLI) 提供。
 */

export interface JudgmentResult {
  verdict: string;          // approve | reject | modify | escalate | hold
  confidence: number;       // 0..1
  reasoning: string;
  values?: string[];
  assetId?: string;
}

const VERDICTS = ['approve', 'reject', 'modify', 'escalate', 'hold'];

/** 判断力资产文本 → 判断执行器系统提示。assetText 可以是本地 jd 或买到的 markdown。 */
export function buildJudgeSystemPrompt(assetText: string): string {
  return [
    '你是「判断力执行器」。调用方付费使用下面的判断力资产, 你只依据该资产做判断, 不引入资产之外的偏好。',
    '',
    '## 判断力资产',
    assetText.trim(),
    '',
    '## 要求',
    '对用户的问题/场景给出裁决, 只输出一个 JSON 对象:',
    '{"verdict":"approve|reject|modify|escalate|hold","confidence":0.0,"reasoning":"中文理由(引用资产依据)","values":["价值标签"]}',
    'verdict 语义: approve=可以做 · reject=不做 · modify=要修改后再做 · escalate=需要更高层或人裁决 · hold=待定先不动。',
    'confidence 是依据该资产的把握度 (0..1)。reasoning 必须引用资产里的评分/依据, 不许凭空给理由。',
  ].join('\n');
}

export function buildJudgeUserPrompt(question: string, context?: string): string {
  const lines = [`问题: ${question.trim()}`];
  if (context && context.trim()) lines.push(`背景: ${context.trim()}`);
  return lines.join('\n');
}

/** 容错解析 LLM 输出: 剥 ```json 围栏 / 取首尾 { } / 容忍 key 缺省。 */
export function parseJudgment(text: string): JudgmentResult | null {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  let obj: any;
  try {
    obj = JSON.parse(t.slice(first, last + 1));
  } catch {
    return null;
  }
  const verdict = String(obj.verdict || '').toLowerCase();
  if (!VERDICTS.includes(verdict)) return null;
  const confidence = Number(obj.confidence);
  const reasoning = String(obj.reasoning || '').trim();
  if (!reasoning) return null;
  const values = Array.isArray(obj.values)
    ? obj.values.map((v: unknown) => String(v)).filter(Boolean)
    : undefined;
  return {
    verdict,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    reasoning,
    values,
    assetId: typeof obj.assetId === 'string' ? obj.assetId : undefined,
  };
}

export interface JudgeCallOptions {
  /** 判断力资产文本 (judgenessToPaidMarkdown 的输出, 或买到的内容) */
  assetText: string;
  question: string;
  context?: string;
  /** 真跑时由调用方注入 (web server 的 getMinimax / CLI 的 pi-ai); 失败可返回 null */
  llm: (system: string, user: string) => Promise<string | null>;
}

/** 核心: 基于判断力资产对问题做判断。LLM 拿不到/解析失败 → null (调用方决定降级)。 */
export async function judgeWithAsset(opts: JudgeCallOptions): Promise<JudgmentResult | null> {
  const sys = buildJudgeSystemPrompt(opts.assetText);
  const user = buildJudgeUserPrompt(opts.question, opts.context);
  const raw = await opts.llm(sys, user);
  if (!raw) return null;
  const parsed = parseJudgment(raw);
  if (!parsed) return null;
  // 资产 id 从正文标题里带出来 (解析层能拿到的字段)
  const idm = opts.assetText.match(/^# 判断力资产 (\S+)/m);
  if (!parsed.assetId && idm) parsed.assetId = idm[1];
  return parsed;
}
