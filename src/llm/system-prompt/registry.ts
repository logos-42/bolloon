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

export type AppliesTo = (
  | 'local' | 'p2p-visitor' | 'p2p-agent'
  | 'role:expert' | 'role:architect' | 'role:implementer' | 'role:security'
  | 'tool:bash' | 'tool:str_replace' | 'tool:view' | 'tool:web_search' | 'tool:web_fetch'
  | 'tool:mcp_apps' | 'tool:hibs_api' | 'tool:image_search' | 'tool:artifacts' | 'tool:manifest'
  | 'all'
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
}

/**
 * 静态 layer 注册表 — 一个 layer 一个文件
 * 这里只声明 metadata, 内容从 .md 读
 */
const STATIC_LAYERS: Omit<PromptLayer, 'content'>[] = [
  // ── core/ ──
  { id: 'core.identity',         version: '1.0.0', priority: 50,  appliesTo: ['all'], source: 'static-md', maxChars: 2500 },
  { id: 'core.knowledge',        version: '1.0.0', priority: 60,  appliesTo: ['all'], source: 'static-md', maxChars: 1200 },
  { id: 'core.tools.thin',       version: '1.0.0', priority: 70,  appliesTo: ['all'], source: 'static-md', maxChars: 400 },
  { id: 'core.hibs_reminders',   version: '1.0.0', priority: 80,  appliesTo: ['all'], source: 'static-md', maxChars: 800 },
  { id: 'core.refusal',          version: '1.0.0', priority: 100, appliesTo: ['all'], source: 'static-md', maxChars: 1200 },
  { id: 'core.tone',             version: '1.0.0', priority: 110, appliesTo: ['all'], source: 'static-md', maxChars: 1000 },
  { id: 'core.wellbeing',        version: '1.0.0', priority: 120, appliesTo: ['all'], source: 'static-md', maxChars: 2500 },
  { id: 'core.evenhandedness',   version: '1.0.0', priority: 130, appliesTo: ['all'], source: 'static-md', maxChars: 700 },
  { id: 'core.memory_system',    version: '1.0.0', priority: 140, appliesTo: ['all'], source: 'static-md', maxChars: 600 },
  { id: 'core.artifacts_storage',version: '1.0.0', priority: 145, appliesTo: ['all'], source: 'static-md', maxChars: 1500 },
  { id: 'core.network_filesystem',version: '1.0.0', priority: 148, appliesTo: ['all'], source: 'static-md', maxChars: 900 },

  // ── role/ ──
  { id: 'role.expert',           version: '1.0.0', priority: 200, appliesTo: ['all', 'role:expert'],         source: 'static-md', maxChars: 500 },
  { id: 'role.architect',        version: '1.0.0', priority: 200, appliesTo: ['all', 'role:architect'],      source: 'static-md', maxChars: 500 },
  { id: 'role.implementer',      version: '1.0.0', priority: 200, appliesTo: ['all', 'role:implementer'],    source: 'static-md', maxChars: 500 },
  { id: 'role.security',          version: '1.0.0', priority: 200, appliesTo: ['all', 'role:security'],        source: 'static-md', maxChars: 500 },

  // ── channel/ ──
  { id: 'channel.local',         version: '1.0.0', priority: 150, appliesTo: ['local'],                     source: 'static-md', maxChars: 500 },
  { id: 'channel.p2p-visitor',   version: '1.0.0', priority: 150, appliesTo: ['p2p-visitor'],               source: 'static-md', maxChars: 700 },
  { id: 'channel.p2p-agent',     version: '1.0.0', priority: 150, appliesTo: ['p2p-agent'],                 source: 'static-md', maxChars: 700 },

  // ── tool/ (按工具调用嵌对应 layer) ──
  { id: 'tool.bash',             version: '1.0.0', priority: 250, appliesTo: ['tool:bash'],                source: 'static-md', maxChars: 900 },
  { id: 'tool.web_search',       version: '1.0.0', priority: 250, appliesTo: ['tool:web_search'],          source: 'static-md', maxChars: 3000 },
  { id: 'tool.mcp_apps',         version: '1.0.0', priority: 250, appliesTo: ['tool:mcp_apps'],            source: 'static-md', maxChars: 1800 },
  { id: 'tool.hibs_api',         version: '1.0.0', priority: 250, appliesTo: ['tool:hibs_api'],            source: 'static-md', maxChars: 2500 },
  { id: 'tool.image_search',     version: '1.0.0', priority: 250, appliesTo: ['tool:image_search'],        source: 'static-md', maxChars: 1500 },
  { id: 'tool.artifacts',        version: '1.0.0', priority: 250, appliesTo: ['tool:artifacts'],           source: 'static-md', maxChars: 2500 },
  { id: 'tool.manifest',         version: '1.0.0', priority: 250, appliesTo: ['tool:manifest'],            source: 'static-md', maxChars: 2000 },
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
    maxChars: 4000,
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

const TOTAL_BUDGET = 15000; // 单次 system prompt 总字符上限 (hibs 1 完整版)

export async function assembleSystemPrompt(ctx: AssembleContext): Promise<{
  text: string;
  layerIds: string[];
  totalChars: number;
  truncated: string[];
}> {
  // 1. 收集所有 layer
  const allLayers: PromptLayer[] = [];
  for (const meta of STATIC_LAYERS) {
    const content = await loadStaticLayer(meta.id);
    allLayers.push({ ...meta, content });
  }
  allLayers.push(...DYNAMIC_LAYERS);

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
        content = await layer.resolver();
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

async function loadStaticLayer(id: string): Promise<string> {
  const path2md = idToPath(id);
  try {
    return await fs.readFile(path2md, 'utf-8');
  } catch (err: any) {
    console.warn(`[system-prompt] layer ${id} 读失败: ${err.message?.slice(0, 100)}`);
    return `<!-- ${id}: 文件丢失 -->`;
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
