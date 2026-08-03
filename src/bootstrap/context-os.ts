/**
 * context-os.ts — Context OS 资产层 (2026-08-03, P5)
 *
 * 把 Ziye-Context-OS 的 12+3 层文件夹体系落地到 Bolloon:
 *   ~/.bolloon/context-os/
 *     01-Me ~ 12-Analysis + output / research / tmp
 *
 * 每层回答一种问题 (Context OS §3):
 *   01-Me 我是谁 / 02-Network 我认识谁 / 03-Current 我现在在做什么
 *   04-Projects 我正在推进什么 / 05-Prompts 哪些提示词已验证
 *   06-Protocols AI 和系统该如何工作 / 07-Knowledge 哪些知识跨项目复用
 *   08-Insights 哪些判断改变决策 / 09-Tools 哪些工具省时间
 *   10-Skills 哪些能力可验证 / 11-Write 哪些表达可复用
 *   12-Analysis 决策过程与复盘 / output 对外交付 / research 中间成果 / tmp 一次性草稿
 *
 * 价值判断标准 (Context OS §5): 每个资产进入前回答"未来哪个具体场景会用到它?".
 * 回答不出 = 噪音, 不该进正式层.
 *
 * 设计 (减法):
 *   - 每层一个 README.md 声明职责边界 (存什么/不该存什么/典型用途)
 *   - 资产文件: <ts>-<slug>.md, frontmatter v2 (stage0 = 临时价值点, 与 judgeness 生命周期对应)
 *   - 写操作失败静默, 不阻塞主对话
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// ============================================================
// 12+3 层定义 (直接来自 Context OS §3 职责边界表)
// ============================================================

export interface ContextOsLayer {
  /** 目录 key: '01-Me' */
  key: string;
  /** 层要回答的问题 */
  name: string;
  /** 存什么 */
  store: string;
  /** 不该存什么 */
  notStore: string;
  /** 典型用途 */
  usage: string;
}

export const CONTEXT_OS_LAYERS: ContextOsLayer[] = [
  { key: '01-Me', name: '我是谁', store: '经过验证的原则、不可碰的边界、稳定偏好', notStore: '临时情绪、未经验证的念头', usage: '防止 AI 用错误的方式帮助你' },
  { key: '02-Network', name: '我认识谁', store: '有真实关系、能力可定位、能在具体问题上调用的人', notStore: '只看过主页的陌生人', usage: '需要咨询、合作、求证时找到正确的人' },
  { key: '03-Current', name: '我现在在做什么', store: '今天/本周的现实状态、工作现场、阻塞项', notStore: '长期知识、项目历史全文', usage: '防止 AI 按过期状态给建议' },
  { key: '04-Projects', name: '我正在推进什么', store: '有明确交付、真实进度、可验证证据的项目', notStore: '只有想法的脑暴', usage: '让 AI 按项目真实边界推进' },
  { key: '05-Prompts', name: '已验证可复用的提示词', store: '至少复用过、效果稳定的 Prompt', notStore: '一次性调试 Prompt', usage: '跨项目、跨工具复用工作方法' },
  { key: '06-Protocols', name: 'AI 和系统该如何工作', store: '为防止真实错误而产生、被重复调用的规则', notStore: '纯理论流程', usage: '把"知道"变成"每次都会做"' },
  { key: '07-Knowledge', name: '哪些领域知识未来复用', store: '未来至少三个项目可能复用的领域理解', notStore: '随手可搜的常识', usage: '技术/行业问题的长期积累' },
  { key: '08-Insights', name: '哪些已验证的判断改变决策', store: '能改变决策、产品方向或自我认知的已验证判断', notStore: '情绪碎片、未经验证的直觉', usage: '防止重复踩同一种坑' },
  { key: '09-Tools', name: '哪些工具和脚本省时间', store: '实际用过、能节约时间、包含回退方案的工具经验', notStore: '只安装未使用的软件', usage: '提升执行效率，避免重复试错' },
  { key: '10-Skills', name: '哪些能力可验证交付', store: '可外部验证、能交付、有作品支撑的能力', notStore: '"我想学"的愿望', usage: '简历、分工、能力缺口识别' },
  { key: '11-Write', name: '哪些写作可复用', store: '可以引用、改写、发布的成熟表达', notStore: '未整理草稿', usage: '保持跨场景表达一致' },
  { key: '12-Analysis', name: '决策过程与复盘', store: '有推理链、可事后复盘的研究与决策', notStore: '只有结论的事后合理化', usage: '重要决策可追溯、可修正' },
  { key: 'output', name: '对外交付物', store: '给外部的人看的最终交付物', notStore: '内部草稿', usage: '可直接分享给他人' },
  { key: 'research', name: '研究中间成果', store: '研究中的中间成果', notStore: '结论已定型的资产', usage: '未完成研究的暂存' },
  { key: 'tmp', name: '一次性草稿', store: '一次性草稿与临时文件', notStore: '任何未来要复用的东西', usage: '定期清理' },
];

