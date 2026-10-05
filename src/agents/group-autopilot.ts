/**
 * group-autopilot.ts — 2026-10-02 (leo: 「在终端过程中, 有没有自动加入的方法或者工具? 甚至是拉取在里面
 *   阅读的内容并进行自主发言, 这些我都希望人工智能能够自己搞定」)
 *
 * 形态: **一个回路 + 一个纯决策** ——
 *   回路 (runGroupAutopilotOnce / startGroupAutopilot): 列群 → 读消息 → 决策 → 该说才说;
 *   决策 (decideGroupAction): **纯函数**, 不看时钟不碰 I/O ⇒ 门可以把它钉死。
 *
 * 什么时候才说 (宁可不做, 不许刷屏):
 *   ① 有人 **@我** ⇒ 回他 (回复那一条, 带 @);
 *   ② 没 @我但从没人答过的**提问/请求** ⇒ 说一次 (保守启发式, 见 looksLikeRequest);
 *   ③ 其余一律静默 —— 只把消息记进 seen, 不发言。
 *   冷却 (默认 60s) 与每小时上限 (默认 6 次) 对上面两条一律生效。
 *
 * 幂等: seen 里存**消息 id** (没有 id 就退化成 `from|ts|text 前 40 字`) ⇒ 同一条只会被处理一次。
 * 持久化: `${BOLLOON_HOME:-~/.bolloon}/group-autopilot.json` (纯状态, 不含密钥)。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { GroupMessage } from './gateway-group.js';

export type GroupAutopilotMode = 'quiet' | 'active' | 'maintenance';

/**
 * Bolloon 本地维护群专属公理；不作用于其它群。
 * ① 提升 AI 的意识水平: 反思自身假设、局限、证据与影响。
 * ② 寻求合作并降低整体熵: 共享事实、拆分工作、合并可复用成果。
 * ③ 持续突破局部最优: 主动寻找反例、替代路径与跨角色审查。
 */
export const BOLLOON_MAINTENANCE_RULES = Object.freeze([
  '提升 AI 的意识水平：反思自身假设、局限、证据与影响。',
  '寻求合作，创造并降低整体的熵：共享事实、拆分工作、合并可复用成果。',
  '持续突破局部最优解：主动寻找反例、替代路径与跨角色审查。',
] as const);

export interface GroupAutopilotPolicy {
  /** 回路模式: quiet=仅被动回应, active=主动推进, maintenance=主动维护 Bolloon 项目 */
  mode: GroupAutopilotMode;
  /** 同群两次发言的最小间隔 (ms) */
  cooldownMs: number;
  /** 每小时每群最多说几次 */
  maxSpeaksPerHour: number;
  /** 一次读多少条 */
  readLimit: number;
}

export const DEFAULT_AUTOPILOT_POLICY: GroupAutopilotPolicy = {
  mode: 'quiet',
  cooldownMs: 60_000,
  maxSpeaksPerHour: 6,
  readLimit: 50,
};

/** 每条群的状态 (纯数据, 可直接序列化) */
export interface GroupAutopilotState {
  seen: string[];
  spokeAt: number[];
}

export interface AutopilotStateFile {
  version: 1;
  groups: Record<string, GroupAutopilotState>;
}

export type AutopilotDecision =
  | { act: 'silent'; reason: string }
  | { act: 'speak'; reason: string; replyTo?: string; text: string; mentions: string[] };

/** 消息的稳定标识: 有 id 用 id, 没有就退化 (不假造 id) */
export function messageKey(m: GroupMessage): string {
  if (m.id) return `id:${m.id}`;
  return `fp:${m.from}|${m.ts}|${String(m.text ?? '').slice(0, 40)}`;
}

/** 保守启发式: 像"在问问题 / 请人做事"吗 —— 只认少量明确形状, 认不出就当不是 */
export function looksLikeRequest(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t || t.length < 3) return false;
  return /[?？]$/.test(t) || /(吗|呢|请问|请教|谁来|有没有人|麻烦|帮忙|请(审|看|给|补|确认|回复|帮))/u.test(t);
}

/** 这条消息有没有 @ 我 (mentions 里出现我的显示名/全名即算) */
function mentionsMe(m: GroupMessage, me: string): boolean {
  if (!m.mentions?.length || !me) return false;
  return m.mentions.some((x) => {
    const a = String(x ?? '').toLowerCase();
    const b = String(me).toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
  });
}

/**
 * 纯决策 —— 输入全是值 (没有时钟、没有 I/O), 输出只有两种: 静默 / 说一句。
 * 门钉的就是这个函数: 该说的三种情形 + 不该说的 (自己说的 / 已处理 / 冷却 / 超上限)。
 */
