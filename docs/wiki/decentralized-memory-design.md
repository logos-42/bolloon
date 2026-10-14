---
title: 去中心化向量记忆设计方案
source: compiled from leo 需求 (2026-10-14: 需要向量记忆和去中心化记忆) + 现有 memory/vector/orbitdb 栈实查
created: 2026-10-14
last_confirmed: 2026-10-14
schema_version: 2
audience: self
stage: draft
status: draft
confidence: medium
entity_type: chapter
tags: [memory, vector, embedding, orbitdb, decentralized, design]
---

# 去中心化向量记忆设计方案

## 0. 一句话

**把「本地向量检索 + OrbitDB 内容寻址复制 + 分层记忆」拼成一条完整记忆链: 写入自动向量化 → 本地语义召回 → 快照 CID 化 → 跨设备自动同步; 手机号/身份只做记忆的归属锚, 不进记忆内容。**

## 1. 现状 (实查, 2026-10-14)

| 层 | 现状 | 文件 |
|---|---|---|
| 摘要 | LLM 生成会话摘要, 落 `~/.bolloon/memory/<agentId>/sessions/*.summary.md` | `src/bootstrap/memory-compressor.ts` |
| 召回 | BM25 关键词打分, 每轮注入 system prompt (上限 3 条/800 字) | `src/agents/memory-recall.ts` |
| 检索 | **TF-IDF 倒排索引** (非真 embedding), `~/.bolloon/index/<name>.json`, 文档 <4KB/10000 份时 <50ms | `src/bootstrap/vector-index.ts` |
| 去中心化 | CID 快照进 OrbitDB (内容寻址), `sharedMemory` type='memory' 跨 agent | `src/orbitdb/context-store.ts` |
| 同步 | OrbitDB pubsub 自动 (peer 订阅即发 heads); 手机端本地副本双向 merge | `src/orbitdb/cid-database.ts` / `mobile-orbit.ts` |
| 分层目录 | context-os 08-Insights / 04-Projects 等 (本地文件) | `~/.bolloon/context-os/` |

**缺口:**
1. **无真 embedding** —— `vector-index.ts` 是 TF-IDF (词面匹配), 同义词/语义相关召回率低; 无 embedding API 接入
2. **召回是本地 BM25** —— 记忆不进向量索引, 语义召回不存在
3. **去中心化记忆只有快照** —— 没有「记忆条目级」的跨设备复制 (只有整快照), 没有记忆的版本链/冲突合并语义
4. **价值分层缺失** —— 现有记忆平铺, 无重要性/衰减/固化 (crystallize) 机制
5. **手机端只同步快照** —— 记忆本身不能离线语义检索

## 2. 设计 (按架构四原则分层)

### 2.1 全貌

```
写入: 会话结束 → memory-compressor 摘要 → 向量化 (embedding) → 双写:
        ① 本地向量库 (V)   [立即语义可查]
        ② OrbitDB CID 快照 [跨设备持久]
召回: 用户输入 → 向量化 → 本地向量 topK → (<embedding 模型> 无则 TF-IDF fallback)
      → 拼 memory-context 注入 systemPrompt → 同时可触发 CID 拉取远程补充
同步: OrbitDB pubsub 自动复制 (已有) + 手机端 replica merge (已有) + 记忆条目级增量
```

### 2.2 分层归属 (五问过一遍)

| 能力 | 归属层 | 理由 |
|---|---|---|
| 记忆条目模型 / 价值打分 (importance/recency/frequency) | **domain module** (`src/agents/memory/`) | 业务判断: 什么值得记、记多久 |
| 向量化调用 (embedding API) | **Adapter/Port** (`src/llm/embedding-adapter.ts`) | 供应商可换 (本地/云), 走端口注入 |
| 向量索引 / 检索 | **Tool Capability** (`src/bootstrap/vector-index.ts` 扩展) | 机制, 不碰 Pi 主体 |
| 记忆持久化 / 去中心化复制 | **OrbitDB CIDDatabase** (已有) + 记忆专用 store | 存储机制 |
| 记忆写入/召回工具 (`memory_save`/`memory_recall`) | **agent 工具注册** (pi-sdk-tools 模式) | 暴露给 LLM |
| 记忆门禁 (哪些进 Run/Evidence) | **Harness Gate** (复用) | 隐私/合规 |

**不新增的全局状态** (原则 4): 不搞全局 `currentMemory` map / session singleton; 记忆条目始终挂在 `agentId` 键下, 走现有 agent 分区。

### 2.3 向量化 (核心新增)

**Embedding Adapter (端口注入):**
```
interface EmbeddingAdapter {
  embed(text: string): Promise<number[]>;      // 单条
  embedBatch(texts: string[]): Promise<number[][]>;
  dim: number;                                   // 维度 (校验一致性)
  provider: 'local' | 'openai' | 'glm' | 'none';
}
```
- **默认 none → TF-IDF fallback** (现有 vector-index 不动, 作为降级路径)
- 接入点: `glm-5.3-flash` 的供应商若提供 `/embeddings` 端点则配一个; 否则先本地 `@xenova/transformers` (轻量, 本地跑, 不上云) — **需评估依赖体积** (npm 包爆炸是现有代码明确避免的)
- **唯一真源**: embedding 维度/供应商由 setup 配置 (`llm-config.json` 扩展), 不硬编码

### 2.4 向量存储 (不引重型库)

