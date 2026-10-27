//! chat_command.rs — `/命令` 的**真实现** (文案与可用性在 `slash.rs`)
//!
//! 分层: `slash` 只管"有哪些命令、叫什么、能不能用"; 本文件只管"能用的时候它到底做什么"。
//! `ChatSession` 持有会话本体 (消息 / 标题 / 模型 / 附件 / 队列 / steer / 目标 / loop / 落盘目录),
//! `exec` 返回一个 `Cmd` 告诉 chat 循环下一步干什么 —— 这样命令逻辑不用碰终端。
//!
//! agent 循环 (2026-10-26 起): chat 有了**轮末调度器** —— 每轮结束后按 busy 模式依次取
//! 「到点的 loop → steer → queue」自动跑 (`next_scheduled` 是纯函数, 单测钉顺序)。
//! `/bg` 起后台会话 (`Jobs` 任务板, tokio 任务), `/agents` `/tasks` 看板, `/stop` 全停。
//!
//! 纪律:
//!   · 做不到就 `slash::Status::Planned/Na` 说清楚, **不在这里假装成功**;
//!   · 会话落盘 `0600` (对话里有私事);
//!   · 附件图片真进模型: `build_user_message` 把文件读成 base64 data URL 塞进
//!     `ChatMessage.images` (视觉闸见 `bolloon_llm::check_vision`), 不再只是 `@路径`。

use bolloon_llm::{ChatMessage, LlmRuntime};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::slash::{self, Spec};

/// 单张图片上限 (8MB): base64 之后 ~11MB, 再大就该让人先压一压
pub const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// 命令执行后让 chat 循环做什么
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cmd {
    /// 打印几行 (进 transcript)
    Say(Vec<String>),
    /// 用这段内容当作**下一条用户消息**立即发送
    Send(String),
    /// 放回输入框 (不发送, 让人先改)
    Prefill(String),
    /// 清屏 + 重画
    Clear,
    /// 整屏重画
    Redraw,
    /// 检查/安装自身更新
    Update { install: bool },
    /// 退出 (delete = 连会话文件一起删)
    Quit { delete: bool },
    /// 打开**选择窗口** (表格 + 滚轮); 由终端层负责画, 本层只管给出数据和落地
    Pick(PickKind),
}

/// 选择窗口的三类数据源 (`/model` `/channel` `/sessions`)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickKind {
    Model,
    Channel,
    Sessions,
}

/// 选择窗口的一行 (**已经是给人看的对齐文本**, 终端层原样渲染)
#[derive(Debug, Clone)]
pub struct PickRow {
    pub value: String,
    pub label: String,
    pub hint: Option<String>,
}

impl ChatSession {
    pub fn pick_title(&self, kind: PickKind) -> String {
        match kind {
            PickKind::Model => "选择模型 (↑↓ / 滚轮 / 直接打序号 / Enter 确认 · Esc 取消)".to_string(),
            PickKind::Channel => "选择渠道 (一渠道一历史, 互不串)".to_string(),
            PickKind::Sessions => "选择会话 (序号 / 标题 / 条数 · Enter 接上)".to_string(),
        }
    }

    /// 表格行: 列按**显示宽度**对齐 (CJK 标题也不会错列)
    pub fn pick_rows(&self, kind: PickKind) -> Vec<PickRow> {
        match kind {
            PickKind::Model => {
                let cfg = bolloon_llm::config_store::load();
                let mut rows: Vec<PickRow> = Vec::new();
                for r in bolloon_llm::config_store::usable(&cfg) {
                    let mark = if r.model == self.model { "●" } else { "○" };
                    rows.push(PickRow {
                        value: r.model.clone(),
                        label: format!("{mark} {:<18} {}", r.model, r.id),
                        hint: Some(format!("{} · 密钥 {}", r.base_url, r.auth_ref())),
                    });
                }
                // 当前模型即使不在可用列表里也要能看见 (否则用户以为丢了)
                if !rows.iter().any(|x| x.value == self.model) {
                    rows.insert(
                        0,
                        PickRow {
                            value: self.model.clone(),
                            label: format!("● {:<18} (当前, 未在配置里)", self.model),
                            hint: Some("这个模型名当前配置解析不到密钥/地址".to_string()),
                        },
                    );
                }
                rows
            }
            PickKind::Channel => {
                let mut names = vec![self.channel.clone()];
                let dir = bolloon_tui::history::history_dir();
                if let Ok(rd) = std::fs::read_dir(&dir) {
                    for e in rd.flatten() {
                        let p = e.path();
                        if p.extension().and_then(|x| x.to_str()) == Some("json") {
                            if let Some(stem) = p.file_stem().and_then(|x| x.to_str()) {
                                let n = stem.replace("__", ":");
                                if !names.contains(&n) {
                                    names.push(n);
                                }
                            }
                        }
                    }
                }
                names.sort();
                names
                    .into_iter()
                    .map(|n| PickRow {
                        value: n.clone(),
                        label: format!("{} {}", if n == self.channel { "●" } else { "○" }, n),
                        hint: None,
                    })
                    .collect()
            }
            PickKind::Sessions => self
                .list()
                .into_iter()
                .enumerate()
                .map(|(i, (id, title, n))| PickRow {
                    value: i.to_string(), // 用**序号**落地: 与列表同序, 不会选错
                    label: format!(
                        "{:>2}. {}{}  ({n} 条)",
                        i + 1,
                        title,
                        if id == self.id { "  ← 当前" } else { "" }
                    ),
                    hint: Some(id),
                })
                .collect(),
        }
    }

    /// 落地选择结果 (`value` 来自 `pick_rows`)
    pub fn apply_pick(&mut self, kind: PickKind, value: &str) -> Result<Vec<String>, String> {
        match kind {
            PickKind::Model => {
                self.model = value.to_string();
                let _ = self.save();
                Ok(vec![format!("模型已切换到 {}", self.model)])
            }
            PickKind::Channel => {
                if value == self.channel {
                    return Ok(vec![format!("渠道没变 ({})", value)]);
                }
                self.channel = value.to_string();
                let _ = self.save();
                Ok(vec![format!("渠道已切换到 {}", value)])
            }
            PickKind::Sessions => match self.load_into(value) {
                Ok(()) => Ok(vec![
                    format!("已恢复会话「{}」 ({} 条消息)", self.title, self.messages.len()),
                    format!("继续聊即可 —— 之前的上下文都在 (id {})", self.id),
                ]),
                Err(e) => Err(e),
            },
        }
    }
}

/// 忙时调度模式 (`/busy`)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum BusyMode {
    /// steer 优先, queue 随后 (默认 —— 用户插话比排队的事急)
    #[default]
    Steer,
    /// 排队的事先跑, steer 随后
    Queue,
    /// 调度暂停: loop/steer/queue 都等下一次手动输入之后再说
    Interrupt,
}

impl BusyMode {
    pub fn parse(s: &str) -> Option<BusyMode> {
        match s.trim().to_lowercase().as_str() {
            "queue" => Some(BusyMode::Queue),
            "steer" => Some(BusyMode::Steer),
            "interrupt" => Some(BusyMode::Interrupt),
            _ => None,
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            BusyMode::Steer => "steer (插话优先)",
            BusyMode::Queue => "queue (排队优先)",
            BusyMode::Interrupt => "interrupt (调度暂停)",
        }
    }
}

/// `/loop` 的循环任务 (一个会话同时只有一个; 再 /loop 就是替换)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopJob {
    pub prompt: String,
    pub interval_ms: u64,
    /// 剩余次数 (None = 不限)
    pub runs_left: Option<u32>,
    /// `--until <条件>`: 每次跑完问一次模型是否满足
    pub until: Option<String>,
    /// 下次该跑的时间 (epoch ms)
    pub next_run_ms: u128,
    pub paused: bool,
}

/// 轮末调度器取出的下一件事
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scheduled {
    /// 到点的 loop (内容)
    Loop(String),
    /// 用户插话
    Steer(String),
    /// 排队提示
    Queue(String),
}

impl Scheduled {
    /// 发送时的**来源标记** (进消息正文, 让模型和人都能看出这句是自动跑的)
    pub fn marker(&self) -> &'static str {
        match self {
            Scheduled::Loop(_) => "【loop 定时任务】",
            Scheduled::Steer(_) => "【steer 插话】",
            Scheduled::Queue(_) => "【queue 排队】",
        }
    }
    pub fn text(&self) -> &str {
        match self {
            Scheduled::Loop(t) | Scheduled::Steer(t) | Scheduled::Queue(t) => t,
        }
    }
}

/// 后台任务 (`/bg`) 的记录
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobView {
    pub id: String,
    pub status: &'static str,
    pub prompt_head: String,
    pub path: String,
}

enum JobStatus {
    Running,
    Done,
    Failed,
    Aborted,
}

impl JobStatus {
    fn label(&self) -> &'static str {
        match self {
            JobStatus::Running => "running",
            JobStatus::Done => "done",
            JobStatus::Failed => "failed",
            JobStatus::Aborted => "aborted",
        }
    }
}

struct Job {
    prompt_head: String,
    status: JobStatus,
    path: PathBuf,
    abort: Option<tokio::task::AbortHandle>,
}

/// 后台任务板 (`/bg` `/agents` `/tasks` `/stop` 共用; 归 run_chat 持有, 测试可自建)
#[derive(Default, Clone)]
pub struct Jobs {
    /// Arc 是为了让后台任务能拿着句柄回报状态 (self 的生命周期活不过 `tokio::spawn`)
    inner: Arc<Mutex<Vec<Job>>>,
}

impl Jobs {
    pub fn new() -> Self {
        Self::default()
    }

    /**
     * 起一个后台会话: 独立上下文 (不带主会话历史), 结果写 `dir/<id>.md`。
     * 返回任务 id。**不阻塞**当前会话 —— 模型在后台跑, 人继续打字。
     */
    pub fn spawn(&self, llm: Arc<LlmRuntime>, model: String, prompt: String, dir: PathBuf) -> String {
        let id = format!(
            "bg-{}",
            chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f")
        );
        let head: String = prompt.chars().take(40).collect();
        let path = dir.join(format!("{id}.md"));
        let rec = Job {
            prompt_head: head,
            status: JobStatus::Running,
            path: path.clone(),
            abort: None,
        };
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).push(rec);

        let jobs_flag = JobFlag(Arc::clone(&self.inner));
        let id2 = id.clone();
        let prompt2 = prompt.clone();
        let marker = path.clone();
        let path2 = path.clone();
        let handle = tokio::spawn(async move {
            let msgs = vec![ChatMessage {
                role: "user".into(),
                content: prompt2.clone(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
                images: vec![],
            }];
            let body = match llm
                .generate("env", bolloon_llm::GenerateParams::new(&model, msgs))
                .await
            {
                Ok(res) => format!(
                    "# 后台会话 {id2}\n\n## 提示\n\n{prompt2}\n\n## 回复\n\n{}\n",
                    res.content
                ),
                Err(e) => format!("# 后台会话 {id2}\n\n## 提示\n\n{prompt2}\n\n## 失败\n\n✗ {e}\n"),
            };
            let failed = body.contains("## 失败");
            if std::fs::create_dir_all(path2.parent().unwrap_or(Path::new("."))).is_ok() {
                let _ = std::fs::write(&path2, &body);
            }
            jobs_flag.set_by_path(&marker, if failed { JobStatus::Failed } else { JobStatus::Done });
        });
        // 任务可能先于这行跑完 ⇒ 只在还 running 时挂 abort (挂不上也不影响正确性)
        let mut all = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(j) = all.iter_mut().find(|j| j.path == path && matches!(j.status, JobStatus::Running)) {
            j.abort = Some(handle.abort_handle());
        }
        id
    }

    /// 任务列表 (新→旧)
    pub fn list(&self) -> Vec<JobView> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .rev()
            .map(|j| JobView {
                id: j
                    .path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                status: j.status_label(),
                prompt_head: j.prompt_head.clone(),
                path: j.path.display().to_string(),
            })
            .collect()
    }

    /// 全停: 中断所有还在跑的任务; 返回停了几个
    pub fn stop_all(&self) -> usize {
        let mut all = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut stopped = 0;
        for j in all.iter_mut() {
            if matches!(j.status, JobStatus::Running) {
                if let Some(h) = &j.abort {
                    h.abort();
                }
                j.status = JobStatus::Aborted;
                stopped += 1;
            }
        }
        stopped
    }

    pub fn running(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|j| matches!(j.status, JobStatus::Running))
            .count()
    }
}

/// 后台任务手里的回报句柄 (Arc 共享同一张任务板)
struct JobFlag(Arc<Mutex<Vec<Job>>>);

impl JobFlag {
    fn set_by_path(&self, path: &Path, status: JobStatus) {
        let mut all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(j) = all.iter_mut().find(|j| j.path == path) {
            j.status = status;
        }
    }
}

impl Job {
    fn status_label(&self) -> &'static str {
        self.status.label()
    }
}

/// exec 的环境 (注入, 便于测试): LLM 运行时 + 后台任务板
pub struct ChatCtx<'a> {
    pub llm: Arc<LlmRuntime>,
    pub jobs: &'a Jobs,
}

#[derive(Serialize, Deserialize)]
struct Persisted {
    id: String,
    title: String,
    /// 用户用 `/title` 亲手起的名字 (自动摘要不覆盖它)
    #[serde(default)]
    title_custom: bool,
    model: String,
    channel: String,
    created_ms: u128,
    messages: Vec<ChatMessage>,
    #[serde(default)]
    queue: Vec<String>,
    #[serde(default)]
    steer: Vec<String>,
    #[serde(default)]
    busy: BusyMode,
    #[serde(default)]
    goal: Option<String>,
    #[serde(default)]
    goal_paused: bool,
    #[serde(default)]
    subgoals: Vec<String>,
    #[serde(default)]
    loop_job: Option<LoopJob>,
}

