/**
 * skills-manager.ts — Skills Manager Runtime 的统一门面 (2026-09-16, 批次 2-G.1)
 *
 * 之前的问题: 技能能力被拆成四个各自为政的入口 (skill-loader 扫描 / skill-share 打包分享 /
 * skill-writer 生成 / skill-organizer 整理), 谁也不知道"这个技能现在到底是什么状态、来自哪里、能不能用",
 * CLI / Web / agent 各看各的。长期执行的 Goal 因此无法固定"我依赖的技能是哪一版"。
 *
 * 这一层做的事 (2-G.1 范围):
 *   - **统一事实模型**: 每个技能一条 `SkillRecord` (skillId/name/version/contentHash/source/sourceRef/
 *     status/trust/compatibility/installedAt/updatedAt);
 *   - **统一入口**: discover / inspect / install / import / enable / disable / validate / resolve /
 *     snapshot / health / export —— CLI / Web / Supervisor / agent 都只走这里, 不再各自直调底层模块;
 *   - **内容真值仍是 SKILL.md**, 管理元数据落在 `~/.bolloon/skills-registry.json` (不让 loader/share/writer 各自推断)。
 *
 * 2-G.1 **刻意不改执行行为**: enable/disable/status 只被记录与展示; 真正用它拦执行 (readiness gate)
 * 与 Goal 级 skill snapshot 属 2-G.2/2-G.4。
 */

import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
// 2026-09-16 (2-G.3): 事务型导入复用底层真实实现 (别名避免与上面重名)
import { parseSkillBundle as parseBundleLoose, parseSkillRef as parseSkillRefLoose, fetchSkillBundle as fetchBundleLoose } from './skill-share.js';
import { sanitizeSkillName as sanitizeNameLoose, getUserSkillsDir as userSkillsDirLoose, getProjectSkillsDir as projectSkillsDirLoose } from './skill-writer.js';
import { parseSkillFile as parseSkillFileLoose } from './skill-loader.js';
import { parseSkillFile, SkillMeta, defaultSkillPaths } from './skill-loader.js';
import { getUserSkillsDir } from './skill-writer.js';
import {
  collectSkillBundle,
  type SkillBundle,
} from './skill-share.js';

// ─────────────────────────────────────────────────────────────────────────────
// 事实模型
// ─────────────────────────────────────────────────────────────────────────────

export type SkillStatus = 'discovered' | 'installed' | 'enabled' | 'disabled' | 'archived' | 'invalid' | 'quarantined';
export type SkillSource = 'project' | 'user' | 'imported' | 'shared' | 'generated';
export type SkillTrust = 'verified' | 'unverified' | 'quarantined';

export interface SkillRecord {
  /** 稳定 id (= name 的规范形式; 单独留字段以便以后换命名空间) */
  skillId: string;
  name: string;
  description: string;
  version: string;
  /** 技能目录整体内容摘要 (SKILL.md + references 等, 排序后逐文件摘要) */
  contentHash: string;
  source: SkillSource;
  /** 来源指向: 本地路径 / CID / 分享链接 / 生成它的 runId */
  sourceRef?: string;
  status: SkillStatus;
  trust: SkillTrust;
  compatibility?: string;
  tier: string;
  triggers: string[];
  /** SKILL.md 绝对路径 */
  skillFile: string;
  dir: string;
  fileCount: number;
  bytes: number;
  installedAt: string;
  updatedAt: string;
  /** validate() 发现的问题 (空 = 没有问题) */
  issues: string[];
  /** registry 记录的 hash (用于检出内容漂移) */
  registryHash?: string;
  /** 人工批准信息 (approve()) */
  approvedBy?: string;
  approvedAt?: string;
  /** 被隔离的原因与时间 (quarantine()) */
  quarantineReason?: string;
  quarantinedAt?: string;
}

export interface SkillSnapshotEntry {
  name: string;
  version: string;
  contentHash: string;
  source: SkillSource;
  resolvedAt: string;
}

export interface SkillsRegistryFile {
  schema: 'bolloon-skills-registry/1';
  /** name → 管理元数据 (内容真值仍在 SKILL.md) */
  skills: Record<string, Partial<SkillRecord> & { name: string }>;
  updatedAt: string;
}

export interface SkillHealth {
  total: number;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  /** 内容被改过 (hash 与 registry 不一致) */
  drifted: { name: string; expected?: string; actual: string }[];
  /** 结构/内容有问题的 */
  invalid: { name: string; issues: string[] }[];
  /** 同名出现在多个目录 */
  duplicates: { name: string; dirs: string[] }[];
  /** registry 里记着、盘上找不到的 */
  missing: string[];
}