const LAYER_KEYS = new Set(CONTEXT_OS_LAYERS.map((l) => l.key));

// ============================================================
// 路径
// ============================================================

export function getContextOsRoot(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'context-os');
}

export function getLayerDir(layer: string, home: string = os.homedir()): string {
  return path.join(getContextOsRoot(home), layer);
}

/** 校验 layer 合法; 非法返回 null */
export function resolveLayer(layer: string): ContextOsLayer | null {
  const key = String(layer || '').trim();
  return LAYER_KEYS.has(key) ? CONTEXT_OS_LAYERS.find((l) => l.key === key)! : null;
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_').slice(0, 40) || 'untitled';
}

// ============================================================
// 初始化: 建目录 + 每层 README (幂等)
// ============================================================

function layerReadme(l: ContextOsLayer): string {
  return `# ${l.key} — ${l.name}

## 这一层回答的问题
${l.name}

## 存什么
${l.store}

## 不该存什么
${l.notStore}

## 典型用途
${l.usage}

## 价值判断标准 (Context OS §5)
写入前先回答: **未来哪个具体场景会用到它?**
回答不出 = 噪音, 留在 tmp/, 不进正式层.

## 价值生命周期
阶段0 临时价值点 (对话中刚出现, 未验证) → 阶段1 验证 (被使用/确认)
→ 阶段2 固化 (本层唯一位置) → 阶段3 索引化 (高频引用) → 阶段4 归档/删除.
`;
}

export async function ensureContextOsDirs(home?: string): Promise<void> {
  const root = getContextOsRoot(home);
  await fs.mkdir(root, { recursive: true });
  for (const l of CONTEXT_OS_LAYERS) {
    const dir = getLayerDir(l.key, home);
    await fs.mkdir(dir, { recursive: true });
    const readmePath = path.join(dir, 'README.md');
    try {
      await fs.access(readmePath);
    } catch {
      await fs.writeFile(readmePath, layerReadme(l), 'utf-8');
    }
  }
}

// ============================================================
// 资产写入 / 读取
// ============================================================

export interface WriteContextAssetInput {
  /** 层 key: 01-Me ~ 12-Analysis / output / research / tmp */
  layer: string;
  /** 资产标题 */
  title: string;
  /** 资产正文 (markdown) */
  content: string;
  /** 可选 tags */
  tags?: string[];
  /** 可选 domain */
  domain?: string;
}

export interface ContextAsset {
  layer: string;
  file: string;
  title: string;
  path: string;
  createdAt: string;
  stage: 'stage0';
}

/**
 * 写入资产到指定层.
 * 文件名: <ts>-<slug>.md; frontmatter v2 (stage0 = 临时价值点, 待验证).
 * 幂等: 同层同 slug 已存在 → 跳过 (不重复造文件, Context OS §6 Step3).
 */
