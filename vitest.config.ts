import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只匹配 *.test.ts (vitest 单元测试), 排除:
    // 2026-09-05: testTimeout 20000 — 重 async 测试 (IndexedDB/数据扫描) 在全量并行下超过默认 5s 误超时
    testTimeout: 20000,
    hookTimeout: 20000,
    // 只匹配 *.test.ts (vitest 单元测试), 排除:
    // - *.spec.ts: playwright e2e 规范
    // - 误命名为 .test.ts 但实际是 tsx 脚本 (顶层 async function + console.log, 无 describe/it)
    // 误匹配会导致 "No test suite found"
    // 2026-10-02 (K1): 把 constraint-runtime 自带的 4 个测试**接进默认套件**。
    // 它们测的正是 A 类原语 (AgentCoordinator / ToolPermissionContext / BudgetTracker /
    // SkillRegistry / DeepThinkingEngine) —— 实测 13/13 全绿, 但此前被下面那条
    // '**/constraint-runtime/**' 全目录排除, **从来没有跑过** ⇒ K1 验收标准里
    // "现有 constraint-runtime 测试继续全绿" 当时是一句空话。判据见
    // src/test/kernel-constraint.test.ts 的 K1-f (这条 exclude 不许再回来)。
    include: ['src/test/**/*.test.ts', 'src/constraint-runtime/tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.kilo/worktrees/**',
      '**/*.spec.ts',
      // 以下是 tsx 脚本式集成测试, 通过 `npx tsx src/test/xxx.test.ts` 单独跑, 不走 vitest
      'src/test/human-value-store.test.ts',
      'src/test/iroh-communication.test.ts',
      'src/test/iroh-transport.test.ts',
      'src/test/llm-judgment-integration.test.ts',
      'src/test/storage-integration.test.ts',
    ]
  }
});
