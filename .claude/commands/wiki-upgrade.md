检查 LLM-wiki 是否有更新，并在可用时进行升级。

```bash
python3 scripts/version_check.py
```

如果有可用更新，先询问用户是否要升级，然后再运行：

```bash
bash scripts/upgrade.sh
```

升级完成后，运行 `/wiki-check` 验证一切仍然通过。
