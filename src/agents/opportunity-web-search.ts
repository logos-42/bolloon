/**
 * opportunity-web-search.ts — AI 主动上网搜机会 (2026-10-05, leo: 系统要主动搜索展示)
 *
 * 设计: 世界观察器 (world-watcher) 每轮 tick 时, 若有 active intent / 用户画像,
 *   自动用 DuckDuckGo 搜索「<意图> + 合作/机会/招募/开放」类关键词, 把真搜索结果
 *   结构化落盘 `~/.bolloon/world/search/<id>.json`, 并进世界流 (reason=search, 带来源 URL)。
 *
 * 真实可信: 每条 = 真 URL + 真摘要 (来自搜索返回), 可点开核实, 不是本机编造。
 * 无 TAVILY_API_KEY 时走 DuckDuckGo HTML 端点 (免费无需 key, 与本仓 fetch_url 同源 curl 模式)。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { worldDir } from './intent-store.js';

const pExecFile = promisify(execFile);

/** 搜索到的一条机会 (结构化, 落盘) */
export interface SearchOpportunity {
  id: string;
  query: string;
  title: string;
  url: string;
  summary: string;
  source: 'duckduckgo' | 'tavily';
  searchedAt: number;
}

const searchDir = (): string => path.join(worldDir(), 'search');

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** DuckDuckGo HTML 搜索 → 结构化结果 (标题/URL/摘要) */
async function searchDuckDuckGo(query: string, limit = 8): Promise<Array<{ title: string; url: string; summary: string }>> {
  try {
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    const { stdout } = await pExecFile('curl', [
      '-sL', '--max-time', '20', '-A', UA,
      '-H', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    ], { maxBuffer: 2 * 1024 * 1024, timeout: 25_000 });
    if (!stdout) return [];
    // 解析 result__a (标题+URL) + result__snippet (摘要)
    const out: Array<{ title: string; url: string; summary: string }> = [];
    const itemRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/g;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = itemRe.exec(stdout)) !== null && guard++ < 30) {
      const rawHref = m[1];
      // DDG 的 href 是重定向包装 (//duckduckgo.com/l/?uddg=<encoded>)
      let url = rawHref;
      const uddg = rawHref.match(/uddg=([^&]+)/);
      if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { url = rawHref; } }
      if (!/^https?:\/\//i.test(url)) continue;
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      const summary = m[3].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
      if (title) out.push({ title, url, summary: summary.slice(0, 200) });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

/** Tavily 搜索 (配置了 TAVILY_API_KEY 时用, 更完整) */
async function searchTavily(query: string, limit = 8): Promise<Array<{ title: string; url: string; summary: string }>> {
  const key = process.env.TAVILY_API_KEY || '';
  if (!key) return [];
  try {
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
    const { stdout } = await pExecFile('curl', [
      '-s', '--max-time', '20', '-A', UA,
      '-X', 'POST', 'https://api.tavily.com/search',
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ api_key: key, query, max_results: limit, include_answer: false }),
    ], { maxBuffer: 2 * 1024 * 1024, timeout: 25_000 });
    const d = JSON.parse(stdout);
    return (d.results || []).slice(0, limit).map((x: any) => ({
      title: String(x.title || '').trim(),
      url: String(x.url || '').trim(),
      summary: String(x.content || '').replace(/\s+/g, ' ').slice(0, 200),
    })).filter((x: any) => x.title && /^https?:/.test(x.url));
  } catch { return []; }
}

/** 搜索查询构造: 意图/画像 + 机会类词 (真搜索, 关键词可配) */
const OPPORTUNITY_HINTS = ['合作', '机会', '招募', 'open call', 'partnership', 'looking for', 'call for'];

function buildQueries(topic: string): string[] {
  const base = String(topic || '').trim().slice(0, 60);
  if (!base) return [];
  return OPPORTUNITY_HINTS.map((h) => `${base} ${h}`);
}

/**
 * 主动搜索一轮: 按 topic (意图/画像文本) 搜机会, 结构化落盘。
 * 返回本轮新增条数 (已有同 URL 的不重复落盘 — 幂等)。
 */
