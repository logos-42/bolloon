---
name: hermes-borrow
description: 外部 agent 架构借鉴落地方法论 — 读源码定位核心机制 → 提炼可借鉴点 → 差距表 → 一次一 commit → 测试 → wiki 回写。Use when 用户要研究外部框架 (Hermes/Claude Code 等) 并借鉴落地。
---

# 外部 Agent 架构借鉴落地

## 触发条件
- 用户说 "看看 X 的架构/文件夹, 学一下, 借鉴一下"
- 需要把外部框架的设计搬到 bolloon

## 流程

1. **定位** — 先找目录/文件, `grep -rn "关键词" --include="*.py"` 精确定位核心函数, 读 docstring 而非全读
2. **提炼** — 每个主题写清: 机制名 + 源码位置 (file:line) + 核心设计 (1-2 句) + Bolloon 差距
3. **差距表** — 做成表格: Hermes 机制 | Bolloon 现状 | 差距
4. **落地 (一次一 commit)** — 每项一个 commit: 代码 → 纯函数抽离可单测 → 测试 → tsc → commit → push
5. **研究型 task** — 没有合适落地点的 (如 LSP 对无 IDE 场景) → wiki 深读记录即可, 不强上代码
6. **wiki 回写** — 架构页 + log.md 表格行 + 关联

## 陷阱
- 外部机制常有隐藏前提 (如 hermes claim TTL 续期依赖 PID 存活检查 — bolloon 单进程无 PID 概念 → 简化)
- blocking 机制要评估: bolloon 单次同步执行无法返工 → 用 advisory
- lefthook 并行跑 tsc+vitest 会饿死 worker → 串行化 (已修)

## 验证
- 每个 commit 前: `npx tsc --noEmit` + 新增测试全过
- 全量: `npm run test` (vitest) + `npm run build`
- 发布前: wiki 落地状态表更新 + 版本 bump + npm publish

## 已沉淀 (2026-08-11)
- Hermes: 委派句柄 HMAC / 两段式取消 / 自生命周期护栏 / canonicalize+续跑提示 / workspace kind+CAS / review 通道 / 父依赖 / TTL+心跳 / 熔断 / 防幻觉 / 全限幅 / 循环检测+完成契约 / i18n / optional-mcps / optional-skills
- 详见 docs/wiki/hermes-agent-architecture.md