pub struct ChatSession {
    /// 会话库根目录 (`<home>/chat`); 测试里注入临时目录
    pub dir: PathBuf,
    pub id: String,
    pub title: String,
    /// `title` 是否由用户 `/title` 指定 (false = 跟着首条用户消息自动改)
    pub title_custom: bool,
    pub model: String,
    pub channel: String,
    pub messages: Vec<ChatMessage>,
    /// 下一条消息要带上的附件路径 (`/image` `/paste`)
    pub attachments: Vec<String>,
    pub created_ms: u128,
    /// 排队提示 (`/queue`), 轮末自动跑
    pub queue: VecDeque<String>,
    /// 插话 (`/steer`), 轮末优先跑
    pub steer: Vec<String>,
    pub busy: BusyMode,
    /// 跨轮持续目标 (`/goal`), 每条消息都会带上
    pub goal: Option<String>,
    pub goal_paused: bool,
    /// 目标子条件 (`/subgoal`)
    pub subgoals: Vec<String>,
    /// `/loop` 的循环任务
    pub loop_job: Option<LoopJob>,
    /// 记忆库路径 (注入, 测试用临时文件)
    pub memory_db_path: PathBuf,
}

impl ChatSession {
    /// 生产入口: `~/.bolloon/rust/chat`
    pub fn new(model: &str, channel: &str) -> Self {
        let dir = bolloon_agent::home::BolloonHome::resolve().root().join("chat");
        Self::with_dir(dir, model, channel)
    }

    pub fn with_dir(dir: impl Into<PathBuf>, model: &str, channel: &str) -> Self {
        let dir = dir.into();
        let now = chrono::Utc::now().timestamp_millis() as u128;
        let mut s = Self {
            memory_db_path: dir
                .parent()
                .map(|p| p.join("memory.db"))
                .unwrap_or_else(|| PathBuf::from("memory.db")),
            dir,
            id: new_id(now),
            title: String::new(),
            title_custom: false,
            model: model.to_string(),
            channel: channel.to_string(),
            messages: Vec::new(),
            attachments: Vec::new(),
            created_ms: now,
            queue: VecDeque::new(),
            steer: Vec::new(),
            busy: BusyMode::Steer,
            goal: None,
            goal_paused: false,
            subgoals: Vec::new(),
            loop_job: None,
        };
        s.id = s.unique_id();
        s.title = default_title();
        s
    }

    fn sessions_dir(&self) -> PathBuf {
        self.dir.join("sessions")
    }

    pub fn path(&self) -> PathBuf {
        self.sessions_dir().join(format!("{}.json", self.id))
    }

    /// 同毫秒内连开两个会话时避开重名 (落盘是文件名, 撞了就丢历史)
    fn unique_id(&self) -> String {
        let mut id = self.id.clone();
        let mut n = 1;
        while self.sessions_dir().join(format!("{id}.json")).exists() {
            n += 1;
            id = format!("{}-{n}", self.id);
        }
        id
    }

    /// 轮数 = 用户消息条数
    pub fn turns(&self) -> usize {
        self.messages.iter().filter(|m| m.role == "user").count()
    }

    pub fn chars(&self) -> usize {
        self.messages.iter().map(|m| m.content.chars().count()).sum()
    }

    /// 粗估 token (字符/4) —— **只是估算**, 输出里也这么写
    pub fn est_tokens(&self) -> usize {
        self.chars() / 4
    }

    /// 退出摘要 —— 用户回来时**一眼能接上** (标题/时长/消息数/怎么恢复/存哪了)。
    ///
    /// 与 Hermes 的收尾同口径: 给的是"可执行的下一条命令", 不是一句"再见"。
    pub fn exit_summary(&self, elapsed: std::time::Duration) -> Vec<String> {
        let secs = elapsed.as_secs();
        let dur = if secs >= 3600 {
            format!("{}h {:02}m", secs / 3600, (secs % 3600) / 60)
        } else if secs >= 60 {
            format!("{}m {}s", secs / 60, secs % 60)
        } else {
            format!("{secs}s")
        };
        vec![
            format!("会话    {}  ({})", self.title, self.id),
            format!(
                "时长    {dur} · {} 条消息 / {} 轮 · 渠道 {}",
                self.messages.len(),
                self.turns(),
                self.channel
            ),
            format!("继续    bolloon chat --resume {}", self.id),
            format!("        (或进来后 /resume {} / /resume <序号> / /sessions 看全部)", self.id),
            format!("落盘    {}", self.path().display()),
        ]
    }

    /// 自动标题: 用户没亲手起名时, 用首条用户消息当**语义标题**。
    ///
    /// 调用点只有一个 (`main.rs` 每轮发出用户消息之后), 幂等 —— 反复调用不会改出怪东西。
    pub fn refresh_title(&mut self) {
        if self.title_custom {
            return;
        }
        if let Some(t) = title_from_messages(&self.messages) {
            self.title = t;
        } else if self.title.is_empty() {
            self.title = default_title();
        }
    }

    pub fn save(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(self.sessions_dir())?;
        let p = Persisted {
            id: self.id.clone(),
            title: self.title.clone(),
            title_custom: self.title_custom,
            model: self.model.clone(),
            channel: self.channel.clone(),
            created_ms: self.created_ms,
            messages: self.messages.clone(),
            queue: self.queue.iter().cloned().collect(),
            steer: self.steer.clone(),
            busy: self.busy,
            goal: self.goal.clone(),
            goal_paused: self.goal_paused,
            subgoals: self.subgoals.clone(),
            loop_job: self.loop_job.clone(),
        };
        let body = serde_json::to_vec_pretty(&p).unwrap_or_default();
        write_0600(&self.path(), &body)
    }

    /// 开新会话 (消息清空, ID 换新); `name` 给了就当标题
    pub fn reset(&mut self, name: Option<&str>) {
        let now = chrono::Utc::now().timestamp_millis() as u128;
        let old = self.id.clone();
        self.created_ms = now;
        self.id = new_id(now);
        self.id = self.unique_id();
        // 同一毫秒内 /new 两次: 光靠文件重名避不开, 显式避开旧 ID
        if self.id == old {
            self.id.push_str("-2");
        }
        self.messages.clear();
        self.attachments.clear();
        // 队列/插话/loop 是**会话级**的: 开新会话就清掉 (目标也是)
        self.queue.clear();
        self.steer.clear();
        self.loop_job = None;
        self.goal = None;
        self.subgoals.clear();
        match name.map(str::trim).filter(|s| !s.is_empty()) {
            Some(n) => {
                self.title = n.to_string();
                self.title_custom = true;
            }
            None => {
                self.title = default_title();
                self.title_custom = false;
            }
        }
    }

    /// 载入某个会话 (按 id, 再按标题不区分大小写)
    pub fn load_into(&mut self, key: &str) -> Result<(), String> {
        let key = key.trim();
        if let Some(p) = self.find(key) {
            let raw = std::fs::read_to_string(&p).map_err(|e| format!("读 {} 失败: {e}", p.display()))?;
            let parsed: Persisted =
                serde_json::from_str(&raw).map_err(|e| format!("{} 不是合法会话文件: {e}", p.display()))?;
            self.id = parsed.id;
            self.title = parsed.title;
            self.title_custom = parsed.title_custom;
            self.model = parsed.model;
            self.channel = parsed.channel;
            self.created_ms = parsed.created_ms;
            self.messages = parsed.messages;
            self.queue = parsed.queue.into();
            self.steer = parsed.steer;
            self.busy = parsed.busy;
            self.goal = parsed.goal;
            self.goal_paused = parsed.goal_paused;
            self.subgoals = parsed.subgoals;
            self.loop_job = parsed.loop_job;
            self.attachments.clear();
            // 老会话里存的是 `会话 HH:MM:SS` 这种时间戳标题 ⇒ 按现存消息重新摘出语义标题
            if !self.title_custom && looks_like_clock_title(&self.title) {
                self.refresh_title();
            }
            return Ok(());
        }
        Err(format!(
            "找不到会话 “{key}” —— /sessions 列出的序号 / id / 标题都能直接用"
        ))
    }

    /// 按 **序号 (1-based, 新的在前) → id → id 前缀 → 标题(精确→子串)** 逐级回落定位会话。
    ///
    /// 序号与 `/sessions` 列表**同一份数据、同一顺序** (都来自 `list()`), 否则"按 3 选"
    /// 会选到别的东西 —— 这条是本仓列表类命令的既有口径 (`/channel` 同款)。
    fn find(&self, key: &str) -> Option<PathBuf> {
        let key = key.trim();
        let all = self.list();

        // ① 序号
        if let Ok(n) = key.parse::<usize>() {
            if n >= 1 {
                if let Some((id, _, _)) = all.get(n - 1) {
                    return Some(self.sessions_dir().join(format!("{id}.json")));
                }
            }
        }
        // ② 直接就是 id (文件名)
        let direct = self.sessions_dir().join(format!("{key}.json"));
        if direct.exists() {
            return Some(direct);
        }
        let want = key.to_lowercase();
        // ③ id 全等
        if let Some((id, _, _)) = all.iter().find(|(id, _, _)| id.to_lowercase() == want) {
            return Some(self.sessions_dir().join(format!("{id}.json")));
        }
        // ④ id 前缀 (会话 id 很长, 手打不方便)
        if key.len() >= 6 {
            if let Some((id, _, _)) = all.iter().find(|(id, _, _)| id.to_lowercase().starts_with(&want)) {
                return Some(self.sessions_dir().join(format!("{id}.json")));
            }
        }
        // ⑤ 标题: 精确 → 子串
        if let Some((id, _, _)) = all.iter().find(|(_, t, _)| t.to_lowercase() == want) {
            return Some(self.sessions_dir().join(format!("{id}.json")));
        }
        all.iter()
            .find(|(_, t, _)| t.to_lowercase().contains(&want))
            .map(|(id, _, _)| self.sessions_dir().join(format!("{id}.json")))
    }

