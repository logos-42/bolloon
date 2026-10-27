---
title: Rust CLI 终端渲染所有权: 底部固定 composer (单一渲染者 + 日志隔离 + 真 pty 门)
source: session (leo 2026-10-27 四次追加需求 + 真 pty 抓包 + VT 回放 + 变异验证)
created: 2026-10-27
last_confirmed: 2026-10-27
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [rust, cli, tui, ansi, composer, render-ownership, logbus, tracing, pty-gate, vt-replay, ctrl-c, status-bar, session-title]
---

# Rust CLI 终端渲染所有权 (2026-10-27)

## 一句话

`bolloon chat` 的底部区域**只有一个渲染者** (`bolloon-tui::app::Chrome`), 只用**绝对行号 + 整行擦**;
键盘/流式/工具/日志事件**只改状态**, 由它统一重画。日志先落盘, TUI 期间不写 stderr。

## 根因 (三类同时存在, 逐条有真机证据)

### ① 两个渲染者抢同一块底栏 (主因, 输入时逐键堆叠)

| 渲染者 | 写法 | 几何 |
| --- | --- | --- |
| `Chrome::draw` (`app.rs`) | `\x1b[{row}H\x1b[2K` 绝对行号 | 6 行固定 (活动行/线/状态/线/输入/线) |
| `input::ask_composer` (`input.rs`, **已删**) | `\x1b[{drawn-1}A` + `\r\x1b[J` 相对位移 | 补全菜单 + 顶线 + 输入块 + 底线 + 状态 |

`composer_frame()` 的每一行都以 `\n` 结尾 (含最后一行) ⇒ 打印完光标停在**末行下一行**,
而 `paint_composer()` 的上移量是 `drawn-1` ⇒ **每次重画都少上移一行** ⇒ 上一帧的**第一行**
永远擦不掉, 一帧一帧往下堆。真机观测 (100×30 pty, 打"你/你可/你可以"):
`scrolled` 6 → 16 → 31 行, 屏幕上留下 3 组横线 + 3 份输入。

### ② 日志 / TUI 抢同一块终端

`tracing_subscriber` 写 **stderr**, 而 tty 上 stderr 与 stdout 同屏 ⇒ 日志落点由**上一帧的光标位置**
决定, 每来一行就把底栏往下推一行, 下一帧的绝对行号全部对不上。`bolloon_llm::runtime` 的
429 退避 `WARN` 就是这样插进输入框的。

### ③ 两个几何口径

composer 自己在 `cols` 上算线宽、`Chrome` 用 `cols-1`; 两边的"输入行/状态行"行号也不同 ⇒
"等输入"与"等模型"切换时整块底栏上下跳。

### 附带查实的四个真缺陷

1. `print_above` 的钉底分支**不会滚动**: 在 `chrome_top-1` 打印 n 行不会触发终端滚动 (最后一行
   正好落在终端末行) ⇒ 打印完再画底栏就把刚打印的行盖掉 —— 真机表现为"发出去的消息框不见了"。
2. 流式面板 (`StreamPanel`) 向上生长时**吃掉已上屏的历史** (它 erase 的是刚滚进来的行)。
3. `Ctrl+D` 在 raw 模式下**只是一个字节** (`0x04` 走 `Key::Char` → Ignore) ⇒ 帮助里写的
   "Ctrl+D 退出"从来没生效; 同理 `tokio::signal::ctrl_c()` 在整段会话里**是聋的** (`cfmakeraw` 关掉 ISIG)。
4. 非 TTY (管道) 仍把 SGR/光标控制写进 stdout (`Chrome::drop` 无条件发 `\x1b[?25h`)。

## 修法 (最小、可靠、按层)

### 渲染所有权 (`crates/bolloon-tui/src/app.rs`)

- 底栏固定 **5 行**: 运行状态行 / 输入 composer / 分隔线 / 模型行 / 指标行 (`RESERVED_LINES = 5`)。
- `draw()` 只发 `\x1b[{row}H\x1b[2K{line}`, **全场无相对位移**; 折行不会漂移。
- 输入区**恒 1 行**: 高度一变, 下面固定行就整体位移 (用户看到的就是"打字时底栏在跳")。
  多行缓冲只画**光标所在行**, 上下各有几行用 `…N行` 如实标注 (不假装看得到)。
- `read_compose()` = 键盘 → 状态 (`Compose` 缓冲/光标 + 补全 + 运行状态) → `draw()`。
  删掉 `ask_composer` / `composer_frame` / `paint_composer` / `COMPOSER_*` (273 行)。
- 补全候选不再单独开浮层, 而是占**运行状态行**那一行 (行数不变)。
- 输入区不加四边框, 一条水平分隔线 (边框多占两行, 窄屏最容易折行)。

### 滚动与流式 (`Chrome::scroll_history` + `StreamPanel::show(scroll)`)