// ─────────────────────────────────────────────────────────────────────────────

export function registryPath(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'skills-registry.json');
}

async function readRegistry(home: string): Promise<SkillsRegistryFile> {
  try {
    const raw = JSON.parse(await fsp.readFile(registryPath(home), 'utf8')) as SkillsRegistryFile;
    if (raw && typeof raw.skills === 'object' && raw.skills) return raw;
  } catch { /* 缺文件/坏文件 → 空 registry (不阻挡发现) */ }
  return { schema: 'bolloon-skills-registry/1', skills: {}, updatedAt: new Date(0).toISOString() };
}

async function writeRegistry(reg: SkillsRegistryFile, home: string): Promise<void> {
  const p = registryPath(home);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  reg.updatedAt = new Date().toISOString();
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(reg, null, 2), 'utf8');
  await fsp.rename(tmp, p);                     // 原子替换
}

/** 技能目录内容摘要: 排序后逐文件 sha256 → 再摘要一次 (目录整体指纹) */
export async function hashSkillDir(dir: string): Promise<{ hash: string; fileCount: number; bytes: number; issues: string[] }> {
  const issues: string[] = [];
  const files: { rel: string; content: Buffer }[] = [];
  let bytes = 0;
  const walk = async (d: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (err) {
      issues.push(`目录不可读: ${String((err as Error)?.message || err).slice(0, 80)}`);
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { issues.push(`符号链接被跳过 (避免越界): ${rel}`); continue; }
      if (e.isDirectory()) { await walk(abs, rel); continue; }
      if (!e.isFile()) continue;
      try {
        const buf = await fsp.readFile(abs);
        bytes += buf.length;
        files.push({ rel, content: buf });
      } catch (err) {
        issues.push(`文件不可读: ${rel} (${String((err as Error)?.message || err).slice(0, 60)})`);
      }
    }
  };
  await walk(dir, '');
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f.rel);
    h.update('\0');
    h.update(crypto.createHash('sha256').update(f.content).digest());
  }
  return { hash: h.digest('hex').slice(0, 32), fileCount: files.length, bytes, issues };
}

