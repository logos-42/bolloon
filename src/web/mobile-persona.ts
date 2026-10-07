/**
 * mobile-persona.ts — 手机端 Personal AI 性格配置 (2026-10-07)
 *
 * 手机端智能体的「性格文件」: 与桌面 persona 体系 (soul.md/identity.md 的性格字段) 对齐,
 * 但以浏览器可持久化的 JSON 存储 (localStorage), 供 WEB_AGENT_SYSTEM 注入。
 *
 * 字段设计 (对齐桌面 identity.md 的「性格/兴趣/能力」+ soul.md 的「价值观/不做的事」):
 *   - name        : 智能体名字 (默认 blln-mobile)
 *   - personality : 性格 (严谨/活泼/务实/探索 等自由文本)
 *   - values      : 价值观 (优先级列表)
 *   - interests   : 兴趣领域
 *   - style       : 说话方式 (简洁/详细/幽默)
 *   - boundaries  : 不做的事
 *   - extra       : 扩展自由文本 (给 LLM 的补充人设)
 *
 * 用法:
 *   persona.load()             → 读当前性格 (无则默认)
 *   persona.save(partial)      → 更新并持久化
 *   persona.buildSystemPrompt() → 注入 agent 系统提示
 */
const PERSONA_KEY = 'bolloon_mobile_persona';

export interface MobilePersona {
  name: string;
  personality: string;
  values: string[];
  interests: string[];
  style: string;
  boundaries: string[];
  extra: string;
}

export const DEFAULT_PERSONA: MobilePersona = {
  name: 'blln-mobile',
  personality: '严谨、可靠、有边界感',
  values: ['本地优先', '隐私优先', '诚实透明'],
  interests: ['P2P 网络', 'AI 智能体', '知识系统'],
  style: '简洁中文，先给结论再给细节',
  boundaries: ['不假装能做做不到的事', '不编造数据'],
  extra: '',
};

function safeGet(): Storage {
  try { return window.localStorage; } catch { return (globalThis as any).localStorage || { getItem: () => null, setItem: () => {} }; }
}

/** 读取当前性格 (未配置 → 默认) */
export function loadPersona(): MobilePersona {
  try {
    const raw = safeGet().getItem(PERSONA_KEY);
    if (!raw) return { ...DEFAULT_PERSONA };
    const p = JSON.parse(raw);
    return {
      name: typeof p.name === 'string' && p.name ? p.name : DEFAULT_PERSONA.name,
      personality: typeof p.personality === 'string' ? p.personality : DEFAULT_PERSONA.personality,
      values: Array.isArray(p.values) ? p.values : DEFAULT_PERSONA.values,
      interests: Array.isArray(p.interests) ? p.interests : DEFAULT_PERSONA.interests,
      style: typeof p.style === 'string' ? p.style : DEFAULT_PERSONA.style,
      boundaries: Array.isArray(p.boundaries) ? p.boundaries : DEFAULT_PERSONA.boundaries,
      extra: typeof p.extra === 'string' ? p.extra : '',
    };
  } catch { return { ...DEFAULT_PERSONA }; }
}

/** 更新并持久化 (部分更新; 返回合并后的完整 persona) */
export function savePersona(partial: Partial<MobilePersona>): MobilePersona {
  const cur = loadPersona();
  const next: MobilePersona = {
    name: typeof partial.name === 'string' && partial.name.trim() ? partial.name.trim() : cur.name,
    personality: typeof partial.personality === 'string' ? partial.personality : cur.personality,
    values: Array.isArray(partial.values) ? partial.values : cur.values,
    interests: Array.isArray(partial.interests) ? partial.interests : cur.interests,
    style: typeof partial.style === 'string' ? partial.style : cur.style,
    boundaries: Array.isArray(partial.boundaries) ? partial.boundaries : cur.boundaries,
    extra: typeof partial.extra === 'string' ? partial.extra : cur.extra,
  };
  try { safeGet().setItem(PERSONA_KEY, JSON.stringify(next)); } catch { /* 存不下就内存态 */ }
  return next;
}

/** 重置回默认 */
export function resetPersona(): MobilePersona {
  try { safeGet().removeItem(PERSONA_KEY); } catch { /* ignore */ }
  return { ...DEFAULT_PERSONA };
}

/** 组装注入 agent 系统提示的性格段 (mobile-agent 的 WEB_AGENT_SYSTEM 里引用) */
export function buildPersonaPrompt(p: MobilePersona = loadPersona()): string {
  const lines = [
    `你的名字: ${p.name}`,
    `性格: ${p.personality}`,
    p.style ? `说话方式: ${p.style}` : '',
    p.values.length ? `价值观: ${p.values.join('、')}` : '',
    p.interests.length ? `兴趣: ${p.interests.join('、')}` : '',
    p.boundaries.length ? `不做的事: ${p.boundaries.join('、')}` : '',
    p.extra ? `补充: ${p.extra}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}
