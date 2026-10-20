/**
 * resource-contract.ts — 可执行资源契约 (Phase 2, 2026-09-18)
 *
 * 为什么需要: 之前的"买到资源"只是拿到一段**内容**; leo 的 Phase 2 要求买到的是**可执行资源** —
 * 卖方必须声明: 输入要什么、输出长什么样、怎么执行、执行需要哪些工具、多久算超时、
 * 验真看哪些字段/证据字段, 以及**保证什么/不保证什么** (不许把"schema 通过"吹成"生意成功")。
 *
 * 契约写进 SKILL.md frontmatter:
 * ```yaml
 * resource:
 *   inputSchema: {type: object, required: [product], properties: {...}}
 *   outputSchema: {type: object, required: [summary, sources] ...}
 *   execution: {entrypoint: run.mjs, requiredTools: [read_file], maxDurationMs: 60000}
 *   verification: {requiredFields: [summary, sources], evidenceFields: [sources]}
 *   guarantees: [schema_valid, source_declared, content_hash_bound]
 *   doesNotGuarantee: [business_success, market_profit]
 * ```
 *
 * 三条硬规则:
 *   ① 输入不合 inputSchema → **不执行、不付款** (协议层拒绝, 不是"执行后报错")
 *   ② 输出不合 outputSchema / 缺证据字段 → 交易**不能** verified (只能 verification_failed)
 *   ③ 资源执行失败 ≠ 资源可用; 买到资源但没改善 Goal → 不计入 Goal 成功证据
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { sha256Hex } from './paid-info-protocol.js';
import type { ExecutionEvidence } from './settlement-state.js';

// ── 契约类型 ───────────────────────────────────────────────────────────────

/** JSON Schema 的**受限子集** (够用且可确定性校验; 不引第三方库) */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
}

export interface ResourceExecutionSpec {
  /** 相对技能目录的可执行入口 (JS 模块, 导出 execute(params, ctx)) */
  entrypoint?: string;
  /** 执行需要哪些工具 (Harness 只在允许清单里放行) */
  requiredTools?: string[];
  maxDurationMs?: number;
  /** 执行体类型: js-module (真跑代码) / declared (只有声明, 由宿主实现) */
  kind?: 'js-module' | 'declared';
}

export interface ResourceVerificationSpec {
  /** 输出里必须有的字段 */
  requiredFields?: string[];
  /** 证据字段 (来源/引用); 缺了只能 verification_failed */
  evidenceFields?: string[];
}

export interface ResourceContract {
  name: string;
  version: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  execution: ResourceExecutionSpec;
  verification: ResourceVerificationSpec;
  guarantees: string[];
  doesNotGuarantee: string[];
}

export interface ContractParseResult { ok: boolean; contract?: ResourceContract; issues: string[] }

const CAPABILITY_WORDS = ['schema_valid', 'source_declared', 'content_hash_bound', 'executable', 'deterministic_entrypoint'];

/**
 * 从 SKILL.md frontmatter 解析资源契约。
 * 兼容两种写法: `resource: {...}` 或直接平铺在 frontmatter 顶层。
 * 缺 name/version 视为**不是**可执行资源 (普通技能照旧可用)。
 */