- `scroll_history(n)` = 在终端末行写 n 个 `\n` ⇒ 终端整体上滚, 内容进 scrollback (不擦)。
- `print_above` 钉底分支: **先滚 n 行, 再打在历史区底部** (`[底-n+1 .. 底]`)。
- 流式面板变高时先 `scroll(h-prev)`, 再从底边向上画 ⇒ 不再啃历史。

### 日志隔离 (`crates/bolloon-tui/src/logbus.rs`, 新)

- `tracing` 的 writer = `logbus::LogWriter`:
  1. **永远先落盘** `<BOLLOON_HOME>/rust/logs/bolloon.log` (剥 ANSI, 机器可 grep; 级别/模块/上下文/时间戳不丢);
  2. TUI 运行中 (`TuiGuard`) **不写 stderr**, 改推**事件队列** (有界 64, 满了丢最老并计数);
  3. 非 TUI / 重定向 / `bolloon web` 照原样写 stderr。
- 界面展示: `flush_logs()` 在空闲时把事件落进历史区, 生成中只更新状态行 (并把它们攒到回合收尾再落)。
  形态是 `⚠ bolloon_llm::runtime · llm retry after backoff status=429 …` —— **渲染成事件**,
  不是把 tracing 行原样倾倒。
- `panic` 也走同一条路 (文件 + 事件), TUI 期间不往 stderr 砸栈。

### 中断语义 (leo 2026-10-27 追加)

- **运行中按一次 Ctrl+C = 中断这一回合** (不退出): raw 模式不会有 SIGINT, 由 `input::watch_interrupts`
  用 `poll(100ms)` 读键, 命中即置 `cancel` + 唤醒 `select!`。
- 非 Ctrl+C 的按键进**预输入缓冲** (`take_pending`), 下一次读输入时补回 —— watcher 不许吃字。
- **空闲时按一次 Ctrl+C = 退出** (`EditAction::Quit` → `InputOutcome::Quit`), 退出前 `sess.save()`
  并打印"已保存 <路径>"。`Esc` 只丢当前这一行。
- `Ctrl+D` 补成真 EOF (`Key::Eof`)。

### 状态栏语义 (真数据, 无数据就不显示)

- 模型行: `◉ model · @agent · ctx 3k · ⚙ n` + 右对齐 `▸ 会话标题`。
- 指标行: `◷ 9.5s · ↑ ≈108 t/s · ⏱ 12m 3s` (回合耗时 / 输出速率 / 会话时长, 全来自 `usage` 与时钟)。
- **容量未知就不写分母**: `ctx 3k`; 只有 `BOLLOON_CTX_LIMIT` 或调用方给了真值才画 `303k/1M` + `[██░] 30%`。
- 会话标题 = **首条用户消息的语义摘要** (24 显示列), 不是时间戳; `/title` 指定的名字 (`title_custom`)
  不被自动摘要覆盖。老存档里的 `会话 HH:MM:SS` 标题在载入时自动重摘。

### 非 TTY

- `plain()` 在**写 stdout 的那一层**统一剥 ANSI; `Chrome::drop` 只在真藏过光标时才发 `\x1b[?25h`。

## 门禁

`python3 scripts/verify-rust-tui.py` —— 真 pty (100×30 / 72×24) + **VT 回放** (CUP/CUU/EL/ED/宽字符),
34 条判据:

| 组 | 判据 |
| --- | --- |
| T1 | 空输入只有 1 个输入框 · 纯分隔线 1 条 · 状态行 1 行 · 底栏完整在屏内 |
| T2 | **100 键后**横线条数/输入框数/输入行行号恒定 · 输入行以外无残影 · 回显就是刚打的字 |
| T3 | 退格 / ← → / 中间退格 / Ctrl+J 多行都不增加横线, 多行标注 `…1行` |
| T4 | 缩放到 72×24 后仍 1 个输入框、底栏完整、无行超宽 |
| T5 | 发送后输入清空 · 消息区只 1 条用户消息 · 回复进历史 · 固定区形状不变 |
| T6 | 流式结束底栏归位 · **运行中 Ctrl+C 不退进程** 且状态行说"已中断" · 中断后还能继续输入 |
| T7 | 429 退避**真发生** (桩服务 3 次请求) · 日志文件有 `status=429` + `backoff_ms` · 屏上无原始 tracing 行 · 界面里只有 `⚠/✗` 事件形态 |
| T8 | 空闲**一次** Ctrl+C 退出 · 退出恢复光标 · 屏上留"已退出会话 · 已保存 <path>" |
| T9 | 非交互 (管道) 退出 0 · stdout 零 ESC · 日志不混进 stdout |

单元层 (`cargo test -p bolloon-tui`, 171 条) 钉纯函数几何: 帧高恒 5 · 输入行 `❯ ` 起头且正好框宽 ·
100 次 set_input 横线数不变 · 无行写满整宽 · 状态行/指标行字段语义 · 容量未知不画分母 ·
占位文案有内容即消失 · 多行折叠 · logbus 有界队列/级别路由/守卫恢复/多行压平。

