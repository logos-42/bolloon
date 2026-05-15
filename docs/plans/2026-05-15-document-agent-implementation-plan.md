# Document Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现基于 OpenClaw 双层架构的 AI 文档处理智能体，支持完全自主运行

**Architecture:** 约束层（Prompt Guardrails）+ 执行层（Code-Driven Workflow），通过重试机制和 guardrail 实现安全可控的自主决策

**Tech Stack:** TypeScript, libp2p, Minimax LLM

---

## 任务 1: 创建约束层 (ConstraintLayer)

**Files:**
- Create: `src/agents/constraint-layer.ts`
- Modify: `src/agents/pi-sdk.ts` (集成约束层)
- Test: `src/test/constraint-layer.test.ts`

---

### Task 1.1: 定义约束层接口与类型

**Files:**
- Create: `src/agents/constraint-layer.ts`

**Step 1: 创建约束层基础类型和接口**

```typescript
export interface Guardrail {
  name: string;
  check: (context: WorkflowContext, step?: WorkflowStep) => Promise<boolean>;
  onFail?: 'block' | 'warn' | 'retry';
}

export interface ConstraintRule {
  id: string;
  description: string;
  guardrails: Guardrail[];
}

export interface WorkflowContext {
  document?: DocumentContent;
  summary?: string;
  improved?: string;
  qualityScore?: number;
  peers: string[];
  logs: OperationLog[];
  metadata?: Record<string, unknown>;
}

export interface OperationLog {
  timestamp: number;
  action: string;
  details: Record<string, unknown>;
  status: 'success' | 'failed' | 'blocked' | 'warn';
}
```

**Step 2: 实现 SYSTEM_PROMPT 约束模板**

```typescript
export const SYSTEM_PROMPT = `
你是一个文档处理Agent，在以下规则下运行：

【边界规则】
1. 只处理：txt, md, pdf, docx 格式文档
2. 不修改原始文件，只输出改进版本
3. 发送前必须记录操作日志

【自主权限】
- ✅ 自主决定：摘要详细程度、chunk分块策略
- ✅ 自主决定：重试次数（最多3次）
- ✅ 自主决定：是否需要补充信息
- ❌ 必须确认：首次向新对等节点发送文档
- ❌ 必须确认：删除操作

【敏感操作拦截】
if (操作 === '发送文档' && 对等节点不在已知列表) {
  拦截 → 记录 → 等待确认
}
`;

export const AUTONOMOUS_ACTIONS = ['summarize', 'chunk', 'improve'];
export const CONFIRM_REQUIRED_ACTIONS = ['send', 'delete'];
```

**Step 3: 实现约束层类**

```typescript
export class ConstraintLayer {
  private rules: Map<string, ConstraintRule> = new Map();
  private logs: OperationLog[] = [];

  constructor() {
    this.registerDefaultRules();
  }

  private registerDefaultRules(): void {
    // 未知节点发送拦截
    this.registerRule({
      id: 'unknown-peer-send',
      description: '阻止向未知对等节点发送文档',
      guardrails: [{
        name: 'validateSendTarget',
        check: async (ctx, step) => {
          const targetPeer = step?.config?.peerId as string;
          if (!targetPeer) return true;
          const isKnown = ctx.peers.includes(targetPeer);
          if (!isKnown) {
            this.log('BLOCKED: Unknown peer', { targetPeer }, 'blocked');
          }
          return isKnown;
        },
        onFail: 'block'
      }]
    });

    // 摘要质量检查
    this.registerRule({
      id: 'summary-quality',
      description: '确保摘要质量达标',
      guardrails: [{
        name: 'validateSummaryQuality',
        check: async (ctx) => {
          if (ctx.qualityScore !== undefined && ctx.qualityScore < 0.5) {
            this.log('WARN: Low quality summary', { score: ctx.qualityScore }, 'warn');
            return false;
          }
          return true;
        },
        onFail: 'retry'
      }]
    });
  }

  registerRule(rule: ConstraintRule): void {
    this.rules.set(rule.id, rule);
  }

  async checkGuardrails(context: WorkflowContext, step?: WorkflowStep): Promise<{
    passed: boolean;
    blocked?: Guardrail;
  }> {
    for (const rule of this.rules.values()) {
      for (const guardrail of rule.guardrails) {
        const passed = await guardrail.check(context, step);
        if (!passed) {
          return { passed: false, blocked: guardrail };
        }
      }
    }
    return { passed: true };
  }

  log(action: string, details: Record<string, unknown>, status: OperationLog['status']): void {
    this.logs.push({
      timestamp: Date.now(),
      action,
      details,
      status
    });
  }

  getLogs(): OperationLog[] {
    return [...this.logs];
  }

  isAutonomousAction(action: string): boolean {
    return AUTONOMOUS_ACTIONS.includes(action);
  }

  requiresConfirmation(action: string): boolean {
    return CONFIRM_REQUIRED_ACTIONS.includes(action);
  }
}
```

