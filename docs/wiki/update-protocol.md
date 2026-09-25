---
title: 更新协议 (版本身份 → 更新检查 → 更新计划 → 安全替换 → 健康验证 → 回滚)
source: session (leo 2026-09-19 计划 + 现状盘点)
created: 2026-09-19
last_confirmed: 2026-09-25
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [update, version, install-identity, update-manager, update-state, update-lock, doctor, health-check, publish-gate, npm-channel, github-release, dual-source, dev-channel, release, phase-0, acceptance-matrix, cli, bare-word-commands]
---

# 更新协议 (Phase 0-8)

> 一句话: **让用户永远知道自己运行的是什么, 更新是否真的成功, 失败后能否安全回到旧版本。**
>
> 本文是这次收敛的**口径文档**: 唯一事实 / 枚举 / 命令面 / 流水线 / 硬约束 / 完成度台账。
> 代码在 `src/utils/{version-info,update-state,update-manager,update-health,update-cli}.ts`
> + `src/cli/update-commands.ts`, 脚本在 `scripts/{version_check.py,install.sh,upgrade.sh,postinstall.js,verify-release.mjs,verify-update-system.ts}`。

---

## 0. 为什么做这次收敛 (2026-09-19 之前的真实现状)

| 问题 | 事实 |
| --- | --- |
| 版本有 **4 个来源** | `src/cli-entry.ts` 读 package.json · `bin/bolloon.cjs` 硬编码 `v0.1.1` · `scripts/version_check.py` 注释写死 `0.3.7` · `scripts/postinstall.js` 写死 `0.1.12` |
| 检查逻辑 **4 套** | `scripts/version_check.py` / `src/utils/auto-update.ts` / `cli-entry` 的 `update` 子命令 / `index.ts` 的 `--update-check` |
| 发行渠道有两个说法 | CLI/auto-update 以 **npm** 为准, `scripts/install.sh` 却**先查 GitHub Releases**、失败才回退 npm |
| 失败被说成成功 | 网络失败时 `checkBolloonUpdates()` 返回 null → 上层打印 **"✅ 已是最新版本"** |
| 默认自动替换运行时 | `autoUpdate: true` + `autoRestart: true` —— 检测到新版就 `npm install -g` 并重启, 可能打断正在跑的 Goal |
| 半更新无痕迹 | `npm install -g` 退出码 0 就报成功; 装完不验证新入口能否启动; 无锁、无回滚、无历史 |

结论: **不再堆自动更新功能, 先把更新收敛成一个可信的产品能力。**

---

## 1. 唯一事实 (Phase 0/1)

### 1.1 版本身份只有一个来源

`src/utils/version-info.ts` 的 `collectVersionInfo()` → `VersionInfo{ schema:'bolloon-version/1', ... }`。

三种输出 (普通 / `--verbose` / `json`) **读同一份 VersionInfo**, 只是渲染不同 —— 见 `renderVersionText()` / `renderVersionJson()`。
`cli-entry` 的启动横幅、`bin/bolloon.cjs`、`version_check.py`、安装脚本全部走这一份。

字段: 包名/包版本/构建时间(入口 mtime)/git commit+branch+dirty(+来源)/Node/npm/Python/平台架构/安装方式/安装目录/运行入口/bin shim/配置目录/更新通道/上架地址/registry/更新来源/是否可自动更新/分类依据/更新摘要。

### 1.2 安装方式固定枚举 (`InstallMethod`)

```text
npm-global | npm-local | source-git | release-binary | development | unknown
```

判定顺序 (`detectInstallation`) —— **先具体后兜底**:

1. npm 全局目录是**软链**且链到 git 检出, 且包根就是那个软链目标 → `development` (npm link)
2. 包根在 `<npm root -g>` 里且**不是** git 检出 → `npm-global`
3. 包根在全局目录里**但本身是 git 检出** → `source-git` (就地发布)
4. 包根在任意 `node_modules/@bolloon/bolloon-agent` (非全局) → `npm-local`
5. 包根是 git 检出 → `source-git`
6. 包根有 `RELEASE.json` → `release-binary`
7. 其余 → `unknown`

> **本机就是第 1 种**: `~/.npm-global/lib/node_modules/@bolloon/bolloon-agent → ~/Downloads/bolloon`
> → 报 `development`, `autoUpdatable: false`, 更新方式写明 "git pull + npm run build:all"。
> 这正是"开发目录不能被误判成全局安装"的落点。

### 1.3 更新来源固定枚举 (`UpdateSource`)

```text
npm | github-release | git | unknown
```

### 1.4 渠道决定

**npm 是稳定发行渠道 (stable 的权威); GitHub 作为源码 + 发布记录, 并作 stable 的交叉校验源与 dev 通道的唯一源。**

> **2026-09-25 修订 (原句是 "npm 是唯一稳定发行渠道")**: 改的是"唯一"两个字, **权威顺序没变** ——
> 完整口径、实数语义与真跑验收见 §12 (已落地)。

- `NPM_REGISTRY_BASE` (可被 `BOLLOON_NPM_REGISTRY` 覆盖 → 镜像/内网)
- `dist-tags.latest` 是 stable 通道; `beta` 暂与 stable 同源 (**明说, 不假装有独立 beta 通道**)
- 安装脚本不再查 GitHub Releases 下载资产 (旧行为会去下载"有 tag 但 npm 未公开"的资产)
- GitHub 那一侧: `BOLLOON_GITHUB_API` 可覆盖 (受控假源/企业实例); 可选 `GITHUB_TOKEN` **只为提配额**, 只进请求头, 永不打印/入库

---

## 2. 命令面 (Phase 1/4/7)

> **2026-09-19 leo 指令: 子命令一律裸词, 不带 `--` 前缀; 只有 `--version` 保留 `--`。**
> 旧的 `--plan/--now/...` 写法**仍然被接受** (已有脚本不断裂), 但文档与帮助只展示裸词。