export async function searchOpportunitiesForTopic(topic: string, opts: { limit?: number } = {}): Promise<{
  ok: boolean;
  added: number;
  total: number;
  results: SearchOpportunity[];
  error?: string;
}> {
  const limit = opts.limit ?? 6;
  const queries = buildQueries(topic);
  if (!queries.length) return { ok: false, added: 0, total: 0, results: [], error: '空 topic' };

  // 合并引擎结果 (Tavily 优先, 无 key 走 DDG)
  const engine = process.env.TAVILY_API_KEY ? searchTavily : searchDuckDuckGo;
  const raw: Array<{ title: string; url: string; summary: string; query: string }> = [];
  for (const q of queries.slice(0, 3)) {
    const hits = await engine(q, limit);
    for (const h of hits) raw.push({ ...h, query: q });
  }

  // 已有 URL 集合 (幂等)
  const seen: Set<string> = new Set();
  try {
    const files = await fs.readdir(searchDir());
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const p = JSON.parse(await fs.readFile(path.join(searchDir(), f), 'utf-8'));
        if (p && p.url) seen.add(String(p.url));
      } catch { /* 坏文件跳过 */ }
    }
  } catch { /* 目录不存在 = 首次 */ }

  const now = Date.now();
  const results: SearchOpportunity[] = [];
  let added = 0;
  try {
    await fs.mkdir(searchDir(), { recursive: true });
  } catch { /* 落盘失败不阻断 */ }
  for (const r of raw) {
    if (seen.has(r.url)) continue; // 已有, 不重复
    const id = `search_${safeId(crypto.createHash('sha256').update(r.url).digest('hex').slice(0, 14))}`;
    const opp: SearchOpportunity = {
      id,
      query: r.query,
      title: r.title.slice(0, 80),
      url: r.url,
      summary: r.summary,
      source: process.env.TAVILY_API_KEY ? 'tavily' : 'duckduckgo',
      searchedAt: now,
    };
    try {
      await fs.writeFile(path.join(searchDir(), `${id}.json`), JSON.stringify(opp, null, 2) + '\n', { mode: 0o600 });
      seen.add(r.url);
      results.push(opp);
      added += 1;
    } catch { /* 单条失败跳过 */ }
    if (added >= limit) break;
  }
  // 2026-10-05 降级 (leo: 输入后要足够多机会): 引擎被限流/返回空时,
  // 从已有搜索库按关键词相关度返回匹配旧结果 — 保证输入后总有内容 (不假装, 都是真 URL)。
  if (added === 0) {
    try {
      const existing = await listSearchOpportunities();
      const topicTags = buildTags(topic);
      const related = existing
        .map((o) => {
          const tags = buildTags(`${o.title} ${o.summary} ${o.query || ''}`);
          const hit = topicTags.filter((t) => tags.includes(t)).length;
          return { o, hit };
        })
        .filter((x) => x.hit > 0)
        .sort((a, b) => b.hit - a.hit)
        .slice(0, limit);
      for (const { o } of related) {
        results.push({ ...o, query: `${topic} (相关)` });
      }
      if (results.length > 0) {
        return { ok: true, added: 0, total: results.length, results, error: '引擎限流, 已返回相关旧结果' };
      }
    } catch { /* 降级失败不影响 */ }
  }
  return { ok: true, added, total: results.length, results };
}

/** 提取关键词标签 (分词: ASCII 词 + CJK 二元片) — 用于相关度匹配 (导出供测试) */
export function buildTags(text: string): string[] {
  const src = String(text || '').toLowerCase();
  const words = src.match(/[a-z][a-z0-9_-]{2,}/g) || [];
  const cjk = src.match(/[\u4e00-\u9fff]+/g) || [];
  const cjkBigrams = cjk.flatMap((s) => {
    if (s.length <= 2) return [s];
    const out: string[] = [];
    for (let i = 0; i + 1 < s.length; i += 1) out.push(s.slice(i, i + 2));
    return out;
  });
  return Array.from(new Set([...words, ...cjkBigrams]));
}

/** 列出已搜索到的机会 (最近在前) */
export async function listSearchOpportunities(): Promise<SearchOpportunity[]> {
  try {
    const files = await fs.readdir(searchDir());
    const out: SearchOpportunity[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const p = JSON.parse(await fs.readFile(path.join(searchDir(), f), 'utf-8'));
        if (p && p.id && p.url) out.push(p);
      } catch { /* 坏文件跳过 */ }
    }
    return out.sort((a, b) => b.searchedAt - a.searchedAt);
  } catch { return []; }
}
