# ConstraintRuntime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a TypeScript implementation that replicates py-bolloon architecture with AI constraint management, deep thinking, and multi-agent coordination.

**Architecture:** Module mirroring pattern (py-bolloon style) with TypeScript-first implementation. Core components: ConstraintLayer, DeepThinkingEngine, AgentCoordinator, SkillRegistry.

**Tech Stack:** TypeScript, Node.js, strict mode

---

## Task 1: Project Scaffold

**Files:**
- Create: `src/constraint-runtime/index.ts`
- Create: `src/constraint-runtime/package.json`
- Create: `src/constraint-runtime/tsconfig.json`

**Step 1: Create project structure**

```bash
mkdir -p src/constraint-runtime/{src/{constraint,thinking,agent,skills,runtime,reference_data/subsystems},tests}
```

**Step 2: Create package.json**

```json
{
  "name": "@bolloon/constraint-runtime",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  }
}
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

---

## Task 2: Core Models

**Files:**
- Create: `src/constraint-runtime/src/models.ts`

**Step 1: Create models**

```typescript
export interface PortingModule {
  name: string;
  responsibility: string;
  source_hint: string;
  status: 'mirrored' | 'ported' | 'pending';
}

export interface PermissionDenial {
  tool_name: string;
  reason: string;
}

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
}

export interface TurnResult {
  prompt: string;
  output: string;
  matched_commands: string[];
  matched_tools: string[];
  permission_denials: PermissionDenial[];
  usage: UsageSummary;
  stop_reason: string;
}
```

---

## Task 3: ConstraintLayer

**Files:**
- Create: `src/constraint-runtime/src/constraint/index.ts`
- Create: `src/constraint-runtime/src/constraint/permission.ts`
- Create: `src/constraint-runtime/src/constraint/budget.ts`

**Step 1: Create permission context**

```typescript
export class ToolPermissionContext {
  private denyTools: Set<string>;
  private denyPrefixes: string[];

  static fromIterables(denyTools: string[] = [], denyPrefixes: string[] = []): ToolPermissionContext {
    return new ToolPermissionContext(new Set(denyTools.map(t => t.toLowerCase())), denyPrefixes);
  }

  blocks(name: string): boolean {
    const lower = name.toLowerCase();
    if (this.denyTools.has(lower)) return true;
    return this.denyPrefixes.some(p => lower.startsWith(p.toLowerCase()));
  }
}
```

**Step 2: Create budget tracker**

```typescript
export class BudgetTracker {
  constructor(
    public maxBudgetTokens: number = 2000,
    public maxTurns: number = 8,
    public compactAfterTurns: number = 12
  ) {}

  addTurn(inputTokens: number, outputTokens: number): UsageSummary {
    return { input_tokens: inputTokens, output_tokens: outputTokens };
  }

  isBudgetExceeded(usage: UsageSummary): boolean {
    return usage.input_tokens + usage.output_tokens > this.maxBudgetTokens;
  }
}
```

---

## Task 4: DeepThinkingEngine

**Files:**
- Create: `src/constraint-runtime/src/thinking/index.ts`
- Create: `src/constraint-runtime/src/thinking/engine.ts`
- Create: `src/constraint-runtime/src/thinking/reflection.ts`

**Step 1: Create thinking engine**

```typescript
export interface ThinkStep {
  step: number;
  thought: string;
  reflection?: string;
  improvement?: string;
}

export interface ThinkResult {
  originalPrompt: string;
  steps: ThinkStep[];
  finalOutput: string;
  depth: number;
}

export class DeepThinkingEngine {
  constructor(private maxDepth: number = 3) {}

  async think(prompt: string): Promise<ThinkResult> {
    const steps: ThinkStep[] = [];
    let current = prompt;

    for (let i = 0; i < this.maxDepth; i++) {
      const thought = await this.generateThought(current, i);
      const reflection = await this.reflect(thought, current);

      steps.push({
        step: i + 1,
        thought,
        reflection: reflection.question,
        improvement: reflection.improvement
      });

      if (reflection.improvement) {
        current = reflection.improvement;
      }
    }

    return {
      originalPrompt: prompt,
      steps,
      finalOutput: steps[steps.length - 1]?.improvement ?? current,
      depth: this.maxDepth
    };
  }

  private async generateThought(prompt: string, step: number): Promise<string> {
    return `[Step ${step + 1}] Thinking about: ${prompt}`;
  }

  private async reflect(thought: string, original: string): Promise<{ question: string; improvement?: string }> {
    return {
      question: `Is "${thought}" the best approach?`,
      improvement: step < this.maxDepth - 1 ? `${thought} (refined)` : undefined
    };
  }
}
```

---

## Task 5: AgentCoordinator

**Files:**
- Create: `src/constraint-runtime/src/agent/index.ts`
- Create: `src/constraint-runtime/src/agent/coordinator.ts`
- Create: `src/constraint-runtime/src/agent/agent-pool.ts`
- Create: `src/constraint-runtime/src/agent/result-aggregator.ts`

**Step 1: Create coordinator**

```typescript
import { DeepThinkingEngine } from '../thinking/engine.js';

