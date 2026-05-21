# Source of Truth

> 这份 rule 告诉 agent 哪些文件是"事实源"，不允许凭记忆或 LLM 自己推断；必须先 Read 或 Grep 再做判断。

## Layout 真相源

| 主题 | 真相文件 |
|------|---------|
| Harness 组件清单 (hooks/checks/rules/skills) | `.boll/MANIFEST.yaml` |
| PreToolUse / PostToolUse matcher 注册 | `.boll/settings.json` |
| Annex A.1 五类脱敏分类 | `src/scripts/lib/sanitize_patterns.ts` |
| 三元 count (command_instances/unique_scripts/physical_files) | `src/scripts/ci/count-components.sh` 实时输出 |
| rebaseline triggers | `.boll/MANIFEST.yaml` `rebaseline_triggers[]` |

## 决策链真相源

| 主题 | 真相文件 |
|------|---------|
| 开源治理与剥离边界 | `docs/decisions/ADR-043-wow-harness-open-sourcing.md`（fork 时已脱敏） |
| Harness 优化决策链 | `docs/decisions/ADR-038-harness-optimization-v5.md` |
| Codex 分流边界 | `docs/decisions/ADR-041-codex-integration.md` |
| Guard signal 与 governance reload | `docs/decisions/ADR-030-guard-signal-and-governance-reload.md` |

## 禁止行为

- 禁止凭记忆声称"某个 hook 存在"——先 `grep src/scripts/hooks/` 或读 `MANIFEST.yaml`
- 禁止在多个文件维护同一份数字（例如 hook 总数）——引用 `MANIFEST.yaml` 单一源
- 禁止在 skill 或 rule 里硬编码 `.boll/` 路径——harness runtime dir 统一为 `.boll/`

## 参见

- `.boll/rules/closure-semantics.md` — Fixed 三层定义
- `.boll/rules/review-agent-isolation.md` — review agent schema-level 工具隔离