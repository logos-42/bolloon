/**
 * 命令栏必须覆盖分发链里的所有命令 (2026-10-01)。
 *
 * 用户实测两次: `/channel` 与 `/group` 都**选不到** —— 弹框显示「无匹配」✗。
 * 根因是同一件事: 命令在 `src/index.ts` 的分发链里有实现, 但**没登记进命令栏清单**
 *   (`src/cli/mention-data.ts` 的 CLI_COMMANDS —— 有处理器没条目 ⇒ 打 `/` 选不到)。
 * 这张门做机械核对: 分发链的命令头 (CLI_KNOWN_COMMAND_HEADS) ⊆ 命令栏条目 ⇒ 再漏就红。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

function knownCommands(): string[] {
  const src = read('src/index.ts');
  const m = /CLI_KNOWN_COMMAND_HEADS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  return m ? [...new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))] : [];
}

function barItems(): string[] {
  const src = read('src/cli/mention-data.ts');
  return [...new Set([...src.matchAll(/insert: '([^']+)'/g)].map((x) => x[1]))];
}

describe('命令栏覆盖率', () => {
  it('分发链里的每个命令都能在命令栏里选到 (用户报过 /channel 与 /group 选不到)', () => {
    const listed = new Set(barItems());
    const missing = knownCommands().filter((c) => !listed.has(c.replace(/^\//, '')));
    expect(missing, `这些命令有实现但命令栏里没有: ${missing.join(' ')}`).toEqual([]);
  });
  it('反向体检: 命令栏不该为空 / 条目数合理', () => {
    expect(knownCommands().length).toBeGreaterThan(30);
    expect(barItems().length).toBeGreaterThan(30);
  });
});