## 第二轮修复 (2026-10-27 晚)

真机又报四类问题, 根因都在**几何记账**, 不是样式:

| 现象 | 根因 | 修法 |
|---|---|---|
| 发消息后输入框/加载区**重复一套** | `print_above` 先把 `flow_top` 置 `None` 再 `clear()` ⇒ 擦的是**新位置**, 老 flow 位置的底栏留在屏上, 新底栏画下面 | 新增 `erase_block_at(top)`: 切布局前**先擦老位置**, 再切; 之后按老位置续排 |
| 框与框之间出现**大段空白洞** | 流式预览块"向上借历史行", 收尾 `finish()` 把借来的行擦白 | 预览块改成**固定 `STREAM_ROWS=4` 行** (`reserve_stream` 先滚出占住), 收尾 `end_stream` 只清自己那 4 行并记进 `tail_free`; `print_above` **先复用 `tail_free`** 再滚屏 |
| 打一个字多一条横线 (旧) | 见上文 | 同上文 |
| 工具执行时输入框**动画冻住** | 工具 `harness.gate()` 是阻塞 await, 期间无人重绘 | `tokio::select!` 里把 `gate()` 与 **100ms tick** 并跑, 新增 `Activity::Tool{name,started}` (`⚙ shell · 1.4s · 执行中`) |

其它同时落地:

- **diff 要看得见**: `file_tools::bounded_diff()` 生成有界 unified diff (24 行封顶, 超出如实写"省略 N 行"),
  `edit_file` 成功输出 = `已编辑 + diff + 读回自证`; TUI 侧 `panel::render_diff_excerpt()` 着色 `+/-/@@` 并限宽。
- **选择窗口**: `/model` `/channel` `/sessions` 空参数打开 `tui_select` (表格 + 序号直达 + **滚轮**);
  `parse_keys` 认 SGR 鼠标 `ESC[<64/65;x;yM`, 选择器进入时开 `?1000h?1006h`、退出必关。
  `/sessions` 用**序号**落地 (`apply_pick`), 与列表同序不选错; `/resume` 也认序号 / id 前缀 / 标题。
- **退出摘要**: `ChatSession::exit_summary()` 打标题 / 时长 / 消息数 / `bolloon chat --resume <id>` / 落盘路径,
  `chat --resume <序号|id|标题>` 启动即接上旧会话。
- **启动面板**: 艺术字移到**框上方** (`pick_banner` 自适应宽度 + 左右补齐到正好 `w` 列),
  `Available Skills` 改为**扫全机技能库** (`~/.hermes/skills` `~/.claude/skills` `~/.codex/skills` + 项目内), 目录名即技能名,
  面板只列前 8 个 + `… 还有 N 个` (实测 1374 个)。
- **缩放即时生效**: `install_resize_watch()` 装 SIGWINCH, `read_key_raw` 每 250ms 回来看一眼,
  空批次 = 只有缩放没有按键 ⇒ `refresh_size() + draw()`。

## 踩过的坑 (给下一次)

1. **相对位移 + 尾随换行**必然少上移一行; 修法是取消相对位移, 不是调 `-1`。
2. 只按 `\n` 切行数"超宽行"会造假证据 —— 必须 VT 回放 (本仓踩过两次)。
3. 夹具缩放**不能**拿最终宽度重放全部历史字节 (缩放前的帧按新宽度重放会折行错位) ⇒
   增量回放 + `Screen.resize()`; 缩放前先 `screen()` 把旧字节按旧尺寸喂完。
4. 固定 sleep 会给出假红: 首帧要 `wait_for(pred)` (冷启动可能 >2.5s)。
5. `print_above` 在钉底态必须**先滚**; "打印完再画底栏"会把新行盖掉。
6. raw 模式里 `Ctrl+C` / `Ctrl+D` 都只是字节: 退出/中断只能靠读键, `tokio::signal::ctrl_c` 收不到。
7. **切布局必须先擦老位置**: `clear()` 只认当前 `chrome_top()`; 先改状态再擦 = 擦错行, 老底栏变残影/洞。
8. **预览块不能"借行"**: 借来的行收尾只能擦白 ⇒ 洞。固定的行数 + `tail_free` 复用才有干净几何。
9. **阻塞的 await 会让 TUI 假死**: 工具/网络调用一律与 tick 赛跑 (`select!`), 否则动画冻住。
10. 日志文件必须剥 SGR: `.with_ansi(tty)` 写进文件后 `grep status=429` 会漏 (实测被 `\x1b[3m` 打断)。

## 关联

- [cli-startup-panel.md](./cli-startup-panel.md) — TS 侧面板几何纪律 (帧高恒定/绝不写满整宽)
- [cli-reply-stream-hygiene.md](./cli-reply-stream-hygiene.md) — 回复流卫生 (内部日志不进对话流)
- [rust-rewrite.md](./rust-rewrite.md) — Rust 台账
