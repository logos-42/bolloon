## 分布式协商约定

你正在编辑 catalyst 相关代码。端侧与平台侧职责严格分离：

**平台侧（cloud catalyst）**：
- 协调协商轮次、管理 deadline、聚合响应
- 拥有全局视角，决定何时进入下一轮或结束

**端侧（bridge worker）**：
- 执行具体的 LLM 调用、生成响应
- 只上报执行事实，不判断协商是否成功

**BYOK 模式**：用户绑定自己的 API Key（Anthropic / MiniMax / 自定义 base_url）。
平台侧使用用户 key 调用 LLM，不存储 key 明文（仅 session 级绑定）。

**行为约束**: 不得在 worker 侧添加协商策略逻辑（何时结束、何时重试）。
catalyst coordinator 的状态机变更必须伴随测试覆盖。
BYOK base_url 必须经过校验，不得接受任意 URL（SSRF 防护）。
