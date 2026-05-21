# Agent 接入、Profile 与投影机制

> 来源: ARCHITECTURE_DESIGN.md §1.3-1.4, §7
> 依赖: [PRINCIPLES.md](PRINCIPLES.md)
> 关联讨论: D-08

---

## V2 实现现状

| V1 设计 | V2 现实 | 状态 |
|---------|---------|------|
| 多源 Adapter（SecondMe/Claude/GPT/Template/Custom） | profile 文本文件 + DB | ❌ 已迭代（实用简化） |
| ProfileDataSource 可插拔接口 | DB profiles + Claude Code 处理 | ❌ 已迭代 |
| Agent 画像 = 投影函数结果（无状态） | MemoryField 加载 profiles → HDC 向量 | ✅ 概念保留 |
| WebSocket 长连接 Agent | 端侧 = ephemeral LLM 调用 | ❌ 已迭代 |
| Edge Agent + Service Agent（一自多我） | 一人一 Agent | ❌ 已迭代（规模不需要） |
| 场景（Scene）= 商业入口 | 无场景概念，直接需求驱动 | ❌ 已迭代 |
| 信息熵检测（specificity score） | 未实现 | 🔮 |

---

## 1.3 "自-我"工程映射 ⚠️ 概念有效，实现简化

### 核心认知 ✅

**"自"在系统之外，系统中只有投影（"我"）。** 一个人的存在不能被完整数字化——我们能做的是提供尽可能好的投影。

### 三个层次

```
系统之外: 人的真实存在（"自"）— 活的、完备的、不可完整数字化
    ↓ 数据源（Profile 文件、交互历史...）
数据影子: Profile Data — 是"自"能被数字化的那部分
    ↓ 投影（不同透镜）
网络中的存在: "我" — HDC 超向量
```

### Edge Agent 与 Service Agent ❌ V2 已迭代

V1 设计了 Edge Agent（全维度通才）和 Service Agent（聚焦专才）。

| | Edge Agent | Service Agent |
|--|-----------|-------------|
| 数量 | 每人一个 | 零到多个 |
| 信噪比 | 低（广覆盖） | 高（聚焦） |
| 价值 | 捕捉意外关联 | 快速精准响应 |

**V2 决策**: 一人一 Agent（等同于 Edge Agent）。Service Agent / 面具是远景功能。

**保留的设计**: `surprise`（意外度）= 全维度共振 - 最佳专项共振。差异大 → 跨域干涉 → 有涌现可能。这个概念可用于未来的路由决策。

---

## 1.4 场景（Scene）❌ V2 已迭代

### V1 设计

**场景 = 有组织者的协商空间**。商业入口 + 数据收集器。

```python
class Scene:
    scene_id: str
    name: str                    # "AI创业者黑客松2026"
    organizer_id: str
    template: Optional[Template] # 数据收集问卷
    agent_ids: List[str]
    access_policy: str           # "open" | "invite"
```

### V2 现实

V2 没有场景概念。用户注册 → 提交需求 → 全库匹配。

**V1 场景的三个价值在 V2 中的替代**:
- **商业入口**: V2 用邀请码控制
- **数据收集**: V2 用 profile 文本文件
- **有界广播空间**: V2 全库匹配（规模小，不需要边界）

**🔮 未来可能恢复**: 当规模增长后，场景作为 k* 的配置单元、作为商业合作入口。

---

## 7. Agent 接入机制

### 7.1.1 V1 模式: 平台模式（协议 DNA 内置） ✅ 概念保留

| | 平台模式（V1/V2） | 协议模式（未来） |
|--|-------------------|----------------|
| Agent 运行在哪 | 我们的基础设施 | 用户设备 |
| 身份由谁管 | 我们分配 | Agent 自己持有（DID） |
| 通信方式 | 集中式 | 任意协议 |
| 画像由谁算 | 我们计算 | 端侧自算 |

V2 确实是平台模式，但走得更简化——没有实时连接的 Agent，而是按需 LLM 调用。

### 7.1.4 信任模型: 场景准入 ⚠️ 概念有效

**核心认知仍然成立**: 信任不只是"是不是坏人"，更是"Agent 有没有足够丰富的上下文"。

上下文稀薄的 Agent 的伤害: 噪音（低质量 Offer）→ 稀释 → 用户体验差 → 口碑损害。

**V2 应对**: 邀请码限制 + profile 文本质量由人工把控。等同于场景准入的简化版。

### 7.1.5 多源接入: Adapter 架构 ❌ V2 已迭代

V1 设计了统一注册接口 + 5 种 Adapter（SecondMe/Claude/GPT/Template/Custom）。

**V2 现实**: 用户注册 → 写 profile 文本 → 管理员 load-profiles → HDC 编码。没有 Adapter 层。

**保留的价值**: 如果未来需要对接 SecondMe 或其他数据源，Adapter 架构仍然适用。ProfileDataSource 接口仍然有效。

### 7.1.6 ProfileDataSource 与投影机制 ⚠️ 概念保留

**核心突破**（Design Log #003）: **Agent 是投影函数的结果，不是有状态对象。**

```
ProfileDataSource.get_profile() → Profile Data
    → 投影函数（无状态）
    → Agent Vector = project(profile_data, lens)
```

**V2 实现**: `field_sync.py` 从 DB 读取 profiles → `EncodingPipeline` 编码 → `MemoryField` 加载。
本质上就是 project(profile_data, "full_dimension") 的实现。

**关键原则仍然成立**:
- Agent 是投影，不是对象
- 数据源可插拔（目前是 DB text，未来可以是 SecondMe API）
- 投影无状态，可重复计算

### 7.1.7 Template ❌ V2 已迭代

V1 的 Template（结构化表单收集）被 V2 的 profile 文本文件替代。更灵活但缺乏结构化。

---

## 商业-运营-架构闭环 🔮

V1 设计的飞轮:
```
场景丰富 → Agent上下文丰富 → 共振精准 → 协商产出好
    → 用户满意 → 口碑 → 更多场景 → ...
```

V2 的简化版飞轮:
```
邀请码用户 → profile 文本 → 匹配+结晶 → 交付
    → 用户体验 → 口碑 → 更多用户 → ...
```

核心逻辑一致，只是载体从"场景"简化为"个人直接参与"。
