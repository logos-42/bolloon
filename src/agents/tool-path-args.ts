/**
 * 工具参数里的 `~` 展开 (2026-10-01)。
 *
 * 用户实测: 智能体调 `list_files { path: "~/.bolloon" }` ⇒ `ENOENT: scandir '~/.bolloon'` ✗。
 * 根因: 全仓**没有任何一处**做 `~` 展开 ⇒ 模型写的 `~/x` 原样进 fs, 变成字面目录名。
 * 修法: 在**唯一分发点** (pi-sdk.ts 的 `tool.execute(...)`) 统一展开 —— 工具设置层修一次,
 *   而不是每个工具各打一个补丁 (那样必然漏)。只碰已知的路径类参数, 其它参数一律不动。
 */
import os from 'node:os';
import path from 'node:path';

/** 会被当成路径的参数名 (只展开这些, 别的一律不碰) */
export const PATH_ARG_KEYS: ReadonlyArray<string> = [
  'path', 'paths', 'dir', 'directory', 'folder', 'file', 'file_path', 'filePath',
  'from', 'to', 'target', 'source', 'src', 'dest', 'cwd', 'workdir', 'root', 'glob_dir',
];

/** 只展开**开头**的 `~` (单独的 `~` 或 `~/...`); `a~b` / `~user` 不碰 */
export function expandTilde(p: string, home: string = os.homedir()): string {
  const s = String(p ?? '');
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~' + path.sep)) return path.join(home, s.slice(2));
  return s;
}

export function expandHomeArgs(args: Record<string, any>, home?: string): Record<string, any> {
  if (!args || typeof args !== 'object') return args;
  const out: Record<string, any> = { ...args };
  for (const key of Object.keys(out)) {
    if (!PATH_ARG_KEYS.includes(key)) continue;
    const v = out[key];
    if (typeof v === 'string') out[key] = expandTilde(v, home);
    else if (Array.isArray(v)) out[key] = v.map((x) => (typeof x === 'string' ? expandTilde(x, home) : x));
  }
  return out;
}