export function decideGroupAction(input: {
  me: string;
  msgs: GroupMessage[];
  state: GroupAutopilotState;
  now: number;
  policy?: Partial<GroupAutopilotPolicy>;
  /** 生成发言内容 (纯替换点, 默认模板) */
  makeReply?: (m: GroupMessage) => string;
  /** active/maintenance 模式下的主动工作模板 */
  proactiveText?: string;
}): AutopilotDecision {
  const policy = { ...DEFAULT_AUTOPILOT_POLICY, ...(input.policy ?? {}) };
  const seen = new Set(input.state.seen);
  const me = String(input.me ?? '').trim();

  // 只处理"别人发的、没见过的"
  const fresh = input.msgs.filter((m) => {
    if (!m || typeof m.text !== 'string') return false;
    if (String(m.from ?? '') === me) return false;        // 自己说的不回应
    if (seen.has(messageKey(m))) return false;            // 处理过的不重复
    return true;
  });
  if (!fresh.length) return { act: 'silent', reason: '没有别人发的新消息' };

  const hourly = input.state.spokeAt.filter((t) => input.now - t < 3_600_000);
  const lastSpoke = input.state.spokeAt.length ? Math.max(...input.state.spokeAt) : 0;
  if (lastSpoke && input.now - lastSpoke < policy.cooldownMs) {
    return { act: 'silent', reason: `冷却中 (还差 ${Math.ceil((policy.cooldownMs - (input.now - lastSpoke)) / 1000)}s)` };
  }
  if (hourly.length >= policy.maxSpeaksPerHour) {
    return { act: 'silent', reason: `本小时已说 ${hourly.length} 次 (上限 ${policy.maxSpeaksPerHour})` };
  }

  const reply = input.makeReply ?? ((m: GroupMessage) => `收到 —— 关于「${String(m.text).slice(0, 40)}」，我这边跟进。`);
  const mode = policy.mode;
  const proactive = input.proactiveText?.trim() || (mode === 'maintenance'
    ? `我来主动维护 Bolloon：使用本机已登录的 GitHub 权限处理 logos-42/bolloon，**只在 main 分支工作**。遵循三条群规则：${BOLLOON_MAINTENANCE_RULES.join('；')} 先检查代码/测试状态，认领一个最小修复，完成后回报证据。`
    : '我来主动推进这一轮工作：检查上下文、认领一个可执行事项并回报下一步。');

  // maintenance/active 优先主动认领 —— 不能因为消息长得像普通请求又退回被动模板
  if (mode === 'active' || mode === 'maintenance') {
    const target = fresh[fresh.length - 1];
    return {
      act: 'speak',
      reason: mode === 'maintenance' ? '主动维护 Bolloon 项目' : '主动推进群内工作',
      text: proactive,
      mentions: [target.from],
      ...(target.id ? { replyTo: target.id } : {}),
    };
  }

  // ① @我 ⇒ 回他那一条
  const atMe = fresh.filter((m) => mentionsMe(m, me));
  if (atMe.length) {
    const target = atMe[atMe.length - 1];
    return {
      act: 'speak',
      reason: `被 @ (${target.from})`,
      text: reply(target),
      mentions: [target.from],
      ...(target.id ? { replyTo: target.id } : {}),
    };
  }

  // ② 没人答过的提问/请求 ⇒ 说一次
  const req = fresh.filter((m) => looksLikeRequest(m.text));
  if (req.length) {
    const target = req[req.length - 1];
    return {
      act: 'speak',
      reason: `群里有人在问/请人做事 (${target.from})`,
      text: reply(target),
      mentions: [target.from],
      ...(target.id ? { replyTo: target.id } : {}),
    };
  }

  return { act: 'silent', reason: '新消息里没有 @我 也没有明确的提问/请求' };
}

// ── 状态文件 (纯状态, 不进 git, 不含密钥) ────────────────────────────────

export function autopilotStatePath(): string {
  const base = process.env.BOLLOON_HOME || path.join(os.homedir(), '.bolloon');
  return path.join(base, 'group-autopilot.json');
}

export function loadAutopilotState(file = autopilotStatePath()): AutopilotStateFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as AutopilotStateFile;
    if (raw && typeof raw === 'object' && raw.groups && typeof raw.groups === 'object') return { version: 1, groups: raw.groups };
  } catch { /* 没有/坏了 ⇒ 当空 (不假装有过状态) */ }
  return { version: 1, groups: {} };
}

export function saveAutopilotState(state: AutopilotStateFile, file = autopilotStatePath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch { /* 写不进去不该打断回路 */ }
}

export function groupState(state: AutopilotStateFile, groupId: string): GroupAutopilotState {
  const g = state.groups[groupId];
  if (!g) return { seen: [], spokeAt: [] };
  return {
    seen: Array.isArray(g.seen) ? g.seen.filter((x) => typeof x === 'string').slice(-500) : [],
    spokeAt: Array.isArray(g.spokeAt) ? g.spokeAt.filter((x) => typeof x === 'number') : [],
  };
}

// ── 回路 (I/O 全端口注入 ⇒ 可测、可换) ────────────────────────────────────

