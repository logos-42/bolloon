---
paths:
  - "scenes/epic-hackathon/**"
  - "backend/product/hackathon/**"
  - "backend/product/routes/hackathon*.py"
---

# Hackathon 开发规则

- 双字段模式：`_xxx_to_dict` 必须同时返回 `id` 和 `xxx_id`
- ADR-037 场景适配器：协议概念不得泄露到场景 API，用 SceneAdapter 做翻译+编排+角色路由
- 状态机：`backend/product/hackathon/state_machine.py` 是事件状态转换的单一真相源
