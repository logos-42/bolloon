# AI智能体自主文档处理系统 - 设计文档

## 1. 概述

设计一个基于 OpenClaw 双层架构的 AI 智能体系统，实现文档自主阅读、总结、改进和 P2P 发送。系统通过 **约束层（Prompt Guardrails）** + **执行层（Code-Driven Workflow）** 实现安全可控的完全自主运行。

## 2. 架构设计

### 2.1 双层架构

```
┌─────────────────────────────────────────────────────────┐
│                    Human Interaction                     │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│  Constraint Layer (Prompt Guardrails)                    │
│  - System Prompt: Agent 边界、规则、禁忌                 │
│  - Task Prompt: 当前任务的具体约束                     │
│  - Safety Check: 敏感操作拦截                           │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│  Execution Layer (Code-Driven Workflow)                 │
│  - WorkflowEngine: 工作流执行引擎                       │
│  - Step 执行 + 重试机制 + Guardrail 检查                │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│  P2P Network (libp2p + DIaoP Identity)                │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心组件

| 组件 | 职责 |
|------|------|
| `ConstraintLayer` | Prompt 约束管理、安全拦截、规则执行 |
| `WorkflowEngine` | 工作流编排、步骤执行、重试逻辑 |
| `WorkflowStep` | 单个步骤定义（read/chunk/summarize/improve/review/send/report） |
| `AgentSession` | Agent 会话管理、状态维护 |

## 3. 约束层设计

### 3.1 System Prompt 约束

```typescript
const SYSTEM_PROMPT = `
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
```

### 3.2 约束执行流程

```
任务输入 → 约束检查 → 放行/拦截/确认
                │
                ▼
        ┌───────────────┐
        │ 新节点发送?    │──Yes──→ 拦截 + 记录 + 等待确认
        └───────────────┘
                │No
                ▼
        ┌───────────────┐
        │ 在规则内?      │──No──→ 拦截 + 返回错误
        └───────────────┘
                │Yes
                ▼
            放行执行
```

## 4. 执行层设计

### 4.1 WorkflowStep 接口

```typescript
interface WorkflowStep {
  id: string;
  type: 'read' | 'chunk' | 'summarize' | 'improve' | 'review' | 'send' | 'report';
  config?: Record<string, unknown>;
  retry: {
    max: number;      // 最大重试次数
    current: number;  // 当前重试次数
    backoffMs: number; // 退避时间（毫秒）
  };
  onFail: 'skip' | 'abort' | 'retry';
  guardrail?: (context: WorkflowContext) => Promise<boolean>;
  guardrailOnRetry?: boolean; // 重试时是否也执行 guardrail
}

interface WorkflowContext {
  document?: DocumentContent;
  summary?: string;
  improved?: string;
  qualityScore?: number;
  peers: string[];
  logs: OperationLog[];
}
```

### 4.2 WorkflowEngine 执行逻辑

```typescript
class WorkflowEngine {
  async execute(step: WorkflowStep, context: WorkflowContext): Promise<StepResult> {
    // 1. Guardrail 前置检查
    if (step.guardrail && !await step.guardrail(context)) {
      return { status: 'blocked', reason: 'guardrail_failed' };
    }

    // 2. 执行步骤，带重试
    for (let attempt = 0; attempt <= step.retry.max; attempt++) {
      try {
        const result = await this.runStep(step, context);

        // 3. Guardrail 后置检查（可选）
        if (step.guardrailOnRetry !== false && step.guardrail && !await step.guardrail(context)) {
          return { status: 'blocked', reason: 'guardrail_failed' };
        }

        return { status: 'success', result };
      } catch (error) {
        if (attempt === step.retry.max) {
          // 达到最大重试次数
          return step.onFail === 'skip'
            ? { status: 'skipped', error: String(error) }
            : { status: 'failed', error: String(error) };
        }
        // 指数退避
        await this.backoff(step.retry.backoffMs * Math.pow(2, attempt));
      }
    }
  }
}
```

### 4.3 默认工作流

```typescript
const DEFAULT_WORKFLOW: WorkflowStep[] = [
  {
    id: 'read',
    type: 'read',
    retry: { max: 3, current: 0, backoffMs: 1000 },
    onFail: 'abort'
  },
  {
    id: 'chunk',
    type: 'chunk',
    retry: { max: 0, current: 0, backoffMs: 0 },
    onFail: 'abort'
  },
  {
    id: 'summarize',
    type: 'summarize',
    retry: { max: 3, current: 0, backoffMs: 1000 },
    onFail: 'skip',
    guardrail: validateSummaryQuality
  },
  {
    id: 'improve',
    type: 'improve',
    retry: { max: 2, current: 0, backoffMs: 1500 },
    onFail: 'skip'
  },
  {
    id: 'send',
    type: 'send',
    retry: { max: 2, current: 0, backoffMs: 2000 },
    onFail: 'skip',
    guardrail: validateSendTarget
  }
];
```

## 5. 数据流

```
用户输入 → 约束层检查 → 工作流引擎
                           │
    ┌──────────────────────┼──────────────────────┐
    ▼                      ▼                      ▼
Read文档 → Chunk分块 → Summarize → (可选)Improve → Send
    │           │           │              │
    └───────────┴───────────┴──────────────┘
                    │
                    ▼
              质量评估 → Guardrail检查 → 决策（重试/跳过/完成）
```

## 6. 安全机制

### 6.1 敏感操作 Guardrail

```typescript
// 发送到新节点时拦截
const validateSendTarget: Guardrail = async (ctx, step) => {
  const targetPeer = step.config?.peerId as string;
  if (!ctx.peers.includes(targetPeer)) {
    log('BLOCKED: Sending to unknown peer', { targetPeer });
    return false; // 拦截，等待确认
  }
  return true;
};

// 摘要质量检查
const validateSummaryQuality: Guardrail = async (ctx) => {
  if (ctx.qualityScore < 0.5) {
    log('WARN: Low quality summary', { score: ctx.qualityScore });
    return false; // 触发重试
  }
  return true;
};
```

### 6.2 操作日志

```typescript
interface OperationLog {
  timestamp: number;
  action: string;
  details: Record<string, unknown>;
  status: 'success' | 'failed' | 'blocked';
}

const logs: OperationLog[] = [];
```

## 7. 文件结构

```
src/
├── agents/
│   ├── pi-sdk.ts           # AgentSession（已存在）
│   ├── constraint-layer.ts # NEW: 约束层实现
│   └── workflow-engine.ts  # NEW: 工作流引擎
├── documents/
│   └── reader.ts           # 文档读取（已存在）
├── llm/
│   └── minimax.ts          # LLM调用（已存在）
├── network/
│   └── p2p.ts              # P2P网络（已存在）
└── index.ts                # 入口（已存在）
```

## 8. 实现顺序

1. **约束层** (`constraint-layer.ts`) - Prompt 管理与拦截
2. **工作流引擎** (`workflow-engine.ts`) - 执行与重试逻辑
3. **集成** - 将约束层和工作流引擎集成到 `AgentSession`
4. **测试** - 验证各步骤和重试机制