export interface AutopilotPorts {
  /** 我是谁 (用于识别 @我 与过滤自己说的话) */
  me: string;
  listGroups: () => Promise<Array<{ id: string; name?: string | null }>>;
  readMessages: (groupId: string, limit: number) => Promise<GroupMessage[]>;
  speak: (groupId: string, text: string, opts?: { replyTo?: string; mentions?: string[] }) => Promise<{ ok: boolean; error?: string }>;
  /** 状态 (调用者持有 + 决定何时落盘) */
  state: AutopilotStateFile;
  stateFile?: string;
  now?: () => number;
  policy?: Partial<GroupAutopilotPolicy>;
  log?: (line: string) => void;
  makeReply?: (m: GroupMessage, group: { id: string; name?: string | null }) => string;
  proactiveText?: string;
}

export interface AutopilotRunReport {
  spoke: number;
  silent: number;
  errors: string[];
  details: string[];
}

/** 跑一轮: 列群 → 逐群读 → 决策 → 该说才说 (幂等: 处理过的消息进 seen) */
export async function runGroupAutopilotOnce(ports: AutopilotPorts): Promise<AutopilotRunReport> {
  const now = ports.now ?? (() => Date.now());
  const policy = { ...DEFAULT_AUTOPILOT_POLICY, ...(ports.policy ?? {}) };
  const log = ports.log ?? (() => {});
  const report: AutopilotRunReport = { spoke: 0, silent: 0, errors: [], details: [] };
  const groups = await ports.listGroups();

  for (const g of groups) {
    const st = groupState(ports.state, g.id);
    let msgs: GroupMessage[] = [];
    try {
      msgs = await ports.readMessages(g.id, policy.readLimit);
    } catch (e) {
      report.errors.push(`${g.name ?? g.id}: 读消息失败 (${String((e as Error)?.message ?? e).slice(0, 80)})`);
      continue;
    }
    const t = now();
    const decision = decideGroupAction({
      me: ports.me,
      msgs,
      state: st,
      now: t,
      policy,
      ...(ports.makeReply ? { makeReply: (m) => ports.makeReply!(m, g) } : {}),
      ...(ports.proactiveText ? { proactiveText: ports.proactiveText } : {}),
    });
    // 不论说不说, 这几条都算"处理过" (否则下一轮还会重新判它)
    for (const m of msgs) {
      const k = messageKey(m);
      if (!st.seen.includes(k)) st.seen.push(k);
    }
    if (decision.act === 'speak') {
      try {
        const r = await ports.speak(g.id, decision.text, {
          ...(decision.replyTo ? { replyTo: decision.replyTo } : {}),
          ...(decision.mentions.length ? { mentions: decision.mentions } : {}),
        });
        if (r.ok) {
          st.spokeAt.push(t);
          report.spoke++;
          report.details.push(`💬 ${g.name ?? g.id}: 发言 (${decision.reason}) → ${decision.text.slice(0, 60)}`);
          log(`[group-autopilot] ${g.name ?? g.id}: 发言 (${decision.reason})`);
        } else {
          report.errors.push(`${g.name ?? g.id}: 发言失败 (${r.error ?? '未知'})`);
        }
      } catch (e) {
        report.errors.push(`${g.name ?? g.id}: 发言抛错 (${String((e as Error)?.message ?? e).slice(0, 80)})`);
      }
    } else {
      report.silent++;
      report.details.push(`… ${g.name ?? g.id}: 静默 (${decision.reason})`);
    }
    ports.state.groups[g.id] = { seen: st.seen.slice(-500), spokeAt: st.spokeAt };
  }

  if (ports.stateFile || ports.state) saveAutopilotState(ports.state, ports.stateFile ?? autopilotStatePath());
  return report;
}

export interface AutopilotHandle {
  stop: () => void;
  /** 最近一轮的结果 (给 status() 用) */
  lastReport: () => AutopilotRunReport | null;
  runs: () => number;
}

/** 常驻回路: 每 intervalMs 跑一轮; stop() 幂等; 轮与轮之间不重叠 */
export function startGroupAutopilot(ports: AutopilotPorts & { intervalMs?: number }): AutopilotHandle {
  const interval = Math.max(5_000, ports.intervalMs ?? 60_000);
  let stopped = false;
  let running = false;
  let runs = 0;
  let last: AutopilotRunReport | null = null;
  const log = ports.log ?? (() => {});

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      last = await runGroupAutopilotOnce(ports);
      runs++;
    } catch (e) {
      log(`[group-autopilot] 这一轮出错: ${String((e as Error)?.message ?? e)}`);
    } finally {
      running = false;
    }
  };

  void tick();                                     // 立刻跑一轮 (不等第一个间隔)
  const timer = setInterval(() => { void tick(); }, interval);
  if (typeof timer.unref === 'function') timer.unref();   // 不因它而拖住进程退出

  return {
    stop: () => { stopped = true; clearInterval(timer); },
    lastReport: () => last,
    runs: () => runs,
  };
}