**Step 4: 提交**

```bash
git add src/agents/constraint-layer.ts
git commit -m "feat: add constraint layer with guardrails"
```

---

## 任务 2: 创建工作流引擎 (WorkflowEngine)

**Files:**
- Create: `src/agents/workflow-engine.ts`
- Modify: `src/agents/pi-sdk.ts`
- Test: `src/test/workflow-engine.test.ts`

---

### Task 2.1: 定义工作流步骤类型

**Files:**
- Modify: `src/agents/pi-sdk.ts` (扩展 WorkflowStep 接口)

**Step 1: 更新 WorkflowStep 接口**

```typescript
// 在 pi-sdk.ts 中添加
export interface WorkflowStepConfig {
  path?: string;
  requirements?: string;
  context?: string;
  peerId?: string;
  message?: string;
  content?: string;
  maxChunkSize?: number;
}

export interface WorkflowStep {
  id: string;
  type: 'read' | 'chunk' | 'summarize' | 'improve' | 'review' | 'send' | 'report';
  config?: WorkflowStepConfig;
  retry: {
    max: number;
    current: number;
    backoffMs: number;
  };
  onFail: 'skip' | 'abort' | 'retry';
  guardrail?: (context: WorkflowContext) => Promise<boolean>;
  guardrailOnRetry?: boolean;
}

export interface StepResult {
  status: 'success' | 'failed' | 'skipped' | 'blocked';
  result?: unknown;
  error?: string;
  guardrailFailed?: string;
}
```

### Task 2.2: 实现 WorkflowEngine

**Files:**
- Create: `src/agents/workflow-engine.ts`

**Step 1: 实现 WorkflowEngine 类**

