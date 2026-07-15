# Discover 排名算法 (反攻期 O2)

> Phase: 反攻期 (18+ 月)
> 状态: stub. 反攻期第一周实现.

## 目标

judgeness.bolloon.com /api/hearth/discover 返回的列表按某种"价值"排序.
**核心约束**: 算法必须**可解释, 不黑盒**. (乔布斯 skill "focus on user-visible value" 的延伸.)

## 算法草案 (v0)

`rank_score = a*recency + b*breadth + c*depth + d*trust`

| 因子 | 含义 | 来源 |
|:-----|:-----|:-----|
| recency | 最近 30 天发 description 数 | `description.createdAt` |
| breadth | 涉及 topic 数 (`scope.topics`) | description aggregate |
| depth | 5 维中实际填了的维度数 | description.facets 非空数 |
| trust | 该 peer 是否在 allowlist 内 | allowlist.yaml |

权重 (a, b, c, d) 默认 (0.4, 0.2, 0.2, 0.2). **权重也是可解释的** (用户在 visibility.yaml 里可调).

## 可解释性实现

每个 ranked 项带上 `why: { recency: N, breadth: N, depth: N, trust: N }` 字段, UI 显示时把每项的 4 项得分也展示出来.

## 黑名单 (不做)

- 不做 PR / 关注数 / 转化率 / 私域流量维度 (这些都是黑盒因子)
- 不做"内容农场"检测 (留个 hook, 但本期不实现)

## 实现位置

`src/judgeness/rank.ts` (待新建)
被 `routes-hearth.ts` 的 GET /api/hearth/discover 调用.

## Phase 2 (反攻后期)

考虑接入 LLM-as-judge 给每个 description 打一个 "judgeability" 标签; 但需 fallback 启发式 (LLM 限流真实存在, 见 bolloon-cli-e2e-2026-26.md memory).
