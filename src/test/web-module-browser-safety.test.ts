/**
 * 门: 浏览器可达模块不许引用 Node 全局 (process / require / __dirname / __filename / Buffer)
 *
 * 背景 (2026-10-02 真事故): src/agents/parse-tool-call.ts 顶层加了
 *   `const PARSE_DIAG_ON = process.env.BOLLOON_PARSE_DIAG === '1' || ...`
 * 该文件被浏览器侧模块链引用:
 *   /ui/message-renderer.js → /agents/chat-segmenter.js → /agents/parse-tool-call.js
 * 浏览器没有 process ⇒ 模块求值抛 ReferenceError ⇒ message-renderer 整个模块不上屏挂载
 * ⇒ window.MR 为 undefined ⇒ client.js 里所有 MR_* 调用变成静默 no-op
 * ⇒ 用户气泡/AI 回复/流式全部不渲染, 且**没有任何报错**。
 *
 * 断言: 浏览器可达图里每一行都不得出现"未加保护"的 Node 全局。
 * 允许的写法 (守卫): 行内含 `typeof process` / `typeof require` / `typeof window` / `typeof globalThis`。
 * 这门的红绿只取决于"源码文本里是否存在未守卫的 Node 全局引用"这一件事。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';

const ROOT = resolve(__dirname, '..'); // src/

/**
 * 浏览器实际加载的模块入口 — 从 src/web/index.html 的 <script src> 推导 (不写死, 防清单漂移)。
 * 远程 CDN 跳过; "./x.js" 映射到源文件 "./x.ts" (或 .mjs 原样)。
 */
function browserEntries(): string[] {
  const html = readFileSync(resolve(ROOT, 'web/index.html'), 'utf8');
  const out: string[] = [];
  const re = /<script[^>]*\ssrc="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (/^https?:/.test(src)) continue; // CDN
    const rel = src.replace(/^\.\//, '');
    const cands = [
      'web/' + rel.replace(/\.js$/, '.ts'),
      'web/' + rel,
    ];
    const hit = cands.find(c => existsSync(resolve(ROOT, c)));
    out.push(hit || 'web/' + rel); // 找不到也记下来, 由"断裂 import"用例报红
  }
  return out;
}

/** Node 全局引用模式 */
const NODE_GLOBAL_RE = /\b(process\s*\.\s*(env|argv|cwd|platform|version|exit|on)|require\s*\(|__dirname|__filename|Buffer\s*\.\s*(from|alloc|concat))\b/;
/** 守卫模式: 命中则视为已加保护 */
const GUARD_RE = /typeof\s+(process|require|window|globalThis|self)\b/;

/** 解析相对 import 到源文件 (./x.js → x.ts | x.js | x/index.ts) */
function resolveSource(fromRel: string, spec: string): string | null {
  const base = resolve(ROOT, dirname(fromRel), spec);
  const cands = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.mjs$/, '.mts'),
    base,
    base + '.ts',
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ];
  for (const c of cands) {
    if (existsSync(c) && statSync(c).isFile()) return relative(ROOT, c);
  }
  return null;
}

function collectGraph(): { files: Set<string>; missing: string[] } {
  const files = new Set<string>();
  const missing: string[] = [];
  const stack = [...browserEntries()];
  while (stack.length) {
    const rel = stack.pop()!;
    if (files.has(rel)) continue;
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) { missing.push(rel); continue; }
    files.add(rel);
    const src = readFileSync(abs, 'utf8');
    const re = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // 裸模块不在本门范围 (另由打包器处理)
      const target = resolveSource(rel, spec);
      if (!target) missing.push(`${rel} → ${spec}`);
      else stack.push(target);
    }
  }
  return { files, missing };
}

describe('门: 浏览器可达模块的 Node 全局安全', () => {
  const { files, missing } = collectGraph();

  it('浏览器可达图非空且无断裂 import (扫描面拿不到事实就拒跑)', () => {
    expect(files.size).toBeGreaterThanOrEqual(4);
    expect(missing).toEqual([]);
  });

  it('图里不得出现未加保护的 Node 全局引用', () => {
    const offences: string[] = [];
    for (const rel of files) {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');
      src.split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (GUARD_RE.test(line)) return; // 已加保护
        if (NODE_GLOBAL_RE.test(line)) {
          offences.push(`${rel}:${i + 1}  ${t.slice(0, 100)}`);
        }
      });
    }
    expect(offences, `未加保护的 Node 全局引用 (浏览器里会抛 ReferenceError 且无提示):\n${offences.join('\n')}`).toEqual([]);
  });

  it('判别力: 检测器能抓住未守卫的写法, 且不误报已守卫的写法', () => {
    const bad = "const ON = process.env.BOLLOON_VERBOSE === '1';";
    const good = "const ON = typeof process !== 'undefined' && process.env.BOLLOON_VERBOSE === '1';";
    expect(GUARD_RE.test(bad)).toBe(false);
    expect(NODE_GLOBAL_RE.test(bad)).toBe(true);
    expect(GUARD_RE.test(good)).toBe(true);
    expect(NODE_GLOBAL_RE.test(good) && !GUARD_RE.test(good)).toBe(false);
  });
});