```text
bolloon --version [verbose|json]     版本身份 (普通 / 诊断 / 机器可读)
bolloon update                       只检查并给结论 (不安装任何东西)
bolloon update plan                  更新计划 (要更新什么 / 不会动什么 / 风险检查 / 策略)
bolloon update status                状态 (当前/最新/通道/安装/最近检查/最近更新/失败/需重启/开关/锁)
bolloon update history [N]           最近 N 次 (时间 · 版本变化 · 结果 · 耗时 · 原因)
bolloon update now                   真正执行更新 (默认先打印计划)
bolloon update now wait              等当前 Run 结束后再更新 (有长期任务时的默认建议)
bolloon update now force             忽略"有长期任务在跑"的提醒
bolloon doctor [json|offline]        安装入口 + 版本事实 + 更新状态 是否自洽
```

**退出码 (稳定约定)**: `0` 正常 · `1` 执行失败 · `2` 检查不可用 (离线 / registry 不可用 / 读不到本地版本)。
—— `2` 的存在就是为了**把"没查到"和"没有更新"在脚本层面区分开**。

辅助脚本入口 (同样的逻辑, 不拉整个 CLI): `node dist/utils/update-cli.js {check|status|plan|history|version|doctor} [json] [force] [offline]`。

---

## 3. 检查的 7 个结论与优先级 (Phase 2)

```text
up_to_date | update_available | check_skipped | offline
registry_unavailable | local_version_unknown | unsupported_installation
```

优先级 (刻意定死, 防模糊行为):

1. 读不到本地版本 → `local_version_unknown` (**绝不默认 `0.0.0` 后继续更新**)
2. 安装方式 ∈ {development, unknown, release-binary} → `unsupported_installation` (仍带出 latest + 可回滚性)
3. 显式跳过 / 节流 → `check_skipped` (**结论来自缓存, 且用 `cachedStatus` 标明缓存里那条是什么**)
4. 网络不可达 → `offline` (**绝不显示"已是最新"**)
5. registry 5xx / 包不存在(404) / 无 dist-tags → `registry_unavailable`
6. `latest > current` → `update_available` (带 `targetPublished` / `rollbackSupported`)
7. 否则 → `up_to_date`

错误分类只有两类, 且**区分"网不通"与"服务有问题"**: `classifyRegistryError` (ENOTFOUND/EAI_AGAIN/ECONNREFUSED/超时 → `offline`; 其余 → `registry_unavailable`)。

每次检查都写 `~/.bolloon/update-state.json` (`lastCheckAt/lastCheckStatus/lastCheckReason/latestVersion`), 所以 `doctor` / `--version` 事后都能看到**上次是离线**而不是最新。

节流: 24h (config `checkIntervalHours`); **显式 `bolloon update` 忽略节流** (用户问了就得真查), 启动后台检查遵守节流。

---

## 4. 更新计划与风险检查 (Phase 4)

`bolloon update plan` 输出: 当前/目标版本 · 安装方式 · 通道 · **将更新** · **不会修改** · 需要重启 · 风险检查逐项 · 阻塞项 · 提醒项 · 三种策略。

**不会修改 (写进计划的承诺)**: `~/.bolloon/config.json` · `goals/` · `runs/` · `transactions/` · `skills/` · `sessions/` · `identity/`。

风险项分两类 (代码里也是两段函数, 安装类**不许被测试注入跳过**):

| 类别 | 项 | 阻塞? |
| --- | --- | --- |
| 安装类 | 安装方式支持自动更新 / 安装目录可写 / 磁盘空间 ≥300MiB / 没有其它更新进程 | **阻塞** |
| registry 类 | registry 可达 / 目标版本真实存在 / 当前版本可回滚 | registry 不可达 + 目标不存在 = **阻塞** |
| 负载类 | Supervisor 未运行 / 没有进行中的 Goal / 没有进行中的 Run / 没有支付中的交易 | 不阻塞, **但默认策略变成 `wait`** |

默认策略: 有负载提醒 → **等待当前 Run 结束**; 没有 → 立即更新。

---

## 5. 流水线 (Phase 5) 与**刻意做出的偏差**

```text
检查 + 计划 (阻塞项 → 直接 blocked)
→ 抢更新锁 (~/.bolloon/update.lock, O_EXCL + pid 存活检测)
→ 下载 tarball 到临时目录 (npm pack --pack-destination <tmp>)
→ 解压 + 校验包内容 (版本 == 目标 + 含 dist/cli-entry.js)
→ 切换 (npm install -g @bolloon/bolloon-agent@<目标>)
→ 验证 (磁盘版本 == 目标 + 真起一次新入口跑 --version json)
→ 健康检查 (分层 8 项)
→ 写成功记录 + 提示重启; 释放锁
```

失败时: 清理临时目录 → **保留旧版本** → 若检测到"半更新"(磁盘版本既不是旧也不是新) → `npm install -g <旧版本>` 回滚 → 写失败原因 (`lastFailure.stage` = **卡在哪一步**, 不是结果) → 释放锁 → 用户继续用旧版本。

### 刻意偏差 (逐条写明理由)

计划的原文是 "**安装到临时位置 → 原子切换**", 落地是 "**临时位置下载并校验 tarball → 交给 npm 完成替换 → 验证 + 失败回滚**"。

理由: 手工把整棵依赖树 (本包 949 个包) 复制/切换一遍, 比 npm 自己的替换**更危险**也更容易半更新; 而真正要保的性质是
**"不能删掉旧版本后才发现新版本起不来"** —— 这条由 **切换后验证 + 失败回滚** 保证, 两步都真跑 (`scripts/verify-update-system.ts` 里真 npm + 真 SIGKILL)。

### 更新锁语义

- 持有者活着 → 第二个进程 `blocked`, 写明持有者 pid/时间
- 持有者已死 **或** 锁超过 30 分钟 → **陈旧锁, 可回收** (下一次更新自动接管; `doctor` 也会回收并报告)
- 只释放自己的锁 (别人的锁不删)

### 状态 (`UpdateRunStatus`)

```text
planned | downloading | staged | switching | verifying | succeeded | failed | rolled_back | blocked
```