export function parseResourceContract(frontmatter: Record<string, unknown> | null | undefined, opts: { skillName?: string; skillVersion?: string } = {}): ContractParseResult {
  const fm: any = frontmatter || {};
  // 手写 SKILL.md 的 `resource: {…}` 常被最小 YAML 解析器当成**字符串**留下 → 这里两种都吃。
  // (真跑抓到过: 夹具技能因此被判"没有资源契约字段", 顾问直接看不到任何可执行资源。)
  let resObj: any = fm.resource;
  if (typeof resObj === 'string') {
    try { resObj = JSON.parse(resObj); } catch { resObj = undefined; }
  }
  const raw: any = resObj && typeof resObj === 'object' ? resObj : fm;
  const issues: string[] = [];
  const name = String(raw?.name || opts.skillName || fm.name || '').trim();
  const version = String(raw?.version || opts.skillVersion || fm.version || '').trim();
  const hasAnyContractField = !!(raw?.inputSchema || raw?.outputSchema || raw?.execution || raw?.verification || raw?.guarantees || raw?.doesNotGuarantee);
  if (!hasAnyContractField) return { ok: false, issues: ['没有资源契约字段 (inputSchema/outputSchema/execution/verification/guarantees)'] };
  if (!name) issues.push('缺少 name');
  if (!version) issues.push('缺少 version');
  if (raw?.guarantees !== undefined && !Array.isArray(raw.guarantees)) issues.push('guarantees 必须是数组');
  if (raw?.doesNotGuarantee !== undefined && !Array.isArray(raw.doesNotGuarantee)) issues.push('doesNotGuarantee 必须是数组');
  const exec = raw?.execution || {};
  if (exec.maxDurationMs !== undefined && (!Number.isFinite(Number(exec.maxDurationMs)) || Number(exec.maxDurationMs) <= 0)) issues.push('execution.maxDurationMs 必须是正数');
  if (exec.requiredTools !== undefined && !Array.isArray(exec.requiredTools)) issues.push('execution.requiredTools 必须是数组');
  if (exec.entrypoint !== undefined && typeof exec.entrypoint !== 'string') issues.push('execution.entrypoint 必须是字符串');
  // 可执行资源必须声明"不保证什么" —— 否则就是把"能跑"吹成"能赚"
  if (Array.isArray(raw?.guarantees) && raw.guarantees.length > 0 && (!Array.isArray(raw?.doesNotGuarantee) || raw.doesNotGuarantee.length === 0)) {
    issues.push('声明了 guarantees 就必须声明 doesNotGuarantee (不许把能力边界说满)');
  }
  if (issues.length) return { ok: false, issues };

  const contract: ResourceContract = {
    name,
    version,
    inputSchema: raw?.inputSchema,
    outputSchema: raw?.outputSchema,
    execution: {
      entrypoint: exec.entrypoint,
      requiredTools: Array.isArray(exec.requiredTools) ? exec.requiredTools.map(String) : [],
      maxDurationMs: exec.maxDurationMs !== undefined ? Number(exec.maxDurationMs) : 60_000,
      kind: exec.entrypoint ? 'js-module' : (exec.kind || 'declared'),
    },
    verification: {
      requiredFields: Array.isArray(raw?.verification?.requiredFields) ? raw.verification.requiredFields.map(String) : [],
      evidenceFields: Array.isArray(raw?.verification?.evidenceFields) ? raw.verification.evidenceFields.map(String) : [],
    },
    guarantees: Array.isArray(raw?.guarantees) ? raw.guarantees.map(String).filter((g: string) => CAPABILITY_WORDS.includes(g) || g.length > 0) : [],
    doesNotGuarantee: Array.isArray(raw?.doesNotGuarantee) ? raw.doesNotGuarantee.map(String) : [],
  };
  return { ok: true, contract, issues: [] };
}

// ── 受限 JSON Schema 校验 (确定性, 无依赖) ─────────────────────────────────

