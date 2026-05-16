# AI智能体自主文档处理系统 - 设计文档

## 1. 概述

设计一个基于 OpenClaw 双层架构的 AI 智能体系统，实现文档自主阅读、总结、改进和 P2P 发送。系统通过 **约束层（Prompt Guardrails）** + **执行层（Code-Driven Workflow）** 实现安全可控的完全自主运行。

### 1.1 OpenCLI 集成

系统集成 OpenCLI 实现**零 Token 消耗的浏览器自动化**和数据获取能力：

| 能力 | 命令示例 | Token 消耗 |
|------|----------|------------|
| 社交媒体搜索 | `opencli zhihu search "AI Agent"` | 0 |
| 视频/图文下载 | `opencli bilibili download <url>` | 0 |
| 私域聊天记录 | `opencli wx search <keyword>` | 0 |
| 办公套件 | `opencli lark search <keyword>` | 0 |
| 浏览器 CDP 控制 | `opencli cdp screenshot` | 0 |

**核心优势**：CLI 命令在本地浏览器直接执行，不经过 LLM 推理，实现零 Token 消耗的确定性操作。

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
│  - Privacy Guardrail: 私域数据访问拦截                  │
└─────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│  Execution Layer (Code-Driven Workflow)                 │
│  - WorkflowEngine: 工作流执行引擎                       │
│  - Step 执行 + 重试机制 + Guardrail 检查                │
│  - OpenCLI Adapter: 零Token浏览器自动化                │
│  - CDP Controller: Electron应用控制                      │
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
| `PrivacyGuardrail` | 私域数据访问权限检查（微信/飞书等） |
| `WorkflowEngine` | 工作流编排、步骤执行、重试逻辑 |
| `OpenCLIAdapter` | OpenCLI 命令执行，零 Token 数据获取 |
| `CDPController` | 浏览器 CDP 协议控制，Electron 应用自动化 |
| `WorkflowStep` | 单个步骤定义（含 scrape/opencli/chat 等新类型） |
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
type StepType =
  | 'read' | 'chunk' | 'summarize' | 'improve' | 'review' | 'send' | 'report'
  | 'scrape'    // 网页数据抓取（opencli）
  | 'opencli'   // OpenCLI 命令执行
  | 'chat'      // 私域聊天记录获取（wx/tg/discord）
  | 'cdp';      // CDP 浏览器控制

interface WorkflowStep {
  id: string;
  type: StepType;
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
  scrapedData?: ScrapedData;  // OpenCLI 获取的数据
  chatHistory?: ChatMessage[]; // 私域聊天记录
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
        if (step.onRetry !== false && step.guardrail && !await step.guardrail(context)) {
          return { status: 'blocked', reason: 'guardrail_failed' };
        }

        return { status: 'success', result };
      } catch (error) {
        if (attempt === step.retry.max) {
          return step.onFail === 'skip'
            ? { status: 'skipped', error: String(error) }
            : { status: 'failed', error: String(error) };
        }
        await this.backoff(step.retry.backoffMs * Math.pow(2, attempt));
      }
    }
  }
}
```

### 4.3 OpenCLI Adapter

```typescript
class OpenCLIAdapter {
  constructor(private shell: ShellExecutor) {}

  async execute(command: string, args: string[]): Promise<OpenCLIResult> {
    const cmd = `opencli ${command} ${args.join(' ')}`;
    const output = await this.shell.exec(cmd);
    return this.parseOutput(output);
  }

  // 社交媒体数据获取
  async scrapeSite(platform: string, query: string): Promise<ScrapedData> {
    return this.execute(platform, ['search', `"${query}"`]);
  }

  // 私域聊天记录（需 PrivacyGuardrail 通过）
  async fetchChatHistory(
    platform: 'wx' | 'tg' | 'discord',
    options: ChatFetchOptions
  ): Promise<ChatMessage[]> {
    const cmd = platform === 'wx' ? 'wx' : `opencli ${platform}`;
    return this.execute(cmd, ['history', '--keyword', options.keyword]);
  }