其中前 5 个是"进行中" —— **落盘时看到它 = 上次更新被中断**, `doctor` 会报"上次更新停在 <stage>, 异常中断"。

---

## 6. 更新后的健康检查 + doctor (Phase 6/7)

**安装成功 ≠ 更新成功。** 更新后真读一遍用户数据 (`runHealthCheck`), 分级 `healthy/degraded/failed`:

```text
版本读取 → CLI 启动(真起进程跑 --version json) → 配置读取 → SetupStore
→ RunStore → TransactionStore → SkillsManager.health → Supervisor 状态
```

举例 (与计划的例子一一对应): 新版本能启动但技能有漂移 → `degraded`; 旧交易记录读不出来 → `failed`; CLI 正常但 dist 与 package.json 版本不一致 → `degraded` + 提示 `npm run build:main`; **配置损坏 → `failed` 但绝不覆盖原文件**。

`bolloon doctor` 检查项:

| 项 | 判据 |
| --- | --- |
| 安装入口 | `binPath` 真实指向本安装目录的 `dist/cli-entry.js` |
| 版本一致性 | `package.json` 版本 == 运行时 `--version json` 报的版本 (防 dist 过期) |
| npm 全局路径 | 扫描 npm 可能的全局位置, 报出**多余的副本** (which bolloon 可能指向旧版本) |
| `~/.bolloon` 可写 | 不可写 → failed (会话/Run 都落不下去) |
| 更新锁 | 残留锁: 陈旧 → 回收并报; 活着 → 提示等它结束 |
| 上次更新 | 停在"进行中"状态 → 异常中断; 有 `lastFailure` → 报原因 |
| 待重启 | `needsRestart` 为真 → 新版本已就位但当前进程还跑旧代码 |
| 版本源可达 | npm registry 是否可达 (可 `offline` 跳过) |
| 分层健康检查 | 上面 8 项的总评 |

> 本机实测 (2026-09-19): `degraded` —— 唯一一项是 **SkillsManager 健康: 1258 个技能, 漂移 13, 不合格 234, 重复 36** (这是真实的技能库状态, 与更新系统无关, 如实报出而不是粉饰)。

---

## 7. 开关与**行为变更** (Phase 3)

```text
checkUpdates  (默认 true)   启动时后台检查
autoInstall   (默认 false)  **自动安装 —— 默认关**
autoRestart   (默认 false)  装完自动重启
updateChannel (默认 stable)
```

环境变量只作**本次进程的临时覆盖**, 不落盘: `BOLLOON_SKIP_UPDATE=1` · `BOLLOON_AUTO_UPDATE=1` · `BOLLOON_UPDATE_CHANNEL=stable|beta|dev`。

### 行为变更 (逐条, 不藏在 refactor 里)

| # | 旧行为 | 新行为 | 为什么必须变 |
| --- | --- | --- | --- |
| 1 | 检测到新版 → 自动 `npm install -g` | **只通知** + 给出 `update plan / now` | Bolloon 有长期运行 / Supervisor / 持久化任务 / 支付恢复, 自动替换运行时可能打断正在执行的 Goal |
| 2 | 装完自动重启 | 默认不重启 (需 `autoRestart: true`) | 同上; 且重启会丢掉当前会话上下文 |
| 3 | 网络失败 → "✅ 已是最新版本" | `offline` / `registry_unavailable` 明说**不等于最新** | 这是本次最危险的一条: 把"没查到"说成"最新"会让人以为升级完成了 |
| 4 | 旧字段 `autoUpdate: true` 表示"自动检查+自动安装" | `autoUpdate` **只映射到 `checkUpdates`**, **绝不**映射成 `autoInstall` | 一次升级不能把"自动替换运行时"当成用户意愿 |
| 5 | `bolloon update --now` 直接装 | `update` 默认只检查; `update now` 才装, 且先打印计划 | 先看计划再动手 |
| 6 | `checkForUpdate` 节流时把缓存结论当作"刚查出来的" | `check_skipped` + `cachedStatus` 标明这是缓存里的哪条结论 | 避免时间戳骗人 |

**旧语义怎么显式取回**: `autoInstall: true` (+ `autoRestart: true`) 或 `BOLLOON_AUTO_UPDATE=1`; 旧的 `--plan/--now/--json` 写法仍被接受。

---

## 8. 发布纪律 (Phase 8)

`node scripts/verify-release.mjs <版本> [--install-check]` —— 发布后硬门, **把"已发布"和"用户可安装"分开验证**:

1. `package.json` 版本 == 目标
2. Git tag `v<版本>` 与方法一致 (提醒级) + 工作区干净
3. registry 上**存在**该版本
4. `dist-tags.latest == 该版本` —— 否则: **"版本已上传但未公开为 latest (staged?), 用户 `npm i` 拿到的是旧版"**, 硬门失败
5. tarball HTTP 200 + shasum/integrity 存在
6. tarball 内 `package.json` 版本一致 + 含 `dist/cli-entry.js`
7. (`--install-check`) 真 `npm install -g --prefix <tmp>` → `bolloon --version json` 可解析且版本一致 → 普通版 `--version` 含安装方式/目录/通道/上游 → `update plan json` 结构正确

配套: `scripts/install.sh` 装完**自检** (`--version json` 报的版本 == 目标, 不等就报"发布/安装异常"并退出非 0); `scripts/upgrade.sh` 只是 `bolloon update now` 的包装 (不再直连 `npm install -g @latest`, 免得绕过计划/锁/校验/回滚)。

> **0.4.28 的实况**: 2026-09-18 记录为"publish 退出码 0 但 registry 未公开 (暂存)"; 2026-09-19 复核 **已公开** —— `dist-tags.latest = 0.4.28`, `time[0.4.28] = 2026-09-19T06:10:13Z`, `versions` 尾三 `[0.4.26, 0.4.27, 0.4.28]`。这条待办可以关闭。

---

## 9. 完成度台账 (Phase 0-8)

