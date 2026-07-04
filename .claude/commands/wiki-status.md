显示当前 wiki 状态：包含哪些页面、最近的日志条目，以及任何问题。

1. 读取 `docs/wiki/index.md` 并列出所有页面
2. 读取 `docs/wiki/log.md` 的最近 3 条记录
3. 读取 `docs/wiki/current-status.md` 并作摘要
4. 运行 `python3 scripts/stale_report.py --dry-run` 并报告是否存在过期内容
5. 运行 `python3 scripts/version_check.py` 检查是否有更新
6. 用一段话总结项目当前状态