export function validateJsonSchema(schema: JsonSchema | undefined, value: unknown, at = '$'): string[] {
  if (!schema) return [];
  const out: string[] = [];
  const type = schema.type;
  if (type) {
    const t = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const ok = type === 'integer' ? (t === 'number' && Number.isInteger(value as number)) : (t === type);
    if (!ok) { out.push(`${at} 类型应为 ${type}, 实际 ${t}`); return out; }
  }
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at} 取值不在 enum 里 (${JSON.stringify(schema.enum)})`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at} 小于最小值 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at} 大于最大值 ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at} 长度小于 ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${at} 长度大于 ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${at} 不匹配 pattern ${schema.pattern}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => out.push(...validateJsonSchema(schema.items, v, `${at}[${i}]`)));
  }
  if (type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required || []) {
      if (obj[req] === undefined || obj[req] === null) out.push(`${at}.${req} 缺失 (required)`);
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (obj[k] !== undefined) out.push(...validateJsonSchema(sub, obj[k], `${at}.${k}`));
    }
  }
  return out;
}

export interface InputValidation { ok: boolean; issues: string[] }

/** ① 输入校验: 不合 schema 就不该执行 (更不该付款) */
export function validateResourceInput(contract: ResourceContract, input: unknown): InputValidation {
  const issues = validateJsonSchema(contract.inputSchema, input);
  return { ok: issues.length === 0, issues };
}

export interface OutputValidation { ok: boolean; issues: string[]; missingFields: string[]; missingEvidence: string[] }

/** ② 输出校验: schema + 必填字段 + 证据字段 (缺证据只能算"没验真") */
export function validateResourceOutput(contract: ResourceContract, output: unknown): OutputValidation {
  const issues = validateJsonSchema(contract.outputSchema, output);
  const obj = (output && typeof output === 'object' && !Array.isArray(output)) ? output as Record<string, unknown> : {};
  const missingFields = (contract.verification.requiredFields || []).filter((f) => obj[f] === undefined || obj[f] === null);
  const missingEvidence = (contract.verification.evidenceFields || []).filter((f) => {
    const v = obj[f];
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'string') return v.trim().length === 0;
    return false;
  });
  return { ok: issues.length === 0 && missingFields.length === 0 && missingEvidence.length === 0, issues, missingFields, missingEvidence };
}

// ── 执行 (Harness 约束: 工具允许清单 + 超时 + 只看声明过的入口) ──────────────

export interface ExecuteResult {
  execution: ExecutionEvidence;
  output?: unknown;
  rawOutput?: string;
  issues: string[];
}

export interface ExecuteOptions {
  contract: ResourceContract;
  skillDir: string;
  input: unknown;
  /** 宿主当前允许放行的工具 (requiredTools 必须是它的子集) */
  allowedTools?: string[];
  /** 显式同意执行下载来的代码 (默认 false: 只做契约校验, 不跑) */
  allowCodeExecution?: boolean;
  maxDurationMs?: number;
}

/**
 * 在契约与 Harness 约束下执行资源。
 * - 输入不合 inputSchema → 直接返回 ok:false (不执行)
 * - requiredTools 超出允许清单 → 拒绝执行 (不静默降级)
 * - 超时 → 判定失败 (不留"可能跑完了"的模糊态)
 * - 输出不合 outputSchema / 缺证据字段 → schemaOk/sourceDeclared 如实置 false
 */
export async function executeContractSkill(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { contract, skillDir, input } = opts;
  const inChk = validateResourceInput(contract, input);
  if (!inChk.ok) {
    return {
      issues: inChk.issues,
      execution: { ok: false, tool: 'skill_exec', reason: `输入不符合 inputSchema: ${inChk.issues[0]}`, schemaOk: false, sourceDeclared: false },
    };
  }
  const required = contract.execution.requiredTools || [];
  if (opts.allowedTools && required.some((t) => !opts.allowedTools!.includes(t))) {
    const bad = required.filter((t) => !opts.allowedTools!.includes(t));
    return {
      issues: [`requiredTools 超出允许清单: ${bad.join(', ')}`],
      execution: { ok: false, tool: 'skill_exec', reason: `执行需要未获准的工具: ${bad.join(', ')}`, schemaOk: false, sourceDeclared: false },
    };
  }
  const entry = contract.execution.entrypoint;
  if (!entry) {
    return {
      issues: ['契约没有 execution.entrypoint (声明式资源: 由宿主实现, 不能在这里真跑)'],
      execution: { ok: false, tool: 'skill_exec', reason: '没有可执行入口', schemaOk: false, sourceDeclared: false },
    };
  }
  if (!opts.allowCodeExecution) {
    return {
      issues: ['未显式同意执行下载来的代码 (allowCodeExecution=false)'],
      execution: { ok: false, tool: 'skill_exec', reason: '宿主未同意执行资源代码', schemaOk: false, sourceDeclared: false },
    };
  }
  const entryPath = path.resolve(skillDir, entry);
  if (!entryPath.startsWith(path.resolve(skillDir) + path.sep)) {
    return {
      issues: [`entrypoint 越出技能目录: ${entry}`],
      execution: { ok: false, tool: 'skill_exec', reason: 'entrypoint 越出技能目录 (拒绝加载)', schemaOk: false, sourceDeclared: false },
    };
  }
  if (!fs.existsSync(entryPath)) {
    return {
      issues: [`entrypoint 不存在: ${entry}`],
      execution: { ok: false, tool: 'skill_exec', reason: '入口文件不存在', schemaOk: false, sourceDeclared: false },
    };
  }

  const maxMs = opts.maxDurationMs ?? contract.execution.maxDurationMs ?? 60_000;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let mod: any;
  try {
    mod = await import(pathToFileURL(entryPath).href);
  } catch (err: any) {
    return {
      issues: [`入口加载失败: ${String(err?.message || err).slice(0, 160)}`],
      execution: { ok: false, tool: 'skill_exec', startedAt, durationMs: Date.now() - t0, reason: `入口加载失败: ${String(err?.message || err).slice(0, 120)}`, schemaOk: false, sourceDeclared: false },
    };
  }
  const fn = mod?.execute || mod?.default?.execute || (typeof mod?.default === 'function' ? mod.default : undefined);
  if (typeof fn !== 'function') {
    return {
      issues: ['入口没有导出 execute(params, ctx)'],
      execution: { ok: false, tool: 'skill_exec', startedAt, durationMs: Date.now() - t0, reason: '入口未导出 execute', schemaOk: false, sourceDeclared: false },
    };
  }

  let timer: NodeJS.Timeout | null = null;
  let raw: any;
  try {
    const toolsUsed: string[] = [];
    raw = await Promise.race([
      Promise.resolve(fn(input, { skillDir, contract, toolsUsed, tool: (name: string, args: any) => {
        if (opts.allowedTools && !opts.allowedTools.includes(name)) throw new Error(`工具 ${name} 未获准`);
        toolsUsed.push(name);
        return args;
      } })),
      new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error(`执行超时 (>${maxMs}ms)`)), maxMs); }),
    ]);
  } catch (err: any) {
    if (timer) clearTimeout(timer);
    const msg = String(err?.message || err).slice(0, 200);
    return {
      issues: [`执行失败: ${msg}`],
      execution: { ok: false, tool: 'skill_exec', startedAt, durationMs: Date.now() - t0, reason: msg, schemaOk: false, sourceDeclared: false },
    };
  }
  if (timer) clearTimeout(timer);

  const durationMs = Date.now() - t0;
  const output = typeof raw === 'string' ? safeJson(raw) ?? raw : raw;
  const outChk = validateResourceOutput(contract, output);
  const outputHash = sha256Hex(typeof raw === 'string' ? raw : JSON.stringify(raw ?? null));
  const evidence = {
    ok: outChk.ok,
    tool: 'skill_exec',
    startedAt,
    durationMs,
    outputHash,
    schemaOk: outChk.issues.length === 0 && outChk.missingFields.length === 0,
    sourceDeclared: outChk.missingEvidence.length === 0,
    reason: outChk.ok ? undefined : `输出不达标: ${[...outChk.issues.slice(0, 2), ...outChk.missingFields.map((f) => `缺字段 ${f}`), ...outChk.missingEvidence.map((f) => `缺证据 ${f}`)].join('; ')}`,
  } as ExecutionEvidence;
  return { execution: evidence, output, rawOutput: typeof raw === 'string' ? raw : undefined, issues: outChk.ok ? [] : [String(evidence.reason)] };
}

function safeJson(s: string): any | null {
  try { return JSON.parse(s); } catch { return null; }
}

// ── 绑定: 交易 ↔ 技能 (版本 / 内容哈希 / 卖方) ─────────────────────────────

export interface ResourceSnapshot {
  name: string;
  version: string;
  contentHash: string;
  fileCount?: number;
  bytes?: number;
  source?: string;
  resolvedAt: string;
  contractHash: string;
}

/** 购买后固定快照: 版本 + 内容哈希 + 契约哈希 (漂移就能检出) */
export async function buildResourceSnapshot(skillDir: string, contract: ResourceContract, source?: string): Promise<ResourceSnapshot> {
  const { hashSkillDir } = await import('../skills-manager.js');
  const h = await hashSkillDir(skillDir);
  return {
    name: contract.name,
    version: contract.version,
    contentHash: h.hash,
    fileCount: h.fileCount,
    bytes: h.bytes,
    source,
    resolvedAt: new Date().toISOString(),
    contractHash: sha256Hex(JSON.stringify(contract)),
  };
}

export interface BindCheck { ok: boolean; issues: string[] }

/**
 * 交易的 itemId / contentHash / providerDid 必须与**实际拿到的技能**一致
 * (否则"买到的是可执行资源"就是空话: 可能买到的是另一份东西)。
 */
export function verifyResourceAgainstTransaction(
  rec: { itemId?: string; contentHash?: string; providerDid?: string },
  snapshot: ResourceSnapshot,
  expected: { itemId?: string; providerDid?: string; version?: string },
): BindCheck {
  const issues: string[] = [];
  if (expected.itemId && rec.itemId && String(rec.itemId) !== String(expected.itemId)) issues.push(`交易 itemId (${rec.itemId}) 与预期 (${expected.itemId}) 不一致`);
  if (expected.providerDid && rec.providerDid && String(rec.providerDid) !== String(expected.providerDid)) issues.push(`交易 providerDid 与预期不一致`);
  if (expected.version && snapshot.version !== expected.version) issues.push(`技能版本 (${snapshot.version}) 与预期 (${expected.version}) 不一致`);
  // 内容绑定**不在这里**用两种口径硬比: 交易里的 contentHash 是协议哈希 (sha256:<hex> of content),
  // snapshot.contentHash 是技能目录哈希。两者的关系由 verifyInstallFidelity() 做检查链证明。
  return { ok: issues.length === 0, issues };
}

/** 执行前漂移检查: 快照内容哈希必须和当前盘上一致 */
export async function checkResourceDrift(skillDir: string, snapshot: ResourceSnapshot): Promise<BindCheck> {
  const { hashSkillDir } = await import('../skills-manager.js');
  const h = await hashSkillDir(skillDir);
  if (h.hash !== snapshot.contentHash) {
    return { ok: false, issues: [`技能已漂移: 快照 ${snapshot.contentHash.slice(0, 12)}… ≠ 当前 ${h.hash.slice(0, 12)}… (购买时的内容不是现在这份)`] };
  }
  return { ok: true, issues: [] };
}


// ── 安装保真: "买到的是这份技能" 的**可检查链** ────────────────────────────

/**
 * 技能包文件集的确定性哈希 —— 与 `hashSkillDir` 用**同一算法** (相对路径 + \0 + 文件内容 sha256)。
 * 这样"包里的文件"和"盘上装出来的目录"才可比。
 */
export function hashBundleFiles(files: Record<string, string>): string {
  const h = crypto.createHash('sha256');
  for (const rel of dfsOrder(Object.keys(files))) {
    h.update(rel);
    h.update('\0');
    h.update(crypto.createHash('sha256').update(Buffer.from(String(files[rel]), 'utf8')).digest());
  }
  return h.digest('hex').slice(0, 32);
}

/**
 * 复刻 `hashSkillDir` 的遍历顺序: 每层 `localeCompare` 排序的 DFS (目录在其兄弟位置被递归进去)。
 * 顺序必须一致, 否则同样内容会算出不同哈希 (真跑抓到过: 默认 sort() 与 localeCompare 对
 * 'SKILL.md' vs 'run.mjs' 给出相反顺序)。
 */
export function dfsOrder(keys: string[]): string[] {
  const tree = new Map<string, { files: Set<string>; dirs: Set<string> }>();
  const ensure = (p: string) => { if (!tree.has(p)) tree.set(p, { files: new Set(), dirs: new Set() }); return tree.get(p)!; };
  ensure('');
  for (const k of keys) {
    const parts = String(k).split('/');
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      const node = ensure(cur);
      const isLast = i === parts.length - 1;
      if (isLast) node.files.add(parts[i]);
      else { node.dirs.add(parts[i]); cur = cur ? `${cur}/${parts[i]}` : parts[i]; }
    }
  }
  const out: string[] = [];
  const walk = (prefix: string) => {
    const node = tree.get(prefix)!;
    const entries = [...node.dirs, ...node.files].sort((a, b) => a.localeCompare(b));
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e}` : e;
      if (node.dirs.has(e)) walk(rel);
      else out.push(rel);
    }
  };
  walk('');
  return out;
}