    /// 会话清单 (新的在前): (id, title, 消息数)
    pub fn list(&self) -> Vec<(String, String, usize)> {
        let mut out: Vec<(u128, String, String, usize)> = Vec::new();
        let Ok(rd) = std::fs::read_dir(self.sessions_dir()) else {
            return Vec::new();
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&p) else { continue };
            let Ok(v) = serde_json::from_str::<Persisted>(&raw) else { continue };
            out.push((v.created_ms, v.id, v.title, v.messages.len()));
        }
        out.sort_by(|a, b| b.0.cmp(&a.0));
        out.into_iter().map(|(_, id, t, n)| (id, t, n)).collect()
    }

    // ── agent 循环: 轮末调度 ──────────────────────────────
    /**
     * 取下一件该自动跑的事 (**纯逻辑**, 顺序由 busy 模式定):
     *   · `Steer` (默认): 到点的 loop → steer → queue
     *   · `Queue`: queue → steer → 到点的 loop
     *   · `Interrupt`: 什么都不取 (调度暂停)
     *
     * 取走即消费 (queue/steer 弹出; loop 在返回前**先排下一次**, 防止出错时死循环重排)。
     */
    pub fn next_scheduled(&mut self, now_ms: u128) -> Option<Scheduled> {
        if self.busy == BusyMode::Interrupt {
            return None;
        }
        let due_loop = self.loop_due(now_ms);
        match self.busy {
            BusyMode::Interrupt => None,
            BusyMode::Queue => {
                if let Some(t) = self.queue.pop_front() {
                    return Some(Scheduled::Queue(t));
                }
                if let Some(t) = self.steer.first().cloned() {
                    self.steer.remove(0);
                    return Some(Scheduled::Steer(t));
                }
                if due_loop {
                    return self.take_loop(now_ms);
                }
                None
            }
            // Steer (默认): 到点的 loop → 插话 → 排队
            BusyMode::Steer => {
                if due_loop {
                    return self.take_loop(now_ms);
                }
                if let Some(t) = self.steer.first().cloned() {
                    self.steer.remove(0);
                    return Some(Scheduled::Steer(t));
                }
                if let Some(t) = self.queue.pop_front() {
                    return Some(Scheduled::Queue(t));
                }
                None
            }
        }
    }

    fn loop_due(&self, now_ms: u128) -> bool {
        matches!(&self.loop_job, Some(l) if !l.paused && l.next_run_ms <= now_ms)
    }

    fn take_loop(&mut self, now_ms: u128) -> Option<Scheduled> {
        let l = self.loop_job.as_mut()?;
        let prompt = l.prompt.clone();
        l.next_run_ms = now_ms.saturating_add(l.interval_ms.into());
        if let Some(n) = l.runs_left.as_mut() {
            *n = n.saturating_sub(1);
        }
        // 次数用完且没有 --until 要判 ⇒ 直接收摊
        if l.runs_left == Some(0) && l.until.is_none() {
            self.loop_job = None;
        }
        Some(Scheduled::Loop(prompt))
    }

    /// loop 跑完一轮之后: 有 `--until` 就问一次模型是否满足 (满足即停)
    pub async fn after_loop_turn(&mut self, ctx: &ChatCtx<'_>) -> Vec<String> {
        let Some(l) = self.loop_job.clone() else { return vec![] };
        let Some(until) = l.until.clone() else { return vec![] };
        let tail = self.transcript_for_llm(6, 2000);
        let ask = format!(
            "只回答 yes 或 no (小写, 不要别的字)。\n条件: {until}\n\n最近对话:\n{tail}\n\n条件满足了吗?"
        );
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: ask,
            name: None,
            tool_call_id: None,
            tool_calls: None,
            images: vec![],
        }];
        match ctx
            .llm
            .generate("env", bolloon_llm::GenerateParams::new(&self.model, msgs))
            .await
        {
            Ok(res) => {
                let yes = res.content.to_lowercase().contains("yes");
                if yes {
                    self.loop_job = None;
                    vec![format!("✓ loop 结束: 模型判定 --until「{until}」已满足")]
                } else {
                    vec![format!("… loop 继续: --until「{until}」未满足 (下一次 {}s 后)", l.interval_ms / 1000)]
                }
            }
            Err(e) => vec![format!("✗ loop 的 --until 判定失败: {e} (loop 暂停, /loop resume 恢复)")],
        }
    }

    // ── 发送前的装配 ──────────────────────────────────────
    /**
     * 把用户输入 + 附件 + 当前目标装配成**真的发出去的消息**。
     *
     * · 附件: 读文件 → base64 data URL → `ChatMessage.images` (**像素真进模型**,
     *   不再只是 `@路径`); 正文仍留 `@路径` 供人核对;
     * · 视觉闸: `bolloon_llm::check_vision` 拦默认纯文本模型, `BOLLOON_VISION=1` 强制;
     * · 目标: `【当前目标】` 前缀, 每条消息都让模型看到 (除非 /goal pause)。
     *
     * 失败时附件**原样保留** (换模型后重试不必重新贴)。
     */
    pub fn build_user_message(&mut self, text: &str) -> Result<ChatMessage, String> {
        let keep = self.attachments.clone();
        let mut content = text.to_string();
        let mut images: Vec<String> = Vec::new();
        for a in std::mem::take(&mut self.attachments) {
            match image_data_url(Path::new(&a)) {
                Ok(url) => {
                    images.push(url);
                    content.push_str(&format!("\n[图片] @{a}"));
                }
                Err(e) => {
                    self.attachments = keep;
                    return Err(e);
                }
            }
        }
        if !images.is_empty() {
            let force = std::env::var("BOLLOON_VISION")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            if !force {
                if let Err(e) = bolloon_llm::check_vision(&self.model, images.len()) {
                    self.attachments = keep;
                    return Err(e);
                }
            }
        }
        if let Some(g) = self.goal.clone() {
            if !self.goal_paused {
                let mut head = format!("【当前目标】{g}");
                if !self.subgoals.is_empty() {
                    head.push_str("\n【子条件】");
                    for (i, sg) in self.subgoals.iter().enumerate() {
                        head.push_str(&format!("\n  {}. {sg}", i + 1));
                    }
                }
                content = format!("{head}\n\n{content}");
            }
        }
        Ok(ChatMessage {
            role: "user".into(),
            content,
            name: None,
            tool_call_id: None,
            tool_calls: None,
            images,
        })
    }

    /// 给 LLM 看的对话摘录 (最多 `turns` 轮 / `max_chars` 字符, 从尾部取)
    fn transcript_for_llm(&self, turns: usize, max_chars: usize) -> String {
        let user_idx: Vec<usize> = self
            .messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m.role == "user")
            .map(|(i, _)| i)
            .collect();
        let start = user_idx.len().saturating_sub(turns);
        let from = user_idx.get(start).copied().unwrap_or(0);
        let mut out = String::new();
        for m in &self.messages[from.min(self.messages.len())..] {
            let who = if m.role == "user" { "你" } else { "Agent" };
            out.push_str(&format!("{who}: {}\n", m.content));
        }
        if out.chars().count() > max_chars {
            out = out.chars().skip(out.chars().count() - max_chars).collect();
        }
        out
    }

    // ── 命令分发 ───────────────────────────────────────────
    pub async fn exec(&mut self, ctx: &ChatCtx<'_>, spec: &Spec, args: &str) -> Cmd {
        match slash::canonical(spec) {
            "/new" | "/reset" => {
                let name = args.trim();
                self.reset(if name.is_empty() { None } else { Some(name) });
                let _ = self.save();
                Cmd::Say(vec![
                    format!("✓ 新会话 {}", self.id),
                    format!("  标题 {} · 渠道 {}", self.title, self.channel),
                ])
            }
            "/clear" => {
                self.reset(None);
                let _ = self.save();
                Cmd::Clear
            }
            "/redraw" => Cmd::Redraw,
            "/history" => Cmd::Say(self.history_lines()),
            "/save" => Cmd::Say(self.save_cmd(args)),
            "/retry" => match self.retry() {
                Ok(text) => {
                    let _ = self.save();
                    Cmd::Send(text)
                }
                Err(e) => Cmd::Say(vec![format!("✗ {e}")]),
            },
            "/prompt" => {
                let seed = if args.trim().is_empty() {
                    String::new()
                } else {
                    format!("{}\n\n", args.trim())
                };
                match bolloon_tui::input::compose_in_editor(&seed) {
                    Ok(text) if text.trim().is_empty() => Cmd::Say(vec!["草稿是空的 · 没有发送".to_string()]),
                    Ok(text) => Cmd::Send(text),
                    Err(e) => Cmd::Say(vec![format!("✗ 打不开编辑器: {e}")]),
                }
            }
            "/undo" => {
                let n = args.trim().parse::<usize>().unwrap_or(1);
                match self.undo(n) {
                    Ok(text) => {
                        let _ = self.save();
                        Cmd::Prefill(text)
                    }
                    Err(e) => Cmd::Say(vec![format!("✗ {e}")]),
                }
            }
            "/title" => {
                let name = args.trim();
                if name.is_empty() {
                    Cmd::Say(vec![format!("当前标题: {}", self.title)])
                } else {
                    self.title = name.to_string();
                    self.title_custom = true; // 用户亲手起的名: 自动摘要不再覆盖
                    let _ = self.save();
                    Cmd::Say(vec![format!("✓ 标题已设为 “{name}”")])
                }
            }
            "/worktree" => Cmd::Say(git_worktree(args)),
            "/plan" => Cmd::Say(self.plan_cmd(args)),
            "/resume" => {
                let key = args.trim();
                if key.is_empty() {
                    Cmd::Say(self.list_lines("用 /resume <序号|id|标题> 恢复 (序号见左列)"))
                } else {
                    match self.load_into(key) {
                        Ok(()) => Cmd::Say(vec![
                            format!("✓ 已恢复会话 {} · {}", self.id, self.title),
                            format!("  {} 条消息 / {} 轮", self.messages.len(), self.turns()),
                        ]),
                        Err(e) => Cmd::Say(vec![format!("✗ {e}")]),
                    }
                }
            }
            // 空参数 = 开**选择窗口** (表格 + 滚轮); 带参数才走文本路径 (脚本/管道友好)
            "/sessions" if args.trim().is_empty() => Cmd::Pick(PickKind::Sessions),
            "/sessions" => Cmd::Say(self.list_lines("用 /resume <序号|id|标题> 恢复 (序号见左列)")),
            // 渠道: 空参数 = 选择窗口; 带参数 = 直接切 (一渠道一输入历史)
            "/channel" => {
                let c = args.trim();
                if c.is_empty() {
                    Cmd::Pick(PickKind::Channel)
                } else {
                    self.channel = c.to_string();
                    let _ = self.save();
                    Cmd::Say(vec![format!("渠道已切换到 {} (输入历史按渠道隔离)", self.channel)])
                }
            }
            "/compress" => Cmd::Say(self.compress_cmd(ctx, args).await),
            "/status" => Cmd::Say(self.status_lines()),
            "/context" => Cmd::Say(self.context_lines(args)),
            "/config" => Cmd::Say(config_lines()),
            "/model" => {
                let m = args.trim();
                if m.is_empty() {
                    Cmd::Pick(PickKind::Model)
                } else {
                    self.model = m.to_string();
                    let _ = self.save();
                    Cmd::Say(vec![format!("✓ 本会话模型已切到 {m}")])
                }
            }
            "/diff" => Cmd::Say(git_diff(args)),
            "/profile" => Cmd::Say(self.profile_lines()),
            "/copy" => Cmd::Say(self.copy_cmd(args)),
            "/paste" => Cmd::Say(self.paste_cmd()),
            "/image" => Cmd::Say(self.image_cmd(args)),
            "/update" => Cmd::Update { install: args.trim() == "install" },
            "/version" | "/v" => Cmd::Say(vec![format!(
                "bolloon {} (rust native) · tui {}",
                env!("CARGO_PKG_VERSION"),
                env!("CARGO_PKG_VERSION")
            )]),
            "/help" => Cmd::Say(help_cmd(ctx, &self.skills_path(), args)),
            "/quit" | "/exit" => {
                let delete = args.split_whitespace().any(|a| a == "--delete");
                if delete {
                    let _ = std::fs::remove_file(self.path());
                } else {
                    let _ = self.save();
                }
                Cmd::Quit { delete }
            }
            // ── agent 循环 ──
            "/queue" => Cmd::Say(self.queue_cmd(args)),
            "/steer" => Cmd::Say(self.steer_cmd(args)),
            "/btw" => Cmd::Say(self.btw_cmd(ctx, args).await),
            "/busy" => Cmd::Say(self.busy_cmd(args)),
            "/bg" => Cmd::Say(self.bg_cmd(ctx, args)),
            "/agents" | "/tasks" => Cmd::Say(self.jobs_cmd(ctx)),
            "/stop" => {
                let n = ctx.jobs.stop_all();
                if n == 0 {
                    Cmd::Say(vec!["(没有在跑的后台任务)".to_string()])
                } else {
                    Cmd::Say(vec![format!("✓ 已停止 {n} 个后台任务")])
                }
            }
            "/refine" => Cmd::Say(self.refine_cmd(ctx, args).await),
            "/loop" => Cmd::Say(self.loop_cmd(args)),
            "/goal" => Cmd::Say(self.goal_cmd(args)),
            "/subgoal" => Cmd::Say(self.subgoal_cmd(args)),
            "/review" => Cmd::Say(self.review_cmd(ctx, args).await),
            // ── 快照回滚 ──
            "/snapshot" => Cmd::Say(self.snapshot_cmd(args)),
            "/rollback" => Cmd::Say(self.rollback_cmd(args)),
            // ── 技能 ──
            "/skills" => Cmd::Say(skills_lines(&self.skills_path())),
            // 注册表里标了 Ready 但这里没接 ⇒ 明确报错 (宁可红, 不假装)
            other => Cmd::Say(vec![format!("✗ {other} 标了可用但没接实现 (这是 bug, 请报)")]),
        }
    }

    fn skills_path(&self) -> PathBuf {
        self.dir
            .parent()
            .map(|p| p.join("skills.json"))
            .unwrap_or_else(|| PathBuf::from("skills.json"))
    }

    // ── agent 循环命令 ────────────────────────────────────
    fn queue_cmd(&mut self, args: &str) -> Vec<String> {
        let t = args.trim();
        let mut it = t.splitn(2, char::is_whitespace);
        let sub = it.next().unwrap_or("");
        let rest = it.next().unwrap_or("").trim();
        match sub {
            "" | "list" => {
                if self.queue.is_empty() && self.steer.is_empty() {
                    return vec!["(队列和插话都是空的; /queue <prompt> 排队)".to_string()];
                }
                let mut out = vec![format!(
                    "队列 {} 条 · 插话 {} 条 · 模式 {}",
                    self.queue.len(),
                    self.steer.len(),
                    self.busy.label()
                )];
                for (i, q) in self.queue.iter().enumerate() {
                    out.push(format!("  {:>2}. {}", i + 1, head(q, 50)));
                }
                for (i, s) in self.steer.iter().enumerate() {
                    out.push(format!("  ⚡ {}. {}", i + 1, head(s, 50)));
                }
                out
            }
            "clear" => {
                let n = self.queue.len();
                self.queue.clear();
                let _ = self.save();
                vec![format!("✓ 已清空队列 ({n} 条)") ]
            }
            "rm" => match rest.parse::<usize>() {
                Ok(n) if n >= 1 && n <= self.queue.len() => {
                    let removed = self.queue.remove(n - 1).unwrap_or_default();
                    let _ = self.save();
                    vec![format!("✓ 已删第 {n} 条: {}", head(&removed, 40))]
                }
                Ok(n) => vec![format!("✗ 没有第 {n} 条 (共 {} 条)", self.queue.len())],
                Err(_) => vec!["用法: /queue rm N".to_string()],
            },
            "edit" => {
                let mut it2 = rest.splitn(2, char::is_whitespace);
                let n = it2.next().and_then(|s| s.parse::<usize>().ok());
                let text = it2.next().unwrap_or("").trim();
                match (n, text.is_empty()) {
                    (Some(n), false) if n >= 1 && n <= self.queue.len() => {
                        self.queue[n - 1] = text.to_string();
                        let _ = self.save();
                        vec![format!("✓ 已改第 {n} 条: {}", head(text, 50))]
                    }
                    _ => vec!["用法: /queue edit N <新内容>".to_string()],
                }
            }
            "move" => {
                let mut it2 = rest.splitn(2, char::is_whitespace);
                let a = it2.next().and_then(|s| s.parse::<usize>().ok());
                let b = it2.next().and_then(|s| s.parse::<usize>().ok());
                match (a, b) {
                    (Some(a), Some(b)) if a >= 1 && a <= self.queue.len() && b >= 1 && b <= self.queue.len() => {
                        let item = self.queue.remove(a - 1).unwrap();
                        self.queue.insert(b - 1, item);
                        let _ = self.save();
                        vec![format!("✓ 已把第 {a} 条移到第 {b}")]
                    }
                    _ => vec![format!("用法: /queue move A B (共 {} 条)", self.queue.len())],
                }
            }
            _ => {
                // 整段当作要排队的内容 (支持多行)
                self.queue.push_back(t.to_string());
                let _ = self.save();
                vec![format!("✓ 已排队 (第 {} 条, 轮末自动跑): {}", self.queue.len(), head(t, 50))]
            }
        }
    }

    fn steer_cmd(&mut self, args: &str) -> Vec<String> {
        let t = args.trim();
        if t.is_empty() {
            return vec![
                format!("用法: /steer <消息> (下一轮前注入; 现有 {} 条)", self.steer.len()),
            ];
        }
        self.steer.push(t.to_string());
        let _ = self.save();
        vec![format!(
            "✓ 已插话 (第 {} 条, 下一轮前自动跑): {}",
            self.steer.len(),
            head(t, 50)
        )]
    }

    fn busy_cmd(&mut self, args: &str) -> Vec<String> {
        let t = args.trim();
        if t.is_empty() || t == "status" {
            return vec![format!(
                "忙时调度: {} · 队列 {} · 插话 {} · loop {}",
                self.busy.label(),
                self.queue.len(),
                self.steer.len(),
                if self.loop_job.is_some() { "有" } else { "无" }
            )];
        }
        match BusyMode::parse(t) {
            Some(m) => {
                self.busy = m;
                let _ = self.save();
                vec![format!("✓ 忙时调度已切到 {}", m.label())]
            }
            None => vec!["用法: /busy [queue|steer|interrupt|status]".to_string()],
        }
    }

    fn bg_cmd(&self, ctx: &ChatCtx<'_>, args: &str) -> Vec<String> {
        let prompt = args.trim();
        if prompt.is_empty() {
            return vec!["用法: /bg <prompt> (独立后台会话, 不带本会话历史)".to_string()];
        }
        let jobs_dir = self.dir.join("jobs");
        let _ = std::fs::create_dir_all(&jobs_dir);
        let id = ctx.jobs.spawn(Arc::clone(&ctx.llm), self.model.clone(), prompt.to_string(), jobs_dir);
        vec![
            format!("✓ 后台任务 {id} 已启动 (模型 {})", self.model),
            format!("  /agents 看进度 · 结果写到 {}", self.dir.join("jobs").join(format!("{id}.md")).display()),
        ]
    }

    fn jobs_cmd(&self, ctx: &ChatCtx<'_>) -> Vec<String> {
        let all = ctx.jobs.list();
        if all.is_empty() {
            return vec!["(没有后台任务; /bg <prompt> 起一个)".to_string()];
        }
        let mut out = vec![format!("后台任务 {} 个 (新→旧):", all.len())];
        for j in all.iter().take(20) {
            out.push(format!("  {} [{}] {}", j.id, j.status, j.prompt_head));
            out.push(format!("        {}", j.path));
        }
        out
    }

    /// `/refine` — 复盘对话, 把经验写进记忆 (memory_db lesson 层) + 技能库 (批准门=用户显式调用)
    async fn refine_cmd(&mut self, ctx: &ChatCtx<'_>, args: &str) -> Vec<String> {
        if self.messages.is_empty() {
            return vec!["(本会话还没有对话, 没什么可复盘)".to_string()];
        }
        let focus = args.trim();
        let tail = self.transcript_for_llm(12, 8000);
        let ask = format!(
            "复盘以下对话, 提炼**最多 3 条**可复用经验 (给以后的会话用)。\n\
             要求: 每条一行, 一行就是一条完整经验, 不要编号不要寒暄不要解释格式。\n\
             {focus}{tail}",
            focus = if focus.is_empty() { String::new() } else { format!("侧重: {focus}\n") },
            tail = format!("\n对话:\n{tail}")
        );
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: ask,
            name: None,
            tool_call_id: None,
            tool_calls: None,
            images: vec![],
        }];
        let res = match ctx
            .llm
            .generate("env", bolloon_llm::GenerateParams::new(&self.model, msgs))
            .await
        {
            Ok(r) => r,
            Err(e) => return vec![format!("✗ 复盘调用失败: {e} (什么都没写)")],
        };
        let lessons: Vec<String> = res
            .content
            .lines()
            .map(|l| l.trim().trim_start_matches(['-', '*', '·', ' ']).trim())
            .filter(|l| l.chars().count() >= 8)
            .take(3)
            .map(|s| s.to_string())
            .collect();
        if lessons.is_empty() {
            return vec![format!("模型没提炼出可用经验 (原文: {})", head(&res.content, 80))];
        }
        // 记忆: lesson 层 (真实落 sqlite)
        let mut saved = Vec::new();
        let db = match bolloon_agent::memory_db::MemoryDb::open(
            self.memory_db_path.to_str().unwrap_or("memory.db"),
        ) {
            Ok(db) => db,
            Err(e) => return vec![format!("✗ 打不开记忆库 {}: {e}", self.memory_db_path.display())],
        };
        let now_ms = chrono::Utc::now().timestamp_millis() as u64;
        // 技能: distill → promote (用户显式 /refine = 批准)
        let spath = self.skills_path();
        let mut evolver = bolloon_agent::skills_runtime::SkillEvolver::load_json(&spath);
        for l in &lessons {
            match db.remember("local", "lesson", l, 0.7, now_ms, None) {
                Ok(row) => saved.push(format!("mem-{:06} {}", row.id, head(l, 46))),
                Err(e) => saved.push(format!("✗ 记忆写入失败: {e}")),
            }
            if let Ok(cand) = evolver.distill(l, &self.id) {
                match evolver.promote(&cand, now_ms) {
                    Ok(()) => {}
                    Err(e) => saved.push(format!("  (技能未入库: {e})")),
                }
            }
        }
        let _ = evolver.save_json(&spath);
        let _ = self.save();
        let mut out = vec![format!("✓ 复盘完成: {} 条经验", lessons.len())];
        out.push(format!("  记忆 → {}", self.memory_db_path.display()));
        out.push(format!("  技能 → {}", spath.display()));
        for s in saved {
            out.push(format!("  · {s}"));
        }
        out
    }

    fn loop_cmd(&mut self, args: &str) -> Vec<String> {
        let t = args.trim();
        let mut it = t.splitn(2, char::is_whitespace);
        let sub = it.next().unwrap_or("");
        let _rest = it.next().unwrap_or("").trim();
        match sub {
            "status" | "show" => match &self.loop_job {
                None => vec!["(没有 loop; /loop [间隔] <prompt> [--times N] [--until 条件])".to_string()],
                Some(l) => vec![
                    format!(
                        "loop: 每 {}s 跑一次 · 剩余 {} · {}",
                        l.interval_ms / 1000,
                        l.runs_left.map(|n| n.to_string()).unwrap_or_else(|| "∞".into()),
                        if l.paused { "已暂停" } else { "运行中" }
                    ),
                    format!("  内容: {}", head(&l.prompt, 60)),
                    if let Some(u) = &l.until { format!("  --until: {u}") } else { String::new() },
                ]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect(),
            },
            "pause" => match self.loop_job.as_mut() {
                Some(l) => {
                    l.paused = true;
                    let _ = self.save();
                    vec!["✓ loop 已暂停 (/loop resume 恢复)".to_string()]
                }
                None => vec!["(没有 loop)".to_string()],
            },
            "resume" => match self.loop_job.as_mut() {
                Some(l) => {
                    l.paused = false;
                    l.next_run_ms = now_ms();
                    let _ = self.save();
                    vec!["✓ loop 已恢复".to_string()]
                }
                None => vec!["(没有 loop)".to_string()],
            },
            "stop" | "clear" => {
                let had = self.loop_job.is_some();
                self.loop_job = None;
                let _ = self.save();
                if had {
                    vec!["✓ loop 已停止".to_string()]
                } else {
                    vec!["(没有 loop)".to_string()]
                }
            }
            _ => {
                // /loop [间隔] <prompt> [--times N] [--until <条件...>]
                let mut toks: Vec<String> = t.split_whitespace().map(|s| s.to_string()).collect();
                if toks.is_empty() {
                    return vec!["用法: /loop [间隔] <prompt> [--times N] [--until 条件] | status | pause | resume | stop".to_string()];
                }
                let mut interval_ms: u64 = 60_000;
                if let Some(ms) = parse_duration(&toks[0]) {
                    interval_ms = ms;
                    toks.remove(0);
                }
                let mut times: Option<u32> = None;
                let mut until: Option<String> = None;
                let mut prompt_toks: Vec<String> = Vec::new();
                let mut i = 0;
                while i < toks.len() {
                    match toks[i].as_str() {
                        "--times" => {
                            times = toks.get(i + 1).and_then(|s| s.parse().ok());
                            i += 2;
                        }
                        "--until" => {
                            until = Some(toks[i + 1..].join(" "));
                            i = toks.len();
                        }
                        other => {
                            prompt_toks.push(other.to_string());
                            i += 1;
                        }
                    }
                }
                let prompt = prompt_toks.join(" ");
                if prompt.is_empty() {
                    return vec!["✗ loop 缺 prompt".to_string()];
                }
                self.loop_job = Some(LoopJob {
                    prompt,
                    interval_ms,
                    runs_left: times,
                    until,
                    next_run_ms: now_ms(), // 本轮结束就先跑一次
                    paused: false,
                });
                let _ = self.save();
                let l = self.loop_job.as_ref().unwrap();
                vec![format!(
                    "✓ loop 已设: 每 {}s · 剩余 {} · 本轮结束就先跑",
                    l.interval_ms / 1000,
                    l.runs_left.map(|n| n.to_string()).unwrap_or_else(|| "∞".into())
                )]
            }
        }
    }

    fn goal_cmd(&mut self, args: &str) -> Vec<String> {
        let mut t = args.trim();
        if let Some(rest) = t.strip_prefix("--") {
            t = rest.trim();
        }
        let mut it = t.splitn(2, char::is_whitespace);
        let sub = it.next().unwrap_or("");
        let _rest = it.next().unwrap_or("").trim();
        match sub {
            "" | "show" | "status" => {
                let mut out = vec![match (&self.goal, self.goal_paused) {
                    (None, _) => "当前没有目标 (/goal <text> 设一个, 每轮都会带上)".to_string(),
                    (Some(g), true) => format!("目标 (已暂停): {g}"),
                    (Some(g), false) => format!("目标: {g}"),
                }];
                for (i, sg) in self.subgoals.iter().enumerate() {
                    out.push(format!("  子条件 {}. {sg}", i + 1));
                }
                out
            }
            "clear" => {
                let had = self.goal.is_some() || !self.subgoals.is_empty();
                self.goal = None;
                self.subgoals.clear();
                self.goal_paused = false;
                let _ = self.save();
                if had {
                    vec!["✓ 目标已清除".to_string()]
                } else {
                    vec!["(本来就没有目标)".to_string()]
                }
            }
            "pause" => {
                self.goal_paused = true;
                let _ = self.save();
                vec!["✓ 目标已暂停 (消息不再带它, /goal resume 恢复)".to_string()]
            }
            "resume" => {
                self.goal_paused = false;
                let _ = self.save();
                vec!["✓ 目标已恢复".to_string()]
            }
            "draft" | "gate" | "wait" | "unwait" => vec![format!(
                "✗ /goal {sub} 没接 (goal 底座在本仓库是判定器, chat 里只有 text/show/pause/resume/clear)"
            )],
            _ => {
                self.goal = Some(t.to_string());
                self.goal_paused = false;
                let _ = self.save();
                vec![format!("✓ 目标已设定 (每轮消息都会带上): {}", head(t, 60))]
            }
        }
    }

    fn subgoal_cmd(&mut self, args: &str) -> Vec<String> {
        let t = args.trim();
        let mut it = t.splitn(2, char::is_whitespace);
        let sub = it.next().unwrap_or("");
        let rest = it.next().unwrap_or("").trim();
        match sub {
            "" | "list" => {
                if self.subgoals.is_empty() {
                    return vec!["(没有子条件; /subgoal <text> 加一条)".to_string()];
                }
                let mut out = vec!["子条件:".to_string()];
                for (i, sg) in self.subgoals.iter().enumerate() {
                    out.push(format!("  {}. {sg}", i + 1));
                }
                out
            }
            "clear" => {
                let n = self.subgoals.len();
                self.subgoals.clear();
                let _ = self.save();
                vec![format!("✓ 已清空子条件 ({n} 条)")]
            }
            "remove" => match rest.parse::<usize>() {
                Ok(n) if n >= 1 && n <= self.subgoals.len() => {
                    let removed = self.subgoals.remove(n - 1);
                    let _ = self.save();
                    vec![format!("✓ 已删子条件 {n}: {removed}")]
                }
                Ok(n) => vec![format!("✗ 没有子条件 {n} (共 {} 条)", self.subgoals.len())],
                Err(_) => vec!["用法: /subgoal remove N".to_string()],
            },
            _ => {
                self.subgoals.push(t.to_string());
                let _ = self.save();
                vec![format!("✓ 已加子条件 ({}): {}", self.subgoals.len(), head(t, 50))]
            }
        }
    }

    /// `/btw` — 旁支提问: 独立上下文, **不进主会话历史**
    async fn btw_cmd(&self, ctx: &ChatCtx<'_>, args: &str) -> Vec<String> {
        let q = args.trim();
        if q.is_empty() {
            return vec!["用法: /btw <问题> (旁支提问, 不打断/不污染主对话)".to_string()];
        }
        let tail = self.transcript_for_llm(6, 3000);
        let ask = format!(
            "下面是一段主对话的最近片段, 只作为背景。回答完就结束, 不要继续对话。\n\n背景:\n{tail}\n\n旁支问题: {q}\n(回答尽量短)"
        );
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: ask,
            name: None,
            tool_call_id: None,
            tool_calls: None,
            images: vec![],
        }];
        match ctx
            .llm
            .generate("env", bolloon_llm::GenerateParams::new(&self.model, msgs))
            .await
        {
            Ok(res) => {
                let mut out = vec!["⚡ 旁支回答 (不进主上下文):".to_string()];
                for l in res.content.lines() {
                    out.push(format!("  {l}"));
                }
                out
            }
            Err(e) => vec![format!("✗ 旁支提问失败: {e}")],
        }
    }

    /// `/review` — 以第三方审查者身份独立复查本会话 (结果不进主上下文)
    async fn review_cmd(&self, ctx: &ChatCtx<'_>, args: &str) -> Vec<String> {
        if self.messages.is_empty() {
            return vec!["(本会话还没有内容可复查)".to_string()];
        }
        let focus = args.trim();
        let tail = self.transcript_for_llm(12, 10000);
        let ask = format!(
            "你是**独立的第三方审查者**, 与上面的对话无关。复查这段工作/讨论, 输出:\n\
             ① 做对了什么 (最多 3 条)\n② 风险与遗漏 (尽量具体, 引用原文)\n③ 下一步建议 (可执行)\n\
             不要寒暄。{}\n\n对话:\n{tail}",
            if focus.is_empty() { String::new() } else { format!("审查重点: {focus}\n") }
        );
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: ask,
            name: None,
            tool_call_id: None,
            tool_calls: None,
            images: vec![],
        }];
        match ctx
            .llm
            .generate("env", bolloon_llm::GenerateParams::new(&self.model, msgs))
            .await
        {
            Ok(res) => {
                let mut out = vec!["🔎 独立复查 (不进主上下文):".to_string()];
                for l in res.content.lines() {
                    out.push(format!("  {l}"));
                }
                out
            }
            Err(e) => vec![format!("✗ 复查调用失败: {e}")],
        }
    }

    // ── 快照回滚 ──────────────────────────────────────────
    /// 快照覆盖的文件 (相对 BolloonHome root): config/ + 顶层状态 json/db, **不含** history/chat (隐私且大)
    fn snapshot_targets(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(root) {
            for e in rd.flatten() {
                let p = e.path();
                let name = e.file_name().to_string_lossy().to_string();
                if p.is_file()
                    && matches!(
                        name.as_str(),
                        "memory.db" | "memory.json" | "skills.json" | "judgments.json" | "task-board.json"
                    )
                {
                    out.push(p);
                }
            }
        }
        let cfg = root.join("config");
        if let Ok(rd) = std::fs::read_dir(&cfg) {
            for e in rd.flatten() {
                if e.path().is_file() {
                    out.push(e.path());
                }
            }
        }
        out.sort();
        out
    }

    fn snapshot_dir(&self) -> PathBuf {
        self.dir.join("snapshots")
    }

    fn snapshot_cmd(&mut self, args: &str) -> Vec<String> {
        let t = args.trim();
        let mut it = t.splitn(2, char::is_whitespace);
        let sub = it.next().unwrap_or("");
        let rest = it.next().unwrap_or("").trim();
        match sub {
            "" | "list" => self.snapshot_lines(),
            "create" => self.snapshot_create(rest),
            "restore" => {
                if rest.is_empty() {
                    vec!["用法: /snapshot restore <id> (用 /snapshot 看列表)".to_string()]
                } else {
                    match self.snapshot_restore(rest) {
                        Ok(lines) => lines,
                        Err(e) => vec![format!("✗ {e}")],
                    }
                }
            }
            "prune" => self.snapshot_prune(),
            other => vec![
                format!("✗ 不认识的子命令 “{other}”"),
                "用法: /snapshot [create|restore <id>|prune]".to_string(),
            ],
        }
    }

    fn snapshot_lines(&self) -> Vec<String> {
        let mut all = self.snapshot_list();
        if all.is_empty() {
            return vec!["(还没有快照; /snapshot create 建一个)".to_string()];
        }
        all.sort_by(|a, b| b.cmp(a));
        let mut out = vec![format!("快照 {} 个 (新→旧):", all.len())];
        for (i, id) in all.iter().enumerate() {
            out.push(format!("  {:>2}. {id}{}", i + 1, if i == 0 { "  ← 最新" } else { "" }));
        }
        out.push("恢复: /snapshot restore <id> 或 /rollback [N]".to_string());
        out
    }

    fn snapshot_list(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(self.snapshot_dir()) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    out.push(e.file_name().to_string_lossy().to_string());
                }
            }
        }
        out
    }

    fn snapshot_create(&mut self, note: &str) -> Vec<String> {
        let root = self
            .dir
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let targets = Self::snapshot_targets(&root);
        if targets.is_empty() {
            return vec![format!("({} 下没有可快照的 state 文件)", root.display())];
        }
        let id = format!(
            "{}{}",
            chrono::Utc::now().format("%Y%m%d-%H%M%S"),
            if note.is_empty() { String::new() } else { format!("-{}", slug(note)) }
        );
        let dest = self.snapshot_dir().join(&id);
        if std::fs::create_dir_all(&dest).is_err() {
            return vec!["✗ 建快照目录失败".to_string()];
        }
        let mut copied = 0;
        let mut lines = Vec::new();
        for src in &targets {
            let rel = match src.strip_prefix(&root) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            };
            let to = dest.join(&rel);
            if let Some(p) = to.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            match std::fs::copy(src, &to) {
                Ok(n) => {
                    copied += 1;
                    lines.push(format!("  {} ({} 字节)", rel.display(), n));
                }
                Err(e) => lines.push(format!("  ✗ {} ({e})", rel.display())),
            }
        }
        let _ = self.save();
        let mut out = vec![format!("✓ 快照 {id}: {copied} 个文件 → {}", dest.display())];
        out.extend(lines);
        out
    }

    fn snapshot_restore(&mut self, id: &str) -> Result<Vec<String>, String> {
        let root = self
            .dir
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let dir = if id == "latest" || id.parse::<usize>().is_ok() {
            let mut all = self.snapshot_list();
            all.sort();
            let idx = if id == "latest" {
                all.len().saturating_sub(1)
            } else {
                let n: usize = id.parse().map_err(|_| "编号得是数字".to_string())?;
                all.len().checked_sub(n).ok_or_else(|| format!("只有 {} 个快照", all.len()))?
            };
            let Some(sid) = all.get(idx) else { return Err("没有快照可恢复".into()) };
            self.snapshot_dir().join(sid)
        } else {
            let p = self.snapshot_dir().join(id);
            if !p.is_dir() {
                return Err(format!("没有快照 {id} (用 /snapshot 看列表)"));
            }
            p
        };
        let mut out = vec![format!("✓ 已从 {} 恢复:", dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default())];
        // 收集快照里的文件 (相对路径)
        let mut stack = vec![dir.clone()];
        let mut restored = 0;
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                let rel = p.strip_prefix(&dir).unwrap_or(&p).to_path_buf();
                let to = root.join(&rel);
                if let Some(parent) = to.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                match std::fs::copy(&p, &to) {
                    Ok(n) => {
                        restored += 1;
                        out.push(format!("  {} ({} 字节)", rel.display(), n));
                    }
                    Err(e) => out.push(format!("  ✗ {} ({e})", rel.display())),
                }
            }
        }
        if restored == 0 {
            return Err("快照里没有文件".into());
        }
        Ok(out)
    }

    fn snapshot_prune(&mut self) -> Vec<String> {
        let mut all = self.snapshot_list();
        all.sort(); // 旧→新
        if all.len() <= 3 {
            return vec![format!("(只有 {} 个快照, 保留最近 3 个, 没删)", all.len())];
        }
        let kill = all.len() - 3;
        let mut out = vec![format!("✓ 删了 {kill} 个旧快照 (保留最近 3 个):")];
        for id in &all[..kill] {
            match std::fs::remove_dir_all(self.snapshot_dir().join(id)) {
                Ok(()) => out.push(format!("  - {id}")),
                Err(e) => out.push(format!("  ✗ {id} ({e})")),
            }
        }
        out
    }

    fn rollback_cmd(&mut self, args: &str) -> Vec<String> {
        let t = args.trim();
        if t.is_empty() {
            return self.snapshot_lines();
        }
        match self.snapshot_restore(t) {
            Ok(lines) => lines,
            Err(e) => vec![format!("✗ {e}")],
        }
    }

    // ── 压缩 ──────────────────────────────────────────────
    async fn compress_cmd(&mut self, ctx: &ChatCtx<'_>, args: &str) -> Vec<String> {
        let mut it = args.trim().split_whitespace();
        let first = it.next().unwrap_or("");
        match first {
            "--preview" | "--dry-run" => {
                let n = it.next().and_then(|s| s.parse::<usize>().ok()).unwrap_or(4);
                let mut clone = clone_of(self);
                let (removed, kept) = clone.compress(n);
                if removed == 0 {
                    return vec![format!("上下文只有 {} 轮, 不用压缩", self.turns())];
                }
                vec![
                    format!("预览: 保留最近 {n} 轮 ⇒ 丢掉 {removed} 条, 留 {kept} 条"),
                    format!("  估算 {} → {} tokens (**只是截断, 不摘要**)", self.est_tokens(), clone.est_tokens()),
                ]
            }
            "focus" => {
                // /compress focus <topic> [--preview] — 模型摘要 (真压缩, 不是截断)
                let rest: Vec<&str> = it.collect();
                let preview = rest.iter().any(|t| *t == "--preview" || *t == "--dry-run");
                let topic: Vec<&str> = rest.iter().filter(|t| !t.starts_with("--")).copied().collect();
                let topic = topic.join(" ");
                let keep_turns = 2usize;
                let user_idx: Vec<usize> = self
                    .messages
                    .iter()
                    .enumerate()
                    .filter(|(_, m)| m.role == "user")
                    .map(|(i, _)| i)
                    .collect();
                if user_idx.len() <= keep_turns {
                    return vec![format!("只有 {} 轮, 没有可摘要的历史", self.turns())];
                }
                let cut = user_idx[user_idx.len() - keep_turns];
                let old_chars: usize = self.messages[..cut].iter().map(|m| m.content.chars().count()).sum();
                if preview {
                    return vec![
                        format!("预览: 摘要前 {cut} 条 ({old_chars} 字符), 保留最近 {keep_turns} 轮"),
                        format!("  主题: {}", if topic.is_empty() { "(全文)".to_string() } else { topic.clone() }),
                        "  (去掉 --preview 真跑; 摘要由模型生成, 替换掉旧消息)".to_string(),
                    ];
                }
                let old = self.transcript_head(cut, 12000);
                let ask = format!(
                    "把以下对话压缩成一份**接续用的摘要**, 保留: 已定的结论/决定、未完成事项、重要数字与路径。\n\
                     主题: {}\n用第三人称, 200 字以内, 直接输出摘要本体。\n\n对话:\n{old}",
                    if topic.is_empty() { "(无)".to_string() } else { topic.clone() }
                );
                let msgs = vec![ChatMessage {
                    role: "user".into(),
                    content: ask,
                    name: None,
                    tool_call_id: None,
                    tool_calls: None,
                    images: vec![],
                }];
                let res = match ctx
                    .llm
                    .generate("env", bolloon_llm::GenerateParams::new(&self.model, msgs))
                    .await
                {
                    Ok(r) => r,
                    Err(e) => return vec![format!("✗ 摘要调用失败: {e} (上下文没动)")],
                };
                if res.content.trim().is_empty() {
                    return vec!["✗ 模型返回空摘要 (上下文没动)".to_string()];
                }
                let before = self.est_tokens();
                self.apply_summary(&res.content, keep_turns);
                let _ = self.save();
                vec![
                    format!("✓ 已摘要压缩: 旧 {} 条 → 1 条摘要 (保留最近 {keep_turns} 轮)", cut),
                    format!("  估算 {} → {} tokens", before, self.est_tokens()),
                    format!("  摘要: {}", head(&res.content, 80)),
                ]
            }
            "" | "here" => {
                let n = if first == "here" {
                    it.next().and_then(|s| s.parse::<usize>().ok()).unwrap_or(4)
                } else {
                    4
                };
                let before = self.est_tokens();
                let (removed, kept) = self.compress(n);
                let _ = self.save();
                if removed == 0 {
                    vec![format!("上下文只有 {} 轮, 没动 (保留最近 {n} 轮)", self.turns())]
                } else {
                    vec![
                        format!("✓ 已截断: 丢 {removed} 条, 留 {kept} 条 (最近 {n} 轮)"),
                        format!("  估算 {} → {} tokens · 这是**截断**不是摘要, 丢的内容不在了 (要摘要用 /compress focus <主题>)", before, self.est_tokens()),
                    ]
                }
            }
            other => vec![
                format!("✗ 不认识的参数 “{other}”"),
                "  用法: /compress [here [N] | focus <topic> | --preview]".to_string(),
            ],
        }
    }

    /// 取前 `cut` 条消息的文本 (给摘要用)
    fn transcript_head(&self, cut: usize, max_chars: usize) -> String {
        let mut out = String::new();
        for m in &self.messages[..cut.min(self.messages.len())] {
            let who = if m.role == "user" { "你" } else { "Agent" };
            out.push_str(&format!("{who}: {}\n", m.content));
        }
        if out.chars().count() > max_chars {
            out = out.chars().skip(out.chars().count() - max_chars).collect();
        }
        out
    }

    /// 用摘要替换前 `keep_turns` 之前的所有消息 (摘要放在最前, role=user 带【历史摘要】标)
    pub fn apply_summary(&mut self, summary: &str, keep_turns: usize) {
        let user_idx: Vec<usize> = self
            .messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m.role == "user")
            .map(|(i, _)| i)
            .collect();
        let keep = keep_turns.max(1);
        let cut = if user_idx.len() > keep {
            user_idx[user_idx.len() - keep]
        } else {
            return;
        };
        let tail: Vec<ChatMessage> = self.messages[cut..].to_vec();
        // 摘要用 assistant 角色: 它是"模型自己的复盘", 既不会把 turns() 算多一轮,
        // 也比把摘要塞进 user 更不容易被当成用户的新指令。
        let mut next = vec![ChatMessage {
            role: "assistant".into(),
            content: format!("【历史摘要 · /compress focus 生成】\n{summary}"),
            name: None,
            tool_call_id: None,
            tool_calls: None,
            images: vec![],
        }];
        next.extend(tail);
        self.messages = next;
    }

    // ── 其余既有命令 ──────────────────────────────────────
    fn history_lines(&self) -> Vec<String> {
        if self.messages.is_empty() {
            return vec!["(本会话还没有消息)".to_string()];
        }
        let mut out = vec![format!("会话 {} · {} 条消息 / {} 轮", self.id, self.messages.len(), self.turns())];
        for (i, m) in self.messages.iter().enumerate() {
            let who = if m.role == "user" { "你  " } else { "Agent" };
            let one = m.content.replace('\n', " ⏎ ");
            out.push(format!("  {:>3}. {who}  {}", i + 1, bolloon_tui::input::fit_for_display(&one, 60)));
        }
        out
    }

    fn list_lines(&self, hint: &str) -> Vec<String> {
        let all = self.list();
        if all.is_empty() {
            return vec!["(本机还没有落过盘的会话)".to_string()];
        }
        let mut out = vec![format!("本机会话 {} 个 (新的在前):", all.len())];
        for (i, (id, title, n)) in all.iter().take(20).enumerate() {
            let mark = if *id == self.id { "← 当前" } else { "" };
            // 序号在最前: 用户能直接 `/resume 2`; id 与标题也照旧可用
            out.push(format!("  {:>2}. {title}  ({n} 条)  {id} {mark}", i + 1));
        }
        if all.len() > 20 {
            out.push(format!("  … 还有 {} 个 (只列最近 20)", all.len() - 20));
        }
        out.push(hint.to_string());
        out
    }

    fn save_cmd(&self, args: &str) -> Vec<String> {
        let mut it = args.split_whitespace();
        let Some(fmt) = it.next() else {
            return vec![
                "用法: /save <json|md|html> [filename] [redact]".to_string(),
                format!("当前会话: {} 条消息 / {} 轮", self.messages.len(), self.turns()),
            ];
        };
        let mut filename: Option<&str> = None;
        let mut redact = false;
        for t in it {
            match t {
                "redact" => redact = true,
                other => filename = Some(other),
            }
        }
        match self.export(fmt, filename, redact) {
            Ok(p) => vec![
                format!("✓ 已导出 {fmt} → {}", p.display()),
                format!("  {} 条消息{}", self.messages.len(), if redact { " · 已脱敏" } else { "" }),
            ],
            Err(e) => vec![format!("✗ {e}")],
        }
    }

    fn plan_cmd(&self, args: &str) -> Vec<String> {
        let task = args.trim();
        if task.is_empty() {
            return vec!["用法: /plan <任务一句话> (只写计划, 不执行)".to_string()];
        }
        let dir = self.dir.join("plans");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return vec![format!("✗ 建目录失败: {e}")];
        }
        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
        let path = dir.join(format!("plan-{stamp}.md"));
        let body = format!(
            "# 实施计划: {task}\n\n- 会话 `{}` · 模型 `{}`\n- 生成 {}\n\n\
             ## 目标\n\n{task}\n\n## 步骤\n\n1. \n\n## 验收\n\n- [ ] \n",
            self.id,
            self.model,
            chrono::Utc::now().to_rfc3339()
        );
        match std::fs::write(&path, body) {
            Ok(()) => vec![
                format!("✓ 计划已写 {}", path.display()),
                "  (只是模板: 没执行任何东西)".to_string(),
            ],
            Err(e) => vec![format!("✗ 写计划失败: {e}")],
        }
    }

    fn status_lines(&self) -> Vec<String> {
        let mut out = vec![
            format!("会话 {} · {}", self.id, self.title),
            format!(
                "  {} 条消息 / {} 轮 · 渠道 {} · 模型 {}{}",
                self.messages.len(),
                self.turns(),
                self.channel,
                self.model,
                if bolloon_llm::is_vision_model(&self.model) { " (视觉)" } else { " (纯文本)" }
            ),
            format!("  上下文 ≈ {} 字符 ≈{} tokens (粗估 字符/4)", self.chars(), self.est_tokens()),
            format!("  落盘 {}", self.path().display()),
        ];
        if !self.attachments.is_empty() {
            out.push(format!("  待发附件 {} 个: {}", self.attachments.len(), self.attachments.join(", ")));
        }
        if let Some(g) = &self.goal {
            out.push(format!("  目标{}: {}", if self.goal_paused { "(暂停)" } else { "" }, head(g, 50)));
        }
        if !self.queue.is_empty() || !self.steer.is_empty() {
            out.push(format!(
                "  调度: {} · 队列 {} · 插话 {} · loop {}",
                self.busy.label(),
                self.queue.len(),
                self.steer.len(),
                if self.loop_job.is_some() { "有" } else { "无" }
            ));
        }
        out
    }

    fn context_lines(&self, args: &str) -> Vec<String> {
        let all = args.trim() == "all";
        let mut out = vec![format!(
            "上下文窗口: {} 条消息 · {} 字符 · ≈{} tokens (粗估, 不含 system/工具)",
            self.messages.len(),
            self.chars(),
            self.est_tokens()
        )];
        let bar_w = 24usize;
        let filled = (self.turns() * bar_w / 24).min(bar_w);
        out.push(format!(
            "  轮数占用 [{}{}] {} 轮",
            "#".repeat(filled),
            "·".repeat(bar_w - filled),
            self.turns()
        ));
        if all {
            out.push("  逐条:".to_string());
            for (i, m) in self.messages.iter().enumerate() {
                let img = if m.images.is_empty() { String::new() } else { format!(" +{}图", m.images.len()) };
                out.push(format!(
                    "   {:>3}. {:<9} {:>6} 字符{}  {}",
                    i + 1,
                    m.role,
                    m.content.chars().count(),
                    img,
                    bolloon_tui::input::fit_for_display(&m.content.replace('\n', " ⏎ "), 40)
                ));
            }
        } else {
            out.push("  (/context all 看逐条明细)".to_string());
        }
        out
    }

    fn profile_lines(&self) -> Vec<String> {
        let home = bolloon_agent::home::BolloonHome::resolve();
        vec![
            format!("home   {}", home.root().display()),
            format!("会话库 {}", self.dir.display()),
            format!("配置   {}", home.config_dir().display()),
            format!("渠道   {} · 模型 {}", self.channel, self.model),
        ]
    }

    fn copy_cmd(&self, args: &str) -> Vec<String> {
        let n: usize = args.trim().parse().unwrap_or(1);
        let replies: Vec<&ChatMessage> = self.messages.iter().filter(|m| m.role != "user").collect();
        if replies.is_empty() {
            return vec!["(还没有回复可复制)".to_string()];
        }
        if n == 0 || n > replies.len() {
            return vec![format!("只有 {} 条回复 (范围 1–{})", replies.len(), replies.len())];
        }
        let target = replies[replies.len() - n];
        match bolloon_tui::clipboard::copy_text(&target.content) {
            Ok(()) => vec![format!("✓ 已复制倒数第 {n} 条回复 ({} 字符) 到剪贴板", target.content.chars().count())],
            Err(e) => vec![format!("✗ 复制失败: {e}")],
        }
    }

    fn paste_cmd(&mut self) -> Vec<String> {
        match bolloon_tui::clipboard::paste_image() {
            Ok(p) => {
                self.attachments.push(p.display().to_string());
                vec![
                    format!("✓ 已附加图片 {}", p.display()),
                    format!("  下一条消息会带上像素 (共 {} 个附件; 模型 {})",
                        self.attachments.len(),
                        if bolloon_llm::is_vision_model(&self.model) { "支持视觉" } else { "⚠ 纯文本, 发送会被拦" }),
                ]
            }
            Err(e) => vec![format!("✗ 贴图失败: {e}")],
        }
    }

    fn image_cmd(&mut self, args: &str) -> Vec<String> {
        let path = args.trim();
        if path.is_empty() {
            return vec!["用法: /image <本地图片路径>".to_string()];
        }
        let p = Path::new(path);
        if !p.is_file() {
            return vec![format!("✗ 没有这个文件: {path}")];
        }
        self.attachments.push(path.to_string());
        vec![
            format!("✓ 已附加 {path}"),
            format!("  下一条消息会带上像素 (共 {} 个附件)", self.attachments.len()),
        ]
    }
}

