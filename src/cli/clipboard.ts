/**
 * clipboard.ts — 把文本真写进**系统剪贴板** (2026-09-27)
 *
 * ## 为什么需要它
 *
 * 面板是 Ink 画的**一屏自绘帧**: 每帧都是 `eraseLines` + 重画。终端里的鼠标框选靠终端自己维护,
 * 而"每秒重画一帧"会不断打断正在进行的框选 —— 于是"想抄一段回复"变成了撞运气。
 * 真终端字节证据 (`scripts/verify-cli-panel.ts` 抓的那一份):
 *   · `ESC[2J ESC[3J ESC[H` (**清屏 + 清回滚缓冲**) 在 30s 内出现 24 次;
 *   · 每一次都来自 Ink 的 `renderInteractiveFrame` (`shouldClearTerminalForFrame`: 帧高缩了/上一帧是别的形状)。
 * 这既解释了"选不中", 也解释了"往上滚看不到更早的内容"。
 *
 * 所以复制走**两条腿**:
 *   ① 结构上少打断: 版面固定成"整屏高" + 跟随暂停时**完全不重画** (见 `ink-app.tsx`) → 帧不再乱清;
 *   ② 一条**不靠鼠标**的显式通路: `/copy` —— 把最近一条/整段回复交给系统剪贴板工具。
 *     能用 `pbcopy` 就不假装"已经复制到剪贴板了"。
 */

import { spawnSync } from 'child_process';

/** 剪贴板工具按平台挑 (第一个能跑的胜出); 环境变量 `BOLLOON_CLIPBOARD_CMD` 可显式覆盖 (验收门用) */
export function clipboardCommand(env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } | null {
  const override = (env.BOLLOON_CLIPBOARD_CMD ?? '').trim();
  if (override) {
    const parts = override.split(/\s+/).filter(Boolean);
    if (parts.length) return { cmd: parts[0], args: parts.slice(1) };
  }
  switch (process.platform) {
    case 'darwin': return { cmd: 'pbcopy', args: [] };
    case 'win32': return { cmd: 'clip', args: [] };
    default:
      if (env.WAYLAND_DISPLAY) return { cmd: 'wl-copy', args: [] };
      if (env.DISPLAY) return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
      return null;
  }
}

/** 剪贴板工具名 (报告/界面里只说工具名, 不打印被复制的内容) */
export function clipboardToolName(env: NodeJS.ProcessEnv = process.env): string | null {
  const c = clipboardCommand(env);
  return c ? c.cmd : null;
}

export interface ClipboardResult {
  ok: boolean;
  /** 真的把字节喂进去了的那个工具 */
  tool?: string;
  chars: number;
  error?: string;
}

/**
 * 真写剪贴板 (同步: 这条命令要立刻给出"成没成", 不能 fire-and-forget)。
 * 返回值只含**长度与工具名** —— 文本内容绝不回显/落日志 (回复里可能有 key/私密内容)。
 */
export function clipboardWrite(text: string, env: NodeJS.ProcessEnv = process.env): ClipboardResult {
  const chars = String(text ?? '').length;
  const c = clipboardCommand(env);
  if (!c) {
    return { ok: false, chars, error: '这个平台没有可用的剪贴板命令 (macOS: pbcopy / Windows: clip / Linux: wl-copy 或 xclip)' };
  }
  try {
    const r = spawnSync(c.cmd, c.args, { input: String(text ?? ''), encoding: 'utf8', timeout: 5000 });
    if (r.error) return { ok: false, chars, tool: c.cmd, error: `调用 ${c.cmd} 失败: ${r.error.message}` };
    if (r.status !== 0) {
      return { ok: false, chars, tool: c.cmd, error: `${c.cmd} 退出码 ${r.status}${r.stderr ? `: ${String(r.stderr).slice(0, 120)}` : ''}` };
    }
    return { ok: true, chars, tool: c.cmd };
  } catch (e: any) {
    return { ok: false, chars, tool: c.cmd, error: String(e?.message || e).slice(0, 160) };
  }
}