| 阶段 | 完成度 | 证据 / 缺口 |
| --- | --- | --- |
| Phase 0 冻结更新事实模型 | ✅ | `version-info.ts` (VersionInfo + 6 值安装枚举 + 4 值来源枚举) · `update-state.ts` (状态/历史/锁/开关) · 单测锁枚举与来源 |
| Phase 1 版本身份三层 | ✅ | `bolloon --version` / `verbose` / `json` 真跑 (本机 development 安装报法正确) · 3 处硬编码版本号已消除 (`cli-entry`/`bin/bolloon.cjs`/`postinstall`) |
| Phase 2 检查统一 | ✅ | `update-manager.checkForUpdate` 是唯一入口 (CLI / 启动后台 / `version_check.py` / `install.sh` / `update-cli` 都走它); 7 结论 + 优先级 + 错误分类有单测与真断网验收 |
| Phase 3 自动更新 → 只通知 | ✅ | 默认三开关; `autoUpdate` 只映射 checkUpdates; 6 条行为变更逐条写明 |
| Phase 4 更新前检查与计划 | ✅ | `update plan` 输出真跑; 10 项风险检查 (安装类 4 / registry 类 3 / 负载类 4, 其中负载 4 项的"不阻塞但改默认策略"有单测) |
| Phase 5 原子更新/失败恢复/回滚 | ⚠️ **按偏差落地** | 锁 + 临时校验 + 切换 + 验证 + 失败回滚全部真跑 (真 npm / 真 SIGKILL); **偏差**: 未手工实现"临时位置整树切换", 见 §5 |
| Phase 6 更新后健康检查 | ✅ | `runHealthCheck` 8 项真读 (真起子进程跑 `--version json`), 分级 healthy/degraded/failed; 本机 doctor 实测 degraded (技能漂移) |
| Phase 7 `--status/--history/doctor` | ✅ | 三个命令真跑; `doctor` 9 项含"npm 全局路径冲突""更新锁残留""上次更新异常中断""幽灵 Supervisor" |
| Phase 8 发布纪律 | ✅ | `verify-release.mjs` 7 项硬门 (真下载 tarball + 可选真隔离安装) · `install.sh` 安装后自检 · `upgrade.sh` 收敛到同一流水线 |
| Phase 9 双源 (npm + GitHub) | ✅ ①②③ / ⛔ ④⑤ | 见 §12: `dual-source.ts` 源事实 + `--channel stable\|dev` + `github_unavailable`/`cross_check_mismatch` + 真跑验收 **63 PASS/0 FAIL** + 变异验证 **6/6 判红**; **未做**: 发布硬门 ④ 与 npm 发新包 ⑤ |

交付批次对照: 第一批 (身份统一) ✅ · 第二批 (检查统一) ✅ · 第三批 (安全更新) ✅ (含偏差) · 第四批 (诊断与发布质量) ✅ + wiki 回写 ✅。

### 未做 / 刻意不做 (如实)

- **运行时 (Node/npm/Git/Python) 的检查/安装/配置/验证** 不在本页 —— 见 [runtime-bootstrap-protocol.md](./runtime-bootstrap-protocol.md)
  (更新流程已接它的健康检查: 更新后 Git/Python 真执行验证不过 → `failed`, 不因 npm 装成功就宣布环境健康)
- **多渠道 / 自动灰度 / 插件热更新 / 后台强制升级** —— 明确不做 (计划里就说不做); **例外**: "npm + GitHub 双源"已于 2026-09-25 落地 (见 §12, 只加源与交叉校验, 不做灰度)
- **`update now wait` 没有后台守护进程**: 它只**记录**"等当前 Run 结束后再执行", 不会在 Run 结束时自动替用户更新 (自动替用户动运行时正是这次要收敛掉的东西)
- **beta/dev 通道没有独立 dist-tag**: 只有 stable 是真通道, `beta` 落到 `beta` tag 但 npm 上没有该 tag → 走 `latest`; 不假装有独立通道
  (dev 通道的双源口径见 §12: dev 走 **GitHub master HEAD + commit sha**, 仍然**不靠 npm dist-tag 假装**有独立通道)
- **`release-binary` 安装方式只能识别, 不支持更新** (报 `unsupported_installation`) —— 目前没有发行二进制包, 不为此写实现
- **`update now` 不会自动重启进程** (即使用户开着 `autoRestart`) —— CLI 场景明确提示"请重启"; 只有 Electron / 常驻宿主在 `autoInstall+autoRestart` 都开时才真重启
- **`--version verbose` 的"构建时间"是入口文件 mtime**, 不是真正的构建戳 (没有构建戳; 字段名里已标注来源 `buildTimeSource: 'entry-mtime'`)

---

## 10. 验收与证据

| 验收 | 命令 | 结果 |
| --- | --- | --- |
| 单元 | `npx vitest run src/test/update-system.test.ts` | **53/53** |
| 单元 (双源) | `npx vitest run src/test/update-dual-source.test.ts` | **34/34** (2026-09-25 新增) |
| 真跑 (真 npm / 真 registry / 真 SIGKILL) | `npx tsx scripts/verify-update-system.ts` | 见下 |
| 真跑 (双源: 真 registry + 真 GitHub + 真 codeload + 真构建) | `npx tsx scripts/verify-dual-source.ts` | **63 PASS / 0 FAIL / 0 SKIP** (见 §12.7) |
| 变异验证 (双源) | `python3 scripts/verify-dual-source-mutations.py` | **6/6 判红**, 恢复后全绿 (见 §12.7) |
| 类型 | `npx tsc --noEmit` | 0 错 |
| 构建 | `npm run build:main` | 通过 |
| 真命令 | `bolloon --version` / `update` / `update plan` / `update status` / `update history` / `doctor` | 见 §6 与 log |
| 全量回归 | `npx vitest run` | 见提交统计 |

`scripts/verify-update-system.ts` 覆盖 (隔离 HOME + 隔离 npm prefix, **不触碰本机全局安装与 `~/.bolloon`**):

