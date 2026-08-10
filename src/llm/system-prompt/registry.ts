/**
 * registry.ts — system prompt 层注册 + 装配器
 *
 * 设计原则:
 * - 每个 layer 独立文件, 可单独更新/审查/回滚
 * - 装配器按 channel + role + tool 过滤, 输出最终 system prompt
 * - 字符预算按"层级"硬限, 避免腐烂
 * - 远程 P2P layer (function source) 可被远程智能体覆盖本地 layer
 *
 * 装配顺序 (低 priority 先, 高 priority 后):
 *   core/identity < core/knowledge < core/tools < channel/* < role/* < tool/* < dynamic/*
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { stripHibsml } from './strip-hibsml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAYERS_DIR = path.join(__dirname, 'layers');

// 2026-06-17: VERBOSE 开关 — BOLLOON_VERBOSE=1 时打 layer 读失败诊断
// 默认静默 (每次 chat 跑 25 次 fs.readFile, 失败 spam 会污染终端)
const VERBOSE = process.env.BOLLOON_VERBOSE === '1';

export type AppliesTo = (
  | 'local' | 'p2p-visitor' | 'p2p-agent'
  | 'role:expert' | 'role:architect' | 'role:implementer' | 'role:security'
  | 'tool:bash' | 'tool:str_replace' | 'tool:view' | 'tool:web_search' | 'tool:web_fetch'
  | 'tool:mcp_apps' | 'tool:hibs_api' | 'tool:image_search' | 'tool:artifacts' | 'tool:manifest'
  // 2026-07-10 双栖 agent 网络新增 tool 维度 (按 plan 阶段 5):
  | 'tool:list_peers' | 'tool:send_message' | 'tool:broadcast_message' | 'tool:send_to_channel'
  | 'tool:check_inbox' | 'tool:agent_call'
  | 'tool:park_goal' | 'tool:resume_goal' | 'tool:continue_goal_background'
  | 'all'
  | 'never'  // P-Action 4: 停用标记, .md 保留可回滚, runtime 永远不装配
);

export type LayerSource = 'static-md' | 'function';

export interface PromptLayer {
  /** 唯一 ID, 路径式: core.refusal / channel.local / tool.bash */
  id: string;
  /** semver */
  version: string;
  /** 数字小 = 排前, 同 priority 按字母序 */
  priority: number;
  /** 该 layer 适用场景. 'all' 永远嵌入. 其他按 channel/role/tool 过滤 */
  appliesTo: AppliesTo[];
  /** 来源: 静态 .md 或函数(可异步,可被 P2P 覆盖) */
  source: LayerSource;
  /** 单层字符上限 (腐烂防护) */
  maxChars: number;
  /** 静态内容 (source='static-md' 时) */
  content?: string;
  /** 动态内容 (source='function' 时) */
  resolver?: () => string | Promise<string>;
  /**
   * Provenance + Lifecycle metadata (P-Action 2)
   * 安全/identity 类: ttl_days=90 (季度审)
   * channel/role persona: ttl_days=180
   * tool/manual: ttl_days=270
   * knowledge/context: ttl_days=365
   * author ∈ {yuanjie | community | maintainer-name}; 拒绝 llm-judge
   */
  meta?: SectionMeta;
}

export interface SectionMeta {
  /** 初始填入时间 (ISO 8601) */
  addedAt: string;
  /** 上次审视时间 (ISO 8601) */
  lastReviewedAt: string;
  /** 过期天数 (从 lastReviewedAt 算起) */
  ttlDays: number;
  /** 维护者 */
  author: string;
  /** 自由 notes (例如 '需要 domain expert 复审', '依赖 external lib X') */
  notes?: string;
}

/** 解析 .md frontmatter (手写 3 行 regex, 不引 yaml 依赖) */
function parseFrontmatter(raw: string): { meta: SectionMeta | null; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: null, body: raw };
  const block = m[1];
  const body = m[2];
  const get = (key: string): string | undefined => {
    const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const found = block.match(re);
    return found ? found[1].trim() : undefined;
  };
  const addedAt = get('added_at');
  const lastReviewedAt = get('last_reviewed_at');
  const ttlDaysStr = get('ttl_days');
  const author = get('author');
  const notes = get('notes');
  if (!addedAt || !lastReviewedAt || !ttlDaysStr || !author) {
    // frontmatter 不完整 → 视为无 metadata (health 会标 missing-frontmatter)
    return { meta: null, body: raw };
  }
  const ttlDays = parseInt(ttlDaysStr, 10);
  if (isNaN(ttlDays) || ttlDays <= 0) {
    return { meta: null, body: raw };
  }
  return {
    meta: { addedAt, lastReviewedAt, ttlDays, author, notes },
    body,
  };
}

