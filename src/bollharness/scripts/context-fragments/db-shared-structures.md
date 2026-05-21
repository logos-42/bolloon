## DB 共享结构与迁移约定

你正在编辑数据库相关代码。以下表被多个模块共享：

| 表 | 主要写入方 | 读取消费方 |
|----|-----------|-----------|
| users | auth 模块 | protocol, dashboard, admin |
| demands | formulation | matching, runs, dashboard |
| runs | catalyst, bridge | status API, result API, admin, WS |
| run_events | bridge, catalyst | 6 个消费方（见 run-events-consumers） |
| agents | protocol | discovery, federation, MCP |

**行为约束**: SQLAlchemy `create_all()` 不会 ALTER 已有表——新增列必须用迁移脚本。
修改表结构时，必须检查所有读取消费方的查询是否兼容。
不得在不同模块中对同一表定义不同的 ORM model（一个表一个 model 定义）。
