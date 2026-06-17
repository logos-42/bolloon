# .comm/ — 跨机聊天收件箱

Bolloon chat transport: commits-as-messages.
每条消息 = 一个 markdown 文件 + 一次 git commit + push.

## 目录约定

- `<role>/` — 每个 role 一个子目录, 里面是该角色发的所有消息
- `_state/` — 本地运行态 (cursor, seen, lock), 不 commit
- `_inbox/` — 看门狗把对方消息反写到本地, 不 commit

## 子命令

```
bolloon --chat-init
bolloon --chat-send "..."
bolloon --chat-pull
bolloon --chat-list
bolloon --chat-watch
bolloon --chat-status
```