/** 单条记录的结构校验 (纯函数, 可单测) */
export function validateSkillRecord(input: { name: string; description: string; body: string; frontmatter: Record<string, unknown>; bytes: number; issues?: string[] }): string[] {
  const issues = [...(input.issues || [])];
  if (!input.name || !/^[a-z0-9_-]{1,64}$/i.test(input.name)) issues.push('技能名非法 (只允许字母数字下划线连字符, ≤64)');
  if (!input.description || input.description.trim().length < 4) issues.push('缺少 description (SKILL.md frontmatter)');
  if (!input.body || input.body.trim().length < 20) issues.push('正文内容过少 (可能不是有效的 SKILL.md)');
  if (input.bytes > 2 * 1024 * 1024) issues.push(`技能体积过大 (${Math.round(input.bytes / 1024)}KB > 2MB)`);
  const fmStatus = String(input.frontmatter?.status ?? 'active');
  if (!['active', 'archived', 'draft'].includes(fmStatus)) issues.push(`frontmatter.status 非法: ${fmStatus}`);
  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoverOptions { home?: string; cwd?: string; writeRegistry?: boolean }

export class SkillsManager {
  private readonly home: string;
  private readonly cwd: string;
  private cache: SkillRecord[] | null = null;
  /** 同名技能出现在哪些目录 (discover 时记录; 同名会被覆盖成一条记录, 重复必须单独留痕) */
  private dirsByName = new Map<string, string[]>();

  constructor(opts: { home?: string; cwd?: string } = {}) {
    this.home = opts.home ?? os.homedir();
    this.cwd = opts.cwd ?? process.cwd();
  }

  /** 技能搜索路径 (去重, 顺序 = 优先级从低到高) */
  skillDirs(): { dir: string; source: SkillSource }[] {
    const out: { dir: string; source: SkillSource }[] = [
      { dir: path.join(this.cwd, '.bolloon', 'skills'), source: 'project' },
      { dir: getUserSkillsDir(this.home), source: 'user' },
    ];
    for (const p of defaultSkillPaths(this.home, this.cwd)) {
      if (!out.some((x) => x.dir === p)) out.push({ dir: p, source: 'user' });
    }
    return out;
  }

  /** 扫描所有技能目录 + registry → 统一视图 (同名: 后者覆盖前者, 与 loader 语义一致) */
  async discover(opts: DiscoverOptions = {}): Promise<SkillRecord[]> {
    const home = opts.home ?? this.home;
    const reg = await readRegistry(home);
    const byName = new Map<string, SkillRecord>();
    const dirsByName = new Map<string, string[]>();

    for (const { dir, source } of this.skillDirs()) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const skillDir = path.join(dir, e.name);
        const skillFile = path.join(skillDir, 'SKILL.md');
        const meta: SkillMeta | null = await parseSkillFile(skillFile).catch(() => null);
        const counted = await hashSkillDir(skillDir);
        if (!meta) {
          // 目录在但不是有效技能: 也进视图 (状态 invalid), 不许静默消失
          const rec = this.buildRecord({
            name: e.name, description: '', version: '0.0.0', frontmatter: {}, body: '',
            dir: skillDir, skillFile, source, hash: counted.hash, fileCount: counted.fileCount,
            bytes: counted.bytes, issues: [`SKILL.md 缺失或无法解析`, ...counted.issues], reg,
          });
          byName.set(rec.name, rec);
          dirsByName.set(rec.name, [...(dirsByName.get(rec.name) || []), skillDir]);
          continue;
        }
        const rec = this.buildRecord({
          name: meta.name || e.name, description: meta.description, version: String((meta.frontmatter as any)?.version ?? '0.0.0'),
          frontmatter: meta.frontmatter, body: meta.body, dir: skillDir, skillFile, source,
          hash: counted.hash, fileCount: counted.fileCount, bytes: counted.bytes, issues: counted.issues, reg, tier: meta.tier, triggers: meta.triggers,
        });
        byName.set(rec.name, rec);
        dirsByName.set(rec.name, [...(dirsByName.get(rec.name) || []), skillDir]);
      }
    }

    const records = Array.from(byName.values());
    this.cache = records;
    this.dirsByName = dirsByName;
    if (opts.writeRegistry !== false) {
      // 首次发现把缺记录补进 registry (内容 hash 作为基线), 以后才能检出漂移
      let changed = false;
      for (const r of records) {
        if (!reg.skills[r.name]) {
          reg.skills[r.name] = {
            skillId: r.skillId, name: r.name, version: r.version, contentHash: r.contentHash,
            source: r.source, sourceRef: r.dir, status: r.status, trust: r.trust,
            installedAt: r.installedAt, updatedAt: r.updatedAt,
          };
          changed = true;
        }
      }
      if (changed) await writeRegistry(reg, home).catch(() => {});
    }
    return records;
  }

  private buildRecord(input: {
    name: string; description: string; version: string; frontmatter: Record<string, unknown>; body: string;
    dir: string; skillFile: string; source: SkillSource; hash: string; fileCount: number; bytes: number;
    issues: string[]; reg: SkillsRegistryFile; tier?: string; triggers?: string[];
  }): SkillRecord {
    const prior = input.reg.skills[input.name];
    const issues = validateSkillRecord({
      name: input.name, description: input.description, body: input.body,
      frontmatter: input.frontmatter, bytes: input.bytes, issues: input.issues,
    });
    const fmStatus = String(input.frontmatter?.status ?? 'active');
    // 状态优先级: 结构坏 → invalid; registry 显式停用/隔离/归档 → 尊重; 否则按 frontmatter/来源推导
    let status: SkillStatus;
    if (issues.length) status = 'invalid';
    else if (prior?.status === 'disabled' || prior?.status === 'quarantined' || prior?.status === 'archived') status = prior.status as SkillStatus;
    else if (fmStatus === 'archived') status = 'archived';
    else if (fmStatus === 'draft') status = 'discovered';
    else status = prior?.status === 'installed' ? 'installed' : 'enabled';

    const source: SkillSource = (prior?.source as SkillSource)
      || (input.source === 'project' ? 'project' : 'user');
    const now = new Date().toISOString();
    return {
      skillId: prior?.skillId || input.name,
      name: input.name,
      description: input.description,
      version: input.version,
      contentHash: input.hash,
      source,
      sourceRef: prior?.sourceRef || input.dir,
      status,
      trust: (prior?.trust as SkillTrust) || 'unverified',
      compatibility: input.frontmatter?.compatibility ? String(input.frontmatter.compatibility) : undefined,
      tier: input.tier || 'utility',
      triggers: input.triggers || [],
      skillFile: input.skillFile,
      dir: input.dir,
      fileCount: input.fileCount,
      bytes: input.bytes,
      installedAt: prior?.installedAt || now,
      updatedAt: now,
      issues,
      registryHash: prior?.contentHash,
      approvedBy: prior?.approvedBy,
      approvedAt: prior?.approvedAt,
    };
  }

  /** 单技能详情 (含正文长度与漂移判定) */
  async inspect(name: string, opts: { home?: string } = {}): Promise<SkillRecord | null> {
    const all = this.cache && !opts.home ? this.cache : await this.discover(opts);
    return all.find((s) => s.name === name) || null;
  }

  /** 解析一组技能名 → 记录 (缺哪个说清); 2-G.2 的 readiness gate 就用这个 */
  async resolve(names: string[], opts: { home?: string } = {}): Promise<{ ok: boolean; resolved: SkillRecord[]; missing: string[]; notEnabled: string[] }> {
    const all = await this.discover(opts);
    const resolved: SkillRecord[] = [];
    const missing: string[] = [];
    const notEnabled: string[] = [];
    for (const n of names) {
      const hit = all.find((s) => s.name === n);
      if (!hit) { missing.push(n); continue; }
      if (hit.status !== 'enabled' && hit.status !== 'installed') notEnabled.push(n);
      resolved.push(hit);
    }
    return { ok: missing.length === 0 && notEnabled.length === 0, resolved, missing, notEnabled };
  }

  /** 版本固定的技能快照 (Goal 级固定版本用; resolvedAt 记录解析时刻) */
  async snapshot(names: string[], opts: { home?: string } = {}): Promise<{ ok: boolean; entries: SkillSnapshotEntry[]; missing: string[] }> {
    const r = await this.resolve(names, opts);
    const resolvedAt = new Date().toISOString();
    return {
      ok: r.missing.length === 0,
      missing: r.missing,
      entries: r.resolved.map((s) => ({ name: s.name, version: s.version, contentHash: s.contentHash, source: s.source, resolvedAt })),
    };
  }

  /** 健康检查: 状态/来源分布 + 漂移 + 不合格 + 重复 + registry 缺盘 */
  async health(opts: { home?: string } = {}): Promise<SkillHealth> {
    const home = opts.home ?? this.home;
    const all = await this.discover(opts);
    const reg = await readRegistry(home);
    const byStatus: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const drifted: { name: string; expected?: string; actual: string }[] = [];
    const invalid: { name: string; issues: string[] }[] = [];
    const duplicates: { name: string; dirs: string[] }[] = [];
    for (const s of all) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      bySource[s.source] = (bySource[s.source] || 0) + 1;
      if (s.issues.length) invalid.push({ name: s.name, issues: s.issues });
      const prior = reg.skills[s.name];
      if (prior?.contentHash && prior.contentHash !== s.contentHash) {
        drifted.push({ name: s.name, expected: prior.contentHash, actual: s.contentHash });
      }
    }
    for (const [name, dirs] of this.dirsByName) {
      const uniq = Array.from(new Set(dirs));
      if (uniq.length > 1) duplicates.push({ name, dirs: uniq });
    }

    const missing = Object.keys(reg.skills).filter((n) => !all.some((s) => s.name === n));
    return { total: all.length, byStatus, bySource, drifted, invalid, duplicates, missing };
  }

  // ── 管理动作 (2-G.1: 只改状态与账, 不改执行行为) ──────────────────────────

  private async patchRegistry(name: string, patch: Partial<SkillRecord>, home?: string): Promise<SkillRecord | null> {
    const h = home ?? this.home;
    const rec = await this.inspect(name, { home: h });
    if (!rec) return null;
    const reg = await readRegistry(h);
    reg.skills[name] = { ...(reg.skills[name] || {}), ...patch, name };
    await writeRegistry(reg, h);
    this.cache = null;
    const after = await this.inspect(name, { home: h });
    return after;
  }

  async enable(name: string, opts: { home?: string } = {}): Promise<{ ok: boolean; reason?: string; skill?: SkillRecord }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false, reason: `没有这个技能: ${name}` };
    if (rec.issues.length) return { ok: false, reason: `技能不合格, 不能启用: ${rec.issues.join('; ')}` };
    const skill = await this.patchRegistry(name, { status: 'enabled' }, opts.home);
    // 2-G.4: 技能又能用了 → 重评被它拦住的 Goal (回 active, 等 Supervisor 继续)
    await this.onRegistryChanged({ home: opts.home ?? this.home, action: 'enable', name }).catch(() => null);
    return { ok: true, skill: skill || undefined };
  }

  async disable(name: string, opts: { home?: string } = {}): Promise<{ ok: boolean; reason?: string; skill?: SkillRecord }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false, reason: `没有这个技能: ${name}` };
    const skill = await this.patchRegistry(name, { status: 'disabled' }, opts.home);
    // 2-G.4: 记录"谁依赖它" (不打断当前 Run; 下一次 Run 前由 2-G.2 门禁拦)
    try {
      const { markDependentsOfSkill } = await import('./skill-supervisor-link.js');
      const affected = await markDependentsOfSkill(name, { home: opts.home ?? this.home, reason: '技能被禁用' });
      if (affected.length) console.warn(`[skills] ${name} 被禁用; 依赖它的 Goal: ${affected.join(', ')} (下一次 Run 前会门禁)`);
    } catch { /* 联动失败不影响禁用结果 */ }
    return { ok: true, skill: skill || undefined };
  }

  /** 人工批准 (信任等级 verified); 2-G.3 的 import 事务会要求它才算"可用" */
  async approve(name: string, by = 'human', opts: { home?: string } = {}): Promise<{ ok: boolean; reason?: string; skill?: SkillRecord }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false, reason: `没有这个技能: ${name}` };
    const skill = await this.patchRegistry(name, { trust: 'verified', approvedBy: by, approvedAt: new Date().toISOString() }, opts.home);
    return { ok: true, skill: skill || undefined };
  }

  /** 隔离 (损坏/不可信来源); 被隔离的技能不允许长期 Goal 自动使用 */
  async quarantine(name: string, reason: string, opts: { home?: string } = {}): Promise<{ ok: boolean; skill?: SkillRecord }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false };
    const reg = await readRegistry(opts.home ?? this.home);
    reg.skills[name] = {
      ...(reg.skills[name] || {}), name,
      status: 'quarantined', trust: 'quarantined',
      quarantineReason: reason.slice(0, 200), quarantinedAt: new Date().toISOString(),
    };
    await writeRegistry(reg, opts.home ?? this.home);
    this.cache = null;
    // 2-G.4: 隔离 = 不再可信 → 依赖它的 Goal 下一次 Run 前必然门禁失败
    try {
      const { markDependentsOfSkill } = await import('./skill-supervisor-link.js');
      const affected = await markDependentsOfSkill(name, { home: opts.home ?? this.home, reason: `技能被隔离: ${reason}` });
      if (affected.length) console.warn(`[skills] ${name} 被隔离; 依赖它的 Goal: ${affected.join(', ')}`);
    } catch { /* 联动失败不影响隔离结果 */ }
    return { ok: true, skill: (await this.inspect(name, opts)) || undefined };
  }

  /** 结构校验: 重算问题清单并把状态落成 invalid (或从 invalid 恢复) */
  async validate(name: string, opts: { home?: string } = {}): Promise<{ ok: boolean; issues: string[]; skill?: SkillRecord }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false, issues: [`没有这个技能: ${name}`] };
    const skill = await this.patchRegistry(name, { status: rec.issues.length ? 'invalid' : (rec.status === 'invalid' ? 'enabled' : rec.status) }, opts.home);
    return { ok: rec.issues.length === 0, issues: rec.issues, skill: skill || undefined };
  }

  /** 导出技能包 (复用 skill-share 的打包, 不重复实现) */
  async export(name: string, opts: { home?: string } = {}): Promise<{ ok: boolean; bundle?: SkillBundle; error?: string }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false, error: `没有这个技能: ${name}` };
    return collectSkillBundle(rec.dir, { name: rec.name });
  }

  /**
   * 导入技能 (对话/链接/CID 三种写法都支持)。
   * **2-G.1 只做统一入口 + 记账**: 下载 → 安装仍走现有 installSkillBundle (已有路径穿越校验 / 版本门 / 备份),
   * 事务化 (临时目录 + 原子移动 + hash 校验) 属 2-G.3。
   */
  async import(ref: string, opts: { home?: string; cwd?: string; force?: boolean; scope?: 'user' | 'project'; source?: SkillSource } = {}): Promise<{ ok: boolean; name?: string; version?: string; error?: string; skill?: SkillRecord }> {
    // 2026-09-16 (2-G.3): 统一走事务版 (暂存 → 原子替换 → 校验 → 回滚), 失败不污染当前技能环境
    const tx = await this.importTransactional({ ref }, opts);
    if (tx.ok) await this.onRegistryChanged({ home: opts.home ?? this.home, action: 'import', name: tx.name }).catch(() => null);
    return { ok: tx.ok, name: tx.name, version: tx.version, error: tx.error, skill: tx.skill };
  }

  
  async install(bundleJson: string, opts: { home?: string; cwd?: string; force?: boolean; source?: SkillSource; sourceRef?: string } = {}): Promise<{ ok: boolean; name?: string; error?: string; skill?: SkillRecord }> {
    // 2026-09-16 (2-G.3): 同样走事务 (install 的默认来源保持 'imported')
    const tx = await this.importTransactional({ bundleJson }, { ...opts, source: opts.source || 'imported' });
    if (tx.ok) await this.onRegistryChanged({ home: opts.home ?? this.home, action: 'install', name: tx.name }).catch(() => null);
    return { ok: tx.ok, name: tx.name, error: tx.error, skill: tx.skill };
  }

  // ── 事务型导入 (2-G.3, 2026-09-16) ───────────────────────────────────────
  /**
   * 把 import/install 变成**事务**:
   *   读来源 → 预备校验 (名字/路径穿越/SKILL.md frontmatter/版本门) → 写暂存目录
   *   → 原子替换 (旧目录先改名保留) → 校验落地结果 → 更新 registry
   * 任何一步失败: 正式目录不变 · registry 不变 · 暂存清理 · 失败原因可查询 (importHistory)。
   * 中途被 SIGKILL: 只可能留下 `.<name>-staging-*` 暂存或 `.<name>.bak-*` 备份 →
   *   recoverInterruptedImports() 会清理暂存并把备份恢复回正式位置。
   */
  async importTransactional(input: { ref?: string; bundleJson?: string }, opts: { home?: string; cwd?: string; force?: boolean; scope?: 'user' | 'project'; source?: SkillSource } = {}):
    Promise<{ ok: boolean; name?: string; version?: string; error?: string; step?: string; backup?: string; skill?: SkillRecord }> {
    const h = opts.home ?? this.home;
    const started = Date.now();
    const fail = async (step: string, error: string, name?: string) => {
      await this.recordImportFailure({ step, error, name, ref: input.ref, at: new Date().toISOString() });
      return { ok: false, error, step, name };
    };

    // 0) 先清上一次中断留下的暂存/备份, 避免互相干扰
    await this.recoverInterruptedImports({ home: h }).catch(() => null);

    // 1) 取包 (ref 走 IPFS; bundleJson 直接用)
    let bundle: any = null;
    let sourceRef = 'local-bundle';
    if (input.bundleJson) {
      const parsed: any = parseBundleLoose(input.bundleJson);
      if (!parsed?.ok || !parsed.bundle) return await fail('parse', parsed?.error || '包格式非法 (不是 bolloon-skill-bundle/1 JSON)');
      bundle = parsed.bundle; sourceRef = 'local-bundle';
    } else if (input.ref) {
      const cid = parseSkillRefLoose(input.ref);
      if (!cid) return await fail('parse', `无法识别的技能引用: ${String(input.ref).slice(0, 60)}`);
      const fetched: any = await fetchBundleLoose(cid);
      if (!fetched?.ok || !fetched.bundle) return await fail('fetch', fetched?.error || '取包失败');
      bundle = fetched.bundle; sourceRef = cid;
    } else {
      return await fail('parse', '必须给 ref 或 bundleJson');
    }

    // 2) 预备校验 (全部发生在动正式目录之前)
    if (!bundle || typeof bundle !== 'object') return await fail('parse', '包内容不是对象');
    const name = sanitizeNameLoose(bundle.name);
    if (!name) return await fail('validate', '技能名非法 (清洗后为空)');
    if (!bundle.files || typeof bundle.files !== 'object') return await fail('validate', '包内没有 files', name);
    const skillMd = bundle.files['SKILL.md'];
    if (typeof skillMd !== 'string' || !skillMd.trim()) return await fail('validate', '包内缺少 SKILL.md', name);
    const fm = parseFrontmatterLoose(skillMd);
    if (!fm) return await fail('validate', 'SKILL.md 缺少合法 frontmatter (--- 包裹)', name);
    if (!fm.name) return await fail('validate', 'SKILL.md frontmatter 缺 name', name);
    for (const rel of Object.keys(bundle.files)) {
      const norm = path.normalize(rel).replace(/^([/\\])+/, '');
      if (norm.startsWith('..') || path.isAbsolute(norm)) return await fail('validate', `技能包含非法路径 (路径穿越): ${rel}`, name);
    }
    const base = opts.scope === 'project' ? projectSkillsDirLoose(opts.cwd ?? this.cwd) : userSkillsDirLoose(h);
    const targetDir = path.join(base, name);
    const existingMeta = await parseSkillFileLoose(path.join(targetDir, 'SKILL.md'));
    const existingVersion = String(existingMeta?.frontmatter?.version ?? '0.0.0');
    const incomingVersion = String(bundle.version || fm.version || '0.0.0');
    if (existingMeta && cmpVersionLoose(existingVersion, incomingVersion) >= 0 && !opts.force) {
      return await fail('version', `本地已有 ${name}@${existingVersion}, 来的是 ${incomingVersion} (不更新; force=true 可强制)`, name);
    }

    // 3) 写暂存目录 (同名 . 前缀 → discover 不会当成技能)
    const staging = path.join(base, `.${name}-staging-${started}`);
    await fsp.mkdir(staging, { recursive: true });
    try {
      for (const [rel, content] of Object.entries(bundle.files)) {
        const norm = path.normalize(rel).replace(/^([/\\])+/, '');
        const abs = path.join(staging, norm);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, String(content), 'utf-8');
      }
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      return await fail('stage', `写暂存失败: ${String((err as Error)?.message || err).slice(0, 160)}`, name);
    }

    // 4) 原子替换: 旧目录改名保留 (备份), 暂存改名就位
    let backup: string | undefined;
    try {
      const exists = await fsp.stat(targetDir).then(() => true).catch(() => false);
      if (exists) {
        backup = path.join(base, `.${name}.bak-${started}`);
        await fsp.rename(targetDir, backup);
      }
      await fsp.rename(staging, targetDir);
    } catch (err) {
      // 回滚: 备份放回, 暂存清掉
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (backup) await fsp.rename(backup, targetDir).catch(() => {});
      return await fail('swap', `原子替换失败 (已回滚): ${String((err as Error)?.message || err).slice(0, 160)}`, name);
    }

    // 5) 校验落地结果 (读回来再确认一次)
    //    回滚条件只看**结构性失败** (SKILL.md 解析不出来); 内容质量类提示 (如正文过少) 只记警告 ——
    //    否则用户自己的"简洁技能"永远装不回来 (导出→安装 自洽被打破)。
    this.cache = null;
    const parsedBack = await parseSkillFileLoose(path.join(targetDir, 'SKILL.md')).catch(() => null);
    const after = await this.inspect(name, { home: h }).catch(() => null);
    if (!parsedBack) {
      await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      if (backup) await fsp.rename(backup, targetDir).catch(() => {});
      return await fail('verify', `落地校验失败 (已回滚): SKILL.md 装完解析不出来`, name);
    }
    if (after && (after.issues || []).length) {
      await appendImportHistory(h, { at: new Date().toISOString(), ok: true, kind: 'warning', name, step: 'verify', warning: (after.issues || []).slice(0, 3).join('; ') }).catch(() => {});
    }

    // 6) registry 更新 (失败不致命: 下次 discover 会重建)
    try {
      await this.patchRegistry(name, {
        status: 'installed', source: opts.source || 'shared', sourceRef,
        trust: 'unverified', contentHash: after?.contentHash || '', version: after?.version || incomingVersion,
      }, h);
    } catch (err) {
      await this.recordImportFailure({ step: 'registry', error: `registry 更新失败: ${String((err as Error)?.message || err).slice(0, 140)}`, name, ref: input.ref, at: new Date().toISOString() });
    }
    await this.recordImportSuccess({ name, version: after?.version || incomingVersion, ref: input.ref, backup, at: new Date().toISOString() });
    return { ok: true, name, version: after?.version || incomingVersion, backup, skill: after || undefined };
  }


  // ── 与 Supervisor 的长期联动 (2-G.4, 2026-09-16) ────────────────────────
  /**
   * 技能注册表发生变化 (导入成功 / 启用 / 禁用 / 隔离 / 漂移) → 重新评估**被技能拦住的 Goal**:
   *   · 技能又能用了 → 重新冻结快照 + Goal 回 active (等 Supervisor 下一轮继续)
   *   · 技能被禁用/隔离/漂移 → 交给 2-G.2 的执行前门禁拦 (这里只把状态标清, 不抢执行权)
   */
  async onRegistryChanged(opts: { home?: string; action: string; name?: string } = { action: 'unknown' }): Promise<{ rechecked: number; resumed: string[]; stillBlocked: string[] }> {
    const h = opts.home ?? this.home;
    try {
      const { reconsiderSkillBlockedGoals } = await import('./skill-supervisor-link.js');
      const res = await reconsiderSkillBlockedGoals({ home: h, action: opts.action, name: opts.name });
      return res;
    } catch (err) {
      console.warn(`[skills] 联动重评失败 (不影响导入结果): ${String((err as Error)?.message || err).slice(0, 140)}`);
      return { rechecked: 0, resumed: [], stillBlocked: [] };
    }
  }

  /** 清理中断残留: 暂存目录删掉; 备份且正式目录缺失 → 恢复备份 (不丢已装技能) */
  async recoverInterruptedImports(opts: { home?: string; cwd?: string } = {}): Promise<{ removedStaging: string[]; restored: string[] }> {
    const h = opts.home ?? this.home;
    const removedStaging: string[] = []; const restored: string[] = [];
    for (const base of [userSkillsDirLoose(h), projectSkillsDirLoose(opts.cwd ?? this.cwd)]) {
      let entries: string[] = [];
      try { entries = await fsp.readdir(base); } catch { continue; }
      for (const e of entries) {
        if (/^\..*-staging-\d+$/.test(e)) { await fsp.rm(path.join(base, e), { recursive: true, force: true }).catch(() => {}); removedStaging.push(e); continue; }
        const m = /^\.(.+)\.bak-(\d+)$/.exec(e);
        if (m) {
          const live = path.join(base, m[1]);
          const liveExists = await fsp.stat(live).then(() => true).catch(() => false);
          if (!liveExists) {
            await fsp.rename(path.join(base, e), live).catch(() => {});
            restored.push(`${m[1]} (from ${e})`);
          }
        }
      }
    }
    return { removedStaging, restored };
  }

  /** 导入历史/失败原因 (CLI/Web 可查) */
  async importHistory(opts: { home?: string; limit?: number } = {}): Promise<any[]> {
    const h = opts.home ?? this.home;
    try {
      const raw = JSON.parse(await fsp.readFile(importHistoryPath(h), 'utf8'));
      return (Array.isArray(raw) ? raw : []).slice(-1 * (opts.limit || 20));
    } catch { return []; }
  }

  private async recordImportSuccess(rec: Record<string, unknown>): Promise<void> {
    await appendImportHistory(this.home, { ...rec, ok: true, kind: 'success' }).catch(() => {});
  }

  private async recordImportFailure(rec: Record<string, unknown>): Promise<void> {
    await appendImportHistory(this.home, { ...rec, ok: false, kind: 'failure' }).catch(() => {});
  }

  // ── 视图 ─────────────────────────────────────────────────────────────────

  /** 给 CLI / Web / agent 的同一份列表 (字段一致, 顺序一致: name 升序) */
  async view(opts: { home?: string } = {}): Promise<SkillRecord[]> {
    const all = await this.discover(opts);
    return [...all].sort((a, b) => a.name.localeCompare(b.name));
  }
}

