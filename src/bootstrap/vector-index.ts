/**
 * vector-index.ts — 简化版 TF-IDF 文本检索 (Layer 4)
 *
 * 2026-07-07 新增. 解决:
 *   - 远端/本地月度归档 + 长文档无法语义检索
 *   - LLM prompt 缺历史上下文时只能 slice(-6) 看最近 6 条
 *   - 不引入 faiss / hnswlib 等重型依赖 (npm 包爆炸)
 *
 * 设计:
 *   - 倒排索引 + TF-IDF cosine similarity (够用, 不引向量库)
 *   - 英文按词切, 中文按字符 bigram 切 (混合分词)
 *   - 索引文件: ~/.bolloon/index/<indexName>.json
 *   - 单文档 < 4KB, 总文档 < 10000 时性能足够 (< 50ms 检索)
 *
 * 触发:
 *   - server.ts: buildIndex 启动时建一次, 增量 addDocument
 *   - server.ts: searchIndex(query, topK=3) → 注入 prompt
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ============== 类型 ==============

export interface IndexDocument {
  /** 唯一 ID */
  id: string;
  /** 文本内容 */
  text: string;
  /** 元数据 (source / type / timestamp / url 等) */
  metadata?: Record<string, unknown>;
}

export interface IndexSearchResult {
  id: string;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface InvertedIndex {
  /** 索引名 */
  name: string;
  /** 倒排索引: term → Set<docId> */
  postings: Record<string, string[]>;
  /** 文档频次: term → 多少 doc 包含 */
  docFreq: Record<string, number>;
  /** 文档向量长度: docId → sqrt(sum of tf^2 * idf^2) */
  docNorms: Record<string, number>;
  /** 文档表 */
  docs: Record<string, IndexDocument>;
  /** 总文档数 */
  totalDocs: number;
  /** 平均文档长度 (词数) */
  avgDocLen: number;
  /** 最后更新时间 */
  updatedAt: string;
}

export interface BuildIndexOptions {
  indexName: string;
  documents: IndexDocument[];
  home?: string;
}

export interface AddDocOptions {
  indexName: string;
  doc: IndexDocument;
  home?: string;
}

export interface SearchOptions {
  indexName: string;
  query: string;
  topK?: number;
  home?: string;
}

// ============== 路径 ==============

/** ~/.bolloon/index/<indexName>.json */
export function getIndexPath(indexName: string, home?: string): string {
  const root = path.join(home || os.homedir(), '.bolloon', 'index');
  return path.join(root, `${indexName.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

// ============== 分词 (中英混合) ==============

/**
 * 简易分词:
 *   - 英文/数字: 连续字母数字
 *   - 中文: 每个 char 单字 + bigram (覆盖常见短语)
 *   - 全部转小写, 去标点
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  // 1. 提取英文/数字词
  const enMatches = lower.match(/[a-z0-9]+/g);
  if (enMatches) tokens.push(...enMatches);

  // 2. 中文按 bigram (覆盖 "项目" "事件" 等常见短语)
  // 用 [\u4e00-\u9fff] 检测中文
  const chineseChars: string[] = [];
  for (const ch of lower) {
    if (/[\u4e00-\u9fff]/.test(ch)) chineseChars.push(ch);
  }
  for (let i = 0; i < chineseChars.length; i++) {
    tokens.push(chineseChars[i]); // 单字
    if (i + 1 < chineseChars.length) {
      tokens.push(chineseChars[i] + chineseChars[i + 1]); // bigram
    }
  }

  return tokens.filter(t => t.length > 0);
}

// ============== 索引构建 ==============

/**
 * 完整重建索引 (初次启动时调一次). 索引文件覆盖写.
 */
export async function buildIndex(opts: BuildIndexOptions): Promise<{ path: string; totalDocs: number }> {
  const index: InvertedIndex = {
    name: opts.indexName,
    postings: {},
    docFreq: {},
    docNorms: {},
    docs: {},
    totalDocs: 0,
    avgDocLen: 0,
    updatedAt: new Date().toISOString(),
  };

  let totalLen = 0;

  for (const doc of opts.documents) {
    const tokens = tokenize(doc.text);
    totalLen += tokens.length;
    index.docs[doc.id] = doc;
    index.docNorms[doc.id] = 0; // 后面算

    // 词频统计 (本 doc)
    const tf: Record<string, number> = {};
    for (const t of tokens) {
      tf[t] = (tf[t] || 0) + 1;
    }

    for (const [term, count] of Object.entries(tf)) {
      if (!index.postings[term]) index.postings[term] = [];
      if (!index.postings[term].includes(doc.id)) index.postings[term].push(doc.id);
      index.docFreq[term] = (index.docFreq[term] || 0) + 1;
    }
  }

  index.totalDocs = opts.documents.length;
  index.avgDocLen = index.totalDocs > 0 ? totalLen / index.totalDocs : 0;

  // 计算 docNorms (TF-IDF 向量长度)
  for (const docId of Object.keys(index.docs)) {
    const tokens = tokenize(index.docs[docId].text);
    const tf: Record<string, number> = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    let sum = 0;
    for (const [term, count] of Object.entries(tf)) {
      const idf = Math.log((index.totalDocs + 1) / ((index.docFreq[term] || 0) + 0.5));
      sum += Math.pow(count * idf, 2);
    }
    index.docNorms[docId] = Math.sqrt(sum);
  }

  const filePath = getIndexPath(opts.indexName, opts.home);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(index), 'utf-8');

  return { path: filePath, totalDocs: index.totalDocs };
}

/**
 * 读索引. 不存在 → 返回 null.
 */
export async function loadIndex(indexName: string, home?: string): Promise<InvertedIndex | null> {
  const filePath = getIndexPath(indexName, home);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.postings) return null;
    return parsed as InvertedIndex;
  } catch {
    return null;
  }
}

/**
 * 加单条文档到索引 (增量). 不存在 → 自动建空索引.
 */
export async function addDocument(opts: AddDocOptions): Promise<InvertedIndex> {
  let index = await loadIndex(opts.indexName, opts.home);
  if (!index) {
    await buildIndex({ indexName: opts.indexName, documents: [opts.doc], home: opts.home });
    return (await loadIndex(opts.indexName, opts.home))!;
  }

  // 增量更新
  const tokens = tokenize(opts.doc.text);
  if (index.docs[opts.doc.id]) {
    // 已存在 → 简单覆盖 (不维护精确 docNorms, 重建)
    const oldDoc = index.docs[opts.doc.id];
    const oldTokens = tokenize(oldDoc.text);
    for (const t of oldTokens) {
      if (index.postings[t]) {
        index.postings[t] = index.postings[t].filter(id => id !== opts.doc.id);
        if (index.postings[t].length === 0) delete index.postings[t];
      }
    }
  }

  index.docs[opts.doc.id] = opts.doc;

  const tf: Record<string, number> = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  for (const [term, count] of Object.entries(tf)) {
    if (!index.postings[term]) index.postings[term] = [];
    if (!index.postings[term].includes(opts.doc.id)) {
      index.postings[term].push(opts.doc.id);
      index.docFreq[term] = (index.docFreq[term] || 0) + 1;
    }
  }

  index.totalDocs = Object.keys(index.docs).length;

  // 简化: 不重算所有 docNorms, 只算本条 (足够增量场景)
  let sum = 0;
  for (const [term, count] of Object.entries(tf)) {
    const idf = Math.log((index.totalDocs + 1) / ((index.docFreq[term] || 0) + 0.5));
    sum += Math.pow(count * idf, 2);
  }
  index.docNorms[opts.doc.id] = Math.sqrt(sum);

  index.updatedAt = new Date().toISOString();

  const filePath = getIndexPath(opts.indexName, opts.home);
  await fs.writeFile(filePath, JSON.stringify(index), 'utf-8');
  return index;
}

// ============== 检索 ==============

/**
 * TF-IDF cosine similarity top-K 检索.
 */
export async function searchIndex(opts: SearchOptions): Promise<IndexSearchResult[]> {
  const index = await loadIndex(opts.indexName, opts.home);
  if (!index || index.totalDocs === 0) return [];

  const queryTokens = tokenize(opts.query);
  if (queryTokens.length === 0) return [];

  // 查询向量
  const queryTf: Record<string, number> = {};
  for (const t of queryTokens) queryTf[t] = (queryTf[t] || 0) + 1;
  let queryNorm = 0;
  const queryVec: Record<string, number> = {};
  for (const [term, count] of Object.entries(queryTf)) {
    const idf = Math.log((index.totalDocs + 1) / ((index.docFreq[term] || 0) + 0.5));
    const w = count * idf;
    queryVec[term] = w;
    queryNorm += w * w;
  }
  queryNorm = Math.sqrt(queryNorm);
  if (queryNorm === 0) return [];

  // 候选 doc 集合 (所有包含 query term 的 doc)
  const candidates = new Set<string>();
  for (const term of Object.keys(queryTf)) {
    const posting = index.postings[term] || [];
    for (const id of posting) candidates.add(id);
  }

  // 计算 cosine
  const scores: Array<{ id: string; score: number }> = [];
  for (const docId of candidates) {
    const docTokens = tokenize(index.docs[docId]?.text || '');
    const docTf: Record<string, number> = {};
    for (const t of docTokens) docTf[t] = (docTf[t] || 0) + 1;

    let dot = 0;
    for (const term of Object.keys(queryTf)) {
      const dw = (docTf[term] || 0) * Math.log((index.totalDocs + 1) / ((index.docFreq[term] || 0) + 0.5));
      dot += queryVec[term] * dw;
    }
    const docNorm = index.docNorms[docId] || 0;
    if (docNorm === 0) continue;
    const score = dot / (queryNorm * docNorm);
    if (score > 0) scores.push({ id: docId, score });
  }

  scores.sort((a, b) => b.score - a.score);
  const topK = opts.topK ?? 3;

  return scores.slice(0, topK).map(s => ({
    id: s.id,
    score: s.score,
    text: index.docs[s.id]?.text || '',
    metadata: index.docs[s.id]?.metadata,
  }));
}

// ============== 删除 ==============

export async function deleteIndex(indexName: string, home?: string): Promise<void> {
  const filePath = getIndexPath(indexName, home);
  try {
    await fs.unlink(filePath);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
}