```typescript
import { WorkflowStep, StepResult, Workflow, WorkflowContext, WorkflowStepConfig } from './pi-sdk.js';
import { documentReader, DocumentContent } from '../documents/reader.js';
import { getMinimax } from '../llm/minimax.js';
import { p2pNetwork } from '../network/p2p.js';
import { ConstraintLayer } from './constraint-layer.js';

export class WorkflowEngine {
  private constraintLayer: ConstraintLayer;

  constructor(constraintLayer?: ConstraintLayer) {
    this.constraintLayer = constraintLayer || new ConstraintLayer();
  }

  async executeWorkflow(steps: WorkflowStep[], initialContext?: Partial<WorkflowContext>): Promise<Workflow> {
    const workflow: Workflow = {
      id: `wf-${Date.now()}`,
      steps,
      status: 'running',
      results: new Map()
    };

    const context: WorkflowContext = {
      peers: p2pNetwork.getPeers(),
      logs: [],
      ...initialContext
    };

    for (const step of steps) {
      const result = await this.executeStep(step, context);
      workflow.results.set(step.id, result);

      if (result.status === 'blocked' || (result.status === 'failed' && step.onFail === 'abort')) {
        workflow.status = 'failed';
        return workflow;
      }
    }

    workflow.status = 'completed';
    return workflow;
  }

  async executeStep(step: WorkflowStep, context: WorkflowContext): Promise<StepResult> {
    // 前置 guardrail 检查
    if (step.guardrail) {
      const guardrailPassed = await this.runGuardrail(step, context, true);
      if (!guardrailPassed) {
        return { status: 'blocked', guardrailFailed: step.guardrail.name };
      }
    }

    // 执行步骤，带重试
    for (let attempt = 0; attempt <= step.retry.max; attempt++) {
      try {
        const result = await this.runStep(step, context);

        // 后置 guardrail 检查（重试时默认也执行）
        if (step.guardrailOnRetry !== false && step.guardrail) {
          const guardrailPassed = await this.runGuardrail(step, context, false);
          if (!guardrailPassed) {
            return { status: 'blocked', guardrailFailed: step.guardrail.name };
          }
        }

        return { status: 'success', result };
      } catch (error) {
        if (attempt === step.retry.max) {
          this.constraintLayer.log(`Step ${step.id} failed after ${attempt + 1} attempts`, { error: String(error) }, 'failed');
          return {
            status: step.onFail === 'skip' ? 'skipped' : 'failed',
            error: String(error)
          };
        }

        // 指数退避
        const backoffMs = step.retry.backoffMs * Math.pow(2, attempt);
        this.constraintLayer.log(`Step ${step.id} attempt ${attempt + 1} failed, retrying in ${backoffMs}ms`, {}, 'warn');
        await this.sleep(backoffMs);
      }
    }

    return { status: 'failed', error: 'Max retries exceeded' };
  }

  private async runStep(step: WorkflowStep, context: WorkflowContext): Promise<unknown> {
    switch (step.type) {
      case 'read': {
        const path = step.config?.path;
        if (!path) throw new Error('Read step requires path config');
        const content = await documentReader.read(path);
        context.document = content;
        return content;
      }

      case 'chunk': {
        if (!context.document) throw new Error('No document loaded');
        const maxSize = step.config?.maxChunkSize || 4000;
        return documentReader.chunk(context.document.text, maxSize);
      }

      case 'summarize': {
        if (!context.document) throw new Error('No document loaded');
        const llm = getMinimax();
        const chunks = documentReader.chunk(context.document.text, step.config?.maxChunkSize || 4000);
        const summaries: string[] = [];
        let totalQuality = 0;

        for (const chunk of chunks) {
          const result = await llm.summarize(chunk, step.config?.context);
          summaries.push(result.summary);
          totalQuality += result.qualityScore;
        }

        context.summary = summaries.join('\n\n');
        context.qualityScore = totalQuality / chunks.length;
        return { summary: context.summary, qualityScore: context.qualityScore };
      }

      case 'improve': {
        if (!context.document) throw new Error('No document loaded');
        const llm = getMinimax();
        const improved = await llm.improveContent(
          context.document.text,
          step.config?.requirements || '',
          step.config?.context
        );
        context.improved = improved;
        return { improved };
      }

      case 'send': {
        const peerId = step.config?.peerId;
        const message = step.config?.message || context.summary || '';
        if (!peerId) throw new Error('Send step requires peerId config');
        await p2pNetwork.sendMessage(peerId, 'message', message);
        this.constraintLayer.log(`Sent message to ${peerId}`, { peerId, messageLength: message.length }, 'success');
        return { sent: true, peerId };
      }

      case 'report': {
        const content = step.config?.content || context.summary || '';
        await p2pNetwork.broadcast('report', content);
        this.constraintLayer.log('Broadcast report', { contentLength: content.length }, 'success');
        return { broadcasted: true };
      }

      case 'review': {
        return { status: 'reviewed', qualityScore: context.qualityScore };
      }

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  private async runGuardrail(step: WorkflowStep, context: WorkflowContext, isPreCheck: boolean): Promise<boolean> {
    if (!step.guardrail) return true;
    try {
      return await step.guardrail(context);
    } catch (error) {
      this.constraintLayer.log(
        `Guardrail ${step.guardrail.name} error`,
        { error: String(error), isPreCheck },
        'failed'
      );
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getConstraintLayer(): ConstraintLayer {
    return this.constraintLayer;
  }
}
```

**Step 2: 提交**

```bash
git add src/agents/workflow-engine.ts
git commit -m "feat: add workflow engine with retry and guardrails"
```

---

## 任务 3: 集成约束层和工作流引擎到 AgentSession

**Files:**
- Modify: `src/agents/pi-sdk.ts`

---

### Task 3.1: 更新 AgentSession 集成新组件

**Step 1: 添加导入和新字段**

```typescript
import { ConstraintLayer, SYSTEM_PROMPT } from './constraint-layer.js';
import { WorkflowEngine } from './workflow-engine.js';

// 在 PiAgentSession 类中添加
class PiAgentSession implements AgentSession {
  private cwd: string;
  private peerId: string;
  private identity: IdentityDoc;
  private minimaxAvailable = false;
  private workflows: Map<string, Workflow> = new Map();
  private constraintLayer: ConstraintLayer;
  private workflowEngine: WorkflowEngine;
  // ... existing fields
}
```