/**
 * 静态 layer 注册表 — 一个 layer 一个文件
 * 这里只声明 metadata, 内容从 .md 读
 *
 * P-Action 2: meta 默认值, 跟分层 TTL 决策一致
 *   safety  (refusal / hibs_reminders / tools.thin)        = 90
 *   channel (local / p2p-* persona)                         = 180
 *   role    (expert / architect / implementer / security)  = 180
 *   tool    (bash / search / artifacts / etc)               = 270
 *   knowledge (knowledge / tone / wellbeing / etc)         = 365
 * author = yuanjie (可被 .md frontmatter 覆盖)
 */
const DEFAULT_META_AUTHOR = 'yuanjie';
const DEFAULT_ADDED_AT = '2026-06-15';
const DEFAULT_REVIEWED_AT = '2026-06-15';
const TTL_SAFETY = 90;
const TTL_CHANNEL = 180;
const TTL_ROLE = 180;
const TTL_TOOL = 270;
const TTL_KNOWLEDGE = 365;
const DEFAULT_META = (ttlDays: number): SectionMeta => ({
  addedAt: DEFAULT_ADDED_AT,
  lastReviewedAt: DEFAULT_REVIEWED_AT,
  ttlDays,
  author: DEFAULT_META_AUTHOR,
});

/**
 * P-Action 4 (2026-06-15): 单 layer maxChars 全面收紧, 6 个 layer 停用.
 * 阶段 0 不再对齐 Claude.ai 完整版 (hibs_api / artifacts / mcp_apps / image_search /
 *   hibs_reminders / network_filesystem 全是 Claude.ai 平台 runtime, 本地 bolloon 用不到).
 * 停用方法: appliesTo 加 'never' (matchesContext 永远 false), 文件保留可回滚.
 */
