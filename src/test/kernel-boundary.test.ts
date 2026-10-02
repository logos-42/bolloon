/**
 * K1 目录边界门 + K3 行数棘轮门 —— **源码级门** (Bolloon Native Macro-Kernel K0)
 *
 * 这道门回答两个问题:
 *   · K1: 「内核只能通过 contracts/ports/adapters 访问外部」是文档里的一句话, 还是代码里绕不过去?
 *   · K3: 「不许所有逻辑回流到 kernel.ts」有上限吗, 还是谁想加就加?
 *
 * 纪律 (与 goal-flywheel-wiring-freeze.test.ts 同款, 少一条就等于门在空转):
 *   · **期望值从真实状态推导** —— 扫描面逐个 readFileSync 真读盘; 文件读不到 = 抛出来判红, 不是"跳过"。
 *   · **判据是纯函数** (src/kernel/gate-scan.ts) ⇒ 变异验证能把**人为改坏的源码**喂给同一份判据。
 *   · **变异在测试里每次都跑**, 不是口头声明。
 *
 * 设计页: docs/wiki/bolloon-native-macro-kernel.md
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  KERNEL_ALLOWED_IMPORT_PREFIXES,
  KERNEL_FILES,
  KERNEL_LINE_BUDGET,
  KERNEL_LINE_BUDGET_FROZEN_AT,
  KERNEL_PLAN_LINE_BUDGET,
  KERNEL_PLAN_LINE_BUDGET_FROZEN_AT,
} from '../kernel/roster.js';
import { type SourceFile, countCodeLines, scanKernelImports } from '../kernel/gate-scan.js';

const SRC = path.join(process.cwd(), 'src');

/** 真读盘。读不到**不跳过**: 抛出来, 让门判红 (期望值从真实状态推导, 不许空转)。 */
function read(rel: string): SourceFile {
  const abs = path.join(SRC, rel);
  if (!fs.existsSync(abs)) throw new Error(`门要读的文件不存在: src/${rel}`);
  return { path: rel, text: fs.readFileSync(abs, 'utf8') };
}

/** kernel 目录盘上真实文件清单 (递归, 相对 src/) */
function kernelFilesOnDisk(): string[] {
  const dir = path.join(SRC, 'kernel');
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(`${prefix}${e.name}`);
    }
  };
  walk(dir, 'kernel/');
  return out.sort();
}

const KERNEL_ON_DISK = kernelFilesOnDisk();
const KERNEL_SRC = KERNEL_ON_DISK.map(read);

describe('K1 目录边界门 —— 内核目录不许 import 业务模块', () => {
  it('扫描面自证: kernel 目录非空, 且与名册逐字相等 (名册外无人越界)', () => {
    // 空目录 = 门在空转, 直接拒跑
    expect(KERNEL_ON_DISK.length).toBeGreaterThan(0);
    expect(KERNEL_ON_DISK).toEqual([...KERNEL_FILES].sort());
  });

  it('负控制: 名册里有盘上没有的文件 ⇒ 门自己判红 (不是跳过)', () => {
    expect(() => read('kernel/__does_not_exist__.ts')).toThrow(/不存在/);
    // 反向: 名册里塞一个不存在的文件, 集合比较也必须不等
    expect([...KERNEL_FILES, 'kernel/__ghost__.ts'].sort()).not.toEqual(KERNEL_ON_DISK);
  });

  it('真实源码 0 命中: kernel 目录每条仓内 import 都落在允许前缀内', () => {
    const findings = scanKernelImports(KERNEL_SRC, KERNEL_ALLOWED_IMPORT_PREFIXES);
    expect(findings).toEqual([]);
  });

  it('允许前缀本身是"只许 kernel 内部" (判据不是空集)', () => {
    expect(KERNEL_ALLOWED_IMPORT_PREFIXES.length).toBeGreaterThan(0);
    expect(KERNEL_ALLOWED_IMPORT_PREFIXES).toContain('kernel/');
  });

  it('判别力自证: 人造越界 import 必须命中 (相对 / 上跳两级都要抓)', () => {
    const synthetic: SourceFile[] = [
      { path: 'kernel/fake-a.ts', text: "import { serve } from '../web/server.js';" },
      { path: 'kernel/sub/fake-b.ts', text: "const x = await import('../../agents/pi-sdk.js');" },
      { path: 'kernel/fake-c.ts', text: "import type { T } from 'fs';\nimport { z } from 'undici';" },
    ];
    const hits = scanKernelImports(synthetic, KERNEL_ALLOWED_IMPORT_PREFIXES);
    expect(hits.map((h) => h.file)).toEqual(['kernel/fake-a.ts', 'kernel/sub/fake-b.ts']);
    expect(hits.map((h) => h.line)).toEqual([1, 1]);
  });

  it('判别力自证: 合法的 kernel 内部 import 与 node 内置都不许误报', () => {
    const ok: SourceFile[] = [
      { path: 'kernel/x.ts', text: "import { LAYERS } from './roster.js';\nimport fs from 'node:fs';" },
    ];
    expect(scanKernelImports(ok, KERNEL_ALLOWED_IMPORT_PREFIXES)).toEqual([]);
  });

  it('判别力自证: 注释里的禁 import 不许误报 (剥注释是本仓硬规矩)', () => {
    const withComment: SourceFile[] = [
      { path: 'kernel/y.ts', text: "// import { a } from '../web/server.js';\nimport fs from 'node:fs';" },
    ];
    expect(scanKernelImports(withComment, KERNEL_ALLOWED_IMPORT_PREFIXES)).toEqual([]);
  });

  it('变异: 拿真实 kernel 文件注入一条禁 import ⇒ 必须判红', () => {
    const victim = KERNEL_SRC[0];
    const mutated: SourceFile = {
      path: victim.path,
      text: `${victim.text}\nimport { x } from '../agents/pi-sdk.js';\n`,
    };
    const before = scanKernelImports([victim], KERNEL_ALLOWED_IMPORT_PREFIXES);
    const after = scanKernelImports([mutated], KERNEL_ALLOWED_IMPORT_PREFIXES);
    expect(before).toEqual([]); // 未变异必须绿, 否则这道门的阴性对照不成立
    expect(after.length).toBe(1);
    expect(after[0].what).toContain('agents/pi-sdk');
  });
});