export interface InstallFidelity { ok: boolean; issues: string[]; contentHashOk?: boolean; installLossless?: boolean }

/**
 * 买到 → 装上 的保真检查:
 *   ① 手里这份 content 重算协议哈希 == 交易记录 contentHash (证明:**就是这份内容**, 没被换过)
 *   ② 解包后落盘的目录哈希 == 包内文件集哈希 (证明:**装的时候没丢没加**)
 * 两句都成立, 才能说"买到的可执行资源 = 现在能执行的这份"。
 */
export async function verifyInstallFidelity(input: {
  content: string;
  rec: { contentHash?: string };
  installDir: string;
}): Promise<InstallFidelity> {
  const issues: string[] = [];
  const recomputed = `sha256:${sha256Hex(input.content)}`;
  const contentHashOk = !!input.rec.contentHash && recomputed === input.rec.contentHash;
  if (!contentHashOk) issues.push(`内容重算哈希 (${recomputed.slice(0, 20)}…) 与交易记录 (${String(input.rec.contentHash).slice(0, 20)}…) 不一致 — 手里这份不是当时交付的那份`);
  let installLossless = false;
  try {
    const { hashSkillDir } = await import('../skills-manager.js');
    const { parseSkillBundle } = await import('../skill-share.js');
    const parsed = parseSkillBundle(input.content);
    if (!parsed.ok || !parsed.bundle) {
      issues.push(`技能包解析失败: ${parsed.error || 'unknown'}`);
    } else {
      const bundleHash = hashBundleFiles(parsed.bundle.files);
      const dirHash = (await hashSkillDir(input.installDir)).hash;
      installLossless = bundleHash === dirHash;
      if (!installLossless) issues.push(`解包落盘后内容变了: 包内 ${bundleHash.slice(0, 12)}… ≠ 目录 ${dirHash.slice(0, 12)}… (装的过程丢/加了东西)`);
    }
  } catch (err: any) {
    issues.push(`保真检查失败: ${String(err?.message || err).slice(0, 120)}`);
  }
  return { ok: contentHashOk && installLossless, issues, contentHashOk, installLossless };
}