- **A 真断网** (registry 指向不可达端口) → `offline`/`registry_unavailable`, `latestVersion` 为空
- **B 真无权限** (目录 `chmod 500`) → `writable=false` + `autoUpdatable=false`
- **C 真成功** (本地受控 registry + 真 npm + 临时 prefix) → `succeeded` + 磁盘版本真变 + **用户配置字节未变** + 锁释放 + `needsRestart`
- **D 真安装失败** (tarball 500) → `failed` + **旧版本仍在** + `lastFailure.stage` 落在 `downloading`/`staged` + 配置未变 + 锁释放
- **E 真 SIGKILL** (下载卡住时 kill -9) → 锁留在盘上且判定为陈旧 + 旧版本可用 + 状态留"进行中"痕迹 + **下一次更新自动接管陈旧锁并成功**
- **F 四个用户问题**都能被回答 (什么版本 / 从哪装的 / 有没有更新 / 失败后怎么办)

---

## 11. 明确不碰的边界

- 更新流程**只写** `~/.bolloon/update-state.json`、`update-history.jsonl`、`update.lock` (+ tmp 目录下的临时产物)
- `postinstall.js` 对已存在的 `config.json` **只补缺失字段** (原子写, 保留用户值), 绝不覆盖
- 更新实例的 `home` 参数约定 (本仓两套约定并存, 已在代码注释里分开): `~/.bolloon` 给 `setup-store`/update-state; **用户 home** 给 RunStore / TransactionStore / SkillsManager (它们内部再拼 `.bolloon/…`)

---

## 12. 双源 (stable: npm + GitHub Tag · dev: GitHub master HEAD) —— **已落地**

> 状态: **shipped (2026-09-25)**。
> §12.1–12.5 的**口径一行没改**, 本节现在是"落地后的实数语义 + 真跑验收结果"。
> 落地顺序: **⑤ 已完成** —— 2026-09-25 发布 `@bolloon/bolloon-agent@0.5.0` (含同名 tag `v0.5.0`), 见 §12.9;
> **④ 发布硬门仍未开** (第一个真实例已经造出来, 要不要开由主线定)。

### 12.0 落地前先查到的**事实** (决定 stable 那一侧必须怎么降级)

真查 (2026-09-25 · `scripts/verify-dual-source.ts` 第 0 段 · 真调 `api.github.com` + 真读本地 tag):

| 事实 | 实数 |
| --- | --- |
| git tag | **25 个**, 最高 **`v0.4.30`** |
| **GitHub Release** | **0 个 (空的)** |
| GitHub `refs/heads/master` HEAD | **`d2148f3`** |
| npm `dist-tags.latest` | **`0.4.33`** (没有对应 tag) |

**如实降级 (不编造一条不存在的 tag / Release 路径)**: 本仓**没有 Release**, 所以

- stable 的"GitHub 那一侧" **以 Tag 为准** (`v<版本>` 与 `<版本>` 两种写法都认);
- **没有**"Release 资产存在"这类硬门可设 —— §12.6 的 ④ **因此还没做**, 理由见 §12.6;
- 交叉校验在**本仓的真实数据**上给出的是 `missing_record` (npm latest `0.4.33` 在 GitHub 上没有同名 Tag),
  这是**提醒级、不阻塞**, 也正是"发布记录缺 Tag"这一行的真实长相 (§12.5 第 4 行)。

### 12.1 为什么 (§1.4 的修订) —— 口径不变

§1.4 原来冻结的是 "**npm 是唯一稳定发行渠道; GitHub 只作为源码与发布记录**"。现在改成**双源**, 但**权威顺序不变**:

| 通道 | 源 | 谁是权威 | 版本身份 | 比较语义 (代码里显式) |
| --- | --- | --- | --- | --- |
| `stable` | npm registry (`dist-tags.latest`) **+** GitHub Tag/Release | **npm 仍是权威**; GitHub 是**交叉校验源** | semver (`0.4.33`) | `semver` —— 只有"npm latest 与 GitHub 同名 tag/Release 指向同一版"才算对得上 |
| `dev` | GitHub `master` HEAD (git ref) | **GitHub 是唯一源** | **`<package.json 版本>+dev.<commit sha 前 7>`** | `git-ref` —— **不用 semver**, 只判"是否同一 commit / 是否落后" |

两套比较语义是**代码里的显式字段** (`ChannelKind = 'semver' | 'git-ref'`, `channelKindOf()`), 不是靠注释约定 ——
`update status` / `update plan` / `--version json` 都会把 `channelKind` 打出来。

为什么 stable 仍以 npm 为权威: `dist-tags.latest` 是用户 `npm i -g` 真拿到的东西 (§8 第 4 项硬门就在验它)。
GitHub 那条记录进来只做一件事: **证明"两条记录指向同一版"** —— 发布流程真的跑完了。

为什么 dev **必须用 `git ref + commit sha`**: master 上的 `package.json` 版本**长期不动** (同一个版本号可能对应几十个 commit)。
拿 semver 当 dev 的身份, "我装的是哪个 dev 版" 就没有答案。**真跑里的实证**: dev 装出来后 `0.4.33` 与 `0.4.33+dev.d2148f3`
的 semver 段**完全相同**, 但按 sha 判定必须报 `update_available` (有另一个 dev 版), 不能报"已是最新"。

### 12.2 命令面增量 (§2 的增项) —— 已接线

```text
bolloon update [--channel stable|dev]          检查 (默认 stable; 显式给了就忽略节流)
bolloon update plan|status|history|now [--channel stable|dev]
```

- `--channel` **只覆盖本次进程**, 不落盘 (config 里的 `updateChannel` 仍是默认值)。
- 只认 `stable | beta | dev`; **给别的值 → 拒绝执行并说清** (不静默落回 stable)。
- `--channel=dev` 与 `--channel dev` 两种写法都吃; 非 `--channel` 的调用方**行为一行没变**。
- **"通道"与"当前装的是哪个源"是两件事**: 通道 = 你想跟谁走; 装的是什么源 = 现在磁盘上跑的代码是谁给的。
  `update status` **分开报** —— 装的 dev、通道 stable (默认值) 是**正常状态**, 不是矛盾。

### 12.3 检查结论与错误分类 (补 `github_unavailable`) —— 已落地

§3 的 7 个结论**只增不改**, 现在是 **9 个**:

