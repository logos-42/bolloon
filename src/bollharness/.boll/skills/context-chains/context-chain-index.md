# Context Chain Index

每日摘要索引，按日期组织。

## 结构

```
.boll/state/context-chains/
└── {YYYY-MM}/
    ├── index.yaml          # 当月所有摘要索引
    └── {session-id}.yaml   # 单个会话摘要
```

## index.yaml Schema

```yaml
month: "2026-05"
summaries:
  - session_id: "20260523-001"
    work_type: code_change
    created_at: "2026-05-23T10:00:00+08:00"
    gate_at_session: 7
    related_adr: ["ADR-042"]
    relevance_tags: ["src/agents", "multi-agent", "coordination"]
    token_size: 320

  - session_id: "20260523-002"
    work_type: review
    created_at: "2026-05-23T14:00:00+08:00"
    gate_at_session: 2
    verdict: BLOCK
    blocking_count: 2
    relevance_tags: ["src/constraints", "api-contract"]
    token_size: 280
```

## 查找协议

1. **按 work_type 过滤**: `grep -l "work_type: $TYPE" .boll/state/context-chains/.../*.yaml`
2. **按 relevance_tags 匹配**: 模糊匹配
3. **按日期范围**: `find .boll/state/context-chains/2026-05 -name "*.yaml"`
4. **按 gate**: 审查门（2/4/6/8）的摘要优先级更高

## 清理规则

- 超过 90 天的摘要移到 `.boll/state/context-chains/archive/{YYYY-MM}/`
- 只保留每类 work_type 最近 50 条
- BLOCK verdict 的 review 摘要保留 180 天（重复问题模式识别需要）