/// `/undo N` — 回退 N 轮, 返回被回退到的**那条用户消息** (放回输入框)
impl ChatSession {
    pub fn undo(&mut self, n: usize) -> Result<String, String> {
        let n = n.max(1);
        let user_idx: Vec<usize> = self
            .messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m.role == "user")
            .map(|(i, _)| i)
            .collect();
        if user_idx.is_empty() {
            return Err("还没有可以回退的对话".to_string());
        }
        if n > user_idx.len() {
            return Err(format!("只有 {} 轮, 回退不了 {n} 轮", user_idx.len()));
        }
        let cut = user_idx[user_idx.len() - n];
        let text = self.messages[cut].content.clone();
        self.messages.truncate(cut);
        Ok(text)
    }

    /// `/retry` — 丢掉最后一条回复, 返回要重发的用户消息
    pub fn retry(&mut self) -> Result<String, String> {
        while matches!(self.messages.last(), Some(m) if m.role != "user") {
            self.messages.pop();
        }
        match self.messages.last() {
            Some(m) if m.role == "user" => {
                let text = m.content.clone();
                self.messages.pop();
                Ok(text)
            }
            _ => Err("没有可以重发的消息".to_string()),
        }
    }

    /// `/compress here N` — 只留最近 N 轮 (不摘要, **如实叫截断**)
    pub fn compress(&mut self, keep_turns: usize) -> (usize, usize) {
        let keep = keep_turns.max(1);
        let user_idx: Vec<usize> = self
            .messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m.role == "user")
            .map(|(i, _)| i)
            .collect();
        if user_idx.len() <= keep {
            return (0, self.messages.len());
        }
        let cut = user_idx[user_idx.len() - keep];
        let removed = cut;
        self.messages.drain(0..cut);
        (removed, self.messages.len())
    }

    /// `/save` — 导出 (json/md/html), `redact` 时把疑似秘密的行打码
    pub fn export(&self, fmt: &str, filename: Option<&str>, redact: bool) -> Result<PathBuf, String> {
        let (ext, body) = match fmt {
            "json" => ("json", self.export_json(redact)),
            "md" | "markdown" => ("md", self.export_md(redact)),
            "html" => ("html", self.export_html(redact)),
            _ => return Err(format!("不认识的格式 “{fmt}” (只支持 json | md | html)")),
        };
        let path = match filename {
            Some(f) => PathBuf::from(f),
            None => {
                let dir = self.dir.join("exports");
                std::fs::create_dir_all(&dir).map_err(|e| format!("建导出目录失败: {e}"))?;
                let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
                dir.join(format!("{}-{stamp}.{ext}", self.id))
            }
        };
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败: {e}"))?;
            }
        }
        std::fs::write(&path, body.as_bytes()).map_err(|e| format!("写 {} 失败: {e}", path.display()))?;
        Ok(path)
    }

    fn body_of(&self, m: &ChatMessage, redact: bool) -> String {
        if redact && bolloon_tui::history::looks_secret(&m.content) {
            return "（已脱敏: 这条看着像私钥/助记词）".to_string();
        }
        m.content.clone()
    }

    fn export_json(&self, redact: bool) -> String {
        let msgs: Vec<serde_json::Value> = self
            .messages
            .iter()
            .map(|m| {
                serde_json::json!({
                    "role": m.role,
                    "content": self.body_of(m, redact),
                    "images": m.images.len(),
                })
            })
            .collect();
        serde_json::to_string_pretty(&serde_json::json!({
            "id": self.id,
            "title": self.title,
            "model": self.model,
            "channel": self.channel,
            "created_ms": self.created_ms,
            "redacted": redact,
            "messages": msgs,
        }))
        .unwrap_or_default()
    }

    fn export_md(&self, redact: bool) -> String {
        let mut out = format!("# {}\n\n", if self.title.is_empty() { &self.id } else { &self.title });
        out.push_str(&format!(
            "- 会话 `{}`\n- 模型 `{}` · 渠道 `{}`\n- 消息 {} 条 / {} 轮\n\n---\n\n",
            self.id,
            self.model,
            self.channel,
            self.messages.len(),
            self.turns()
        ));
        for m in &self.messages {
            let who = if m.role == "user" { "你" } else { "Agent" };
            let img = if m.images.is_empty() { String::new() } else { format!(" *(+{} 图)*", m.images.len()) };
            out.push_str(&format!("**{who}**{img}\n\n{}\n\n", self.body_of(m, redact)));
        }
        out
    }

    fn export_html(&self, redact: bool) -> String {
        let mut out = String::from(
            "<!doctype html><meta charset=\"utf-8\"><title>Bolloon 会话</title>\
             <style>body{font:14px/1.6 -apple-system,Segoe UI,sans-serif;max-width:820px;\
             margin:40px auto;padding:0 16px;background:#141410;color:#d8d8c8}\
             .u{color:#c4d640;font-weight:600}.a{color:#fff;font-weight:600}\
             pre{white-space:pre-wrap;margin:4px 0 20px}</style>\n",
        );
        out.push_str(&format!(
            "<h1>{}</h1><p>会话 <code>{}</code> · 模型 <code>{}</code></p>",
            esc(if self.title.is_empty() { &self.id } else { &self.title }),
            esc(&self.id),
            esc(&self.model)
        ));
        for m in &self.messages {
            let (cls, who) = if m.role == "user" { ("u", "你") } else { ("a", "Agent") };
            out.push_str(&format!(
                "<div class=\"{cls}\">{who}</div><pre>{}</pre>",
                esc(&self.body_of(m, redact))
            ));
        }
        out
    }
}

