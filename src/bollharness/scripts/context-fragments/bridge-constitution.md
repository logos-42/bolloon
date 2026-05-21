## Bridge 宪法（ADR-026）

你正在编辑 Bridge 相关代码。以下 5 条规则约束所有 bridge 改动：

1. **Worker 不拥有业务解释权，只上报执行事实。** 如果代码需要理解输出内容的含义，它写错了地方。
2. **同一个语义只允许有一个定义。** 文件名模式、artifact 类型、event 含义，只能在一个地方定义。
3. **跑通了就发结果，没跑通就报 failed。** 不做 partial_success 抢救、不生成 placeholder。
4. **生产不能是第一个集成环境。** 本地必须能用 fake CLI + 真实 HTTP backend 跑完整链。
5. **新增观测维度或 event 类型，只改 server，不改 worker。**

三层职责：`boll-run` 定义成功产物契约 -> `worker` 执行和上报事实 -> `server` 解释事实并生成产品语义。

**行为约束**: 你不得在 worker 侧添加任何需要理解业务语义的逻辑。所有解释权必须归 server。