describe('K3 行数棘轮门 —— 代码与台账各一档, 都只许减不许增', () => {
  // 分档理由见 roster.ts KERNEL_PLAN_LINE_BUDGET 的注释: 防的是「逻辑回流到内核代码」,
  // 台账是数据 —— 混在一起会逼着人抬代码上限, 棘轮的信号就废了。
  const PLAN_RE = /(^|\/)plan[^/]*\.ts$/; // 台账档 = kernel/plan*.ts (plan.ts · plan-constraint.ts …)
  const CODE_SRC = KERNEL_SRC.filter((f) => !PLAN_RE.test(f.path));
  const PLAN_SRC = KERNEL_SRC.filter((f) => PLAN_RE.test(f.path));

  it('两档都非空 (分档不是拿来绕预算的)', () => {
    expect(CODE_SRC.length).toBeGreaterThan(0);
    expect(PLAN_SRC.length).toBeGreaterThanOrEqual(1);
  });

  it('代码档: 真实行数 ≤ 预算', () => {
    const lines = countCodeLines(CODE_SRC);
    expect(lines).toBeGreaterThan(0);
    expect(lines).toBeLessThanOrEqual(KERNEL_LINE_BUDGET);
  });

  it('台账档: 真实行数 ≤ 预算', () => {
    const lines = countCodeLines(PLAN_SRC);
    expect(lines).toBeGreaterThan(0);
    expect(lines).toBeLessThanOrEqual(KERNEL_PLAN_LINE_BUDGET);
  });

  it('棘轮: 两档的预算都 ≤ 各自的冻结值 (想抬就得同时改两个数字 → 一次显式动作)', () => {
    expect(KERNEL_LINE_BUDGET).toBeLessThanOrEqual(KERNEL_LINE_BUDGET_FROZEN_AT);
    expect(KERNEL_PLAN_LINE_BUDGET).toBeLessThanOrEqual(KERNEL_PLAN_LINE_BUDGET_FROZEN_AT);
  });

  it('判别力自证: 预算不是装饰 (人造超长文件必定超)', () => {
    const fat: SourceFile[] = [{ path: 'kernel/fat.ts', text: 'x\n'.repeat(KERNEL_LINE_BUDGET + 1) }];
    expect(countCodeLines(fat)).toBeGreaterThan(KERNEL_LINE_BUDGET);
    const fatPlan: SourceFile[] = [{ path: 'kernel/plan.ts', text: 'x\n'.repeat(KERNEL_PLAN_LINE_BUDGET + 1) }];
    expect(countCodeLines(fatPlan)).toBeGreaterThan(KERNEL_PLAN_LINE_BUDGET);
  });

  it('变异: 代码档追加一行 ⇒ 超预算判红', () => {
    const victim = CODE_SRC[0];
    const mutated: SourceFile = { path: victim.path, text: `${victim.text}\n// 顺手加的一行\n` };
    const before = countCodeLines(CODE_SRC);
    const after = countCodeLines([mutated, ...CODE_SRC.slice(1)]);
    expect(before).toBeLessThanOrEqual(KERNEL_LINE_BUDGET);
    expect(after).toBeGreaterThan(KERNEL_LINE_BUDGET);
  });

  it('变异: 台账档追加一行 ⇒ 超预算判红', () => {
    // 台账档是**整档**一个预算 (plan.ts + plan-constraint.ts + …), 变异必须落在档位上
    const victim = PLAN_SRC[0];
    const mutated = PLAN_SRC.map((f) =>
      f.path === victim.path ? { path: f.path, text: `${f.text}\n// 顺手加的一行\n` } : f,
    );
    const before = countCodeLines(PLAN_SRC);
    const after = countCodeLines(mutated);
    expect(before).toBeLessThanOrEqual(KERNEL_PLAN_LINE_BUDGET);
    expect(after).toBeGreaterThan(KERNEL_PLAN_LINE_BUDGET);
  });
});
