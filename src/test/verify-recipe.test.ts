import { describe, it, expect } from 'vitest';
import { extractVerifyCommands, detectPackageManager, runVerifyCommands } from '../agents/verify-recipe.js';

describe('verify-recipe (Hermes agent/verify recipes 模式)', () => {
  it('extractVerifyCommands: 按序提取存在的 build/typecheck/test/check/lint', () => {
    const cmds = extractVerifyCommands({
      build: 'tsc && vite build',
      test: 'vitest run',
      dev: 'vite',
    });
    expect(cmds.map((c) => c.name)).toEqual(['build', 'test']);
    expect(cmds[0].command).toBe('npm run build');
  });

  it('runner 随包管理器 (pnpm/bun/yarn/npm)', () => {
    const scripts = { test: 'vitest' };
    expect(extractVerifyCommands(scripts, 'pnpm')[0].command).toBe('pnpm test');
    expect(extractVerifyCommands(scripts, 'bun')[0].command).toBe('bun run test');
    expect(extractVerifyCommands(scripts, 'yarn')[0].command).toBe('yarn test');
    expect(extractVerifyCommands(scripts, 'npm')[0].command).toBe('npm run test');
  });

  it('无 scripts / 无可验证脚本 → 空', () => {
    expect(extractVerifyCommands(undefined)).toEqual([]);
    expect(extractVerifyCommands({ dev: 'vite' })).toEqual([]);
  });

  it('detectPackageManager: lockfile 推断', () => {
    expect(detectPackageManager(['package-lock.json'])).toBe('npm');
    expect(detectPackageManager(['pnpm-lock.yaml', 'package-lock.json'])).toBe('pnpm');
    expect(detectPackageManager(['bun.lockb'])).toBe('bun');
    expect(detectPackageManager(['yarn.lock'])).toBe('yarn');
    expect(detectPackageManager([])).toBeUndefined();
  });

  it('runVerifyCommands: 全部成功 → allPassed', async () => {
    const r = await runVerifyCommands({
      cwd: process.cwd(),
      commands: [
        { name: 'ok1', command: 'node -e "console.log(1)"' },
        { name: 'ok2', command: 'node -e "process.exit(0)"' },
      ],
    });
    expect(r.allPassed).toBe(true);
    expect(r.steps.every((s) => s.exitCode === 0)).toBe(true);
    expect(r.steps[0].outputTail).toContain('1');
  });

  it('runVerifyCommands: 失败步骤不中断, allPassed=false, 收集全量', async () => {
    const r = await runVerifyCommands({
      cwd: process.cwd(),
      commands: [
        { name: 'fail', command: 'node -e "process.exit(3)"' },
        { name: 'after', command: 'node -e "process.exit(0)"' },
      ],
    });
    expect(r.allPassed).toBe(false);
    expect(r.steps[0].exitCode).toBe(3);
    expect(r.steps[1].exitCode).toBe(0); // 失败后继续跑 (收集全量证据)
  });

  it('runVerifyCommands: 输出 cap 2000 字符', async () => {
    const r = await runVerifyCommands({
      cwd: process.cwd(),
      // 单引号 JS (cmd.exe shell 会把 \" 当字面量传给 node, 双引号嵌套会语法错)
      commands: [{ name: 'big', command: "node -e \"console.log('x'.repeat(5000))\"" }],
    });
    expect(r.steps[0].exitCode).toBe(0);
    expect(r.steps[0].outputTail.length).toBeLessThanOrEqual(2000);
    expect(r.steps[0].outputTail.trimEnd().endsWith('x')).toBe(true); // 尾部保留
  });
});
