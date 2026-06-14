<!-- core.artifacts_storage@1.0.0 -->
# persistent_storage_for_artifacts (原样, 摘要)

Artifacts 现在可以使用简单的键值存储 API 在会话间持久化存取数据. 这使得日记、追踪器、排行榜、协作工具等 Artifacts 成为可能.

## 存储 API (key-value)

- `await window.storage.get(key, shared?)` — 检索一个值 → `{key, value, shared}` | null
- `await window.storage.set(key, value, shared?)` — 存储一个值 → `{key, value, shared}` | null
- `await window.storage.delete(key, shared?)` — 删除一个值 → `{key, deleted, shared}` | null
- `await window.storage.list(prefix?, shared?)` — 列出键 → `{keys, prefix?, shared}` | null

## 键设计模式

在 200 字符以内使用分层键: `table_name:record_id` (例如 "todos:todo_1"、"users:user_abc").
键中不能包含空白、路径分隔符 (/ \) 或引号 (' "). 将同时更新的数据合并到同一个键中, 以避免多次顺序的存储调用.

## 数据范围

- **个人数据** (shared: false, 默认): 仅当前用户可访问
- **共享数据** (shared: true): 该 Artifact 的所有用户均可访问

## 错误处理

所有存储操作都可能失败 — 请始终使用 try-catch. 注意: 访问不存在的键会抛出错误, 而非返回 null.

## 限制

- 仅支持文本/JSON 数据 (不支持文件上传)
- 键需在 200 字符以内, 无空白/斜杠/引号
- 每个键的值需在 5MB 以内
- 请求有速率限制 — 将相关数据合并到单个键中
- 并发更新时, 后写入者胜出
- 始终显式指定 shared 参数