  // CDP 浏览器控制
  async controlBrowser(action: CDPAction): Promise<CDPResult> {
    return this.execute('cdp', [action.type, `--selector`, action.selector]);
  }
}
```

### 4.4 Privacy Guardrail（私域数据访问控制）

```typescript
const PRIVACY_GUARDRAIL: Guardrail = async (ctx, step) => {
  const sensitivePlatforms = ['wx', 'tg', 'discord', 'lark', 'wecom', 'dingtalk'];

  if (sensitivePlatforms.includes(step.config?.platform as string)) {
    // 检查是否有明确授权
    if (!ctx.authorizedPlatforms?.includes(step.config.platform)) {
      log('BLOCKED: Access to private data platform', { platform: step.config.platform });
      return false;
    }
    // 记录访问日志
    log('PRIVACY: Accessing private data', {
      platform: step.config.platform,
      scope: step.config.scope,
    });
  }
  return true;
};
```

### 4.5 默认工作流

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

// OpenCLI 增强工作流（可选）
const OPENCLI_ENHANCED_WORKFLOW: WorkflowStep[] = [
  {
    id: 'scrape',
    type: 'scrape',
    config: { platform: 'zhihu', query: 'AI Agent' },
    retry: { max: 2, current: 0, backoffMs: 500 },
    onFail: 'skip',
    guardrail: validatePublicDataAccess
  },
  {
    id: 'enrich',
    type: 'summarize',
    retry: { max: 3, current: 0, backoffMs: 1000 },
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

┌─────────────────────────────────────────────────────────┐
│  OpenCLI 增强数据流（零 Token）                           │
│                                                           │
│  Scrape → ChatHistory → Enrich → Summarize → Send        │
│     │          │             │                           │
│     └──────────┴─────────────┘                           │
│              ↓                                            │
│     PrivacyGuardrail（私域数据拦截）                       │
└─────────────────────────────────────────────────────────┘
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

// OpenCLI 数据访问权限检查
const validateOpenCLIAccess: Guardrail = async (ctx, step) => {
  const platform = step.config?.platform as string;
  const privatePlatforms = ['wx', 'tg', 'discord', 'lark', 'wecom', 'dingtalk'];

  if (privatePlatforms.includes(platform)) {
    if (!ctx.userConsent?.includes(platform)) {
      log('BLOCKED: No consent for private platform', { platform });
      return false;
    }
    log('ALLOWED: Private platform access', { platform });
  }
  return true;
};

// 公共数据访问检查（用于 scrape 步骤）
const validatePublicDataAccess: Guardrail = async (ctx, step) => {
  const platform = step.config?.platform as string;
  const whitelist = ['zhihu', 'bilibili', 'xiaohongshu', 'reddit', 'hackernews'];

  if (!whitelist.includes(platform)) {
    log('BLOCKED: Unsupported platform', { platform });
    return false;
  }
  return true;
};
```

### 6.2 Privacy Guardrail 决策流程

```
数据访问请求 → 平台分类 → 公共平台? ─Yes─→ 放行
                              │
                              No
                              ▼
                    授权平台列表检查 ─Yes─→ 放行 + 记录日志
                              │
                              No
                              ▼
                         拦截 + 等待用户确认
```

### 6.3 操作日志

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
│   ├── constraint-layer.ts # 约束层实现
│   ├── workflow-engine.ts  # 工作流引擎
│   └── opencli-adapter.ts  # NEW: OpenCLI 命令适配器
├── browser/
│   ├── cdp-controller.ts   # NEW: CDP 浏览器控制
│   └── electron-bridge.ts   # NEW: Electron 应用桥接
├── privacy/
│   ├── guardrails.ts       # NEW: 隐私 guardrail 实现
│   └── consent-manager.ts   # NEW: 用户授权管理
├── data/
│   ├── reader.ts           # 文档读取（已存在）
│   ├── scraper.ts          # NEW: 网页数据抓取
│   └── chat-fetcher.ts     # NEW: 私域聊天记录获取
├── llm/
│   └── minimax.ts          # LLM调用（已存在）
├── network/
│   └── p2p.ts              # P2P网络（已存在）
└── index.ts                # 入口（已存在）
```

### 7.1 OpenCLI 安装与配置

```bash
# 安装 OpenCLI（Node.js 21+）
npm install -g @jackwener/opencli

# 安装私域聊天适配器
npm install -g @jackwener/wx-cli      # 微信
npm install -g @jackwener/tg-cli      # Telegram
npm install -g @jackwener/discord-cli # Discord

# 初始化微信（需 root 权限）
sudo wx init

# 验证安装
opencli list
```

## 8. 实现顺序

1. **约束层** (`constraint-layer.ts`) - Prompt 管理与拦截
2. **工作流引擎** (`workflow-engine.ts`) - 执行与重试逻辑
3. **OpenCLI 适配器** (`opencli-adapter.ts`) - 命令执行与结果解析
4. **隐私 Guardrail** (`guardrails.ts`) - 私域数据访问控制
5. **CDP 控制器** (`cdp-controller.ts`) - 浏览器自动化
6. **集成** - 将各组件集成到 `AgentSession`
7. **测试** - 验证各步骤和重试机制

## 9. OpenCLI 能力矩阵

| 平台 | 搜索 | 下载 | 历史记录 | 自动化 |
|------|------|------|----------|--------|
| 知乎 | ✅ | ✅ | - | ✅ |
| B站 | ✅ | ✅ | - | ✅ |
| 小红书 | ✅ | ✅ | - | ✅ |
| 微信公众号 | ✅ | ✅ | - | ✅ |
| Reddit | ✅ | ✅ | - | ✅ |
| Twitter/X | ✅ | ✅ | - | ✅ |
| 微信 | ✅ | - | ✅ | - |
| Telegram | ✅ | - | ✅ | - |
| Discord | ✅ | - | ✅ | ✅ |
| 飞书 | ✅ | ✅ | ✅ | ✅ |
| 企业微信 | ✅ | ✅ | ✅ | - |
| 钉钉 | ✅ | ✅ | ✅ | - |
| GitHub | ✅ | ✅ | - | ✅ |
| Google Scholar | ✅ | ✅ | - | - |

**注**：零 Token 消耗指的是 OpenCLI 命令执行本身不消耗 LLM Token，但解析结果用于 LLM 处理时仍会产生 Token 消耗。
