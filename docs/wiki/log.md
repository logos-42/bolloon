# Wiki 日志

> 精简台账：每批一行，只记「改了什么 + 关键验证」。早期长篇流水（2026-07 ~ 2026-10）已删减，不再保留归档文件。
> 当前版本、架构、已知边界与下一步见 [`current-status.md`](./current-status.md)；实现细节看对应提交。

| 日期 | 主题 | 摘要 |
|---|---|---|
| 2026-11-01 | world / memory | 世界意图交付面（回应=卡片+澄清）、Install 路径真执行、升级管线 v2、hindsight-engine 记忆外挂接入；npm 0.7.5 发布 |
| 2026-11-04 | app / web | 版本号不再写死、旧会话上下文、一次性授权库、空产出与阶段折叠、签名身份、中断留痕、流光卡片；信念改存 SQLite；App 0.7.6→0.7.7（空白页事故修复+换钥+发布门）→0.7.8 |
| 2026-11-04 | world / friend | 世界卡片「⋯」、IPFS/IPNS 链接、固定/持续更新/接受/拒绝/分享；付费 x402 卡片；邀请好友智能体进群、只读指挥、授权三档、SQL 只读工具、CLI 三端同步 |
| 2026-11-05 | fix | 流光消失、删除群残留、agent 自设信念与目标的真跑通、Windows 顶栏/弹窗 |
| 2026-11-06 | routing | 特化生态阶段 0-4：真实调用账本、任务×成本矩阵、影子→真路由（带回退）、本地/Ollama Cloud 接口、特化包评测/外溢/回执、工具循环真切换与白名单 harness |
| 2026-11-06 | belief / test | `live_beliefs` 挂测根因（render 把「现在该做的」放末尾被预算截断）→ 移头部；改确定性临时库，修环境变量 flaky |
| 2026-11-06 | x402 / ollama | 订单与外溢验收链路补完；Bearer 支持、激活同步、免费额度成本 0；`gpt-oss:20b` 真跑通过（`deepseek-v4.1-flash` 不在免费额度，402） |
| 2026-11-06 | secret | App 配置 Ollama 401 根因 = 凭据库写入失败仍清空内存 key；改为只清成功条目，并加 AES-256-GCM 加密文件兜底 + 链式后端，前端零明文、重启免重填 |
| 2026-11-06 | world 媒体 | 音乐卡片（唱片/歌词跟随/全屏半屏）、视频卡片（封面/YouTube 式全屏半屏）、gap 资产卡片、AI 工具 `world_card_publish`；卡片排列规范化；接受/拒绝写状态并反馈推荐引擎与自动化工作流 |
| 2026-11-06 | interaction | 每次点击 → 记忆/判断力/工作流记录/信念四件套；点击上下文按「未对话全量 / 对话中洞察过滤」注入；群中断广播全停（在途模型调用 120ms 可取消） |
| 2026-11-06 | contribution | 贡献记录 + 声誉分（不可转账/兑换、零分求助也分发）+ 求助双通道；跨机可验证用 DID 自带公钥签名验签（`bolloon-contribution/v1`），篡改与换签名者均判红 |
| 2026-11-06 | permission / shell | 完全访问成为总闸：今天所有写类/授权类能力一处登记，关→403、只读照常；Web/App/CLI（`bolloon permission`）三端同步；Shell 速查表（还原粘贴时丢失的美元符、管道符与反引号）播种进内置技能 `shell-direct` 并进每轮能力块；清 3 条编译警告，workspace 0 error / 0 warning |
| 2026-11-06 | credit | 贡献积分进左下角余额：**为别人提供服务才有大分**（`service_paid`/`service_delivered` +5，只能由验链成功等真实交付回执自动记，端点拒绝自报）；日常共享 skill +0.5、贡献/分享卡片 +0.3，按证据去重防刷；`earned` 只增不减（做坏事才有 penalty，无自动判定），唯一消耗是购买增值服务（导出签名证明 2 / 求助加权 3 / 卡片优先分发 5，均真兑现）；余额弹窗与左下角「额度」入口显示 `🎖 N`，Web/App 同源、CLI 可查。验证 92/0、自报拒/重复不加/消费后 earned 不减。 | `rust/crates/bolloon-web/src/{contribution.rs,native.rs,specialize.rs,server.rs,assets/index.html}` |
| 2026-11-07 | fix(credit) | 积分在左下角不显示：根因 `.account` 是 flex，`who` 里 DID 太长把 `payBtn` 挤出裁剪区；改为**独立徽标** `#sideCredit`（`🎖 2.3`，`flex:none`，`who` 加 ellipsis），点徽标也能开余额弹窗；同时把消耗调低（导出证明 1 / 求助加权 1 / 卡片优先 2）。Chrome 桌面与 App 模式均验证 `visible=true`、在账户区内、0 JS 错误。 | `rust/crates/bolloon-web/{assets/index.html,src/contribution.rs}` |
| 2026-11-08 | feat(kernel/ui) | **双核分工 + 三模式统一调度层 + 一批 UI/机制** — ① `kernel_bus.rs`: A=机制核(意图/按钮/开关/模式/路由选择), B=执行核(步骤/工具结果/错误/维护), 互读 HA 心跳检查 alive 与半拍相位, 三模式事件统一进 `kernel-events.jsonl` (`/api/kernel/state|tick|record`); **Kernel 管机制, Harness 仍管实现细节**。② 流光面板「阶段 1/2」→ **执行步骤/工具名**, 默认展开、显示 20 条; 工具 `GateOutcome.result.output` 直接回灌上下文插槽 (shell 结果不再只停工具面板)。③ 卡片补 👍点赞/❤️喜欢/💬评论/↗分享 (`/api/world/cards/react` 真落 reactions), 文档类卡片点「阅读」开**全屏居中可滚动**阅读层; 群消息补复制/重试/分享; 好友改名两次输入框→**一个面板**(昵称/备注/允许智能体访问/黑名单, 开关落 `friend-access.json`); 所有开关点击走 `switch` 事件→意图 + Kernel 按钮记录。④ `feature_pack.rs`: 每会话/智能体模型绑定 (`/api/models/bind|bindings`)、幂等响应缓存 (参考 TS `idempotency cache hit`, TTL 10min, `/api/cache/stats`)、**路由使用费**按次数而非 token/积分 (100 万次 0.001 元, `/api/pay/route-fee`, `router.record` 计数)。⑤ 侧栏新增 SVG「模型池」按钮, 列模型/绑定/分享。验证: workspace 0 error/0 warning · web 96/0 · Kernel 双核 role/相位/互检 ✓ · react/bind/cache/fee 端点真跑 ✓ · Chrome 按钮/面板/阅读层 ✓。**诚实边界**: 缓存层与路由费已就绪但**尚未接到 LLM 调用链**(命中数仍 0); 会话/智能体模型绑定已存但模型选择尚未按绑定生效; HA 跨进程心跳未起时以进程内双核状态代替; `service_delivered` 类跨机社交通信未接。 | `rust/crates/bolloon-web/src/{kernel_bus.rs(新),feature_pack.rs(新),server.rs,native.rs,router.rs,world_interact.rs,lib.rs,assets/index.html}` |
| 2026-11-08 | feat(kernel2) | **上一批未完项全部收口** — ① Kernel 事件进每轮 system prompt (`kernel_bus::prompt_block`, 三模式分组), VFS `/api/kernel/vfs` 把信念/skills/判断力/记忆/上下文/工具/做梦/事件映射成只读「文件 + 事件管道」(Linux 机制面, Harness 仍管实现)。② 缓存接进 `WebStrategy::raw_call` **流式与非流式两条分支**(命中把 Delta 推回前端), 单测往返真命中 (`hits=1`)。③ 会话/智能体模型绑定在 `one_call` 真生效 (shadow 全局 provider/model), 调用错误落 `route-errors.jsonl`。④ 群重试改为 `/api/room/retry` 真调 `group_say` 重发 (真跑 ok=true, 有 deliberation/speaker)。⑤ 自训小模型 `/api/models/custom` 校验真实路径登记、`/api/models/share` 按去中心化协议发卡片, 模型池 SVG 面板合并自定义模型并支持分享/绑定。⑥ 额度整体改路由使用费: `/api/pay/summary` 带 `route_fee`、`low_balance.hit` 恒 false 不再提示充值, 弹窗显示「已调度 N 次 · 100 万次 0.001 元」。验证: workspace 0/0 · web 97/0 (feature_pack 3/0) · Chrome 全元素 ✓ 0 JS 错误 · 群重试/VFS/自训模型/分享/额度/缓存端点真跑 ✓。**边界**: 旧 token 扣费函数仍在代码里但不再作为付费依据; 跨机模型分享依赖对端实现 model 卡片; 双核 HA 跨进程心跳未起时以进程内状态代替。 | `rust/crates/bolloon-web/src/{kernel_bus.rs,feature_pack.rs,native.rs,pay.rs,server.rs,assets/index.html}` |
