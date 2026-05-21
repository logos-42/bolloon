## run_events 消费方（共享结构）

你正在编辑 run_events 相关代码。此表有 6 个消费方，各自角色不同：

| 消费方 | 读/写 | 用途 | 关键依赖 |
|--------|-------|------|----------|
| Bridge events 路由 | 写 | 接收 worker 上报的事件 | event_type 枚举 |
| Catalyst coordinator | 写 | 记录协商轮次事件 | round_number, role |
| Run status API | 读 | 前端展示进度 | 按 run_id 查询 + 时间排序 |
| Run result API | 读 | 提取最终产物 | artifact 类型过滤 |
| Admin event log | 读 | 运维审计 | 全字段 |
| WebSocket hub | 读 | 实时推送 | 增量查询（last_id） |

**行为约束**: 修改 run_events 表结构或写入逻辑时，必须逐一确认 6 个消费方不受影响。
不得假设"只有一个地方读"。读模型截断会导致长 run 状态不正确。