扩展 `vector-index.ts` 语义:
```
MemoryVectorIndex:
  - 条目: { id, agentId, text, vector?, metadata(importance/createdAt/source/type), summaryKey }
  - 存储: ~/.bolloon/memory/<agentId>/vectors/ (JSONL, 追加写)
  - 检索: 有 vector → cosine topK; 无 → TF-IDF cosine (现有)
  - 分桶: 按 agentId 分文件, 不跨 agent 读
```
- **不引 faiss/hnswlib** (符合仓库减法哲学: 文档量 <10000 时暴力 cosine 足够快, <50ms)
- 增量: 新记忆 append, 不重建全量

### 2.5 记忆条目模型 (价值分层)

```
interface MemoryEntry {
  id: string;                  // sha256(agentId + content)
  agentId: string;
  content: string;             // 摘要后文本 (多轮压缩)
  kind: 'fact'|'insight'|'preference'|'event'|'relationship'|'skill-feedback';
  importance: 0-1;             // LLM 打分 + 3 启发式 (被引用次数/用户明确标记/近期活跃)
  createdAt: string; updatedAt: string;
  source: string;              // sessionId / tool / manual
  vec?: number[];
  decayAt?: string;            // 低频 → 降权 (可选淡化, 不删)
  crystallized?: boolean;      // 固化: 多次命中/用户确认 → 进 08-Insights
  refs: string[];              // 关联 (goalId/runId 证据链)
}
```

**生命周期:**
```
写入 → importance 打分 → 向量化 → 本地存 + OrbitDB CID
  → 命中 (被召回) 次数++ → importance 动态升
  → 长期未命中 → decay 降权 (不删, 可手动/自动固化)
  → crystallized → 写 context-os 08-Insights + 全局索引
```

### 2.6 去中心化 (记忆条目级复制)

**在现有 CID 快照之上加「条目级同步」:**
```
MemoryEntry CID store (type='memory'):
  - key: memory:<agentId>:<entryId>
  - value: MemoryEntry (JSON 清洗后, dag-cbor 可编码)
  - 复制: OrbitDB pubsub 自动 (已有机制)
  - 手机端: replica merge 规则扩展 (现有 LWW, 加 importance 权重)
```

**同步选举 (跨设备):**
```
同 entryId 冲突 → updatedAt 大者胜 (现有 LWW) → 平手比内容 hash
  → 手机端与桌面一致性 = 确定性收敛 (现有 mobile-orbit merge 规则复用)
```

### 2.7 工具面 (暴露给 LLM)

| 工具 | 参数 | 返回 |
|---|---|---|
| `memory_save` | content, kind, importance? | entryId + CID |
| `memory_recall` | query, limit? | topK 条目 (含 CID, 可溯源) |
| `memory_search_vector` | query, topK? | 向量相似 topK |
| `memory_forget` | entryId | 删除/淡化 |
| `memory_crystallize` | entryId | 固化 → 08-Insights |

**不给 LLM 的**: embedding 原始向量 / 完整记忆库遍历 (隐私)。

### 2.8 记忆门禁 (Harness, 隐私红线)

- 记忆内容**不进** Run/Goal evidence (与联系人明文同待遇: 外部只见「有记忆/无」)
- 手机号/DID 只作 `agentId` 锚, 记忆正文不存个人身份字段
- `memory_forget` 请求进 consent 链 (删除是高危操作)
- 导出/分享记忆 = 显式 `memory_share` + 脱敏 (复用 contacts 脱敏模式)

## 3. 阶段 (小步落地, 每阶段可独立验收)

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | MemoryEntry 模型 + memory_save/recall 工具 (本地文件, 无向量) | 存→取闭环 + 工具注册 |
| P1 | 真 embedding adapter (先 GLM/云, 后本地) + vector 检索 | 语义召回 (同义词可中) + TF-IDF fallback 保留 |
| P2 | 价值分层 (importance/decay/crystallize) + 工具面 | 低频降权 + 固化进 Insights |
| P3 | 条目级 OrbitDB CID 同步 + 手机端 merge 扩展 | 双节点同步 + 冲突收敛 |
| P4 | 记忆门禁 + 隐私线 + 导出脱敏 | 明文零进 Evidence + forget 走 consent |

**每阶段独立可跑**: P0 现在就能做 (无新依赖); P1 需定 embedding 供应商; P3 需真双节点验证 (wiki 已记「跨机复制未全量验证」, 必须补)。

## 4. 明确不做 (Contrast)

- ❌ 不引 faiss/hnswlib/重型向量库 (文档量级够小)
- ❌ 不做全局人类记忆目录 (那属于手机号方案, 分开)
- ❌ 不把原始对话全文向量化 (只向量化摘要, 控体积)
- ❌ 不做记忆的「云端托管」(P2P/本地优先, 与项目去中心化方向一致)
- ❌ 不给模型 embedding 原始向量 (隐私)

## 5. 风险与诚实边界

- **embedding 供应商选择**: GLM 若无私域 embedding 端点, 需本地模型 → 依赖体积评估 (transformers.js 约 MB 级); 评估不过则 TF-IDF 长期为默认, 方案不阻塞
- **真双节点复制必须实测** (wiki 已记「跨机读群未验证」, 这是 P3 前置)
- 向量化成本: 每会话摘要 1 次 embed 调用, 用户本地免费; 云供应商则 1 次/会话 极小费用
- 记忆是增强层: 召回失败/向量不可用 → 静默降级 TF-IDF → 纯 BM25 → 无记忆 (现有行为), 三层阶梯