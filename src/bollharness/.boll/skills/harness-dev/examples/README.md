# harness-dev 代码示例库

这个目录包含 harness-dev skill 的代码示例，展示{{PROJECT_NAME}}/WOWOK 生态系统的工程实践。

## 示例列表

### 1. 投影函数示例（`projection_example.ts`）

**核心概念**：投影即函数，Agent 无状态

展示：
- 无状态投影函数（Profile Data → HDC Vector）
- ProfileDataSource 接口设计（本质与实现分离）
- Edge Agent vs Service Agent（同样数据，不同透镜）

**关键代码**：
```typescript
function projectToEdgeAgent(profile: ProfileData): HDCVector {
    return hdcEncode(profile, "full_dimension");
}

function projectToServiceAgent(profile: ProfileData, focus: string): HDCVector {
    return hdcEncode(profile, `focus_on_${focus}`);
}
```

**设计理念**：Design Log #003 - Projection as Function

### 2. Adapter 扩展示例（`adapter_example.ts`）

**核心概念**：扩展协议（本质与实现分离）

展示：
- 继承 AgentAdapter 基类
- 实现 formulate_demand 和 generate_offer
- 优雅的错误处理

**关键代码**：
```typescript
class SecondMeAdapter extends AgentAdapter {
    async formulateDemand(rawInput: string): Promise<Demand> {
        return { intent: parseIntent(rawInput) };
    }

    async generateOffer(demand: Demand): Promise<Offer> {
        return { ...demand, status: "pending" };
    }
}
```

**设计理念**：Adapter 模式，可插拔数据源

### 3. 测试编写示例（`test_example.ts`）

**核心概念**：测试是思维清晰度的验证

展示：
- 正常情况测试（happy path）
- 边界情况测试（边界值、空输入）
- 异常情况测试（错误输入）
- Mock 外部依赖（不依赖真实 API）

**关键代码**：
```typescript
describe("projectToVector", () => {
    it("normal case: projection succeeds", () => {
        const mockSource = mock<ProfileDataSource>();
        mockSource.getProfile.mockResolvedValue(mockProfile);

        const vector = projectToVector("user-123", "backend", mockSource);

        expect(vector).toHaveLength(HDC_DIMENSION);
        expect(mockSource.getProfile).toHaveBeenCalledOnceWith("user-123");
    });
});
```

**设计理念**：测试即文档，易测试的代码 = 设计良好的代码

### 4. 状态机示例（`state_machine_example.ts`）

**核心概念**：代码保障 > Prompt 保障

展示：
- 协商状态管理（状态枚举）
- 状态转移检查（异常抛出）
- 防止第一提案偏见（等待屏障）

**关键代码**：
```typescript
enum NegotiationState {
    COLLECTING_OFFERS = "collecting_offers",
    READY_TO_AGGREGATE = "ready_to_aggregate",
    COMPLETED = "completed"
}

function submitOffer(self: NegotiationContext, agentId: string, offer: Offer): void {
    if (self.state !== NegotiationState.COLLECTING_OFFERS) {
        throw new Error("Invalid state for submitOffer");
    }

    self.offers[agentId] = offer;

    if (Object.keys(self.offers).length === self.expectedAgents.length) {
        self.state = NegotiationState.READY_TO_AGGREGATE;
    }
}
```

**设计理念**：Design Principle 0.5 - 代码保障 > Prompt 保障

**研究依据**：Microsoft 2025，第一提案偏见 10-30x

### 5. 可观测性示例（`observable_example.ts`）

**核心概念**：可观测性是设计的一部分

展示：
- 结构化日志（JSON 格式，机器可读）
- 性能监控（timing decorator）
- 分布式追踪（trace_id 传播）

**关键代码**：
```typescript
class StructuredLogger {
    info(message: string, fields: Record<string, unknown>): void {
        const logEntry = {
            timestamp: Date.now(),
            level: "INFO",
            message,
            trace_id: getTraceId(),
            ...fields
        };
        this.logger.info(JSON.stringify(logEntry));
    }
}

function timed<T extends (...args: unknown[]) => unknown>(
    logger: StructuredLogger,
    fn: T
): T {
    return ((...args: unknown[]) => {
        const start = Date.now();
        const result = fn(...args);
        logger.info(`Function ${fn.name} took ${Date.now() - start}ms`);
        return result;
    }) as T;
}
```

**设计理念**：看不到系统在做什么 = 无法判断正确性

### 6. 错误处理示例（`error_handling_example.ts`）

**核心概念**：优雅降级、重试机制、自定义异常

展示：
- 优雅降级（实时数据 → 缓存 → 空数据）
- 重试机制（指数退避）
- 自定义异常（清晰的错误语义）

**关键代码**：
```typescript
async function getProfile(userId: string): Promise<ProfileData> {
    try {
        return await fetchFromSecondMe(userId);
    } catch (error) {
        if (error instanceof ServiceUnavailableError) {
            if (this.cache.has(userId)) {
                return this.cache.get(userId)!;
            }
            return ProfileData.empty(userId);
        }
        throw error;
    }
}
```

**设计理念**：预期的错误捕获并处理，非预期的错误向上传播

## 运行示例

所有示例都可以独立运行：

```bash
cd .boll/skills/harness-dev/examples

# 运行投影函数示例
npx ts-node projection_example.ts

# 运行状态机示例
npx ts-node state_machine_example.ts

# 运行可观测性示例
npx ts-node observable_example.ts

# 运行错误处理示例
npx ts-node error_handling_example.ts

# 运行测试示例
npm test
```

## 最佳实践总结

这些示例展示了 7 个核心工程信念：

1. **代码是思想的投影**：清晰的代码 = 清晰的理解
2. **本质与实现分离**：接口稳定，实现可插拔
3. **投影即函数，Agent 无状态**：无状态函数，极度简单
4. **代码保障 > Prompt 保障**：状态机防护，让 LLM 犯不了错
5. **复杂度预算是有限的**：函数 < 50 行，职责清晰
6. **可观测性是设计的一部分**：结构化日志、性能监控、分布式追踪
7. **测试是思维清晰度的验证**：易测试的代码 = 设计良好的代码

## 进一步阅读

- **harness-dev SKILL.md**：完整的工程主管指南
- **arch skill**：架构理念和设计原则
- **ARCHITECTURE_DESIGN.md**：{{PROJECT_NAME}}网络技术架构
- **MEMORY.md**：项目关键决策记录

## 问题反馈

如果你对这些示例有疑问，或者想看更多示例：
1. 问 harness-dev：代码实现、工程实践、测试策略
2. 问 arch：架构设计、设计原则、本质理解
