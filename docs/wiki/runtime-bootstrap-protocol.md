---
title: 运行时安装协议 (Node/npm · Git · Python 的检查、安装、PATH 与验证)
source: session (leo 2026-09-19 计划 + 现状盘点)
created: 2026-09-19
last_confirmed: 2026-09-19
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [runtime, bootstrap, install, node, npm, git, python, path, config, package-manager, brew, apt, winget, doctor, acceptance-matrix, install-protocol]
---

# 运行时安装协议 (Phase 0-9)

> 完成定义 (冻结): **Bolloon 安装完成 = Node/npm、Git、Python 三个运行时都已可执行、版本可验证、路径已配置。**
> 任何一个必需运行时不可用 → 整个安装**不能**宣布成功 (退出码非 0)。
>
> 代码: `src/utils/runtime-bootstrap.ts` (唯一管理器) + `scripts/install.sh` (编排) + `scripts/postinstall.js` (只检测不装系统软件)。
> 命令: `bolloon runtime [plan|install|dry-run|verbose|json]` · `bolloon setup repair-runtime`。
> 验收: `src/test/runtime-bootstrap.test.ts` (32) + `scripts/verify-runtime-bootstrap.ts` (真跑, 含真装一遍)。

---

## 0. 为什么做 (2026-09-19 之前的真实现状)

| 缺口 | 事实 |
| --- | --- |
| `install.sh` 只检查 Node/npm | Git/Python 缺失时照常打印"✅ 已安装并自检通过" |
| `postinstall.js` 不检查也不提示 | 用户 `npm i -g` 绕过后得到"看似安装成功、实际运行不完整"的状态 |
| `version-info.ts` 只探测 Python | 只回答"有没有", 不负责配置/PATH/验证 |
| 路径没有统一来源 | 各脚本各自 `command -v`, 谁发现什么就是什么 |
| 更新流程不管运行时 | Git/Python 被删掉后 `update` 照样宣布环境健康 |
| 无"最低版本"概念 | `git`/`python` 只要命令存在就算有 |

---

## 1. Phase 0: 冻结的最低版本与平台矩阵

只此一处定义 (`RUNTIME_MIN`), 不在代码里到处写死, 也不照抄别人的版本:

| 运行时 | 最低版本 | 为什么是这个版本 |
| --- | --- | --- |
| Node.js | **18.0.0** | Bolloon CLI/依赖的运行时 (ESM、全局 fetch、`node:` 前缀) |
| npm | **9.0.0** | 随 Node 18+ 发布; 全局安装与 `bolloon update` 的安装通道 |
| Git | **2.20.0** | `git -C`、`--porcelain`、worktree —— 源码更新与协作 |
| Python | **3.8.0** | `scripts/**` (wiki 门禁/消融夹具) 与 Python Skill 执行 |

平台范围: **macOS / Linux / Windows**。不在矩阵内的平台 → `unsupported`, 明确不自动安装。

安装方式四分类 (映射到实际动作): 自动包管理器安装 (`install`) · 官方安装器 (`manual` + 指引) · 已有运行时复用 (`reuse`) · 无法自动安装 (`unsupported` + 说明原因)。

---

## 2. Phase 1: Runtime Bootstrap Manager (唯一实现)

`src/utils/runtime-bootstrap.ts` 负责: 检查四个运行时 · 找包管理器 · 选方案 · 执行安装 · 配置 PATH · 验证 · 写日志/配置 · 返回失败阶段与恢复建议。

**统一输出结构** (每个运行时一条事实, 任何出口都读它):

```text
runtime: node | npm | git | python
status:  found | installed | configured | missing | failed | unsupported
path    绝对路径 (拿不到就是 null, 不编造)
version 真正执行 --version 解析出来的
source: existing | brew | apt | dnf | yum | pacman | zypper | apk | winget | choco | official-installer | none
installedByBolloon / meetsMinimum / lastVerifiedAt / verified(真执行过) / notes / error
```

**出口只有一个**: `install.sh`、`postinstall.js`、`bolloon runtime`、`bolloon doctor`、`bolloon --version`、Onboard 全部读这一份 —— 不允许再各写一套检测。

---