// ── 目录读取 (从技能目录解析契约) ──────────────────────────────────────────

export interface LoadedResource { ok: boolean; dir: string; contract?: ResourceContract; issues: string[]; raw?: string }

/** 从技能目录读 SKILL.md → 解析 frontmatter → 资源契约 */
export async function loadResourceContract(skillDir: string): Promise<LoadedResource> {
  const skillFile = path.join(skillDir, 'SKILL.md');
  let text: string;
  try { text = await fsp.readFile(skillFile, 'utf8'); }
  catch { return { ok: false, dir: skillDir, issues: [`读不到 ${skillFile}`] }; }
  const fm = parseFrontmatter(text);
  const r = parseResourceContract(fm.data, { skillName: path.basename(skillDir) });
  return { ok: r.ok, dir: skillDir, contract: r.contract, issues: r.issues, raw: text };
}

/** 极简 YAML frontmatter 解析 (够用: 标量 / 数组 / 一层嵌套对象 / 内联 JSON) */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text || ''));
  if (!m) return { data: {}, body: String(text || '') };
  const body = String(text).slice(m[0].length);
  const data: any = {};
  const lines = m[1].split(/\r?\n/);
  let curKey: string | null = null;
  let curIndent = 0;
  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)![0].length;
    const line = rawLine.trim();
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rest] = kv;
    if (rest === '') { curKey = key; curIndent = indent; data[key] = {}; continue; }
    const value = parseScalar(rest);
    if (curKey && indent > curIndent) {
      if (typeof data[curKey] === 'object' && data[curKey] !== null) data[curKey][key] = value;
      else data[curKey] = { [key]: value };
    } else {
      data[key] = value;
      curKey = null;
    }
  }
  return { data, body };
}

function parseScalar(rest: string): unknown {
  const v = rest.trim();
  if (v.startsWith('{') || v.startsWith('[')) { try { return JSON.parse(v); } catch { /* fallthrough */ } }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return v;
}
