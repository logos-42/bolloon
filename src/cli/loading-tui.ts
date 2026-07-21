/**
 * loading-tui.ts — Bolloon Agent 终端视觉层 + 启动仪表盘 (纯 ANSI, 无外部依赖)
 *
 * 品牌要素 (与 TUI 一起维护):
 *   - BOLLOON_ICON : 顶部带圆标注的 "0" (气球造型)
 *   - BOLLOON_BANNER : "BOLLOON" / "AGENT" block 字体艺术字
 *
 * 导出构件:
 *   printBanner(v?)        一次性打印完整品牌 banner (图标 + 艺术字 + 版本/标语)
 *   renderDashboard(opts)  带品牌边框的仪表盘 (艺术字在框内)
 *   renderDialog(opts)     带品牌边框的对话框 (艺术字在框内)
 *   LoadingTUI             原地刷新的启动仪表盘类
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const WHITE = '\x1b[37m';

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';

// 版本信息 — 从 package.json 读取, 不再硬编码
function getPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const BOLLOON_VERSION = getPackageVersion();

// ── 品牌图标: 顶部带圆标注的 0 (气球) ──────────────
export const BOLLOON_ICON = [
  `${CYAN}        ✦${RESET}`,
  `${CYAN}      ╱ ╲${RESET}`,
  `${CYAN}  ════◆════${RESET}`,
  `${CYAN}      ╲ ╱${RESET}`,
  `${CYAN}       ╲${RESET}`,
  `${CYAN}    ✦  ╲${RESET}`,
].join('\n');

// ── 艺术字: BOLLOON (box 字体) + Bolloon Agent 副标题 ──
export const BOLLOON_BANNER = [
  `${WHITE}${BOLD}██████╗  ██████╗ ██╗     ██╗      ██████╗  ██████╗ ███╗   ██╗${RESET}`,
  `${WHITE}${BOLD}██╔══██╗██╔═══██╗██║     ██║     ██╔═══██╗██╔═══██╗████╗  ██║${RESET}`,
  `${WHITE}${BOLD}██████╔╝██║   ██║██║     ██║     ██║   ██║██║   ██║██╔██╗ ██║${RESET}`,
  `${WHITE}${BOLD}██╔══██╗██║   ██║██║     ██║     ██║   ██║██║   ██║██║╚██╗██║${RESET}`,
  `${WHITE}${BOLD}██████╔╝╚██████╔╝███████╗███████╗╚██████╔╝╚██████╔╝██║ ╚████║${RESET}`,
  `${WHITE}${BOLD}╚═════╝  ╚═════╝ ╚══════╝╚══════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝${RESET}`,
  `${GRAY}Bolloon Agent v${BOLLOON_VERSION}${RESET}`,
].join('\n');

/** 艺术字全部行 (图标在左, BOLLOON 艺术字在右), 供框内渲染 */
function brandArtLines(): string[] {
  const icon = BOLLOON_ICON.split('\n');
  const banner = BOLLOON_BANNER.split('\n');
  const gap = 2;
  const iconW = Math.max(1, ...icon.map(l => stripAnsi(l).length));
  const rows: string[] = [];
  const n = Math.max(icon.length, banner.length);
  for (let i = 0; i < n; i++) {
    const il = icon[i] ?? '';
    const bl = banner[i] ?? '';
    const pad = Math.max(0, iconW - stripAnsi(il).length);
    rows.push(il + ' '.repeat(pad + gap) + bl);
  }
  return rows;
}

export function printBanner(version?: string): void {
  console.log(BOLLOON_ICON);
  console.log(BOLLOON_BANNER);
  if (version) console.log(`${GRAY}  Bolloon Agent v${version}${RESET}`);
  console.log(`${GRAY}  P2P AI Agent · 文档智能体${RESET}`);
  console.log('');
}

// ── 状态图标 ───────────────────────────────────────
export const STATUS_SYMBOL: Record<string, string> = {
  pending: `${GRAY}○${RESET}`,
  active: `${YELLOW}⠹${RESET}`,
  ok: `${GREEN}✓${RESET}`,
  warn: `${YELLOW}⚠${RESET}`,
  error: `${RED}✗${RESET}`,
  info: `${CYAN}●${RESET}`,
};

// ── 通用边框构件 ───────────────────────────────────
const BOX = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };

