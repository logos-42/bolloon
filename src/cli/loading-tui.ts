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
const DIM = '\x1b[2m';

// Bolloon Web UI 配色 truecolor ANSI
function fg(r: number, g: number, b: number): string { return `\x1b[38;2;${r};${g};${b}m`; }
function bg(r: number, g: number, b: number): string { return `\x1b[48;2;${r};${g};${b}m`; }

const C_ACCENT    = fg(0xc4, 0xd6, 0x40);  // #c4d640
const C_ACCENT_BG = bg(0xc4, 0xd6, 0x40);
const C_TEXT      = fg(0xd8, 0xd8, 0xc8);  // #d8d8c8
const C_DIM       = fg(0x90, 0x90, 0x88);  // #909088
const C_MUTED     = fg(0x60, 0x60, 0x58);  // #606058
const C_OK        = fg(0x22, 0xc5, 0x5e);  // #22c55e
const C_ERROR     = fg(0xef, 0x44, 0x44);  // #ef4444
const C_WARN      = fg(0xf5, 0x9e, 0x0b);  // #f59e0b
const C_BORDER    = fg(0x3a, 0x3a, 0x36);  // #3a3a36

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
  `${C_ACCENT}        ✦${RESET}`,
  `${C_ACCENT}      ╱ ╲${RESET}`,
  `${C_ACCENT}  ════◆════${RESET}`,
  `${C_ACCENT}      ╲ ╱${RESET}`,
  `${C_ACCENT}       ╲${RESET}`,
  `${C_ACCENT}    ✦  ╲${RESET}`,
].join('\n');

// ── 艺术字: BOLLOON (box 字体) + Bolloon Agent 副标题 ──
export const BOLLOON_BANNER = [
  `${C_TEXT}${BOLD}██████╗  ██████╗ ██╗     ██╗      ██████╗  ██████╗ ███╗   ██╗${RESET}`,
  `${C_TEXT}${BOLD}██╔══██╗██╔═══██╗██║     ██║     ██╔═══██╗██╔═══██╗████╗  ██║${RESET}`,
  `${C_TEXT}${BOLD}██████╔╝██║   ██║██║     ██║     ██║   ██║██║   ██║██╔██╗ ██║${RESET}`,
  `${C_TEXT}${BOLD}██╔══██╗██║   ██║██║     ██║     ██║   ██║██║   ██║██║╚██╗██║${RESET}`,
  `${C_TEXT}${BOLD}██████╔╝╚██████╔╝███████╗███████╗╚██████╔╝╚██████╔╝██║ ╚████║${RESET}`,
  `${C_TEXT}${BOLD}╚═════╝  ╚═════╝ ╚══════╝╚══════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝${RESET}`,
  `${C_DIM}Bolloon Agent v${BOLLOON_VERSION}${RESET}`,
].join('\n');

/** 艺术字全部行 (图标在左, BOLLOON 艺术字在右), 供框内渲染 */
function brandArtLines(): string[] {
  const icon = BOLLOON_ICON.split('\n');
  const banner = BOLLOON_BANNER.split('\n');
  const gap = 2;
  const iconW = Math.max(1, ...icon.map(l => dispWidth(l)));
  const rows: string[] = [];
  const n = Math.max(icon.length, banner.length);
  for (let i = 0; i < n; i++) {
    const il = icon[i] ?? '';
    const bl = banner[i] ?? '';
    const pad = Math.max(0, iconW - dispWidth(il));
    rows.push(il + ' '.repeat(pad + gap) + bl);
  }
  return rows;
}

export function printBanner(version?: string): void {
  console.log(BOLLOON_ICON);
  console.log(BOLLOON_BANNER);
  if (version) console.log(`${C_DIM}  Bolloon Agent v${version}${RESET}`);
  console.log(`${C_DIM}  P2P AI Agent · 文档智能体${RESET}`);
  console.log('');
}

// ── 状态图标 ───────────────────────────────────────
export const STATUS_SYMBOL: Record<string, string> = {
  pending: `${C_MUTED}○${RESET}`,
  active: `${C_WARN}⠹${RESET}`,
  ok: `${C_OK}✓${RESET}`,
  warn: `${C_WARN}⚠${RESET}`,
  error: `${C_ERROR}✗${RESET}`,
  info: `${C_ACCENT}●${RESET}`,
};

// ── 通用边框构件 ───────────────────────────────────
type Corners = { tl: string; tr: string; bl: string; br: string; v: string; h: string };
// 方角 (启动仪表盘 / 对话框 / 引用框)
const SQ: Corners = { tl: '┌', tr: '┐', bl: '└', br: '┘', v: '│', h: '─' };
// 圆角 (工具调用显示 / 智能体回复内容)
const RD: Corners = { tl: '╭', tr: '╮', bl: '╰', br: '╯', v: '│', h: '─' };