fn help_cmd(ctx: &ChatCtx<'_>, skills_path: &Path, args: &str) -> Vec<String> {
    let a = args.trim();
    if a == "skills" {
        // 不再只是指路: 真把技能库列出来 (与本会话同一个 skills.json)
        return skills_lines(skills_path);
    }
    if a.is_empty() {
        let mut out = slash::help_lines(None);
        out.push(String::new());
        out.push(format!("后台任务在跑: {} (用 /agents 看)", ctx.jobs.running()));
        return out;
    }
    if let Some(sp) = slash::find(a) {
        return slash::detail_lines(sp);
    }
    slash::help_lines(Some(a))
}

/// 技能库清单 (`/skills` 与 `/help skills` 共用; 读 `SkillEvolver` 的 skills.json)
fn skills_lines(path: &Path) -> Vec<String> {
    if !path.exists() {
        return vec![format!("(还没有技能库 {}; 用 /refine 或 bolloon dream 积累)", path.display())];
    }
    let ev = bolloon_agent::skills_runtime::SkillEvolver::load_json(path);
    if ev.registry.is_empty() {
        return vec![format!("(技能库是空的: {})", path.display())];
    }
    let mut out = vec![format!("已装技能 {} 条 (来自 {}):", ev.registry.len(), path.display())];
    for line in ev.registry.index_for_prompt().lines() {
        out.push(format!("  {line}"));
    }
    out
}

