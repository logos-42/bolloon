/**
 * 门: 对外 skill 文档 (`skills/bolloon-network/SKILL.md`) ↔ `bolloon task` 真命令面 必须对得上。
 *
 * 为什么需要这道门 (2026-09-24 实测):
 *   公告板 (C1/C2: publish/board/claim) 与群聊通道 (C7: announce/trail/post/group) **先有代码、后无文档** ——
 *   对外那份 skill 里一个字都没写, 外部 Agent 读完**不知道有这条路**; 反过来文档一旦写了不存在的子命令,
 *   照抄的人只会失败。两种错都只能靠人肉比对发现, 所以立门。
 *
 * 判据 (双向):
 *   ① 白名单里的每个子命令, 文档必须提到 (少写 = 别人不知道有这条路)
 *   ② 文档里出现的每个 `bolloon task <子命令>`, 必须真在白名单里 (写了不存在的 = 照抄会失败)
 *   ③ `task group <动作>` 同样双向对表 (动作表从 tasks.ts 的 taskGroup 里真扫出来)
 *   ④ 门自身不能空转: 扫不到东西就判红, 不许"零条目通过"
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const skillDoc = fs.readFileSync(path.join(root, 'skills/bolloon-network/SKILL.md'), 'utf8');
const tasksSrc = fs.readFileSync(path.join(root, 'src/cli/commands/tasks.ts'), 'utf8');
const entrySrc = fs.readFileSync(path.join(root, 'src/cli-entry.ts'), 'utf8');

/** cli-entry.ts 的 TASK_SUBCOMMANDS (入口白名单 = CLI 真认的子命令) */
function whitelist(): string[] {
  const m = entrySrc.match(/TASK_SUBCOMMANDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  return m ? [...m[1].matchAll(/'([a-zA-Z][a-zA-Z0-9-]*)'/g)].map((x) => x[1]) : [];
}

/** tasks.ts 的 GROUP_ACTIONS (task group 真认的动作表) */
function groupActions(): string[] {
  const m = tasksSrc.match(/GROUP_ACTIONS\s*=\s*\[([\s\S]*?)\]/);
  return m ? [...m[1].matchAll(/'([a-zA-Z][a-zA-Z0-9-]*)'/g)].map((x) => x[1]) : [];
}

/** 文档里出现的 `bolloon task <子命令>` (排除自由文本 `task "<正文>"` / 选项 `--x` / 占位 `<id>`) */
function docTaskSubcommands(): string[] {
  return [...skillDoc.matchAll(/bolloon task ([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]);
}

/** 文档里出现的 `bolloon task group <动作>` */
function docGroupActions(): string[] {
  return [...skillDoc.matchAll(/bolloon task group ([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]);
}

describe('skill 文档 ↔ bolloon task 命令面 对表', () => {
  it('门自身扫到了东西 (解析为空 = 门失效, 不是通过)', () => {
    expect(whitelist().length, 'TASK_SUBCOMMANDS 解析为空').toBeGreaterThan(12);
    expect(groupActions().length, 'taskGroup 动作表解析为空').toBeGreaterThan(3);
    expect(docTaskSubcommands().length, '文档里没扫到 `bolloon task <子命令>`').toBeGreaterThan(10);
  });

  it('① 白名单里的每个子命令, 文档都必须写到', () => {
    const doc = skillDoc;
    const missing = whitelist().filter((s) => !new RegExp(`(^|[\\s\`|/(])${s}([\\s\`|)/,:]|$)`).test(doc));
    expect(missing, `文档漏写这些真子命令 (外部 Agent 因此不知道有这条路): ${missing.join(', ')}`).toEqual([]);
  });

  it('② 文档提到的 `bolloon task <子命令>` 必须真存在', () => {
    const known = new Set([...whitelist(), 'group']);
    const bogus = [...new Set(docTaskSubcommands())].filter((s) => !known.has(s));
    expect(bogus, `文档写了不存在的子命令 (照抄会失败): ${bogus.join(', ')}`).toEqual([]);
  });

  it('③ `task group <动作>` 双向对表', () => {
    const real = new Set(groupActions());
    const docActions = [...new Set(docGroupActions())];
    expect(docActions.length, '文档里没扫到 `bolloon task group <动作>`').toBeGreaterThan(3);
    const bogus = docActions.filter((a) => !real.has(a));
    expect(bogus, `文档写了不存在的 group 动作: ${bogus.join(', ')}`).toEqual([]);
    const missing = [...real].filter((a) => !docActions.includes(a));
    expect(missing, `文档漏写这些 group 动作: ${missing.join(', ')}`).toEqual([]);
  });

  it('④ 公告板 + 群聊这两族命令的"发行版边界"必须写在文档里 (不许只写能力不写坑)', () => {
    expect(skillDoc, '缺发行版边界说明: 老版本会把 announce/trail/post/group 吞成 M1 任务正文').toMatch(/0\.4\.33/);
    expect(skillDoc).toMatch(/task-subcommands\.test\.ts/);
  });
});