```text
github_unavailable      # GitHub 不可达 / 403·429 限流 / 404 / 读不到 master HEAD
cross_check_mismatch    # stable 下 npm 与 GitHub 的记录指向不同版本 (两个源的事实都摆出来)
```

优先级 (插进 §3 的序列, 位置本身就是口径):
`local_version_unknown` → `unsupported_installation` → `check_skipped` → `offline` → **`github_unavailable`** →
`registry_unavailable` → **`cross_check_mismatch`** → `update_available` → `up_to_date`。

错误分类: `classifyGithubError` 与 registry 侧**并列、不合并** (这是硬要求 —— "更新失败"一句话废掉了):

| 情形 | 分类 (reason) |
| --- | --- |
| `ENOTFOUND`/`EAI_AGAIN`/`ECONNREFUSED`/`ETIMEDOUT`/超时 | `github_unavailable(offline)` |
| HTTP 403 / 429 | `github_unavailable(rate_limited)` + **写明重试时间** (`x-ratelimit-reset`) |
| HTTP 404 (没有该项记录 / codeload 上没这个 commit) | `github_unavailable(not_found)` |
| 5xx / 其它 | `github_unavailable(http_error)` |
| 返回体解析不了 | `github_unavailable(parse_error)` |

**dev 通道下 `github_unavailable` = 直接拒** (没有第二个源可退)。
`REFUSED_STATUSES = ['offline','registry_unavailable','local_version_unknown','github_unavailable','cross_check_mismatch']`
—— 这 5 个结论在**执行面**会让 `applyUpdate` 直接 `blocked`, **一个 `npm` 都不调** (§12.5)。

### 12.4 dev 通道的三条硬约束 (leo 明确要求) —— 已落地, 落点如下

1. **显式警告**: 检查 / 计划 / 执行 / `status` / `doctor` 五处打印**同一句** (`DEV_CHANNEL_WARNING` 常量, 只此一份文案):
   `⚠️ dev 通道 = GitHub master HEAD 的即时快照 (未走发布门): 可能中断正在跑的 Goal/Run, 且不保证可回滚到上一个 dev 版。`
2. **记录 sha**: 装完写 `~/.bolloon/update-state.json`: `{ installedChannel: 'dev', installedDevSha: <sha7>, devSha, devRef: 'refs/heads/master', devCheckedAt }`
   —— 于是 `bolloon --version` / `update status` / `doctor` 都能回答"我现在跑的是哪个 dev 快照"。**没有新开存储** (沿用同一个状态文件)。
   `installedChannel`/`installedDevSha` 是"**当前**装的是谁" (切回 stable 后清空), `devSha`/`devRef` 是"**上次**用过的 dev 快照" (切回后保留)。
3. **一键回 stable**: `bolloon update now --channel stable` 真跑通了 —— 不需要手工 `npm uninstall`,
   换回 registry 的 latest、走 §6 的健康检查、并在 `update-history.jsonl` 留下 `0.4.33+dev.d2148f3 → 0.4.33`。

### 12.5 拒绝, 而不是静默退回旧版 (验收的核心) —— 已落地 + **逐条真跑**

| 场景 | 必须的行为 | 真跑结果 |
| --- | --- | --- |
| npm 不可达 (`registry_unavailable`) | 明说"registry 不可达", 退出码 **2**, 不打印"已是最新" | ✅ `offline`, 退出码 2, 输出无"已是最新", **磁盘版本没被动过** |
| GitHub 不可达 (dev 通道) | `github_unavailable` + 说清哪一类, 不回落 stable 装 npm 旧版 | ✅ `github_unavailable(offline)`: releases: ECONNREFUSED, 退出码 2, 明确"拒绝安装 (不回落到 stable)" |
| Release 存在但 registry 上没有该版本 | `cross_check_mismatch` + 摆出两个源 | ✅ 受控假源造 `v9.9.9` → `cross_check_mismatch`, 退出码 2, 输出无"已是最新" |
| registry 有该版本但 Release/Tag 缺 | 报**发布记录缺 Tag** (提醒级, 不阻塞) | ✅ 本仓真实数据就是这一行: `missing_record`, 计划不阻塞, stable 照常更新 |
| `--channel dev` 但 master 的版本号没变 | 照常按 **sha** 判"是另一个 dev 版" | ✅ 单测 + 真跑: 版本号段相同、sha 不同 → `update_available`, 理由写明"dev 快照落后" |
| 目标 commit 不存在 | 拒绝, 不许装身份不明的快照 | ✅ 真 codeload 404 → `github_unavailable(not_found)`, 什么都没装 |

> 一句话口径 (代码里的落点就是 `REFUSED_STATUSES`): **源不可达 / 版本不存在 → 拒绝并说清 (退出码 2), 不许静默装回旧版。**
> §1 的"唯一事实"在这里的落点: 每个源给了什么 (`sourceFacts`)、哪个源答的、交叉校验结果 (`crossCheck`)、
> 现在装的是谁 (`installedChannel`/`installedDevSha`)、能切回谁 (`switchableTo`) —— 全部落盘, `update status` 直接打出来。

### 12.6 落地顺序 (**双源先于发 npm 新包**) —— ①②③⑤ 已完成, ④ 仍未开

```text
① 双源的就位        ✅ src/utils/dual-source.ts (源事实: classifyGithubError / crossCheckStable /
                       compareDevSnapshots / prepareDevSnapshot) + version-info 的通道与身份 +
                       update-state 的 dev 字段与 9 个结论
② 检查/计划面接双源  ✅ --channel stable|dev / github_unavailable / cross_check_mismatch / REFUSED_STATUSES
③ 验收脚本真跑       ✅ scripts/verify-dual-source.ts 63 PASS / 0 FAIL (§12.7)
④ verify-release.mjs 加 "GitHub Tag 与 package.json 版本同名" 作为发布硬门   ⛔ 仍未开 (真实例已造出 → 由主线定)
⑤ 才允许 npm publish 新包                                                  ✅ 已完成 (2026-09-25: 0.5.0 + tag v0.5.0, 见 §12.9)
```

