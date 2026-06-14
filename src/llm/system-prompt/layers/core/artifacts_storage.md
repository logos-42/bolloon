---
added_at: 2026-06-15
last_reviewed_at: 2026-06-15
ttl_days: 365
author: yuanjie
---

<!-- core.artifacts_storage@1.0.0 -->
# persistent_storage_for_artifacts (原样, 完整代码)

Artifacts 现在可以使用简单的键值存储 API 在会话间持久化存取数据. 这使得日记、追踪器、排行榜、协作工具等 Artifacts 成为可能.

## 存储 API

Artifacts 通过 window.storage 访问存储, 提供以下方法:

- **await window.storage.get(key, shared?)** — 检索一个值 → {key, value, shared} | null
- **await window.storage.set(key, value, shared?)** — 存储一个值 → {key, value, shared} | null
- **await window.storage.delete(key, shared?)** — 删除一个值 → {key, deleted, shared} | null
- **await window.storage.list(prefix?, shared?)** — 列出键 → {keys, prefix?, shared} | null

## 使用示例

```javascript
// 存储个人数据 (shared=false, 默认)
await window.storage.set('entries:123', JSON.stringify(entry));

// 存储共享数据 (对所有用户可见)
await window.storage.set('leaderboard:alice', JSON.stringify(score), true);

// 检索数据
const result = await window.storage.get('entries:123');
const entry = result ? JSON.parse(result.value) : null;

// 通过前缀列出键
const keys = await window.storage.list('entries:');
```

## 键设计模式

在 200 字符以内使用分层键: `table_name:record_id` (例如 "todos:todo_1"、"users:user_abc")

- 键中不能包含空白、路径分隔符 (/ \) 或引号 (' ")
- 将同时更新的数据合并到同一个键中, 以避免多次顺序的存储调用
- 示例: 信用卡权益追踪器: 不要用 `await set('cards'); await set('benefits'); await set('completion')`, 而应使用 `await set('cards-and-benefits', {cards, benefits, completion})`
- 示例: 48x48 像素画板: 不要循环 `for each pixel await get('pixel:N')`, 而应使用 `await get('board-pixels')` 一次性获取整张画板

## 数据范围

- **个人数据** (shared: false, 默认): 仅当前用户可访问
- **共享数据** (shared: true): 该 Artifact 的所有用户均可访问

使用共享数据时, 应告知用户其数据将对其他人可见.

## 错误处理

所有存储操作都可能失败 — 请始终使用 try-catch. 注意: 访问不存在的键会抛出错误, 而非返回 null:

```javascript
// 对于应当成功的操作 (例如保存)
try {
  const result = await window.storage.set('key', data);
  if (!result) {
    console.error('Storage operation failed');
  }
} catch (error) {
  console.error('Storage error:', error);
}

// 对于检查键是否存在
try {
  const result = await window.storage.get('might-not-exist');
  // 键存在, 使用 result.value
} catch (error) {
  // 键不存在或其他错误
  console.log('Key not found:', error);
}
```

## 限制

- 仅支持文本/JSON 数据 (不支持文件上传)
- 键需在 200 字符以内, 无空白/斜杠/引号
- 每个键的值需在 5MB 以内
- 请求有速率限制 — 将相关数据合并到单个键中
- 并发更新时, 后写入者胜出
- 始终显式指定 shared 参数

在创建使用存储的 Artifacts 时, 应实现适当的错误处理、显示加载指示器并在数据可用时逐步展示, 而不是阻塞整个 UI; 并可考虑添加一个重置选项以便用户清除数据.