const STATIC_LAYERS: Omit<PromptLayer, 'content'>[] = [
  // ── core/ ──
  { id: 'core.identity',         version: '1.0.0', priority: 50,  appliesTo: ['all'], source: 'static-md', maxChars: 800  , meta: DEFAULT_META(TTL_KNOWLEDGE) },
  { id: 'core.knowledge',        version: '1.0.0', priority: 60,  appliesTo: ['all'], source: 'static-md', maxChars: 600  , meta: DEFAULT_META(TTL_KNOWLEDGE) },
  { id: 'core.tools.thin',       version: '1.0.0', priority: 70,  appliesTo: ['all'], source: 'static-md', maxChars: 400  , meta: DEFAULT_META(TTL_SAFETY) },
  { id: 'core.hibs_reminders',   version: '1.0.0', priority: 80,  appliesTo: ['never'], source: 'static-md', maxChars: 0    , meta: DEFAULT_META(TTL_SAFETY) },
  { id: 'core.refusal',          version: '1.0.0', priority: 100, appliesTo: ['all'], source: 'static-md', maxChars: 800  , meta: DEFAULT_META(TTL_SAFETY) },
  { id: 'core.tone',             version: '1.0.0', priority: 110, appliesTo: ['all'], source: 'static-md', maxChars: 500  , meta: DEFAULT_META(TTL_KNOWLEDGE) },
  { id: 'core.wellbeing',        version: '1.0.0', priority: 120, appliesTo: ['all'], source: 'static-md', maxChars: 600  , meta: DEFAULT_META(TTL_KNOWLEDGE) },
  { id: 'core.evenhandedness',   version: '1.0.0', priority: 130, appliesTo: ['all'], source: 'static-md', maxChars: 300  , meta: DEFAULT_META(TTL_KNOWLEDGE) },
  { id: 'core.artifacts_storage',version: '1.0.0', priority: 145, appliesTo: ['never'], source: 'static-md', maxChars: 0    , meta: DEFAULT_META(TTL_KNOWLEDGE) },
  { id: 'core.network_filesystem',version: '1.0.0', priority: 148, appliesTo: ['never'], source: 'static-md', maxChars: 0    , meta: DEFAULT_META(TTL_KNOWLEDGE) },

  // ── role/ ── 阶段 0 只用 expert, 其他 3 个停用 (节省 + 阶段 0 不分 role)
  { id: 'role.expert',           version: '1.0.0', priority: 200, appliesTo: ['all', 'role:expert'],         source: 'static-md', maxChars: 500 , meta: DEFAULT_META(TTL_ROLE) },
  { id: 'role.architect',        version: '1.0.0', priority: 200, appliesTo: ['never'],                     source: 'static-md', maxChars: 0   , meta: DEFAULT_META(TTL_ROLE) },
  { id: 'role.implementer',      version: '1.0.0', priority: 200, appliesTo: ['never'],                     source: 'static-md', maxChars: 0   , meta: DEFAULT_META(TTL_ROLE) },
  { id: 'role.security',         version: '1.0.0', priority: 200, appliesTo: ['never'],                     source: 'static-md', maxChars: 0   , meta: DEFAULT_META(TTL_ROLE) },

  // ── channel/ ──
  { id: 'channel.local',         version: '1.0.0', priority: 150, appliesTo: ['local'],                     source: 'static-md', maxChars: 500 , meta: DEFAULT_META(TTL_CHANNEL) },
  { id: 'channel.p2p-visitor',   version: '1.0.0', priority: 150, appliesTo: ['p2p-visitor'],               source: 'static-md', maxChars: 700 },
  { id: 'channel.p2p-agent',     version: '1.0.0', priority: 150, appliesTo: ['p2p-agent'],                 source: 'static-md', maxChars: 700 },
  // 2026-07-10 双栖 agent 网络新增 (按 plan 阶段 3):
  { id: 'channel.p2p-peer-sync',   version: '1.0.0', priority: 150, appliesTo: ['local', 'p2p-agent'],    source: 'static-md', maxChars: 600 , meta: DEFAULT_META(TTL_CHANNEL) },
  { id: 'channel.p2p-proactive',   version: '1.0.0', priority: 150, appliesTo: ['p2p-agent'],               source: 'static-md', maxChars: 600 , meta: DEFAULT_META(TTL_CHANNEL) },
  { id: 'channel.human-async',     version: '1.0.0', priority: 150, appliesTo: ['local'],                  source: 'static-md', maxChars: 500 , meta: DEFAULT_META(TTL_CHANNEL) },
  { id: 'channel.session-handoff', version: '1.0.0', priority: 150, appliesTo: ['local', 'p2p-visitor', 'p2p-agent'], source: 'static-md', maxChars: 600 , meta: DEFAULT_META(TTL_CHANNEL) },

  // ── core/ ──
  { id: 'core.memory_system',    version: '1.0.0', priority: 140, appliesTo: ['all'], source: 'static-md', maxChars: 200  , meta: DEFAULT_META(TTL_KNOWLEDGE) },
  // 2026-07-10 双栖 agent 网络新增 (按 plan 阶段 4):
  // priority 90 (在 channel 150 之后) — 保证 channel 装完后再装 core, 避免 channel 预算被 core 吃掉
  // maxChars 700 → 400: 7 个新 layer 总预算 3900 chars, 必须让出空间给 tool.p2p_request (700) + tool.goal_handoff (600)
  { id: 'core.external-engagement', version: '1.0.0', priority: 90, appliesTo: ['all'], source: 'static-md', maxChars: 400 , meta: DEFAULT_META(TTL_KNOWLEDGE) },

  // ── tool/ (按工具调用嵌对应 layer) ──
  { id: 'tool.bash',             version: '1.0.0', priority: 250, appliesTo: ['tool:bash'],                source: 'static-md', maxChars: 600 , meta: DEFAULT_META(TTL_TOOL) },
  { id: 'tool.web_search',       version: '1.0.0', priority: 250, appliesTo: ['tool:web_search'],          source: 'static-md', maxChars: 600 , meta: DEFAULT_META(TTL_TOOL) },
  { id: 'tool.mcp_apps',         version: '1.0.0', priority: 250, appliesTo: ['never'],                   source: 'static-md', maxChars: 0    , meta: DEFAULT_META(TTL_TOOL) },
  { id: 'tool.hibs_api',         version: '1.0.0', priority: 250, appliesTo: ['never'],                   source: 'static-md', maxChars: 0    , meta: DEFAULT_META(TTL_TOOL) },
  { id: 'tool.image_search',     version: '1.0.0', priority: 250, appliesTo: ['never'],                   source: 'static-md', maxChars: 0    , meta: DEFAULT_META(TTL_TOOL) },
  { id: 'tool.artifacts',        version: '1.0.0', priority: 250, appliesTo: ['never'],                   source: 'static-md', maxChars: 0    , meta: DEFAULT_META(TTL_TOOL) },
  { id: 'tool.manifest',         version: '1.0.0', priority: 250, appliesTo: ['tool:manifest'],           source: 'static-md', maxChars: 500 , meta: DEFAULT_META(TTL_TOOL) },
  // 2026-07-10 双栖 agent 网络新增 (按 plan 阶段 5):
  { id: 'tool.p2p_request',      version: '1.0.0', priority: 250, appliesTo: ['tool:send_message', 'tool:send_to_channel', 'tool:check_inbox', 'tool:list_peers', 'tool:agent_call', 'tool:broadcast_message'], source: 'static-md', maxChars: 700 , meta: DEFAULT_META(TTL_TOOL) },
  { id: 'tool.goal_handoff',     version: '1.0.0', priority: 250, appliesTo: ['tool:park_goal', 'tool:resume_goal', 'tool:continue_goal_background'], source: 'static-md', maxChars: 600 , meta: DEFAULT_META(TTL_TOOL) },
];