## 3. Phase 2: 平台适配器

| 平台 | 优先顺序 | 备注 |
| --- | --- | --- |
| macOS | 已有 → Homebrew；**没有 Homebrew 时不静默安装 Homebrew** | Homebrew 会写 `/opt/homebrew` 或 `/usr/local` 且可能要管理员密码 → 走 `manual` + 官方安装器指引 |
| Linux | 已有 → apt / dnf / yum / pacman / zypper / apk | 包名由适配器决定 (Python 额外带 `python3-venv` / `python3-pip`); 需要 root 时命令带 `sudo`, 但**默认不执行** (见 §4) |
| Windows | 已有 → winget → choco → 官方安装器 | 额外检查 `git.exe`/`python.exe` 是否真进 PATH、**Windows App Execution Aliases 是否劫持 Python** (路径含 `WindowsApps` 且跑不起来 → 判 `missing` 并给关闭别名的指引) |

命令形状是**纯函数** (`packageManagerFor(kind, path).installCmd(pkgs)`) —— 所以 winget/choco 的形状在 Linux/macOS 上也能被单测覆盖, 不靠嘴说支持。

**安装位置**: `install.sh` 只在 `<prefix>/lib` 可写时才用该 prefix, 否则按设计回退到 `~/.npm-global` 并打印提示 —— 真跑验收里踩到过
"没预建 `<prefix>/lib` → 装到了 `~/.npm-global`", 这是**设计行为**, 不是 bug (断言要看产品自报的 `installDir`, 不是猜路径)。

---

## 4. Phase 3: 权限与用户确认

- **不偷偷 sudo**: 需要管理员权限的命令进 `plan.needsAdmin`, 只有显式 `allowSudo` (install.sh 侧是 `BOLLOON_ALLOW_SUDO=1`) 才执行; 否则记 `skipped-needs-sudo` 并写进建议;
- **改系统前先给计划**: `bolloon runtime plan` / `install.sh --dry-run` 打印"装什么 / 用什么装 / 装到哪 / 是否改 PATH / 是否需要管理员权限";
- **不覆盖用户已有运行时**: 已满足最低版本一律 `reuse`;
- **不把密码/口令写日志**;
- **npm 失败要能重试**: npm 默认只重试 2 次/10s —— 真跑里一次干净安装被本机 `ECONNRESET` 打断过, 所以安装/更新统一加
  `--fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=120000` (低频动作, 宁可多等也不要假装成功);
- 非交互入口: `install.sh --yes` · `install.sh --dry-run` · `install.sh --runtime-report`。

---

## 5. Phase 4: PATH 与解释器配置

写入 `~/.bolloon/config.json` 的 **`runtime.*`** (不新建第二个配置文件):

```json
{ "runtime": { "git": { "path": "...", "version": "...", "source": "existing",
                        "installedByBolloon": false, "lastVerifiedAt": "...", "meetsMinimum": true } },
  "runtimeUpdatedAt": "..." }
```

优先级: ① 配置里的绝对路径 (只作**优先候选**) ② PATH ③ 平台默认目录。
**每次启动都重新真执行验证, 不盲信配置**: 配置里的路径失效 → 按 PATH 重新发现, 并在 `notes` 里写明"配置里的路径已失效"。
写配置**只动 `runtime` 一个键** (用户字段、更新开关、providers 原样保留, 单测锁死)。

---

## 6. Phase 5: 安装后的强制验证 (不是"命令存在")

```text
node  → 真加载 Bolloon CLI 入口并读回 --version json
npm   → 真读全局安装信息 (网络查询交给 update 检查, 不重复打 registry)
git   → 真建临时仓库: init → add → status --porcelain → -C 判定
python→ 真跑最小脚本 (6*7 == 42)
```

报告两种形状:

```text
Bolloon 安装完成            |  Bolloon 安装未完成
Node.js  ✓  24.13.0        |  失败阶段: 运行时验证 (git/python)
npm      ✓  11.6.2         |  Git: 找不到可用的 git 命令
Git      ✓  2.39.2         |  处理建议:
Python   ✓  3.12.8         |    - Linux: 用发行版包管理器安装 git
核心运行 可用 / 源码更新 可用 / Git 协作 可用 / Python Skill 可用 / Wiki 工具 可用
```