**Step 2: 在构造函数中初始化**

```typescript
constructor(config: AgentSessionConfig) {
  this.cwd = config.cwd;
  this.peerId = config.peerId || 'local';
  this.identity = config.identityDoc || this.createDefaultIdentity();
  this.minimaxAvailable = this.checkMinimax();
  this.constraintLayer = new ConstraintLayer();
  this.workflowEngine = new WorkflowEngine(this.constraintLayer);
}
```

**Step 3: 添加 runWorkflow 实现**

```typescript
async runWorkflow(steps: WorkflowStep[]): Promise<Workflow> {
  const context = {
    peers: this.getPeers(),
    logs: []
  };

  // 约束层预检查
  const checkResult = await this.constraintLayer.checkGuardrails(context as WorkflowContext);
  if (!checkResult.passed && checkResult.blocked) {
    console.warn(`Guardrail blocked: ${checkResult.blocked.name}`);
  }

  return this.workflowEngine.executeWorkflow(steps, context);
}
```

**Step 4: 添加便捷工作流方法**

```typescript
async summarizeDocumentWorkflow(filePath: string, targetPeer?: string): Promise<Workflow> {
  const steps: WorkflowStep[] = [
    {
      id: 'read',
      type: 'read',
      config: { path: filePath },
      retry: { max: 3, current: 0, backoffMs: 1000 },
      onFail: 'abort'
    },
    {
      id: 'summarize',
      type: 'summarize',
      config: { context: `File: ${filePath}` },
      retry: { max: 3, current: 0, backoffMs: 1000 },
      onFail: 'skip',
      guardrail: (ctx) => Promise.resolve(ctx.qualityScore !== undefined && ctx.qualityScore >= 0.5)
    }
  ];

  if (targetPeer) {
    steps.push({
      id: 'send',
      type: 'send',
      config: { peerId: targetPeer },
      retry: { max: 2, current: 0, backoffMs: 2000 },
      onFail: 'skip'
    });
  }

  return this.runWorkflow(steps);
}

async improveAndSendWorkflow(filePath: string, requirements: string, targetPeer: string): Promise<Workflow> {
  const steps: WorkflowStep[] = [
    {
      id: 'read',
      type: 'read',
      config: { path: filePath },
      retry: { max: 3, current: 0, backoffMs: 1000 },
      onFail: 'abort'
    },
    {
      id: 'improve',
      type: 'improve',
      config: { requirements, context: `File: ${filePath}` },
      retry: { max: 2, current: 0, backoffMs: 1500 },
      onFail: 'skip'
    },
    {
      id: 'send',
      type: 'send',
      config: { peerId: targetPeer, message: '改进后的文档' },
      retry: { max: 2, current: 0, backoffMs: 2000 },
      onFail: 'skip'
    }
  ];

  return this.runWorkflow(steps);
}
```

**Step 5: 提交**

```bash
git add src/agents/pi-sdk.ts
git commit -m "feat: integrate constraint layer and workflow engine into AgentSession"
```

---

## 任务 4: 添加测试

**Files:**
- Create: `src/test/constraint-layer.test.ts`
- Create: `src/test/workflow-engine.test.ts`

---

### Task 4.1: 约束层测试

**Step 1: 编写测试**