export async function writeContextAsset(
  input: WriteContextAssetInput,
  home?: string
): Promise<{ ok: boolean; asset?: ContextAsset; error?: string; skipped?: boolean }> {
  const layer = resolveLayer(input.layer);
  if (!layer) {
    return { ok: false, error: `layer 非法: '${input.layer}'. 合法: ${CONTEXT_OS_LAYERS.map((l) => l.key).join(' / ')}` };
  }
  const title = String(input.title || '').trim();
  if (!title) return { ok: false, error: 'title 必填' };
  const content = String(input.content || '').trim();
  if (!content) return { ok: false, error: 'content 必填' };

  await ensureContextOsDirs(home);

  const now = new Date().toISOString();
  const ts = Date.now();
  const slug = slugify(title);
  const fileName = `${ts}-${slug}.md`;
  const filePath = path.join(getLayerDir(layer.key, home), fileName);

  // 幂等: 同 slug 已存在 → 跳过
  try {
    const files = await fs.readdir(getLayerDir(layer.key, home));
    if (files.some((f) => f.endsWith(`-${slug}.md`))) {
      return { ok: true, skipped: true, error: `同标题资产已存在 (${slug}.md), 未重复写入` };
    }
  } catch { /* 目录不存在, 继续 */ }

  const fm = [
    '---',
    `title: ${title.replace(/[\n\r]/g, ' ').slice(0, 80)}`,
    `source: session`,
    `created: ${now}`,
    `layer: ${layer.key}`,
    `stage: stage0`,
    `tags: [${(input.tags || []).map((t) => t.replace(/[^\w\u4e00-\u9fa5-]/g, '')).filter(Boolean).join(', ')}]`,
    input.domain ? `domain: ${input.domain.replace(/[\n\r]/g, ' ').slice(0, 40)}` : '',
    'schema_version: 2',
    '---',
    '',
    content,
  ].filter(Boolean).join('\n');

  try {
    await fs.writeFile(filePath, fm, 'utf-8');
    return {
      ok: true,
      asset: { layer: layer.key, file: fileName, title, path: filePath, createdAt: now, stage: 'stage0' },
    };
  } catch (e: any) {
    return { ok: false, error: `写入失败: ${e?.message || String(e)}` };
  }
}

export interface ContextLayerListing {
  layer: string;
  name: string;
  fileCount: number;
  files: Array<{ file: string; title: string; createdAt: string }>;
}

/** 列出层资产; layer 为空 → 全层汇总 */
export async function readContextAssets(
  layer?: string,
  keyword?: string,
  home?: string
): Promise<ContextLayerListing[]> {
  const root = getContextOsRoot(home);
  const kw = String(keyword || '').trim().toLowerCase();
  const wanted = layer ? [resolveLayer(layer)].filter(Boolean).map((l) => l!.key) : CONTEXT_OS_LAYERS.map((l) => l.key);
  const out: ContextLayerListing[] = [];

  for (const key of wanted) {
    const l = resolveLayer(key)!;
    try {
      const files = (await fs.readdir(getLayerDir(key, home))).filter((f) => f.endsWith('.md') && f !== 'README.md');
      const entries: Array<{ file: string; title: string; createdAt: string }> = [];
      for (const f of files) {
        try {
          const raw = await fs.readFile(path.join(getLayerDir(key, home), f), 'utf-8');
          const titleM = raw.match(/^title:\s*(.+)$/m);
          const createdM = raw.match(/^created:\s*(.+)$/m);
          const title = titleM ? titleM[1].trim() : f.replace(/\.md$/, '');
          if (kw && !(title.toLowerCase().includes(kw) || raw.toLowerCase().includes(kw))) continue;
          entries.push({ file: f, title, createdAt: createdM ? createdM[1].trim() : '' });
        } catch { /* 单文件损坏跳过 */ }
      }
      entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      out.push({ layer: key, name: l.name, fileCount: entries.length, files: entries.slice(0, 20) });
    } catch {
      out.push({ layer: key, name: l.name, fileCount: 0, files: [] });
    }
  }
  return out;
}

/** 读取单篇资产正文 (供工具输出完整内容) */
export async function readAssetBody(
  layer: string,
  file: string,
  home?: string
): Promise<{ ok: boolean; body?: string; error?: string }> {
  const l = resolveLayer(layer);
  if (!l) return { ok: false, error: `layer 非法: '${layer}'` };
  const safeFile = path.basename(String(file || '').replace(/[^\w\u4e00-\u9fa5.-]/g, '_'));
  if (!safeFile.endsWith('.md')) return { ok: false, error: 'file 必须是 .md' };
  try {
    const raw = await fs.readFile(path.join(getLayerDir(l.key, home), safeFile), 'utf-8');
    return { ok: true, body: raw };
  } catch (e: any) {
    return { ok: false, error: `读取失败: ${e?.message || String(e)}` };
  }
}

/** 层 → 上下文注入摘要 (给 LLM 的资产层目录) */
export function formatLayerListing(listings: ContextLayerListing[]): string {
  if (listings.length === 0) return '';
  const lines = listings.map(
    (l) => `  - ${l.layer} (${l.name}): ${l.fileCount} 篇` + (l.files.length > 0 ? ` — ${l.files.slice(0, 3).map((f) => f.title).join(' / ')}` : '')
  );
  return `[系统上下文] 资产层 (Context OS 12+3 层, 先看 03-Current 再按任务路由):\n${lines.join('\n')}\n\n`;
}