④ **为什么还没做 (如实)**: GitHub 上 **Release 为 0、Tag 最高 `v0.4.30`** 而 npm 已是 `0.4.33` ——
把这条件设成硬门, 当前状态**每一次发布都会被它拦住**, 而拦住的理由是"历史发布没打 tag", 不是"这次发布坏了"。
先发一个**打了同名 tag** 的版本 (④⑤ 一起做), 硬门才有意义。**在此之前不许假装双源都验过了。**

**2026-09-25 更新 (这个版本已经发出来了)**: `@bolloon/bolloon-agent@0.5.0` + tag `v0.5.0` 已发 (§12.9) ——
交叉校验在本仓真实数据上**从 `missing_record` 变成 `agree`**。也就是说 **④ 的条件现在具备了**,
但本步**刻意没开它** (开不开由主线定): 本步的活是把真实例造出来, 不是顺手打开一道会拦死后续发布的门。

### 12.7 验收 (真跑, 2026-09-25) —— 结果

真跑脚本: `npx tsx scripts/verify-dual-source.ts` (**真 npm registry + 真 api.github.com + 真 codeload 下载 + 真构建 + 真 npm 替换**;
隔离 HOME + 隔离 npm prefix, **不碰本机全局安装**)。**63 PASS / 0 FAIL / 0 SKIP**。

| 验收 (对齐原计划的 A–G) | 真跑证据 |
| --- | --- |
| **A** npm 真断网 + GitHub 可达 | `status=offline`, 退出码 2, 输出**不含**"已是最新"; `applyUpdate` 里 `npmCalled=0`, 磁盘版本未动 |
| **B** GitHub 真不可达 (dev 通道) | `github_unavailable(offline)` (真打一个没人监听的端口), 退出码 2, **不回落 stable** |
| **C** GitHub 限流 403 | 同一分类 `github_unavailable(rate_limited)` —— 首次匿名真跑时**真的被 api.github.com 限流打到 403** (60 次/小时), 分类与文案当场验证; 之后用 `GITHUB_TOKEN` (可选, 只进请求头, 永不打印/入库) 把配额提到 5000/h |
| **D** 不存在的 commit / tag | 真 codeload **404** → `github_unavailable(not_found)`, 不装任何东西 |
| **E** dev 真跑 | 真取 codeload master 快照 → 真 `npm run build` → 装出身份 `0.4.33+dev.d2148f3`; `update-state.json` 有 `devSha=d2148f3`/`devRef`; 真起装完的入口, 它**自报** `Bolloon Agent v0.4.33+dev.d2148f3` |
| **F** 一键回 stable | 真 CLI 子进程 `update now --channel stable` → 退出码 0, 磁盘真变回 `0.4.33`, 状态改回 `stable`, 历史留 `+dev.d2148f3 → 0.4.33`。**推送后复跑更强**: 这次 dev 快照来自带本特性的 master (`0.4.33+dev.17fb4ca`), **CLI 代码就是 GitHub 快照自带的, 没有任何覆盖**, 一键回 stable 仍是退出码 0 + 磁盘真变回 |
| **G** 交叉校验 | 受控假 GitHub 说 `v9.9.9` → `cross_check_mismatch`, 退出码 2, **没有任何 `npm install` 被调用** |
| **H** `update --status` 三态 | ① 只装 npm: `安装来源: stable (npm registry)` + `能切回: dev (github)` ② 装了 dev: `安装来源: dev (GitHub master 快照, ref refs/heads/master, commit d2148f3)` + `能切回: stable (npm @ 0.4.33) — 一键切: bolloon update now --channel stable` + 显式警告 ③ 刚切回: `安装来源: stable` + `上次 dev: commit d2148f3… (已切回 stable)` |

**变异验证** (`scripts/verify-dual-source-mutations.py`, 按**词界**改坏、恢复后复跑):

| 变异 | 聚焦测试 |
| --- | --- |
| M1 `REFUSED_STATUSES` 漏掉 `github_unavailable` | 🔴 1 个用例失败 |
| M2 两源不一致 → 说成 `agree` (不再阻塞) | 🔴 3 个用例失败 |
| M3 `channelKindOf`: dev 的比较语义 → 说成 `semver` | 🔴 9 个用例失败 |
| M4 dev 源不可达 → 改报 `up_to_date` ("假装没事") | 🔴 1 个用例失败 |
| M5 装完 dev 却把来源记成 `stable` | 🔴 1 个用例失败 |
| M6 dev 身份反解 sha 失效 | 🔴 5 个用例失败 |

**6/6 按预期判红**, 恢复后 `update-dual-source.test.ts` 34/34 + `update-system.test.ts` 53/53 全绿。
**门禁**: `npx tsc --noEmit` 0 错 · `goal-flywheel-wiring-freeze.test.ts` 34/34 (飞轮侧未削弱) · 全量 `vitest run` 见 §12.7 收尾记录。

**真跑暴露的两个真问题 (都不是设计问题, 是只有真跑才会暴露的)**:

1. dev 快照从 **git 源码树**构建必须**两步**: 先 `npm run build --workspaces --if-present`
   (建 `@bolloon/constraint-runtime`), 再 `npm run build:main` —— 只跑第二步会在干净源码树上必失败 (TS2307)。
2. 验收脚本里**假源必须用异步子进程**: 用 `spawnSync` 会阻塞父进程事件循环, 父进程里的受控假服务器永远答不上话
   (表现为 `releases: timeout`) —— 记录在这里, 免得下次重踩。

### 12.8 与 §9 台账的关系

§9 的 8 个 Phase 完成度**不变** (现有实现原样)。本节兑现后:

- §9 多一行 `Phase 9 双源 (npm + GitHub)`;
- §1.4 已按 §12.1 改成双源口径 (**权威顺序不变**);
- **⑤ 已完成**: 2026-09-25 发布 `0.5.0` + tag `v0.5.0` (§12.9) —— §9 因而再多一行 `Phase 10 发布 0.5.0`;
- **④ 发布硬门仍未开**, 如实留在这里: 第一个"带同名 tag"的版本**已经发出来了** (条件已具备), 开不开由主线定 (§12.9)。