fn config_lines() -> Vec<String> {
    let cfg = bolloon_llm::config_store::load();
    let path = bolloon_llm::config_store::config_path();
    let resolved = bolloon_llm::config_store::active_resolved(&cfg).ok();
    match resolved {
        Some(r) => vec![
            format!("provider {}", r.id),
            format!("protocol {}", r.protocol.as_str()),
            format!("model    {}{}", r.model, if bolloon_llm::is_vision_model(&r.model) { " (视觉)" } else { "" }),
            format!("base_url {}", r.base_url),
            format!("api_key  {} (不显示明文)", r.auth_ref()),
            format!("配置文件 {} (0600)", path.display()),
            "改配置: bolloon model (内置 13 + 目录 200+ 家) 或环境变量".to_string(),
        ],
        None => {
            let provider = std::env::var("BOLLOON_PROVIDER").unwrap_or_else(|_| "(未选)".into());
            let model = std::env::var("BOLLOON_MODEL").unwrap_or_else(|_| "deepseek-chat".into());
            let base = std::env::var("BOLLOON_BASE_URL").unwrap_or_else(|_| "(provider 自带)".into());
            let has_key =
                std::env::var("BOLLOON_API_KEY").map(|k| !k.trim().is_empty()).unwrap_or(false);
            vec![
                format!("provider {provider} (配置里没有可用家)"),
                format!("model    {model}"),
                format!("base_url {base}"),
                format!("api_key  {}", if has_key { "有 (env, 不显示)" } else { "没有" }),
                format!("配置文件 {} (空)", path.display()),
                "先跑 `bolloon model` 选一家并填 key (200+ 家可选)".to_string(),
            ]
        }
    }
}

fn git_diff(args: &str) -> Vec<String> {
    let mut mode = "work";
    let mut stat = false;
    let mut paths: Vec<&str> = Vec::new();
    for t in args.split_whitespace() {
        match t {
            "--stat" => stat = true,
            "staged" => mode = "staged",
            "all" => mode = "all",
            "session" => return vec!["✗ session 模式不记文件改动, 用 /diff 或 /diff all".to_string()],
            other => paths.push(other),
        }
    }
    let mut cmd = std::process::Command::new("git");
    cmd.arg("diff");
    match mode {
        "staged" => {
            cmd.arg("--cached");
        }
        "all" => {
            cmd.arg("HEAD");
        }
        _ => {}
    }
    if stat {
        cmd.arg("--stat");
    }
    for p in &paths {
        cmd.arg(p);
    }
    match cmd.output() {
        Err(e) => vec![format!("✗ 跑不动 git: {e}")],
        Ok(o) if !o.status.success() => vec![format!(
            "✗ git diff 退出码 {:?}: {}",
            o.status.code(),
            String::from_utf8_lossy(&o.stderr).trim()
        )],
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout);
            if text.trim().is_empty() {
                return vec!["(工作区干净, 没有改动)".to_string()];
            }
            let lines: Vec<&str> = text.lines().collect();
            let mut out: Vec<String> = lines.iter().take(60).map(|s| s.to_string()).collect();
            if lines.len() > 60 {
                out.push(format!("… 还有 {} 行 (加 --stat 看摘要)", lines.len() - 60));
            }
            out
        }
    }
}