let singleton: SkillsManager | null = null;

/** 进程内单例 (CLI / Web / Supervisor 共用同一个视图实现) */
export function getSkillsManager(opts: { home?: string; cwd?: string } = {}): SkillsManager {
  if (!singleton) singleton = new SkillsManager(opts);
  return singleton;
}

export function resetSkillsManagerForTest(): void {
  singleton = null;
}

/** 一行摘要 (CLI / 日志用) */
export function formatSkillLine(s: SkillRecord): string {
  return `${s.name.padEnd(28)} ${String(s.status).padEnd(11)} ${String(s.source).padEnd(9)} ${String(s.trust).padEnd(10)} v${s.version.padEnd(8)} ${s.contentHash.slice(0, 10)}${s.issues.length ? `  ⚠ ${s.issues.length} 个问题` : ''}`;
}


// ── 事务型导入的小工具 (2-G.3) ───────────────────────────────────────────────

function importHistoryPath(home: string): string {
  return path.join(home, '.bolloon', 'skill-imports.json');
}

async function appendImportHistory(home: string, rec: Record<string, unknown>): Promise<void> {
  const p = importHistoryPath(home);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  let arr: unknown[] = [];
  try { const raw = JSON.parse(await fsp.readFile(p, 'utf8')); if (Array.isArray(raw)) arr = raw; } catch { /* 首次 */ }
  arr.push(rec);
  await fsp.writeFile(p, JSON.stringify(arr.slice(-50), null, 2), 'utf8');
}

/** 极简 frontmatter 解析 (只要 name/version, 用于预备校验) */
export function parseFrontmatterLoose(text: string): { name?: string; version?: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return null;
  const out: { name?: string; version?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1].toLowerCase(); const val = kv[2].replace(/^["']|["']$/g, '').trim();
    if (key === 'name') out.name = val;
    if (key === 'version') out.version = val;
  }
  return out;
}

/** 版本比较 (semver 数字段; 非法段当 0) */
export function cmpVersionLoose(a: string, b: string): number {
  const pa = String(a).split('.').map((x) => Number(String(x).replace(/[^0-9]/g, '')) || 0);
  const pb = String(b).split('.').map((x) => Number(String(x).replace(/[^0-9]/g, '')) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
