/**
 * judgeness · store.ts
 *
 * 落盘布局 (与 plan §5.1 一致):
 *   ~/.bolloon/judgeness/
 *     descriptions/<jd-id>.md        # 单 description 可读版 (frontmatter v2 + body)
 *     tags.yaml                       # 全局 tags 聚合
 *     visibility.yaml                 # 隐私策略
 *     allowlist.yaml                  # 白名单
 *     hearth-cache/<remote-pk>/       # 远端用户缓存
 *       manifest.json
 *       descriptions/<jd-id>.md
 *       last-seen.txt
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type {
  JudgenessDescription,
  JudgenessVisibilityFile,
  JudgenessAllowlistFile,
  JudgenessAllowlistEntry,
  HearthCacheManifest,
  JudgenessVisibility,
  JudgenessOpenState,
} from './types.js';

// ---------------------------------------------------------------------------
// 路径常量 (每次重读 env, 支持测试隔离)
// ---------------------------------------------------------------------------

export function homeDir(): string {
  return process.env.BOLLOON_HOME || path.join(os.homedir(), '.bolloon');
}

export function JUDGENESS_ROOT(): string {
  return path.join(homeDir(), 'judgeness');
}
function DESCRIPTIONS_DIR(): string { return path.join(JUDGENESS_ROOT(), 'descriptions'); }
function TAGS_FILE(): string { return path.join(JUDGENESS_ROOT(), 'tags.yaml'); }
function VISIBILITY_FILE(): string { return path.join(JUDGENESS_ROOT(), 'visibility.yaml'); }
function ALLOWLIST_FILE(): string { return path.join(JUDGENESS_ROOT(), 'allowlist.yaml'); }
function HEARTH_CACHE_ROOT(): string { return path.join(JUDGENESS_ROOT(), 'hearth-cache'); }

// ---------------------------------------------------------------------------
// id 生成
// ---------------------------------------------------------------------------

export function newDescriptionId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(3).toString('hex');
  return `jd-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// ensureDirs
// ---------------------------------------------------------------------------

export async function ensureJudgenessDirs(): Promise<void> {
  await fs.mkdir(JUDGENESS_ROOT(), { recursive: true });
  await fs.mkdir(DESCRIPTIONS_DIR(), { recursive: true });
  await fs.mkdir(HEARTH_CACHE_ROOT(), { recursive: true });
}

// ---------------------------------------------------------------------------
// description 落盘 / 读回 (md with frontmatter v2)
// ---------------------------------------------------------------------------

function descriptionMdPath(id: string): string {
  return path.join(DESCRIPTIONS_DIR(), `${id}.md`);
}

function escapeYamlString(s: string): string {
  // 单行安全: 包裹单引号 + 转义单引号. 避免依赖 js-yaml.
  return `'${s.replace(/'/g, "''")}'`;
}

function safeVer(v: number | undefined): number {
  return v === 1 ? 1 : 0;
}

function descriptionToMarkdown(desc: JudgenessDescription): string {
  const fm = [
    '---',
    `descriptionId: ${desc.descriptionId}`,
    `judgmentRef: ${desc.judgmentRef}`,
    `description_version: ${safeVer(desc.description_version)}`,
    'facets:',
    desc.facets.judgment !== undefined ? `  judgment: ${desc.facets.judgment}` : '  judgment: null',
    desc.facets.taste_aesthetic !== undefined ? `  taste_aesthetic: ${desc.facets.taste_aesthetic}` : '  taste_aesthetic: null',
    desc.facets.novelty_score !== undefined ? `  novelty_score: ${desc.facets.novelty_score}` : '  novelty_score: null',
    desc.facets.imaginative_score !== undefined ? `  imaginative_score: ${desc.facets.imaginative_score}` : '  imaginative_score: null',
    desc.facets.curiosity_vector !== undefined ? `  curiosity_vector: ${desc.facets.curiosity_vector}` : '  curiosity_vector: null',
    'basis:',
    desc.basis.taste_basis ? `  taste_basis: ${escapeYamlString(desc.basis.taste_basis)}` : '  taste_basis: null',
    desc.basis.novelty_basis ? `  novelty_basis: ${escapeYamlString(desc.basis.novelty_basis)}` : '  novelty_basis: null',
    desc.basis.imagination_basis ? `  imagination_basis: ${escapeYamlString(desc.basis.imagination_basis)}` : '  imagination_basis: null',
    'scope:',
    desc.scope.domains && desc.scope.domains.length > 0
      ? `  domains: [${desc.scope.domains.map((d) => escapeYamlString(d)).join(', ')}]`
      : '  domains: []',
    desc.scope.topics && desc.scope.topics.length > 0
      ? `  topics: [${desc.scope.topics.map((d) => escapeYamlString(d)).join(', ')}]`
      : '  topics: []',
    `visibility: ${desc.visibility}`,
    `openState: ${desc.openState}`,
    `by: ${desc.by}`,
    desc.byAgentId ? `byAgentId: ${escapeYamlString(desc.byAgentId)}` : 'byAgentId: null',
    `createdAt: ${escapeYamlString(desc.createdAt)}`,
    `updatedAt: ${escapeYamlString(desc.updatedAt)}`,
    desc.lastTransitionAt ? `lastTransitionAt: ${escapeYamlString(desc.lastTransitionAt)}` : 'lastTransitionAt: null',
    'schema_version: 2',
    'audience: self',
    'stage: current',
    'status: current',
    `entity_type: concept`,
    `tags: [judgeness, judgment-ref=${desc.judgmentRef}, visibility=${desc.visibility}, state=${desc.openState}]`,
    '---',
    '',
    `# Judgeness Description ${desc.descriptionId}`,
    '',
    `## Judgment Reference`,
    `- judgmentRef: ${desc.judgmentRef}`,
    '',
    `## Facets`,
    `- judgment: ${desc.facets.judgment ?? 'n/a'}`,
    `- taste_aesthetic: ${desc.facets.taste_aesthetic ?? 'n/a'}${desc.basis.taste_basis ? ' — ' + desc.basis.taste_basis : ''}`,
    `- novelty_score: ${desc.facets.novelty_score ?? 'n/a'}${desc.basis.novelty_basis ? ' — ' + desc.basis.novelty_basis : ''}`,
    `- imaginative_score: ${desc.facets.imaginative_score ?? 'n/a'}${desc.basis.imagination_basis ? ' — ' + desc.basis.imagination_basis : ''}`,
    `- curiosity_vector: ${desc.facets.curiosity_vector ?? 'n/a'}`,
    '',
    `## Scope`,
    `- domains: ${(desc.scope.domains ?? []).join(', ') || '(any)'}`,
    `- topics: ${(desc.scope.topics ?? []).join(', ') || '(any)'}`,
    '',
    `## Privacy`,
    `- visibility: ${desc.visibility}`,
    `- openState: ${desc.openState}`,
    `- by: ${desc.by}${desc.byAgentId ? ' (' + desc.byAgentId + ')' : ''}`,
    '',
  ];
  return fm.join('\n');
}

// (旧 declare-module hack 已移除 — types.ts 已允许 description_version: 1 | 0)

function parseMarkdownToDescription(raw: string): JudgenessDescription | null {
  // 极简 frontmatter 解析 (匹配 key: value; facets/scope 走单行)
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const get = (key: string): string | undefined => {
    // ^[ ]* 让缩进子键 (如 `  judgment: 0.7`) 也能匹配
    const re = new RegExp(`^[ ]*${key}:\\s*(.*)$`, 'm');
    const x = fm.match(re);
    if (!x) return undefined;
    let v = x[1].trim();
    if (v === 'null' || v === '~') return undefined;
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    return v;
  };
  const getNum = (key: string): number | undefined => {
    const v = get(key);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const getList = (key: string): string[] | undefined => {
    const v = get(key);
    if (v === undefined) return undefined;
    if (!v.startsWith('[')) return undefined;
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.trim().replace(/^'|'$/g, '').replace(/''/g, "'"));
  };

  const descriptionId = get('descriptionId');
  const judgmentRef = get('judgmentRef');
  if (!descriptionId || !judgmentRef) return null;

  return {
    descriptionId,
    judgmentRef,
    description_version: (getNum('description_version') ?? 1) as 1,
    facets: {
      judgment: getNum('judgment'),
      taste_aesthetic: getNum('taste_aesthetic'),
      novelty_score: getNum('novelty_score'),
      imaginative_score: getNum('imaginative_score'),
      curiosity_vector: getNum('curiosity_vector'),
    },
    basis: {
      taste_basis: get('taste_basis'),
      novelty_basis: get('novelty_basis'),
      imagination_basis: get('imagination_basis'),
    },
    scope: {
      domains: getList('domains') ?? [],
      topics: getList('topics') ?? [],
    },
    visibility: (get('visibility') ?? 'private') as JudgenessVisibility,
    openState: (get('openState') ?? 'locked') as JudgenessOpenState,
    by: (get('by') ?? 'human') as 'human' | 'agent',
    byAgentId: get('byAgentId'),
    createdAt: get('createdAt') ?? new Date().toISOString(),
    updatedAt: get('updatedAt') ?? new Date().toISOString(),
    lastTransitionAt: get('lastTransitionAt'),
  };
}

export async function saveDescription(desc: JudgenessDescription): Promise<void> {
  await ensureJudgenessDirs();
  const md = descriptionToMarkdown(desc);
  const tmp = descriptionMdPath(desc.descriptionId) + '.tmp';
  await fs.writeFile(tmp, md, 'utf-8');
  await fs.rename(tmp, descriptionMdPath(desc.descriptionId));
}

export async function loadDescription(id: string): Promise<JudgenessDescription | null> {
  try {
    const raw = await fs.readFile(descriptionMdPath(id), 'utf-8');
    return parseMarkdownToDescription(raw);
  } catch {
    return null;
  }
}

export async function listDescriptions(): Promise<JudgenessDescription[]> {
  await ensureJudgenessDirs();
  const files = await fs.readdir(DESCRIPTIONS_DIR()).catch(() => [] as string[]);
  const out: JudgenessDescription[] = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const id = f.slice(0, -3);
    const d = await loadDescription(id);
    if (d) out.push(d);
  }
  return out;
}

export async function findDescriptionByJudgmentRef(ref: string): Promise<JudgenessDescription | null> {
  const all = await listDescriptions();
  return all.find((d) => d.judgmentRef === ref) ?? null;
}

// ---------------------------------------------------------------------------
// visibility.yaml
// ---------------------------------------------------------------------------

function visFileToYaml(f: JudgenessVisibilityFile): string {
  const lines: string[] = ['# judgeness/visibility.yaml', `version: ${f.version}`, 'defaults:'];
  lines.push(`  visibility: ${f.defaults.visibility}`);
  lines.push(`  openState: ${f.defaults.openState}`);
  lines.push('channels:');
  for (const c of f.channels) {
    lines.push(`  - channelId: ${c.channelId}`);
    lines.push(`    visibility: ${c.visibility}`);
    lines.push(`    openState: ${c.openState}`);
    lines.push(`    humanOverride: ${c.humanOverride}`);
  }
  lines.push('cards:');
  if (f.cards.length === 0) lines.push('  []');
  else for (const c of f.cards) {
    lines.push(`  - descriptionId: ${c.descriptionId}`);
    lines.push(`    visibility: ${c.visibility}`);
    lines.push(`    openState: ${c.openState}`);
    lines.push(`    humanOverride: ${c.humanOverride}`);
  }
  return lines.join('\n') + '\n';
}

function parseVisYaml(raw: string): JudgenessVisibilityFile {
  // 极简行解析 — 不引依赖
  const lines = raw.split('\n');
  const f: JudgenessVisibilityFile = {
    version: 1,
    defaults: { visibility: 'private', openState: 'locked' },
    channels: [],
    cards: [],
  };
  let section: 'root' | 'defaults' | 'channels' | 'cards' | 'cardItem' | 'channelItem' = 'root';
  let curChannel: any = null;
  let curCard: any = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t === 'defaults:') { section = 'defaults'; continue; }
    if (t === 'channels:') { section = 'channels'; continue; }
    if (t === 'cards:') { section = 'cards'; continue; }
    if (t.startsWith('- ')) {
      const kv = t.slice(2).split(':').map((s) => s.trim());
      const k = kv[0];
      const v = kv.slice(1).join(':');
      if (section === 'channels') { curChannel = { [k]: v }; f.channels.push(curChannel); section = 'channelItem'; continue; }
      if (section === 'cards') { curCard = { [k]: v }; f.cards.push(curCard); section = 'cardItem'; continue; }
    }
    if (section === 'defaults' || section === 'channelItem' || section === 'cardItem') {
      const kv = t.split(':').map((s) => s.trim());
      const k = kv[0];
      const v = kv.slice(1).join(':');
      if (section === 'defaults') {
        if (k === 'visibility') f.defaults.visibility = v as any;
        if (k === 'openState') f.defaults.openState = v as any;
      } else if (section === 'channelItem' && curChannel) {
        if (k === 'visibility') curChannel.visibility = v;
        if (k === 'openState') curChannel.openState = v;
        if (k === 'humanOverride') curChannel.humanOverride = v === 'true';
      } else if (section === 'cardItem' && curCard) {
        if (k === 'visibility') curCard.visibility = v;
        if (k === 'openState') curCard.openState = v;
        if (k === 'humanOverride') curCard.humanOverride = v === 'true';
      }
    }
  }
  return f;
}

export async function loadVisibility(): Promise<JudgenessVisibilityFile> {
  try {
    const raw = await fs.readFile(VISIBILITY_FILE(), 'utf-8');
    return parseVisYaml(raw);
  } catch {
    return {
      version: 1,
      defaults: { visibility: 'private', openState: 'locked' },
      channels: [],
      cards: [],
    };
  }
}

export async function saveVisibility(f: JudgenessVisibilityFile): Promise<void> {
  await ensureJudgenessDirs();
  const tmp = VISIBILITY_FILE() + '.tmp';
  await fs.writeFile(tmp, visFileToYaml(f), 'utf-8');
  await fs.rename(tmp, VISIBILITY_FILE());
}

// ---------------------------------------------------------------------------
// allowlist.yaml
// ---------------------------------------------------------------------------

function allowlistToYaml(f: JudgenessAllowlistFile): string {
  const lines: string[] = ['# judgeness/allowlist.yaml', `version: ${f.version}`, 'peers:'];
  if (f.peers.length === 0) { lines.push('  []'); }
  else {
    for (const p of f.peers) {
      lines.push(`  - pubkey: ${p.pubkey}`);
      if (p.alias) lines.push(`    alias: ${escapeYamlString(p.alias)}`);
      if (p.note) lines.push(`    note: ${escapeYamlString(p.note)}`);
      lines.push(`    addedAt: ${escapeYamlString(p.addedAt)}`);
    }
  }
  return lines.join('\n') + '\n';
}

function parseAllowlistYaml(raw: string): JudgenessAllowlistFile {
  const f: JudgenessAllowlistFile = { version: 1, peers: [] };
  const lines = raw.split('\n');
  let cur: Partial<JudgenessAllowlistEntry> | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('- ')) {
      if (cur && cur.pubkey) f.peers.push(cur as JudgenessAllowlistEntry);
      const kv = t.slice(2).split(':').map((s) => s.trim());
      cur = { pubkey: kv.slice(1).join(':').trim() } as any;
      continue;
    }
    if (cur) {
      const idx = t.indexOf(':');
      if (idx === -1) continue;
      const k = t.slice(0, idx).trim();
      let v = t.slice(idx + 1).trim();
      if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
      (cur as any)[k] = v;
    }
  }
  if (cur && cur.pubkey) f.peers.push(cur as JudgenessAllowlistEntry);
  return f;
}

export async function loadAllowlist(): Promise<JudgenessAllowlistFile> {
  try {
    const raw = await fs.readFile(ALLOWLIST_FILE(), 'utf-8');
    return parseAllowlistYaml(raw);
  } catch {
    return { version: 1, peers: [] };
  }
}

export async function saveAllowlist(f: JudgenessAllowlistFile): Promise<void> {
  await ensureJudgenessDirs();
  const tmp = ALLOWLIST_FILE() + '.tmp';
  await fs.writeFile(tmp, allowlistToYaml(f), 'utf-8');
  await fs.rename(tmp, ALLOWLIST_FILE());
}

export async function isPubkeyAllowed(targetPubkey: string): Promise<boolean> {
  const f = await loadAllowlist();
  return f.peers.some((p) => p.pubkey === targetPubkey);
}

export async function addAllowlistPeer(entry: JudgenessAllowlistEntry): Promise<void> {
  const f = await loadAllowlist();
  const existing = f.peers.findIndex((p) => p.pubkey === entry.pubkey);
  if (existing >= 0) f.peers[existing] = entry;
  else f.peers.push(entry);
  await saveAllowlist(f);
}

export async function removeAllowlistPeer(pubkey: string): Promise<void> {
  const f = await loadAllowlist();
  f.peers = f.peers.filter((p) => p.pubkey !== pubkey);
  await saveAllowlist(f);
}

// ---------------------------------------------------------------------------
// hearth-cache/<remote-pk>/
// ---------------------------------------------------------------------------

function cacheDir(remotePubkey: string): string {
  const sub = remotePubkey.slice(0, 16) + '__' + remotePubkey.slice(0, 8);
  return path.join(HEARTH_CACHE_ROOT(), sub);
}

export async function writeHearthCache(
  remotePubkey: string,
  manifest: HearthCacheManifest,
  descriptions: JudgenessDescription[]
): Promise<void> {
  await ensureJudgenessDirs();
  const dir = cacheDir(remotePubkey);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, 'descriptions'), { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.writeFile(path.join(dir, 'last-seen.txt'), new Date().toISOString(), 'utf-8');
  for (const d of descriptions) {
    await fs.writeFile(path.join(dir, 'descriptions', `${d.descriptionId}.md`), descriptionToMarkdown(d), 'utf-8');
  }
}

export async function readHearthCache(remotePubkey: string): Promise<HearthCacheManifest | null> {
  try {
    const raw = await fs.readFile(path.join(cacheDir(remotePubkey), 'manifest.json'), 'utf-8');
    return JSON.parse(raw) as HearthCacheManifest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// tags.yaml (聚合器, 反攻期主用; 防御期写空壳)
// ---------------------------------------------------------------------------

export async function aggregateTags(): Promise<string[]> {
  const descs = await listDescriptions();
  const set = new Set<string>();
  for (const d of descs) {
    (d.scope.topics ?? []).forEach((t) => set.add(t));
    (d.scope.domains ?? []).forEach((t) => set.add(t));
  }
  return Array.from(set).sort();
}

export async function writeTagsAggregate(): Promise<void> {
  await ensureJudgenessDirs();
  const tags = await aggregateTags();
  const yaml = ['# judgeness/tags.yaml', `version: 1`, `count: ${tags.length}`, 'tags:'];
  for (const t of tags) yaml.push(`  - ${escapeYamlString(t)}`);
  const tmp = TAGS_FILE() + '.tmp';
  await fs.writeFile(tmp, yaml.join('\n') + '\n', 'utf-8');
  await fs.rename(tmp, TAGS_FILE());
}