export function termWidth(): number {
  const c = (process.stdout as any).columns;
  return typeof c === 'number' && c > 24 ? c : 80;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 显示宽度: CJK / 全角符号算 2, 其余算 1 (ANSI 转义不计入) */
function dispWidth(s: string): number {
  const clean = s.replace(/\x1b\[[0-9;]*m/g, '');
  let n = 0;
  for (const ch of clean) {
    const c = ch.codePointAt(0)!;
    const wide =
      c > 0x1100 &&
      (c <= 0x115f ||
        c === 0x2329 ||
        c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe4f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6));
    n += wide ? 2 : 1;
  }
  return n;
}

function centerAnsi(text: string, inner: number): string {
  const vis = dispWidth(text);
  const pad = Math.max(0, inner - vis);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

/** 左侧对齐并按显示宽度填充/截断到 inner */
function fitLeft(text: string, inner: number): string {
  const vis = dispWidth(text);
  if (vis <= inner) return text + ' '.repeat(inner - vis);
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = dispWidth(ch);
    if (w + cw > inner - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** 按显示宽度截断并加省略号 */
function truncate(text: string, max: number): string {
  if (dispWidth(text) <= max) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = dispWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

export function boxTop(title: string, width: number, corners: Corners = SQ): string {
  const inner = Math.max(0, width - 2);
  let t = title ? ` ${title} ` : '';
  if (dispWidth(t) > inner) t = truncate(t, inner);
  const pad = Math.max(0, inner - dispWidth(t));
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return corners.tl + corners.h.repeat(left) + t + corners.h.repeat(right) + corners.tr;
}

export function boxRow(content: string, width: number, align: 'left' | 'center' = 'left', corners: Corners = SQ): string {
  const inner = Math.max(0, width - 4);
  const body = align === 'center' ? centerAnsi(content, inner) : fitLeft(content, inner);
  return corners.v + ' ' + body + ' ' + corners.v;
}

export function boxBottom(width: number, corners: Corners = SQ): string {
  return corners.bl + corners.h.repeat(Math.max(0, width - 2)) + corners.br;
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
  const maxArt = art.reduce((m, l) => Math.max(m, dispWidth(l)), 0);
  const maxRow = opts.rows.reduce(
    (m, r) => Math.max(m, dispWidth(r.label) + (r.detail ? dispWidth(r.detail) + 2 : 0) + 4),
    0,
  );
  const maxTitle = dispWidth(opts.title ?? 'Bolloon Agent · 仪表盘') + 4;
  const inner = Math.max(40, maxArt, maxRow, maxTitle);
  const width = Math.min(termWidth() - 2, opts.width ?? inner + 4);
  const lines: string[] = [];
  lines.push(boxTop(opts.title ?? 'Bolloon Agent · 仪表盘', width));
  if (showBrand) {
    for (const l of art) lines.push(boxRow(l, width, 'center'));
  }
  for (const r of opts.rows) {
    const sym = STATUS_SYMBOL[r.status ?? 'info'];
    const detail = r.detail ? `  ${C_DIM}${r.detail}${RESET}` : '';
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
  const maxArt = art.reduce((m, l) => Math.max(m, dispWidth(l)), 0);
  const inner = Math.max(
    40,
    maxArt,
    dispWidth(opts.prompt) + 4,
    dispWidth(opts.title ?? 'Bolloon Agent') + 4,
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
/** 按显示宽度折行 (保留 ANSI, 优先在空格处断行; 超长无空格片段按字符硬断) */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return text.split('\n');
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (dispWidth(rawLine) <= width) {
      out.push(rawLine);
      continue;
    }
    const words = rawLine.split(/(\s+)/);
    let cur = '';
    const flush = () => {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    };
    for (const w of words) {
      if (w.length === 0) continue;
      const wv = dispWidth(w);
      if (wv > width) {
        // 超长无空格片段 (如中文长句) → 按字符硬断
        flush();
        let chunk = '';
        for (const ch of w) {
          const cv = dispWidth(ch);
          if (dispWidth(chunk) + cv > width && dispWidth(chunk) > 0) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        cur = chunk;
        continue;
      }
      if (dispWidth(cur) + wv > width && dispWidth(cur) > 0) {
        flush();
        cur = w.replace(/^\s+/, '');
      } else {
        cur += w;
      }
    }
    flush();
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
  const color = opts.color ?? C_ACCENT;
  const title = opts.title ?? 'Bolloon Agent';
  const maxLines = opts.maxLines && opts.maxLines > 0 ? opts.maxLines : 0;
  const bodyLines = wrapText(opts.body, 1000);
  // 压缩: 用「引用」框代替被压缩的内容 (仅影响显示, 原文仍发给 LLM)
  if (maxLines > 0 && bodyLines.length > maxLines) {
    return renderReference({ title, body: opts.body, color, hidden: bodyLines.length, width: opts.width });
  }
  const maxLine = bodyLines.reduce((m, l) => Math.max(m, dispWidth(l)), 0);
  const inner = Math.max(20, dispWidth(title) + 4, maxLine);
  const width = Math.min(termWidth() - 2, opts.width ?? inner + 4);
  const lines: string[] = [];
  lines.push(boxTop(`${color}${title}${RESET}`, width, RD));
  for (const l of wrapText(opts.body, width - 4)) lines.push(boxRow(l, width, 'left', RD));
  lines.push(boxBottom(width, RD));
  return lines.join('\n');
}

/** 取首条非空行作为预览 (按可见宽度截断, 加省略号) */
function firstLinePreview(text: string, width: number): string {
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (t) return truncate(t, width);
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
    dispWidth(opts.title) + 8,
    dispWidth(`已压缩 ${opts.hidden} 行 · 完整内容已发送给智能体`),
    dispWidth(preview) + 2,
  );
  const width = Math.min(termWidth() - 2, opts.width ?? inner + 4);
  const lines: string[] = [];
  lines.push(boxTop(`${C_DIM}引用${RESET} ${opts.color}${opts.title}${RESET}`, width, RD));
  lines.push(boxRow(`${C_DIM}已压缩 ${opts.hidden} 行 · 完整内容已发送给智能体${RESET}`, width, 'left', RD));
  if (preview) lines.push(boxRow(`${C_DIM}▏ ${preview}${RESET}`, width, 'left', RD));
  lines.push(boxBottom(width, RD));
  return lines.join('\n');
}

/** 已发送消息框 (用户输入) */
export function renderUserMessage(body: string): string {
  return renderMessageBox({ title: '✓ 已发送', body, color: C_OK, maxLines: DEFAULT_MAX_LINES });
}

/** 智能体回复框 */
export function renderAgentMessage(body: string): string {
  return renderMessageBox({ title: '◉ Bolloon Agent', body, color: C_ACCENT, maxLines: DEFAULT_MAX_LINES });
}

// ── 工具调用显示 (圆角框 + ╼╾ 连接) ────────────────
/** 单步工具调用的视图数据 */
export interface ToolCallView {
  tool: string;
  args?: Record<string, unknown> | string;
  status: 'ok' | 'error';
  output?: string;
  error?: string;
  durationMs?: number;
  width?: number;
}

/** 循环工作流连接线: 用 ╼ ╾ 串联相邻工具框 */
export function flowConnector(width: number): string {
  const unit = '╼ ╾ ';
  let s = '';
  while (s.length < width) s += unit;
  return s.slice(0, width);
}

/** 渲染单个工具调用为圆角框 (参数 / 状态 / 输出预览) */
export function renderToolCall(v: ToolCallView): string {
  const color = v.status === 'ok' ? C_OK : C_ERROR;
  const sym = v.status === 'ok' ? '✅' : '❌';
  const w = Math.min(termWidth() - 2, v.width ?? 72);
  const rows: string[] = [];
  const argStr = typeof v.args === 'string' ? v.args : v.args ? JSON.stringify(v.args) : '';
  if (argStr) rows.push(`参数: ${truncate(argStr, w - 10)}`);
  const dur = v.durationMs != null ? ` (${v.durationMs}ms)` : '';
  rows.push(`状态: ${sym} ${v.status === 'ok' ? '成功' : '失败'}${dur}`);
  const body = v.status === 'ok' ? v.output : v.error;
  if (body) {
    const wrapped = wrapText(body, w - 6);
    const shown = wrapped.slice(0, 3);
    for (const l of shown) rows.push(`▏ ${l}`);
    if (wrapped.length > 3) rows.push(`▏ … 已压缩 ${wrapped.length - 3} 行`);
  }
  const lines: string[] = [];
  lines.push(boxTop(`${color}◉ ${v.tool}${RESET}`, w, RD));
  for (const l of rows) lines.push(boxRow(l, w, 'left', RD));
  lines.push(boxBottom(w, RD));
  return lines.join('\n');
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
    const artW = brandArtLines().reduce((m, l) => Math.max(m, dispWidth(l)), 0);
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
      const sp = C_WARN + FRAMES[this.frameIdx % FRAMES.length] + RESET;
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