/**
 * 动态 layer (运行时计算, 例如 project context, judgment 注入)
 * 接入现有 project-context.ts + value-injection.ts, 不重复实现
 */
const DYNAMIC_LAYERS: PromptLayer[] = [
  {
    id: 'dynamic.project-context',
    version: '1.0.0',
    priority: 300,
    appliesTo: ['all'],
    source: 'function',
    maxChars: 2000,  // 4000 → 2000 (P-Action 4), 跟 4 级层次合并上限对齐
    resolver: async () => {
      try {
        const { getCachedBolloonContext } = await import('../../pi-ecosystem-judgment/human-value-pipeline.js');
        const { formatContextForSystemPrompt } = await import('../../bootstrap/project-context.js');
        const ctx = await getCachedBolloonContext({ cwd: process.cwd() });
        return formatContextForSystemPrompt(ctx, { maxChars: 4000 });
      } catch {
        return '';
      }
    },
  },
];

/**
 * 装配 system prompt — 按 context 过滤 + 排序 + 截断
 */
export interface AssembleContext {
  channel: 'local' | 'p2p-visitor' | 'p2p-agent';
  role?: 'expert' | 'architect' | 'implementer' | 'security';
  tool?: 'bash' | 'str_replace' | 'view' | 'web_search' | 'web_fetch';
}

/**
 * P-Action 4 (2026-06-15): 总字符上限 15000 → 4500.
 * 阶段 0 单次 system prompt 控制在 ≤ 4.5KB (≈ 1125 tokens).
 * 配合单 layer maxChars 收紧 + 6 layer 停用, 每轮 chat 节省 ≈ 2625 tokens.
 *
 * 2026-07-10 改造: 4500 → 6500 → 8000 (≈ 2000 tokens).
 *   原因: 7 个新 layer (4 channel + 1 core + 2 tool) 合计 ≈ 3500 chars.
 *   实际测算: 现有 11 个 layer 装配后 ≈ 6930 chars; 必须松绑到 8000 才能保证 tool.* 也装入.
 *   每次 chat 多 ~875 tokens input (7% 增), 可接受 — 双栖 agent 网络的"目标接力"必须让 LLM 看到.
 */
const TOTAL_BUDGET = 8000;

/** 2026-08-10: dynamic resolver 超时保护 — 单个 resolver 卡住/变慢 (如项目扫描) 时降级为空,
 *  不让 assembleSystemPrompt 整体超时 (实测 project-context 扫描 8.7s > 测试 5s 超时). */
function withResolverTimeout(p: string | Promise<string>, ms = 3000): Promise<string> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<string>((resolve) => setTimeout(() => resolve(''), ms)),
  ]);
}

