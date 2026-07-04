对本项目运行所有 LLM-wiki 校验检查。

按顺序执行以下命令并报告结果：

```bash
python3 scripts/wiki_check.py
python3 scripts/raw_manifest_check.py
python3 scripts/untracked_raw_check.py
python3 scripts/provenance_check.py
python3 scripts/stale_report.py
```

如果任何检查失败，说明问题所在以及如何修复。
如果全部通过，输出 "Wiki health: OK" 并附上汇总计数。