export interface SubTask {
  id: string;
  description: string;
  priority: number;
}

export interface AgentResult {
  taskId: string;
  output: string;
  success: boolean;
  metadata?: Record<string, unknown>;
}

export class AgentCoordinator {
  private engine: DeepThinkingEngine;

  constructor(maxDepth: number = 3) {
    this.engine = new DeepThinkingEngine(maxDepth);
  }

  async dispatch(prompt: string, parallelCount: number = 3): Promise<AgentResult[]> {
    const tasks = this.splitTask(prompt, parallelCount);
    const agents = Array.from({ length: Math.min(tasks.length, parallelCount) }, (_, i) => ({
      id: `agent-${i}`,
      execute: (task: SubTask) => this.executeTask(task)
    }));

    const results = await Promise.all(
      tasks.map(task =>
        agents[task.id.charCodeAt(task.id.length - 1) % agents.length].execute(task)
      )
    );

    return this.aggregate(results);
  }

  private splitTask(prompt: string, count: number): SubTask[] {
    const words = prompt.split(' ');
    const chunkSize = Math.ceil(words.length / count);
    const chunks: SubTask[] = [];

    for (let i = 0; i < count; i++) {
      const chunk = words.slice(i * chunkSize, (i + 1) * chunkSize).join(' ');
      if (chunk) {
        chunks.push({
          id: `task-${i}`,
          description: chunk,
          priority: i
        });
      }
    }
    return chunks;
  }

  private async executeTask(task: SubTask): Promise<AgentResult> {
    const thinkResult = await this.engine.think(task.description);
    return {
      taskId: task.id,
      output: thinkResult.finalOutput,
      success: true
    };
  }

  private aggregate(results: AgentResult[]): AgentResult[] {
    return results.sort((a, b) => a.taskId.localeCompare(b.taskId));
  }
}
```

---

## Task 6: SkillRegistry

**Files:**
- Create: `src/constraint-runtime/src/skills/index.ts`
- Create: `src/constraint-runtime/src/skills/skill-registry.ts`

**Step 1: Create skill registry**

```typescript
export interface Skill {
  name: string;
  description: string;
  execute(params: Record<string, unknown>): Promise<string>;
}

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  async execute(name: string, params: Record<string, unknown>): Promise<string> {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    return skill.execute(params);
  }
}
```

---

## Task 7: Runtime Session

**Files:**
- Create: `src/constraint-runtime/src/runtime/index.ts`
- Create: `src/constraint-runtime/src/runtime/session.ts`
- Create: `src/constraint-runtime/src/runtime/turn-engine.ts`

**Step 1: Create session**

```typescript
import { ToolPermissionContext } from '../constraint/permission.js';
import { BudgetTracker } from '../constraint/budget.js';
import { DeepThinkingEngine } from '../thinking/engine.js';
import { AgentCoordinator } from '../agent/coordinator.js';

export interface RuntimeSession {
  sessionId: string;
  messages: string[];
  context: Record<string, unknown>;
  permissionContext: ToolPermissionContext;
  budget: BudgetTracker;
}

export class Session {
  constructor(
    public sessionId: string,
    public messages: string[] = [],
    public context: Record<string, unknown> = {},
    public permissionContext: ToolPermissionContext = new ToolPermissionContext(),
    public budget: BudgetTracker = new BudgetTracker()
  ) {}

  addMessage(msg: string): void {
    this.messages.push(msg);
  }
}
```

---

## Task 8: Main Entry Point

**Files:**
- Create: `src/constraint-runtime/src/index.ts`

**Step 1: Create main export**

```typescript
export { ToolPermissionContext } from './constraint/permission.js';
export { BudgetTracker } from './constraint/budget.js';
export { DeepThinkingEngine, type ThinkResult, type ThinkStep } from './thinking/engine.js';
export { AgentCoordinator, type SubTask, type AgentResult } from './agent/coordinator.js';
export { SkillRegistry, type Skill } from './skills/skill-registry.js';
export { Session, type RuntimeSession } from './runtime/session.js';
```

---

## Task 9: Tests

**Files:**
- Create: `src/constraint-runtime/tests/constraint.test.ts`
- Create: `src/constraint-runtime/tests/thinking.test.ts`
- Create: `src/constraint-runtime/tests/agent.test.ts`

**Step 1: Write constraint tests**

```typescript
import { describe, it, expect } from 'vitest';
import { ToolPermissionContext } from '../src/constraint/permission.js';

describe('ToolPermissionContext', () => {
  it('blocks denied tools', () => {
    const ctx = ToolPermissionContext.fromIterables(['BashTool'], []);
    expect(ctx.blocks('BashTool')).toBe(true);
    expect(ctx.blocks('FileReadTool')).toBe(false);
  });
});
```

---

## Task 10: Build & Verify

**Step 1: Install dependencies**

```bash
cd src/constraint-runtime
npm install typescript vitest @types/node --save-dev
```

**Step 2: Build**

```bash
npm run build
```

**Step 3: Test**

```bash
npm run test
```
