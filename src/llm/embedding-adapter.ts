/**
 * embedding-adapter.ts — 记忆向量化的端口 (P1, decentralized-memory-design §2.3)
 *
 * 设计 (小步, 不引重型依赖):
 *   - EmbeddingAdapter 接口: 供应商可插拔 (glm/minimax/本地/…)
 *   - createEmbeddingAdapter(): 从配置读 provider, 无可用端点 → none
 *     (none 是合法状态: memory-store 回退到关键词召回, 现有行为不变)
 *   - 不硬编码维度: adapter.dim 由供应商实现自报, 校验一致性
 *
 * 诚实边界 (写死):
 *   - 本仓现有 provider 实测 (2026-10-11):
 *       glm 中转 (llm.goaichat.top): 无 /embeddings 模型 (404)
 *       minimax (api.minimaxi.com): sk-cp- 订阅 key 无法调 API (1004 login fail)
 *     ⇒ 当前 createEmbeddingAdapter() 默认返回 none, 不假装有向量可用;
 *       将来任一供应商 key 就绪时, 在此实现它的 embed() 即可, 记忆层零改动。
 *   - OpenAI 兼容格式 (input → data[].embedding) 与 MiniMax 私有格式
 *     (texts + type + GroupId → vectors) 不同, 各自的 adapter 实现自己处理。
 */
export interface EmbeddingAdapter {
  /** 供应商标识: 'none' | 'glm' | 'minimax' | 'openai' | 'local' | … */
  provider: string;
  /** 向量维度 (一致性校验用; none 为 0) */
  dim: number;
  /** 单条向量化; none 实现抛错 (调用方必须先查 provider !== 'none') */
  embed(text: string): Promise<number[]>;
  /** 批量; none 实现逐条调用 embed (供应商可覆盖为真批量) */
  embedBatch(texts: string[]): Promise<number[][]>;
}

/** none 实现: 无向量能力, 调用即抛 (由调用方按 provider 判走关键词回退) */
const noneAdapter: EmbeddingAdapter = {
  provider: 'none',
  dim: 0,
  async embed() {
    throw new Error('embedding adapter 未配置 (provider=none); 调用方应先查 provider !== "none"');
  },
  async embedBatch(texts: string[]) {
    throw new Error('embedding adapter 未配置 (provider=none); 调用方应先查 provider !== "none"');
  },
};

export interface EmbeddingConfig {
  /** 'none' = 不用向量 (关键词回退); 其他值 = 对应供应商实现 */
  provider?: string;
  /** 供应商侧模型名 (如 'embo-01' / 'text-embedding-3-small') */
  model?: string;
  /** baseUrl 覆盖 (缺省用供应商默认) */
  baseUrl?: string;
  /** API key (从配置/环境读, 不进日志) */
  apiKey?: string;
  /** MiniMax 私有格式需要的 GroupId */
  groupId?: string;
}

/**
 * 工厂: 从配置构造 adapter。
 * 规则:
 *   - 无 provider / provider='none' → none adapter (关键词回退)
 *   - provider 有值但没有实现 → none + 说明 (不假装能用)
 *   - 新增供应商实现在此登记 (每实现一个, 加一个 case)
 */
export function createEmbeddingAdapter(cfg: EmbeddingConfig = {}): EmbeddingAdapter {
  const provider = String(cfg.provider || 'none').toLowerCase();
  switch (provider) {
    case 'none':
    case '':
      return noneAdapter;
    // 预留登记位: 供应商 key 就绪后在此补实现 (见文件头诚实边界)
    // case 'glm':      return createGlmAdapter(cfg);
    // case 'minimax':  return createMiniMaxAdapter(cfg);
    // case 'openai':   return createOpenAIAdapter(cfg);
    default:
      return noneAdapter;
  }
}

/** 测试辅助: 造一个确定性伪 adapter (cosine 检索测试用, 不碰网络) */
export function createFakeAdapter(dim = 8, seedText = 'seed'): EmbeddingAdapter {
  // 确定性伪向量: 文本长度 + 字符和 → 稳定可复现 (仅测试用)
  const vec = (t: string): number[] => {
    const out: number[] = [];
    const s = String(t || '');
    for (let i = 0; i < dim; i++) {
      const v = (s.length * (i + 1) + s.charCodeAt(i % Math.max(1, s.length)) * 0.01) % 1;
      out.push(Number(v.toFixed(6)));
    }
    // 归一化 (cosine 需要)
    const norm = Math.sqrt(out.reduce((a, b) => a + b * b, 0)) || 1;
    return out.map((x) => x / norm);
  };
  return {
    provider: 'fake',
    dim,
    embed: async (t: string) => vec(t),
    embedBatch: async (ts: string[]) => ts.map(vec),
  };
}

/** cosine 相似度 (纯函数, 供检索用; 维度不一致 → 0) */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