fn git_worktree(args: &str) -> Vec<String> {
    let toks: Vec<&str> = args.split_whitespace().collect();
    let sub = toks.first().copied().unwrap_or("list");
    let mut cmd = std::process::Command::new("git");
    cmd.arg("worktree");
    match sub {
        "list" => {
            cmd.arg("list");
        }
        "new" => {
            let name = toks.get(1).copied().unwrap_or("wt");
            cmd.args(["add", &format!("../{name}"), "-b", name]);
        }
        "prune" => {
            cmd.arg("prune");
            if toks.iter().any(|t| *t == "--dry-run") {
                cmd.arg("--dry-run");
            }
        }
        other => {
            return vec![
                format!("✗ 不认识的子命令 “{other}”"),
                "用法: /worktree [new [name]|list|prune [--dry-run]]".to_string(),
            ];
        }
    }
    match cmd.output() {
        Err(e) => vec![format!("✗ 跑不动 git: {e}")],
        Ok(o) => {
            let out = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if !o.status.success() {
                return vec![format!("✗ git worktree 失败: {}", if err.is_empty() { out } else { err })];
            }
            if out.is_empty() {
                vec!["(没有 worktree)".to_string()]
            } else {
                out.lines().map(|s| s.to_string()).collect()
            }
        }
    }
}

// ── 小工具 ────────────────────────────────────────────

fn head(s: &str, n: usize) -> String {
    let one = s.replace('\n', " ⏎ ");
    let mut out: String = one.chars().take(n).collect();
    if one.chars().count() > n {
        out.push('…');
    }
    out
}