缺任何必需项 → 打印"安装未完成" + 失败阶段 + 原因 + 建议, 退出码非 0 (`install.sh` 与 `bolloon runtime` 都是)。

---

## 7. Phase 6/7: Onboard 与 npm 安装路径

- **npm 安装 (`npm i -g`) 的 `postinstall` 不许偷偷装系统软件** (需要管理员权限的动作必须用户知情); 但它**必须检测** Git/Python, 不满足时:
  - 打印"安装**未完成** (缺 git/python)" + 四项运行时状态 + 补齐办法;
  - 写 `~/.bolloon/install-incomplete.json` (缺什么/怎么修) → `bolloon doctor` 会报"安装完整性: 度降级"; 运行时补齐成功后**自动清除**该标记。
- `bolloon setup repair-runtime` = `bolloon runtime install yes` (同一实现, 不是第二套)。
- **Onboard 运行时门禁: 未做** (见 §10)。

---

## 8. Phase 8: 更新流程纳入运行时

- `bolloon doctor` 增两项: **运行时配置** (路径/版本/来源/是否 Bolloon 装) + **能力矩阵** (核心运行/源码更新/Git 协作/Python Skill/Wiki 工具);
- 更新后健康检查 (`runHealthCheck`) 增第 8 项: 运行时**真执行**验证 —— Git 被删/版本不足 → `failed` (不会因为"npm 装成功了"就宣布环境健康);
- 运行时缺失/不合格 → 修复命令写进 `doctor` 的 `action` 与报告的"处理建议"里;
- **不破坏** Goal / Run / Transaction / 用户配置 (运行时流程只写 `runtime.*` 与临时目录)。

---

## 9. Phase 9: 真跑验收矩阵

`scripts/verify-runtime-bootstrap.ts` (隔离 HOME + 隔离 npm prefix, 不碰系统全局安装):

| 用例 | 覆盖场景 | 说明 |
| --- | --- | --- |
| A | 真探测 | 四个运行时的路径/版本/真执行验证 + `ok` 与 facts 自洽 |
| B | 配置持久化 + 路径失效 | `runtime.*` 落盘; 用户字段一个不动; 配置路径失效 → 按 PATH 重新发现 |
| C | `--dry-run` | 造"四个都缺"的真实场景 → **一条安装命令都没执行** |
| D | 未同意不装 | `yes` 缺省 → 0 次执行 + "确认后重跑" |
| E | 权限策略 | 缺 Node 时 `install.sh` **拒绝静默装 Homebrew/不偷偷 sudo**, 退出码非 0 |
| F | 最低版本门 | 假的老 git (2.10.0) → `failed` + 理由 (不是 missing 也不是就绪) |
| G | 缺运行时 | PATH 清空 → CLI 打印"安装未完成 + 失败阶段 + 建议", 退出码 1 |
| H | install.sh 只读入口 | `--dry-run` / `--runtime-report` 打印计划且不做任何修改 |
| I | **真装一遍** | 真 npm 下载 + postinstall + 运行时补齐 + 硬验证; 装出来的 `--version json` 含运行时配置; `doctor` 含运行时项 |

| 三平台真机矩阵 (计划 Phase 9) | 状态 |
| --- | --- |
| 干净 macOS (无 Git/Python, 有 Node) | ⚠️ **未验**: 本机没有可用的干净 macOS 环境 (本机 Git/Python 都在); 已验的是"macOS 无 Homebrew 时明确拒绝并给指引" |
| 干净 Linux (apt/dnf, sudo 提示, 无 sudo 时失败原因清晰) | ⚠️ **未验真机**: 命令形状与 sudo 策略有单测; 无 Linux 机器可跑 |
| 干净 Windows (Git for Windows / Python 不被 Store alias 劫持 / PATH 重启有效) | ⚠️ **未验真机**: winget/choco 命令形状与 Store alias 判定有单测; 无 Windows 机器可跑 |
| 已有旧版本运行时 | ✅ 单测 (F) + 真跑 (F) |
| 网络失败 | ✅ 更新侧真跑 (registry 不可达 → 不报"最新"); 安装侧只到"命令构造"层 |
| 安装中 SIGKILL | ⚠️ **部分**: 更新流程有真 SIGKILL 验收 (`verify-update-system.ts` E); **运行时安装本身的 SIGKILL 续跑未验** (无 safe-to-kill 的安装场景可重复) |