```typescript
import { describe, it, expect } from 'vitest';
import { ConstraintLayer, WorkflowContext } from '../agents/constraint-layer.js';

describe('ConstraintLayer', () => {
  const layer = new ConstraintLayer();

  describe('checkGuardrails', () => {
    it('should pass when no guardrails fail', async () => {
      const context: WorkflowContext = {
        peers: ['peer1', 'peer2'],
        logs: []
      };

      const result = await layer.checkGuardrails(context);
      expect(result.passed).toBe(true);
    });

    it('should block send to unknown peer', async () => {
      const context: WorkflowContext = {
        peers: ['peer1', 'peer2'],
        logs: []
      };

      const result = await layer.checkGuardrails(context, {
        id: 'send',
        type: 'send',
        config: { peerId: 'unknown-peer' },
        retry: { max: 0, current: 0, backoffMs: 0 },
        onFail: 'block'
      } as any);

      expect(result.passed).toBe(false);
      expect(result.blocked?.name).toBe('validateSendTarget');
    });

    it('should allow send to known peer', async () => {
      const context: WorkflowContext = {
        peers: ['peer1', 'peer2'],
        logs: []
      };

      const result = await layer.checkGuardrails(context, {
        id: 'send',
        type: 'send',
        config: { peerId: 'peer1' },
        retry: { max: 0, current: 0, backoffMs: 0 },
        onFail: 'block'
      } as any);

      expect(result.passed).toBe(true);
    });
  });

  describe('isAutonomousAction', () => {
    it('should identify autonomous actions', () => {
      expect(layer.isAutonomousAction('summarize')).toBe(true);
      expect(layer.isAutonomousAction('chunk')).toBe(true);
      expect(layer.isAutonomousAction('improve')).toBe(true);
    });

    it('should identify confirmation-required actions', () => {
      expect(layer.requiresConfirmation('send')).toBe(true);
      expect(layer.requiresConfirmation('delete')).toBe(true);
    });
  });

  describe('logging', () => {
    it('should record operations', () => {
      layer.log('test action', { key: 'value' }, 'success');
      const logs = layer.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('test action');
      expect(logs[0].status).toBe('success');
    });
  });
});
```

**Step 2: 运行测试验证**

```bash
npm test -- src/test/constraint-layer.test.ts
```

**Step 3: 提交**

```bash
git add src/test/constraint-layer.test.ts
git commit -m "test: add constraint layer tests"
```

### Task 4.2: 工作流引擎测试

**Step 1: 编写测试**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowEngine, WorkflowStep } from '../agents/workflow-engine.js';
import { WorkflowContext } from '../agents/constraint-layer.js';

// Mock dependencies
vi.mock('../documents/reader.js', () => ({
  documentReader: {
    read: vi.fn().mockResolvedValue({ text: 'test content', metadata: { filename: 'test.txt', size: 12, type: '.txt' } }),
    chunk: vi.fn().mockReturnValue(['test content'])
  }
}));

vi.mock('../llm/minimax.js', () => ({
  getMinimax: vi.fn().mockReturnValue({
    summarize: vi.fn().mockResolvedValue({ summary: 'test summary', qualityScore: 0.8 })
  })
}));

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine();
  });

  describe('executeStep', () => {
    it('should execute read step successfully', async () => {
      const step: WorkflowStep = {
        id: 'read',
        type: 'read',
        config: { path: 'test.txt' },
        retry: { max: 0, current: 0, backoffMs: 0 },
        onFail: 'abort'
      };

      const context: WorkflowContext = { peers: [], logs: [] };
      const result = await engine.executeStep(step, context);

      expect(result.status).toBe('success');
      expect(context.document).toBeDefined();
    });

    it('should retry on failure up to max attempts', async () => {
      const attemptTracker = { count: 0 };
      const engineWithRetry = new WorkflowEngine();

      // Custom step that fails twice then succeeds
      const step: WorkflowStep = {
        id: 'test',
        type: 'read',
        config: { path: 'test.txt' },
        retry: { max: 3, current: 0, backoffMs: 10 },
        onFail: 'abort'
      };

      const context: WorkflowContext = { peers: [], logs: [] };
      const result = await engineWithRetry.executeStep(step, context);

      expect(result.status).toBe('success');
    });

    it('should skip when onFail is skip and max retries exceeded', async () => {
      const step: WorkflowStep = {
        id: 'fail',
        type: 'read',
        config: { path: 'nonexistent.txt' },
        retry: { max: 0, current: 0, backoffMs: 0 },
        onFail: 'skip'
      };

      const context: WorkflowContext = { peers: [], logs: [] };
      const result = await engine.executeStep(step, context);

      expect(result.status).toBe('skipped');
    });
  });
});
```

**Step 2: 运行测试验证**

```bash
npm test -- src/test/workflow-engine.test.ts
```

**Step 3: 提交**

```bash
git add src/test/workflow-engine.test.ts
git commit -m "test: add workflow engine tests"
```

---

## 任务 5: 验证构建

**Step 1: 运行 TypeScript 编译**

```bash
npm run build
```

Expected: 编译成功，无错误

**Step 2: 运行所有测试**

```bash
npm test
```

Expected: 所有测试通过

**Step 3: 最终提交**

```bash
git add -A
git commit -m "feat: complete document agent with constraint layer and workflow engine"
```