fn slug(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(24)
        .collect()
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// `30s` / `5m` / `1h` / `2d` / 裸数字(秒) → 毫秒
pub fn parse_duration(s: &str) -> Option<u64> {
    let s = s.trim().to_lowercase();
    let split = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let n: u64 = num.parse().ok()?;
    let ms = match unit {
        "" | "s" => 1_000u64,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return None,
    };
    n.checked_mul(ms)
}

fn clone_of(s: &ChatSession) -> ChatSession {
    ChatSession {
        dir: s.dir.clone(),
        id: s.id.clone(),
        title: s.title.clone(),
        title_custom: s.title_custom,
        model: s.model.clone(),
        channel: s.channel.clone(),
        messages: s.messages.clone(),
        attachments: vec![],
        created_ms: s.created_ms,
        queue: s.queue.clone(),
        steer: s.steer.clone(),
        busy: s.busy,
        goal: s.goal.clone(),
        goal_paused: s.goal_paused,
        subgoals: s.subgoals.clone(),
        loop_job: s.loop_job.clone(),
        memory_db_path: s.memory_db_path.clone(),
    }
}

/// 本地图片 → `data:<mime>;base64,…` (超限/读不动都给人话错误)
pub fn image_data_url(path: &Path) -> Result<String, String> {
    use base64::Engine as _;
    let meta = std::fs::metadata(path).map_err(|e| format!("读不到 {path:?}: {e}"))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "{path:?} 有 {} MB, 超过 {} MB 上限 (先压一压)",
            meta.len() / 1024 / 1024,
            MAX_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        other => {
            return Err(format!(
                "{path:?} 不是认识的图片格式 ({:?}; 只支持 png/jpg/webp/gif)",
                other
            ))
        }
    };
    let bytes = std::fs::read(path).map_err(|e| format!("读 {path:?} 失败: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// 默认标题 = **语义占位**, 不是时间戳。
///
/// 真机上 `▸ 会话 06:58:3` 那种标题对用户毫无信息量 (任务书明确: 状态栏的会话摘要
/// "不能显示时间戳代替语义"); 首条用户消息一进来 `refresh_title()` 就会把它换成摘要。
fn default_title() -> String {
    "新会话".to_string()
}

/// 旧会话存档里的时间戳标题 (`会话 06:58:38`) —— 认出来才允许重新摘要
fn looks_like_clock_title(t: &str) -> bool {
    let rest = t.strip_prefix("会话 ").unwrap_or("");
    let digits = rest.chars().filter(|c| c.is_ascii_digit()).count();
    rest.chars().all(|c| c.is_ascii_digit() || c == ':') && digits >= 4
}

/// 会话语义标题: 取**首条用户消息**的首行, 截到 24 显示列 (`…` 收尾)。
///
/// 这就是任务书要的"会话语义摘要": 复用已有的会话/消息机制, 不新建另一套摘要系统。
fn title_from_messages(messages: &[ChatMessage]) -> Option<String> {
    let first = messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.content.as_str())?;
    let line = first.lines().find(|l| !l.trim().is_empty())?.trim();
    // 命令 (`/help` 之类) 不当标题: 它们不代表会话在谈什么
    let line = line.strip_prefix('/').map(|_| "").unwrap_or(line);
    if line.is_empty() {
        return None;
    }
    Some(crate::truncate_display(line, 24))
}

fn new_id(now_ms: u128) -> String {
    let stamp = chrono::DateTime::from_timestamp_millis(now_ms as i64)
        .unwrap_or_else(chrono::Utc::now)
        .format("%Y%m%d-%H%M%S");
    format!("{stamp}-{:03}", now_ms % 1000)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn write_0600(path: &Path, body: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试会话: 目录形如 `<base>/chat` (与生产 `<root>/chat` 同构, parent 才是共享的 root)
    fn sess() -> ChatSession {
        let base = std::env::temp_dir().join(format!(
            "bolloon-chat-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(base.join("chat")).unwrap();
        ChatSession::with_dir(base.join("chat"), "deepseek-chat", "test")
    }

    /// 清掉整个临时 root (会话目录的父目录)
    fn cleanup(s: &ChatSession) {
        if let Some(root) = s.dir.parent() {
            let _ = std::fs::remove_dir_all(root);
        }
    }

    /// 测试 ctx: LLM 指向必然连不上的地址 (这些用例不真调网络; 网络用例自建 mock)
    fn ctx(_s: &ChatSession) -> ChatCtx<'static> {
        let llm = Arc::new(bolloon_llm::LlmRuntime::new(
            vec![bolloon_llm::ProviderConfig {
                id: "env".into(),
                base_url: "http://127.0.0.1:1/v1".into(),
                api_key: None,
                default_model: "deepseek-chat".into(),
            }],
            1,
        ));
        ChatCtx { llm, jobs: jobs_ref() }
    }

    fn jobs_ref() -> &'static Jobs {
        Box::leak(Box::new(Jobs::new()))
    }

    fn push(s: &mut ChatSession, role: &str, text: &str) {
        s.messages.push(ChatMessage {
            role: role.into(),
            content: text.into(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
            images: vec![],
        });
    }

    async fn run(s: &mut ChatSession, cmd: &str, args: &str) -> Cmd {
        let c = ctx(s);
        s.exec(&c, slash::find(cmd).unwrap(), args).await
    }

    /// `/new` 真的换 ID 并清消息; 落盘能读回
    #[tokio::test]
    async fn new_session_rotates_id_and_persists() {
        let mut s = sess();
        push(&mut s, "user", "你好");
        let old = s.id.clone();
        let cmd = run(&mut s, "/new", "谈需求").await;
        assert!(matches!(cmd, Cmd::Say(_)));
        assert_ne!(s.id, old);
        assert!(s.messages.is_empty());
        assert_eq!(s.title, "谈需求");
        assert!(s.path().exists(), "新会话要落盘");
        let mut other = sess();
        other.dir = s.dir.clone();
        other.load_into(&s.id).unwrap();
        assert_eq!(other.title, "谈需求");
        cleanup(&s);
    }

    /// `/undo 1` 少一轮并把那条消息**放回输入框** (不是直接重发)
    #[tokio::test]
    async fn undo_prefills_the_turn_you_backed_to() {
        let mut s = sess();
        push(&mut s, "user", "一");
        push(&mut s, "assistant", "回一");
        push(&mut s, "user", "二");
        push(&mut s, "assistant", "回二");
        let cmd = run(&mut s, "/undo", "1").await;
        assert_eq!(cmd, Cmd::Prefill("二".into()));
        assert_eq!(s.messages.len(), 2, "只该回退最后一轮");

        let cmd2 = run(&mut s, "/undo", "5").await;
        assert!(matches!(cmd2, Cmd::Say(ref v) if v[0].contains("回退不了")));
        cleanup(&s);
    }

    /// `/retry` 丢掉最后一条回复, 重发用户那条
    #[tokio::test]
    async fn retry_resends_last_user_message() {
        let mut s = sess();
        push(&mut s, "user", "问题");
        push(&mut s, "assistant", "半截回复");
        let cmd = run(&mut s, "/retry", "").await;
        assert_eq!(cmd, Cmd::Send("问题".into()));
        assert!(s.messages.is_empty(), "重发前要把这条也摘掉 (由发送逻辑重新入列)");
        cleanup(&s);
    }

    /// `/compress here 1` 只留最后一轮, 且如实说明是截断
    #[tokio::test]
    async fn compress_keeps_recent_turns_and_says_it_is_truncation() {
        let mut s = sess();
        for i in 1..=5 {
            push(&mut s, "user", &format!("问{i}"));
            push(&mut s, "assistant", &format!("答{i}"));
        }
        let out = run(&mut s, "/compress", "here 1").await;
        let text = format!("{out:?}");
        assert!(text.contains("截断"), "{text}");
        assert_eq!(s.turns(), 1);
        assert!(s.messages[0].content.contains("问5"));
        // --preview 不改动
        let before = s.messages.len();
        let _ = run(&mut s, "/compress", "--preview 1").await;
        assert_eq!(s.messages.len(), before, "preview 不许动上下文");
        cleanup(&s);
    }

    /// `/compress focus` 用**模型摘要**替换旧消息 (mock server 验证真的调了模型且上下文变了)
    #[tokio::test]
    async fn compress_focus_summarizes_via_llm() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 65536];
            let _ = sock.read(&mut buf).await;
            let resp = r#"{"choices":[{"message":{"content":"结论: 用方案A。未完成: 支付。"},"finish_reason":"stop"}]}"#;
            let out = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                resp.len(),
                resp
            );
            let _ = sock.write_all(out.as_bytes()).await;
        });
        let llm = Arc::new(bolloon_llm::LlmRuntime::new(
            vec![bolloon_llm::ProviderConfig {
                id: "env".into(),
                base_url: format!("http://{addr}/v1"),
                api_key: None,
                default_model: "m".into(),
            }],
            1,
        ));
        let jobs = Jobs::new();
        let mut s = sess();
        for i in 1..=4 {
            push(&mut s, "user", &format!("讨论{i}"));
            push(&mut s, "assistant", &format!("结论{i}"));
        }
        let ctx = ChatCtx { llm, jobs: &jobs };
        let out = s.exec(&ctx, slash::find("/compress").unwrap(), "focus 支付方案").await;
        server.abort();
        let text = format!("{out:?}");
        assert!(text.contains("已摘要压缩"), "{text}");
        // 摘要替换了旧消息: 第一条是【历史摘要】, 最近 2 轮还在
        assert!(s.messages[0].content.contains("【历史摘要"));
        assert!(s.messages[0].content.contains("方案A"));
        assert_eq!(s.turns(), 2, "保留最近 2 轮");
        assert!(s.messages.iter().any(|m| m.content.contains("讨论4")));
        cleanup(&s);
    }

    /// `/save` 三种格式都真出文件; redact 会把像私钥的内容打码
    #[tokio::test]
    async fn save_exports_three_formats_and_redacts() {
        let mut s = sess();
        let secret = "a".repeat(64);
        push(&mut s, "user", "普通一句");
        push(&mut s, "assistant", &secret);
        for fmt in ["json", "md", "html"] {
            let cmd = run(&mut s, "/save", fmt).await;
            let line = match cmd {
                Cmd::Say(v) => v[0].clone(),
                other => panic!("要 Say: {other:?}"),
            };
            assert!(line.contains("已导出"), "{line}");
            let path = line.split("→ ").nth(1).unwrap().trim().to_string();
            let body = std::fs::read_to_string(&path).unwrap();
            assert!(body.contains("普通一句"));
            if fmt == "html" {
                assert!(body.starts_with("<!doctype html>"));
            }
        }
        let cmd = run(&mut s, "/save", "md out-redact.md redact").await;
        assert!(matches!(cmd, Cmd::Say(ref v) if v.join(" ").contains("已脱敏")));
        let body = std::fs::read_to_string("out-redact.md").unwrap();
        assert!(!body.contains(&secret), "redact 必须真的打码");
        let _ = std::fs::remove_file("out-redact.md");
        cleanup(&s);
    }

    /// 裸 `/save` 只给用法 (不许静默失败)
    #[tokio::test]
    async fn bare_save_shows_usage() {
        let mut s = sess();
        let cmd = run(&mut s, "/save", "").await;
        assert!(matches!(cmd, Cmd::Say(ref v) if v[0].contains("用法")));
        cleanup(&s);
    }

    /// `/status` 与 `/context` 里的数字来自真消息, 不是编的
    #[tokio::test]
    async fn status_and_context_report_real_numbers() {
        let mut s = sess();
        push(&mut s, "user", "12345678");
        push(&mut s, "assistant", "12345678");
        let st = format!("{:?}", run(&mut s, "/status", "").await);
        assert!(st.contains("2 条消息"), "{st}");
        assert!(st.contains("≈4 tokens"), "{st}");
        let ctx = format!("{:?}", run(&mut s, "/context", "all").await);
        assert!(ctx.contains("user") && ctx.contains("assistant"), "{ctx}");
        cleanup(&s);
    }

    /// `/sessions` + `/resume` 真能列出来再恢复
    #[tokio::test]
    async fn sessions_list_and_resume() {
        let mut a = sess();
        a.title = "甲".into();
        push(&mut a, "user", "甲的消息");
        a.save().unwrap();
        let mut b = sess();
        b.dir = a.dir.clone();
        push(&mut b, "user", "乙的消息");
        b.save().unwrap();

        // 空参数 = 开选择窗口 (终端层画); 文本清单走带参数的形式 (脚本/管道友好)
        let picked = format!("{:?}", run(&mut b, "/sessions", "").await);
        assert!(picked.contains("Pick(Sessions)"), "{picked}");
        let listed = format!("{:?}", run(&mut b, "/sessions", "list").await);
        assert!(listed.contains(&a.id), "{listed}");
        // 序号能定位 (与列表同序): 1 号就是最近的那个
        let by_num = format!("{:?}", run(&mut b, "/resume", "1").await);
        assert!(by_num.contains("已恢复"), "{by_num}");

        let resumed = format!("{:?}", run(&mut b, "/resume", "甲").await);
        assert!(resumed.contains("已恢复"), "{resumed}");
        assert_eq!(b.messages[0].content, "甲的消息");
        cleanup(&a);
    }

    /// `/quit --delete` 真删会话文件; 不带的只是保存
    #[tokio::test]
    async fn quit_can_delete_session_file() {
        let mut s = sess();
        push(&mut s, "user", "x");
        s.save().unwrap();
        let path = s.path();
        assert!(path.exists());
        let cmd = run(&mut s, "/quit", "--delete").await;
        assert_eq!(cmd, Cmd::Quit { delete: true });
        assert!(!path.exists(), "--delete 要真删");
        cleanup(&s);
    }

    /// `/title` 空参数是查看, 有参数才改
    #[tokio::test]
    async fn title_show_and_set() {
        let mut s = sess();
        assert!(matches!(run(&mut s, "/title", "").await, Cmd::Say(ref v) if v[0].contains("当前标题")));
        let _ = run(&mut s, "/title", "新名字").await;
        assert_eq!(s.title, "新名字");
        cleanup(&s);
    }

    /// `/image` 不存在的路径必须报错 (不许假装附加成功)
    #[tokio::test]
    async fn image_rejects_missing_path() {
        let mut s = sess();
        let cmd = run(&mut s, "/image", "/nope/x.png").await;
        assert!(matches!(cmd, Cmd::Say(ref v) if v[0].contains("没有这个文件")));
        assert!(s.attachments.is_empty());
        cleanup(&s);
    }

    /// 附件**真进模型**: build_user_message 把 png 读成 base64 data URL 塞进 images
    #[tokio::test]
    async fn attachments_become_data_urls_in_the_message() {
        let mut s = sess();
        s.model = "gpt-4o".into(); // 已知视觉模型, 闸放行
        let png = s.dir.join("t.png");
        std::fs::write(&png, [0x89u8, b'P', b'N', b'G', 0, 0, 0]).unwrap();
        s.attachments.push(png.display().to_string());
        let m = s.build_user_message("看这张").unwrap();
        assert_eq!(m.images.len(), 1);
        assert!(m.images[0].starts_with("data:image/png;base64,"), "{}", m.images[0]);
        // base64 可解回原字节
        use base64::Engine as _;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(m.images[0].trim_start_matches("data:image/png;base64,"))
            .unwrap();
        assert_eq!(raw, vec![0x89u8, b'P', b'N', b'G', 0, 0, 0]);
        assert!(m.content.contains("看这张") && m.content.contains("@"));
        assert!(s.attachments.is_empty(), "发完就清");
        cleanup(&s);
    }

    /// 视觉闸: 默认纯文本模型 + 附件 ⇒ 拦下且**附件保留** (换模型后可直接重试)
    #[tokio::test]
    async fn vision_gate_keeps_attachments_on_refusal() {
        let mut s = sess(); // deepseek-chat
        let png = s.dir.join("t.png");
        std::fs::write(&png, b"PNG").unwrap();
        s.attachments.push(png.display().to_string());
        let err = s.build_user_message("看图").unwrap_err();
        assert!(err.contains("BOLLOON_VISION"), "{err}");
        assert_eq!(s.attachments.len(), 1, "拒绝时附件不许丢");
        // 强制开关放行
        unsafe { std::env::set_var("BOLLOON_VISION", "1") };
        let m = s.build_user_message("看图").unwrap();
        unsafe { std::env::remove_var("BOLLOON_VISION") };
        assert_eq!(m.images.len(), 1);
        cleanup(&s);
    }

    /// 目标会**每轮都带上** (含子条件); pause 之后不带
    #[tokio::test]
    async fn goal_is_prepended_to_every_outgoing_message() {
        let mut s = sess();
        let _ = run(&mut s, "/goal", "把支付跑通").await;
        let _ = run(&mut s, "/subgoal", "先过 x402").await;
        let m = s.build_user_message("继续").unwrap();
        assert!(m.content.starts_with("【当前目标】把支付跑通"), "{}", m.content);
        assert!(m.content.contains("1. 先过 x402"));
        let _ = run(&mut s, "/goal", "pause").await;
        let m2 = s.build_user_message("继续").unwrap();
        assert!(!m2.content.contains("【当前目标】"), "{}", m2.content);
        cleanup(&s);
    }

    /// `/queue` 全套: 排队/列表/编辑/移动/删除/清空
    #[tokio::test]
    async fn queue_full_lifecycle() {
        let mut s = sess();
        let _ = run(&mut s, "/queue", "第一件事").await;
        let _ = run(&mut s, "/queue", "第二件事").await;
        let listed = format!("{:?}", run(&mut s, "/queue", "list").await);
        assert!(listed.contains("第一件事") && listed.contains("第二件事"), "{listed}");
        let _ = run(&mut s, "/queue", "edit 1 改成别的").await;
        assert_eq!(s.queue[0], "改成别的");
        let _ = run(&mut s, "/queue", "move 2 1").await;
        assert_eq!(s.queue[0], "第二件事");
        let _ = run(&mut s, "/queue", "rm 2").await; // 删掉"改成别的"
        assert_eq!(s.queue.len(), 1);
        // 调度: 取走即消费
        let item = s.next_scheduled(now_ms()).unwrap();
        assert!(matches!(item, Scheduled::Queue(ref t) if t == "第二件事"));
        assert!(s.next_scheduled(now_ms()).is_none(), "取完就没了");
        cleanup(&s);
    }

    /// 轮末调度顺序由 busy 模式定: steer 默认插话优先; queue 模式排队优先; interrupt 全停
    #[tokio::test]
    async fn scheduler_order_follows_busy_mode() {
        let mut s = sess();
        let _ = run(&mut s, "/queue", "排队的事").await;
        let _ = run(&mut s, "/steer", "插话").await;
        // 默认 steer: 插话先
        match s.next_scheduled(now_ms()) {
            Some(Scheduled::Steer(t)) => assert_eq!(t, "插话"),
            other => panic!("要 Steer: {other:?}"),
        }
        match s.next_scheduled(now_ms()) {
            Some(Scheduled::Queue(t)) => assert_eq!(t, "排队的事"),
            other => panic!("要 Queue: {other:?}"),
        }
        // queue 模式: 排队先
        let _ = run(&mut s, "/queue", "又一件").await;
        let _ = run(&mut s, "/steer", "又一插话").await;
        let _ = run(&mut s, "/busy", "queue").await;
        assert!(matches!(s.next_scheduled(now_ms()), Some(Scheduled::Queue(_))));
        assert!(matches!(s.next_scheduled(now_ms()), Some(Scheduled::Steer(_))));
        // interrupt: 全停 (东西还在, 不消费)
        let _ = run(&mut s, "/queue", "再一件").await;
        let _ = run(&mut s, "/busy", "interrupt").await;
        assert!(s.next_scheduled(now_ms()).is_none());
        assert_eq!(s.queue.len(), 1, "interrupt 只是暂停, 不许丢东西");
        cleanup(&s);
    }

    /// `/loop`: 解析间隔/次数, 调度到点触发并自动排下一次, 次数用完收摊
    #[tokio::test]
    async fn loop_parses_fires_and_expires() {
        assert_eq!(parse_duration("30s"), Some(30_000));
        assert_eq!(parse_duration("5m"), Some(300_000));
        assert_eq!(parse_duration("1h"), Some(3_600_000));
        assert_eq!(parse_duration("90"), Some(90_000), "裸数字 = 秒");
        assert_eq!(parse_duration("3x"), None);

        let mut s = sess();
        let _ = run(&mut s, "/loop", "10s 汇报进度 --times 2").await;
        let l = s.loop_job.as_ref().unwrap();
        assert_eq!(l.interval_ms, 10_000);
        assert_eq!(l.runs_left, Some(2));
        // 建完立刻到点 (next_run = now) ⇒ 触发
        let item = s.next_scheduled(now_ms());
        assert!(matches!(item, Some(Scheduled::Loop(ref t)) if t == "汇报进度"));
        assert_eq!(s.loop_job.as_ref().unwrap().runs_left, Some(1));
        // 再触发一次 ⇒ 次数用完收摊
        s.loop_job.as_mut().unwrap().next_run_ms = 0;
        let _ = s.next_scheduled(now_ms());
        assert!(s.loop_job.is_none(), "次数用完且无 --until ⇒ 收摊");
        // stop 清掉
        let _ = run(&mut s, "/loop", "1m 再来").await;
        let _ = run(&mut s, "/loop", "stop").await;
        assert!(s.loop_job.is_none());
        cleanup(&s);
    }

    /// `/snapshot` create → list → restore → prune 全链 (真复制真恢复)
    #[tokio::test]
    async fn snapshot_create_restore_prune() {
        let mut s = sess();
        let home = s.dir.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("skills.json"), br#"{"v":1}"#).unwrap();
        std::fs::create_dir_all(home.join("config")).unwrap();
        std::fs::write(home.join("config").join("llm-config.json"), b"{}").unwrap();

        // create
        let out = format!("{:?}", run(&mut s, "/snapshot", "create 测试").await);
        assert!(out.contains("快照"), "{out}");
        let snaps = s.snapshot_list();
        assert_eq!(snaps.len(), 1);
        // 快照内容与原文件一致
        let snap_file = s.snapshot_dir().join(&snaps[0]).join("skills.json");
        assert_eq!(std::fs::read(&snap_file).unwrap(), b"{\"v\":1}");

        // 改坏原文件 → restore → 恢复
        std::fs::write(home.join("skills.json"), b"broken").unwrap();
        let out = format!("{:?}", run(&mut s, "/snapshot", &format!("restore {}", snaps[0])).await);
        assert!(out.contains("已从"), "{out}");
        assert_eq!(std::fs::read(home.join("skills.json")).unwrap(), b"{\"v\":1}");

        // /rollback 1 = 恢复最新
        std::fs::write(home.join("skills.json"), b"broken2").unwrap();
        let _ = run(&mut s, "/rollback", "1").await;
        assert_eq!(std::fs::read(home.join("skills.json")).unwrap(), b"{\"v\":1}");

        // prune: 只造 1 个, 不该删
        let out = format!("{:?}", run(&mut s, "/snapshot", "prune").await);
        assert!(out.contains("没删"), "{out}");
        cleanup(&s);
    }

    /// `/skills` 真读技能库; 空库/缺文件都如实说
    #[tokio::test]
    async fn skills_lists_real_registry() {
        let mut s = sess();
        let sp = s.skills_path();
        std::fs::create_dir_all(sp.parent().unwrap()).unwrap();
        // 空文件 → 空库
        std::fs::write(&sp, b"").unwrap();
        let out = format!("{:?}", run(&mut s, "/skills", "").await);
        assert!(out.contains("空"), "{out}");
        // 放一条真技能 (走 promote, 与 dream 同一条路)
        let mut ev = bolloon_agent::skills_runtime::SkillEvolver::new();
        let cand = ev.distill("先做最小版本\n大而全首版从未按时交付", "run-1").unwrap();
        ev.promote(&cand, 1).unwrap();
        ev.save_json(&sp).unwrap();
        let out = format!("{:?}", run(&mut s, "/skills", "").await);
        assert!(out.contains("先做最小版本"), "{out}");
        // /help skills 同一口
        let out = format!("{:?}", run(&mut s, "/help", "skills").await);
        assert!(out.contains("先做最小版本"), "{out}");
        cleanup(&s);
    }

    /// Jobs: spawn → 列表 → stop_all (不真打网络: 连不上就 failed/aborted, 状态机要对)
    #[tokio::test]
    async fn jobs_spawn_list_stop() {
        let jobs = Jobs::new();
        let llm = Arc::new(bolloon_llm::LlmRuntime::new(
            vec![bolloon_llm::ProviderConfig {
                id: "env".into(),
                base_url: "http://127.0.0.1:1/v1".into(), // 必然连不上
                api_key: None,
                default_model: "m".into(),
            }],
            1,
        ));
        let dir = std::env::temp_dir().join(format!("bolloon-jobs-{}", std::process::id()));
        let id = jobs.spawn(Arc::clone(&llm), "m".into(), "后台跑一件事".into(), dir.clone());
        assert!(id.starts_with("bg-"));
        // 等任务失败落盘 (连不上, 很快)
        for _ in 0..50 {
            if jobs.list().iter().any(|j| j.status != "running") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let all = jobs.list();
        assert_eq!(all.len(), 1);
        assert!(all[0].prompt_head.contains("后台跑一件事"), "{:?}", all[0]);
        // 文件真写了 (含失败原因)
        let body = std::fs::read_to_string(&all[0].path).unwrap();
        assert!(body.contains("后台跑一件事"));
        assert_eq!(jobs.stop_all(), 0, "已经结束的任务不算停");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 标了 Ready 就必须有实现 —— 真跑一遍全部 Ready 命令, 不许出现"没接实现"
    #[tokio::test]
    async fn every_ready_command_has_an_impl() {
        let mut s = sess();
        let mut bad: Vec<String> = Vec::new();
        for sp in slash::specs().iter().filter(|s| s.status.is_ready()) {
            // 只跑不会起交互/真网络的分支: 编辑器/更新/后台跑 在测试里跳过
            if matches!(sp.name, "/prompt" | "/compose" | "/update" | "/bg") {
                continue;
            }
            let cmd = s.exec(&ctx(&s), sp, "").await;
            let text = format!("{cmd:?}");
            if text.contains("没接实现") {
                bad.push(sp.name.to_string());
            }
        }
        assert!(bad.is_empty(), "这些 Ready 命令没有实现: {bad:?}");
        cleanup(&s);
    }
}