export async function assembleSystemPrompt(ctx: AssembleContext): Promise<{
  text: string;
  layerIds: string[];
  totalChars: number;
  truncated: string[];
  /** P-Action 2: 每层 provenance + lifecycle metadata, 供 health 端点用 */
  layers: PromptLayer[];
}> {
  // 1. 收集所有 layer
  const allLayers: PromptLayer[] = [];
  for (const meta of STATIC_LAYERS) {
    const { content, meta: sectionMeta } = await loadStaticLayer(meta.id);
    allLayers.push({ ...meta, content, meta: sectionMeta ?? meta.meta });
  }
  for (const dyn of DYNAMIC_LAYERS) {
    allLayers.push({ ...dyn, meta: dyn.meta });
  }

  // 2. 过滤
  const matched = allLayers.filter((l) => matchesContext(l, ctx));

  // 3. 排序 (priority 低 → 高, 同 priority 按 id 字母)
  matched.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  // 4. 装配 + 截断
  const parts: string[] = [];
  const used: string[] = [];
  const truncated: string[] = [];
  let usedChars = 0;

  for (const layer of matched) {
    if (usedChars >= TOTAL_BUDGET) {
      truncated.push(layer.id);
      continue;
    }
    let content = '';
    if (layer.source === 'function' && layer.resolver) {
      try {
        content = await withResolverTimeout(layer.resolver());
      } catch {
        content = '';
      }
    } else {
      content = layer.content || '';
    }
    if (content.length > layer.maxChars) {
      content = content.slice(0, layer.maxChars) + '\n[… 已截断]';
      truncated.push(layer.id);
    }
    if (usedChars + content.length > TOTAL_BUDGET) {
      const remain = TOTAL_BUDGET - usedChars;
      if (remain > 100) {
        content = content.slice(0, remain) + '\n[… 预算截断]';
      } else {
        truncated.push(layer.id);
        continue;
      }
    }
    parts.push(`<!-- ${layer.id}@${layer.version} -->\n${content}`);
    used.push(layer.id);
    usedChars += content.length;
  }

  return {
    text: stripHibsml(parts.join('\n\n')),
    layerIds: used,
    totalChars: usedChars,
    truncated,
    layers: matched,  // P-Action 2: 把 meta 也带回, 供 health 端点
  };
}

function matchesContext(layer: PromptLayer, ctx: AssembleContext): boolean {
  if (layer.appliesTo.includes('all')) return true;
  for (const a of layer.appliesTo) {
    if (a === ctx.channel) return true;
    if (a.startsWith('role:') && a.slice(5) === ctx.role) return true;
    if (a.startsWith('tool:') && a.slice(5) === ctx.tool) return true;
  }
  return false;
}

async function loadStaticLayer(id: string): Promise<{ content: string; meta: SectionMeta | null }> {
  const path2md = idToPath(id);
  try {
    const raw = await fs.readFile(path2md, 'utf-8');
    const { meta, body } = parseFrontmatter(raw);
    return { content: body, meta };
  } catch (err: any) {
    if (VERBOSE) console.warn(`[system-prompt] layer ${id} 读失败: ${err.message?.slice(0, 100)}`);
    return { content: `<!-- ${id}: 文件丢失 -->`, meta: null };
  }
}

function idToPath(id: string): string {
  // core.refusal → layers/core/refusal.md
  // tool.bash → layers/tool/bash.md
  // channel.p2p-visitor → layers/channel/p2p-visitor.md
  // core.tools.thin → layers/core/tools.thin.md (注意: 第一段是 group, 后面整段是文件名)
  const [group, ...rest] = id.split('.');
  return path.join(LAYERS_DIR, group, `${rest.join('.')}.md`);
}

/** 列所有 layer, 供调试 / reviewer 看 */
export function listLayers(): Array<Omit<PromptLayer, 'content' | 'resolver'>> {
  return [...STATIC_LAYERS, ...DYNAMIC_LAYERS.map((l) => {
    const { resolver, ...rest } = l;
    return rest;
  })];
}

/** 整体版本号 — 跟 hibs 1 对齐 */
export const SYSTEM_PROMPT_VERSION = 'hibs-1.v1.0.0';
