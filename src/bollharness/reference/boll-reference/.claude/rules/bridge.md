---
paths:
  - "bridge_agent/**"
  - "backend/product/bridge/**"
  - "bridge_contract/**"
---

# Bridge 宪法 (ADR-026)

Bridge 是薄中继，不是本地 orchestrator。以下 5 条规则约束所有 bridge 改动：

1. **Worker 不拥有业务解释权，只上报执行事实。** 如果一段 worker 代码需要理解输出内容的含义，它就写错了地方。
2. **同一个语义只允许有一个定义。** 不管是文件名模式、artifact 类型、还是 event 含义，只能在一个地方定义。
3. **跑通了就发结果，没跑通就报 failed。** 不做 partial_success 抢救、不生成 placeholder、不从失败 stdout 里猜内容。这些如果需要，由 server 决定。
4. **生产不能是第一个集成环境。** 本地必须能用 fake CLI + 真实 HTTP backend 跑完整链。
5. **新增观测维度或 event 类型，只改 server，不改 worker。** 这是开闭原则的具体体现。

三层职责：`boll-run` 定义成功产物契约 → `worker` 执行和上报事实 → `server` 解释事实并生成产品语义。

详见: `docs/decisions/ADR-026-bridge-thin-relay-architecture.md`