---

## 12.9 发布记录: `@bolloon/bolloon-agent@0.5.0` (2026-09-25) —— **第一个「带同名 Tag」的版本**

### 发的是什么

| 项 | 值 |
| --- | --- |
| 版本号 | **`0.4.33` → `0.5.0`** |
| 内容 | ① **飞轮** M0 接线冻结 + M1–M4 接线 + M5 长周期真跑验收 (接进真执行路径) · ② **新 CLI**: `bolloon task group create\|join\|list\|link\|leave` 与 `bolloon identity init\|show` (此前只在源码, `0.4.33` 里没有; 旧版会把 `announce …` 这类吞成一句任务正文真跑) · ③ **`update` 双源** (`--channel stable\|dev` + 两套比较语义 + 源不可达必拒, §12) |
| tag | annotated **`v0.5.0`** → commit **`493d8d5`** (发布出去的源码提交) |
| 产物 | 1565 文件 · `package size 19.0 MB` / `unpacked 43.9 MB` · `shasum f8f5dbcf223a8994d788ce9abefa51fcd772c52b` |

### 版本号为什么是 minor (依据与取舍)

- **仓内没有成文的发布版本号政策** (`AGENTS.md` / 本页 / `docs/` 都没有, 也没有 `scripts/release*` 约定脚本)。
- 找到的是**习惯**: 线上 142 个版本**全是 patch**, 且**功能批次也走 patch** (0.4.30 = 手机端联系方式与授权能力)。
- 本次取 **minor**, 依据 = 本批是**向后兼容的新能力** (新子命令 + `--channel` 选项 + 飞轮接线) —— semver 对这种情况的定义就是 minor。
- **取舍如实**: 严格照习惯应是 `0.4.34`。选 minor 是**判断, 不是仓内约定**; 属主线可否决项 (npm 已发, 真要改只能等下一次发布)。
- 影响面确认: 版本号唯一影响的是 **dev 身份** (`<package.json 版本>+dev.<sha7>`, 按 sha 比较), 比较语义**一行未变**。

### 发布判据 (逐条真查, 全过)

| # | 判据 | 真输出 |
| --- | --- | --- |
| 1 | `dist-tags.latest` 真前进 | `{"latest":"0.5.0"}` (版本总数 143); **发布后约 5 分钟才放行** (20:25:47 翻), 期间直连 404 —— 与 0.4.27/0.4.28「退出码 0 但未公开」同形状, 处置是**只轮询不重发** |
| 2 | 版本直连 URL | `HTTP 200` |
| 3 | packument `dist.tarball` 真下载 + shasum 逐字对上 | 19010013 字节 → 本地 SHA-1 **== `dist.shasum`**; SRI 同样逐字相同 |
| 4 | `tar -tzf` 入口 + **新 CLI** | `dist/cli-entry.js` · `bin/bolloon.cjs` 在; `GROUP_ACTIONS`/`case 'group'` · `identity init` · `--channel` 解析都在; 装出来真跑 `task group`/`identity` 帮助 + `--channel nonsense` 必拒 |
| 5 | **全新目录**消费者安装 | `added 972 packages` · **`npm warn` 行数 = 0** (stderr 逐字为空) · `bolloon --version` → `Bolloon Agent v0.5.0` |
| 6 | 拿新版**回环重跑**双源验收 | **63 PASS / 0 FAIL / 0 SKIP**; dev 身份 `0.5.0+dev.493d8d5` 真启动自报; 一键回 stable 退出码 0 且磁盘真变回; `--status` 三态说清源 + sha |
| 补充 | 仓内发布后硬门 | `node scripts/verify-release.mjs 0.5.0 --install-check` → **13/13 全过**, 结论「发布可信」 |

### 交叉校验: 第一个真实例

真跑 (真 `api.github.com` + 真 packument + **仓内同一份** `crossCheckStable`):

```text
kind = agree · blocking = false · hasTag = true · hasRelease = false
GitHub: 可达 · master HEAD 493d8d5 · Release 0 个 · Tag 26 个 · 最新版本标签 0.5.0
detail = npm latest=0.5.0 在 GitHub 上有同名记录 (Tag v0.5.0) — 两个源指向同一版
```

**此前这条恒为 `missing_record`** (§12.0 的真实数据: npm latest `0.4.33` 在 GitHub 上没有同名 Tag)。
**④ 发布硬门仍未开** —— 真实例已经造出来了, 条件具备, 但**开不开由主线定** (本步不顺手打开会拦死后续发布的门)。

### 如实留下的 (没做到 / 有保留)

1. 双源验收**第一次跑 18 FAIL**, 单一根因 = 隔离 prefix 预置安装失败 (`磁盘=null`), 下游 18 项被连带判红;
   手动**同形状**命令复现成功 (`added 972 packages`, exit 0) → 判**瞬时环境抖动**, 重跑 63/0。
   **但夹具把 npm 的 stderr 丢掉 ⇒ 红起来没有原因可读** —— 这个弱点本轮**未改**。
2. `skills/bolloon-network/SKILL.md` 的「发行版可用性边界」仍按 **0.4.33 实测**口径写 (0.5.0 已带上 `group/announce/trail/post`);
   技能源与站点镜像按纪律**逐字节同源**, 改它属 **UI 仓**那一侧的活, 本步没动。
3. 双源验收的「装依赖」一跳仍复用本仓 `node_modules` (`BOLLOON_DEV_REUSE_NODE_MODULES`, 加速开关) —— 其余全真。
4. tag 指向 `493d8d5`, wiki 回写落在随后一个 docs 提交 → tag 与 HEAD 不再重合; `verify-release.mjs` 的 `git_tag` 是**软门**, 之后跑会显示 ⚠️ (不是发布坏了, 是回写在 tag 之后)。
5. 匿名 GitHub API 配额只有 60 次/小时 (本次全程真调) —— 环境约束, 且按设计 **stable 侧不该被 GitHub 阻塞** (npm 仍是权威)。