---

## 10. 完成度台账

| 阶段 | 完成度 | 证据 / 缺口 |
| --- | --- | --- |
| Phase 0 冻结版本与平台 | ✅ | `RUNTIME_MIN` 单测锁死 (node≥18 / npm≥9 / git≥2.20 / python≥3.8) |
| Phase 1 统一管理器 | ✅ | `runtime-bootstrap.ts`; `install.sh` / `postinstall` / `runtime` / `doctor` / `--version` 全走它 |
| Phase 2 三平台适配 | ⚠️ **部分** | macOS 真跑 (含无 Homebrew 拒绝路径); Linux/Windows 只到**命令形状 + 策略**单测层, 无真机 |
| Phase 3 权限与确认 | ✅ | `plan` / `--dry-run` / `--yes` / `allowSudo` 默认关; 真跑 C/D/E |
| Phase 4 PATH 与配置 | ✅ | `runtime.*` 落盘 + 只动一个键 + 路径失效重新发现 (真跑 B) |
| Phase 5 强制验证 | ✅ | git 真建仓库 / python 真跑脚本 / node 真加载 CLI / npm 真读全局; 两种报告形状 |
| Phase 6 Onboard 强制接管 | ❌ **未做** | 初始化向导里加运行时前置阶段 + "从失败阶段继续"的状态机 (SetupStore 里已有 stage 概念, 但没接 runtime_* 阶段) |
| Phase 7 npm 路径一致 | ⚠️ **部分** | postinstall 只检测不装 + 未完成标记 + `doctor` 报它 + `setup repair-runtime` ✅; "首次执行 bolloon 时再次进入 Runtime Bootstrap" ❌ 未做 |
| Phase 8 更新纳入运行时 | ✅ | 更新后健康检查第 8 项真执行; `doctor` 运行时项 + 能力矩阵 |
| Phase 9 真机矩阵 | ⚠️ **部分** | 见 §9 表: macOS(本机) + 旧版本 + 权限策略已验; 干净三平台/无 sudo/网络失败/安装 SIGKILL 未验 |

### 未做 / 刻意不做 (如实)

- **不静默安装 Homebrew** (计划允许"安装 Homebrew 或走官方安装器", 我选择**只给指引** —— 它写系统目录且可能要管理员密码; 这台机器上正好是无 brew 的真实场景)
- **不静默 sudo**: 即使 `--yes` 也需要 `BOLLOON_ALLOW_SUDO=1` 才会执行带 sudo 的命令
- **Runtime 安装的 SIGKILL 续跑** 未验 (没有可安全重复的安装场景); 更新流程的 SIGKILL 续跑已验
- **不存在"绕过门禁"的开关**: `BOLLOON_SKIP_SETUP=1` 只是诊断模式 (产品设计), 夹具因此改用"门禁未就绪就明确不跑" (ablation runner 退出码 3)

---

## 11. 与更新协议的关系

| 问题 | 谁回答 |
| --- | --- |
| 我是什么版本 / 从哪装的 / 有没有更新 | [update-protocol.md](./update-protocol.md) |
| Node/npm/Git/Python 在哪、什么版本、谁装的、能不能用 | 本文 |
| 两者同时出现在 | `bolloon --version` (普通版就展示运行时配置块) · `bolloon doctor` · `bolloon --version json` 的 `runtime` 字段 |

`bolloon --version` 的运行时块 (leo 2026-09-19 要求"展示安装信息时要展示这些配置"):

```text
运行时配置: (来自 ~/.bolloon/config.json 的 runtime.*, 每次启动重新验证)
  ✓ Node.js  24.13.0   /usr/local/bin/node    [已有]
  ✓ npm      11.6.2    /usr/local/bin/npm     [已有]
  ✓ Git      2.39.2    /usr/bin/git           [已有]
  ✓ Python   3.12.8    /Library/.../python3   [已有]
```