function termWidth(): number {
  const c = (process.stdout as any).columns;
  return typeof c === 'number' && c > 24 ? c : 80;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function centerAnsi(text: string, inner: number): string {
  const vis = stripAnsi(text).length;
  const pad = Math.max(0, inner - vis);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

function fitLeft(text: string, inner: number): string {
  const vis = stripAnsi(text).length;
  return text + ' '.repeat(Math.max(0, inner - vis));
}

export function boxTop(title: string, width: number): string {
  const inner = Math.max(0, width - 2);
  const t = title ? ` ${title} ` : '';
  const pad = Math.max(0, inner - stripAnsi(t).length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return BOX.tl + BOX.h.repeat(left) + t + BOX.h.repeat(right) + BOX.tr;
}

export function boxRow(content: string, width: number, align: 'left' | 'center' = 'left'): string {
  const inner = Math.max(0, width - 4);
  const body = align === 'center' ? centerAnsi(content, inner) : fitLeft(content, inner);
  return BOX.v + ' ' + body + ' ' + BOX.v;
}

export function boxBottom(width: number): string {
  return BOX.bl + BOX.h.repeat(Math.max(0, width - 2)) + BOX.br;
}

// ── 仪表盘 / 对话框 ───────────────────────────────
export interface DashRow {
  label: string;
  status?: 'pending' | 'active' | 'ok' | 'warn' | 'error' | 'info';
  detail?: string;
}

export interface DashboardOpts {
  title?: string;
  rows: DashRow[];
  brand?: boolean;
  width?: number;
}

export function renderDashboard(opts: DashboardOpts): string {
  const showBrand = opts.brand !== false;
  const art = showBrand ? brandArtLines() : [];
  const maxArt = art.reduce((m, l) => Math.max(m, stripAnsi(l).length), 0);
  const maxRow = opts.rows.reduce(
    (m, r) => Math.max(m, stripAnsi(r.label).length + (r.detail ? stripAnsi(r.detail).length + 2 : 0) + 4),
    0,
  );
  const maxTitle = stripAnsi(opts.title ?? 'Bolloon Agent · 仪表盘').length + 4;
  const inner = Math.max(40, maxArt, maxRow, maxTitle);
  const width = Math.min(termWidth() - 2, opts.width ?? inner + 4);
  const lines: string[] = [];
  lines.push(boxTop(opts.title ?? 'Bolloon Agent · 仪表盘', width));
  if (showBrand) {
    for (const l of art) lines.push(boxRow(l, width, 'center'));
  }
  for (const r of opts.rows) {
    const sym = STATUS_SYMBOL[r.status ?? 'info'];
    const detail = r.detail ? `  ${GRAY}${r.detail}${RESET}` : '';
    lines.push(boxRow(`${sym} ${r.label}${detail}`, width));
  }
  lines.push(boxBottom(width));
  return lines.join('\n');
}

export interface DialogOpts {
  title?: string;
  prompt: string;
  width?: number;
}

export function renderDialog(opts: DialogOpts): string {
  const art = brandArtLines();
  const maxArt = art.reduce((m, l) => Math.max(m, stripAnsi(l).length), 0);
  const inner = Math.max(
    40,
    maxArt,
    stripAnsi(opts.prompt).length + 4,
    stripAnsi(opts.title ?? 'Bolloon Agent').length + 4,
  );
  const width = Math.min(termWidth() - 2, opts.width ?? inner + 4);
  const lines: string[] = [];
  lines.push(boxTop(opts.title ?? 'Bolloon Agent', width));
  for (const l of art) lines.push(boxRow(l, width, 'center'));
  lines.push(boxRow(opts.prompt, width));
  lines.push(boxBottom(width));
  return lines.join('\n');
}

// ── 消息对话框 (聊天流: 已发送 / 智能体回复) ───────
/** 按可见宽度折行 (保留 ANSI, 优先在空格处断行) */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (stripAnsi(rawLine).length <= width) {
      out.push(rawLine);
      continue;
    }
    const words = rawLine.split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      if (stripAnsi(cur).length + stripAnsi(w).length > width && stripAnsi(cur).length > 0) {
        out.push(cur);
        cur = w.replace(/^\s+/, '');
      } else {
        cur += w;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

export interface MessageBoxOpts {
  title?: string;
  body: string;
  color?: string;
  width?: number;
  /** 显示截断: 超过此行数则截断 (仅影响显示, 原文仍发给 LLM)。0 或省略=不限制 */
  maxLines?: number;
}

/** 对话框默认显示上限 (按高度截断) */
const DEFAULT_MAX_LINES = 14;

export function renderMessageBox(opts: MessageBoxOpts): string {
  const color = opts.color ?? CYAN;
  const title = opts.title ?? 'Bolloon Agent';
  const maxLines = opts.maxLines && opts.maxLines > 0 ? opts.maxLines : 0;
  const bodyLines = wrapText(opts.body, 1000);
  // 压缩: 用「引用」框代替被压缩的内容 (仅影响显示, 原文仍发给 LLM)
  if (maxLines > 0 && bodyLines.length > maxLines) {
    return renderReference({ title, body: opts.body, color, hidden: bodyLines.length, width: opts.width });
  }
  const maxLine = bodyLines.reduce((m, l) => Math.max(m, stripAnsi(l).length), 0);
  const inner = Math.max(20, stripAnsi(title).length + 4, maxLine);
  const width = Math.min(termWidth() - 2, opts.width ?? inner + 4);
  const lines: string[] = [];
  lines.push(boxTop(`${color}${title}${RESET}`, width));
  for (const l of wrapText(opts.body, width - 4)) lines.push(boxRow(l, width));
  lines.push(boxBottom(width));
  return lines.join('\n');
}

/** 取首条非空行作为预览 (按可见宽度截断, 加省略号) */
function firstLinePreview(text: string, width: number): string {
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (t) {
      const s = stripAnsi(t);
      return s.length > width ? s.slice(0, Math.max(0, width - 1)) + '…' : t;
    }
  }
  return '';
}

/** 压缩后的「引用」框: 代替被压缩的正文 */
function renderReference(opts: {
  title: string;
  body: string;
  color: string;
  hidden: number;
  width?: number;
}): string {
  const preview = firstLinePreview(opts.body, 60);
  const inner = Math.max(
    20,
    stripAnsi(opts.title).length + 8,
    stripAnsi(`已压缩 ${opts.hidden} 行 · 完整内容已发送给智能体`).length,
    stripAnsi(preview).length + 2,
  );
  const width = Math.min(termWidth() - 2, opts.width ?? inner + 4);
  const lines: string[] = [];
  lines.push(boxTop(`${GRAY}引用${RESET} ${opts.color}${opts.title}${RESET}`, width));
  lines.push(boxRow(`${GRAY}已压缩 ${opts.hidden} 行 · 完整内容已发送给智能体${RESET}`, width));
  if (preview) lines.push(boxRow(`${GRAY}▏ ${preview}${RESET}`, width));
  lines.push(boxBottom(width));
  return lines.join('\n');
}

/** 已发送消息框 (用户输入) */
export function renderUserMessage(body: string): string {
  return renderMessageBox({ title: '✓ 已发送', body, color: GREEN, maxLines: DEFAULT_MAX_LINES });
}

/** 智能体回复框 */
export function renderAgentMessage(body: string): string {
  return renderMessageBox({ title: '◉ Bolloon Agent', body, color: CYAN, maxLines: DEFAULT_MAX_LINES });
}

// ── 启动仪表盘 (原地刷新) ──────────────────────────
export type LoadingStepStatus = 'pending' | 'active' | 'ok' | 'warn' | 'error';

export interface LoadingStep {
  label: string;
  status: LoadingStepStatus;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class LoadingTUI {
  private write: (chunk: any, ...args: any[]) => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;
  private steps: LoadingStep[] = [];
  private currentLabel = 'Bolloon loading...';
  private finished = false;
  private ok = true;
  private width = 0;

  constructor() {
    this.write = process.stdout.write.bind(process.stdout);
  }

  private computeWidth(): number {
    const cols = (process.stdout as any).columns;
    const maxCols = cols && cols > 30 ? cols - 2 : 60;
    const artW = brandArtLines().reduce((m, l) => Math.max(m, stripAnsi(l).length), 0);
    const needed = Math.max(
      40,
      artW,
      ...this.steps.map(s => s.label.length + 8),
      this.currentLabel.length + 6,
    );
    return Math.min(maxCols, needed + 4);
  }

  /** 仪表盘区域总行数: 上边框 + 艺术字 + steps + spinner + 下边框 */
  private regionLines(): number {
    return 1 + brandArtLines().length + this.steps.length + 1 + 1;
  }

  private draw(showSpinner: boolean): void {
    const w = this.width || (this.width = this.computeWidth());
    const out: string[] = [];
    out.push(boxTop('Bolloon Agent · 启动仪表盘', w));
    for (const l of brandArtLines()) out.push(boxRow(l, w, 'center'));
    for (const step of this.steps) {
      out.push(boxRow(`${STATUS_SYMBOL[step.status]} ${step.label}`, w));
    }
    if (showSpinner) {
      const sp = YELLOW + FRAMES[this.frameIdx % FRAMES.length] + RESET;
      out.push(boxRow(`${sp} ${this.currentLabel}`, w));
    } else {
      out.push(boxRow(`${STATUS_SYMBOL.ok} Bolloon ready`, w));
    }
    out.push(boxBottom(w));
    this.write(out.join('\n'));
    // 回退到仪表盘上边框, 下次 draw 原地覆盖
    this.write(`\x1b[${this.regionLines()}A`);
  }

  setSteps(steps: string[]) {
    this.steps = steps.map(label => ({ label, status: 'pending' as LoadingStepStatus }));
    this.width = 0;
    if (this.timer) this.draw(true);
  }

  startStep(index: number, label?: string) {
    if (index < 0 || index >= this.steps.length) return;
    this.steps[index].status = 'active';
    if (label !== undefined) this.steps[index].label = label;
    if (this.timer) this.draw(true);
  }

  completeStep(index: number, status: LoadingStepStatus = 'ok', label?: string) {
    if (index < 0 || index >= this.steps.length) return;
    this.steps[index].status = status;
    if (label !== undefined) this.steps[index].label = label;
    if (this.timer) this.draw(true);
  }

  setMessage(msg: string) {
    this.currentLabel = msg;
    if (this.timer) this.draw(true);
  }

  start(msg = 'Bolloon loading...') {
    if (this.timer) return;
    this.currentLabel = msg;
    this.write(HIDE);
    this.timer = setInterval(() => {
      if (this.finished) return;
      this.frameIdx++;
      this.draw(true);
    }, 100);
    this.draw(true);
  }

  stop(ok = true) {
    this.finished = true;
    this.ok = ok;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.draw(false);
    this.write(SHOW);
  }

  isFinished() {
    return this.finished;
  }

  wasOk() {
    return this.ok;
  }
}
