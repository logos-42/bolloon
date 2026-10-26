//! chat_command.rs — `/命令` 的**真实现** (文案与可用性在 `slash.rs`)
//!
//! 分层: `slash` 只管"有哪些命令、叫什么、能不能用"; 本文件只管"能用的时候它到底做什么"。
//! `ChatSession` 持有会话本体 (消息 / 标题 / 模型 / 附件) 与落盘目录 (**可注入**, 便于测试),
//! `exec` 返回一个 `Cmd` 告诉 chat 循环下一步干什么 —— 这样命令逻辑不用碰终端。
//!
//! 纪律:
//!   · 做不到就 `slash::Status::Planned/Na` 说清楚, **不在这里假装成功**;
//!   · 会话落盘 `0600` (对话里有私事);
//!   · 所有"打印"走 `Cmd::Say(Vec<String>)`, 由调用方决定进 transcript 还是 println。

use bolloon_llm::ChatMessage;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::slash::{self, Spec};

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
}

#[derive(Serialize, Deserialize)]
struct Persisted {
    id: String,
    title: String,
    model: String,
    channel: String,
    created_ms: u128,
    messages: Vec<ChatMessage>,
}

pub struct ChatSession {
    /// 会话库根目录 (`<home>/chat`); 测试里注入临时目录
    pub dir: PathBuf,
    pub id: String,
    pub title: String,
    pub model: String,
    pub channel: String,
    pub messages: Vec<ChatMessage>,
    /// 下一条消息要带上的附件 (`/image` `/paste`)
    pub attachments: Vec<String>,
    pub created_ms: u128,
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
            dir,
            id: new_id(now),
            title: String::new(),
            model: model.to_string(),
            channel: channel.to_string(),
            messages: Vec::new(),
            attachments: Vec::new(),
            created_ms: now,
        };
        s.id = s.unique_id();
        s.title = default_title(&s.id);
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

    pub fn save(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(self.sessions_dir())?;
        let p = Persisted {
            id: self.id.clone(),
            title: self.title.clone(),
            model: self.model.clone(),
            channel: self.channel.clone(),
            created_ms: self.created_ms,
            messages: self.messages.clone(),
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
        self.title = match name.map(str::trim).filter(|s| !s.is_empty()) {
            Some(n) => n.to_string(),
            None => default_title(&self.id),
        };
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
            self.model = parsed.model;
            self.channel = parsed.channel;
            self.created_ms = parsed.created_ms;
            self.messages = parsed.messages;
            self.attachments.clear();
            return Ok(());
        }
        Err(format!("找不到会话 “{key}” (用 /sessions 看有哪些)"))
    }

    fn find(&self, key: &str) -> Option<PathBuf> {
        let direct = self.sessions_dir().join(format!("{key}.json"));
        if direct.exists() {
            return Some(direct);
        }
        let want = key.to_lowercase();
        for (id, title, _) in self.list() {
            if id.to_lowercase() == want || title.to_lowercase() == want {
                return Some(self.sessions_dir().join(format!("{id}.json")));
            }
        }
        None
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

    /// `/undo N` — 回退 N 轮, 返回被回退到的**那条用户消息** (放回输入框)
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
            out.push_str(&format!("**{who}**\n\n{}\n\n", self.body_of(m, redact)));
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

    // ── 命令分发 ───────────────────────────────────────────
    pub fn exec(&mut self, spec: &Spec, args: &str) -> Cmd {
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
                    let _ = self.save();
                    Cmd::Say(vec![format!("✓ 标题已设为 “{name}”")])
                }
            }
            "/worktree" => Cmd::Say(git_worktree(args)),
            "/plan" => Cmd::Say(self.plan_cmd(args)),
            "/resume" => {
                let key = args.trim();
                if key.is_empty() {
                    Cmd::Say(self.list_lines("用 /resume <name|id> 恢复"))
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
            "/sessions" => Cmd::Say(self.list_lines("用 /resume <name|id> 恢复")),
            "/compress" => Cmd::Say(self.compress_cmd(args)),
            "/status" => Cmd::Say(self.status_lines()),
            "/context" => Cmd::Say(self.context_lines(args)),
            "/config" => Cmd::Say(config_lines()),
            "/model" => {
                let m = args.trim();
                if m.is_empty() {
                    Cmd::Say(vec![format!("当前模型: {} (只影响本会话, 用 /model <名字> 切)", self.model)])
                } else {
                    self.model = m.to_string();
                    let _ = self.save();
                    Cmd::Say(vec![format!("✓ 本会话模型已切到 {m}")])
                }
            }
            "/diff" => Cmd::Say(git_diff(args)),
            "/profile" => Cmd::Say(self.profile_lines()),
            "/diff-session" => Cmd::Say(vec!["chat 不记文件改动, 用 /diff 看 git".to_string()]),
            "/copy" => Cmd::Say(self.copy_cmd(args)),
            "/paste" => Cmd::Say(self.paste_cmd()),
            "/image" => Cmd::Say(self.image_cmd(args)),
            "/update" => Cmd::Update { install: args.trim() == "install" },
            "/version" | "/v" => Cmd::Say(vec![format!(
                "bolloon {} (rust native) · tui {}",
                env!("CARGO_PKG_VERSION"),
                env!("CARGO_PKG_VERSION")
            )]),
            "/help" => Cmd::Say(help_cmd(args)),
            "/quit" | "/exit" => {
                let delete = args.split_whitespace().any(|a| a == "--delete");
                if delete {
                    let _ = std::fs::remove_file(self.path());
                } else {
                    let _ = self.save();
                }
                Cmd::Quit { delete }
            }
            // 注册表里标了 Ready 但这里没接 ⇒ 明确报错 (宁可红, 不假装)
            other => Cmd::Say(vec![format!("✗ {other} 标了可用但没接实现 (这是 bug, 请报)")]),
        }
    }

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
        for (id, title, n) in all.iter().take(20) {
            let mark = if *id == self.id { "← 当前" } else { "" };
            out.push(format!("  {id}  {title}  ({n} 条) {mark}"));
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

    fn compress_cmd(&mut self, args: &str) -> Vec<String> {
        let mut it = args.split_whitespace();
        let first = it.next().unwrap_or("");
        match first {
            "--preview" | "--dry-run" => {
                let before = self.est_tokens();
                let n = it.next().and_then(|s| s.parse::<usize>().ok()).unwrap_or(4);
                let mut clone = Self {
                    dir: self.dir.clone(),
                    id: self.id.clone(),
                    title: self.title.clone(),
                    model: self.model.clone(),
                    channel: self.channel.clone(),
                    messages: self.messages.clone(),
                    attachments: vec![],
                    created_ms: self.created_ms,
                };
                let (removed, kept) = clone.compress(n);
                if removed == 0 {
                    return vec![format!("上下文只有 {} 轮, 不用压缩", self.turns())];
                }
                vec![
                    format!("预览: 保留最近 {n} 轮 ⇒ 丢掉 {removed} 条, 留 {kept} 条"),
                    format!("  估算 {} → {} tokens (**只是截断, 不摘要**)", before, clone.est_tokens()),
                ]
            }
            "focus" => vec![
                "✗ focus 需要模型摘要 (chat 没接摘要器)".to_string(),
                "  可以先用 /compress here <N> 只留最近 N 轮".to_string(),
            ],
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
                        format!("  估算 {} → {} tokens · 这是**截断**不是摘要, 丢的内容不在了", before, self.est_tokens()),
                    ]
                }
            }
            other => vec![
                format!("✗ 不认识的参数 “{other}”"),
                "  用法: /compress [here [N] | focus <topic> | --preview]".to_string(),
            ],
        }
    }

    fn status_lines(&self) -> Vec<String> {
        let mut out = vec![
            format!("会话 {} · {}", self.id, self.title),
            format!(
                "  {} 条消息 / {} 轮 · 渠道 {} · 模型 {}",
                self.messages.len(),
                self.turns(),
                self.channel,
                self.model
            ),
            format!("  上下文 ≈ {} 字符 ≈{} tokens (粗估 字符/4)", self.chars(), self.est_tokens()),
            format!("  落盘 {}", self.path().display()),
        ];
        if !self.attachments.is_empty() {
            out.push(format!("  待发附件 {} 个: {}", self.attachments.len(), self.attachments.join(", ")));
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
                out.push(format!(
                    "   {:>3}. {:<9} {:>6} 字符  {}",
                    i + 1,
                    m.role,
                    m.content.chars().count(),
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
                    format!("  下一条消息会带上 (共 {} 个附件)", self.attachments.len()),
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
            format!("  下一条消息会带上 (共 {} 个附件)", self.attachments.len()),
        ]
    }

    /// 发送前把附件拼进正文 (单模态 content 的现实做法: 给路径, 不冒充多模态)
    pub fn outgoing(&self, text: &str) -> String {
        if self.attachments.is_empty() {
            return text.to_string();
        }
        let mut out = text.to_string();
        for a in &self.attachments {
            out.push_str(&format!("\n[图片] @{a}"));
        }
        out
    }
}

fn help_cmd(args: &str) -> Vec<String> {
    let a = args.trim();
    if a == "skills" {
        return vec!["chat 还没挂技能循环 (/skills 看技能库)".to_string()];
    }
    if a.is_empty() {
        return slash::help_lines(None);
    }
    if let Some(sp) = slash::find(a) {
        return slash::detail_lines(sp);
    }
    slash::help_lines(Some(a))
}

fn config_lines() -> Vec<String> {
    let provider = std::env::var("BOLLOON_PROVIDER").unwrap_or_else(|_| "(未设, 走默认)".into());
    let model = std::env::var("BOLLOON_MODEL").unwrap_or_else(|_| "deepseek-chat".into());
    let base = std::env::var("BOLLOON_BASE_URL").unwrap_or_else(|_| "(provider 自带)".into());
    let has_key = std::env::var("BOLLOON_API_KEY").map(|k| !k.trim().is_empty()).unwrap_or(false);
    vec![
        format!("provider {provider}"),
        format!("model    {model}"),
        format!("base_url {base}"),
        format!("api_key  {}", if has_key { "有 (env, 不显示)" } else { "没有" }),
        "改配置: env 或 ~/.bolloon/rust/config/ (chat 里用 /model 只改本会话)".to_string(),
    ]
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

fn default_title(id: &str) -> String {
    // id 形如 `20261026-031338-628` ⇒ 标题用时间部分, 比截尾巴好认
    match id.split('-').nth(1) {
        Some(t) if t.len() == 6 => {
            let b: Vec<char> = t.chars().collect();
            format!("会话 {}:{}:{}", b[0..2].iter().collect::<String>(), b[2..4].iter().collect::<String>(), b[4..6].iter().collect::<String>())
        }
        _ => format!("会话 {id}"),
    }
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

    fn sess() -> ChatSession {
        let dir = std::env::temp_dir().join(format!(
            "bolloon-chat-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        ChatSession::with_dir(dir, "deepseek-chat", "test")
    }

    fn push(s: &mut ChatSession, role: &str, text: &str) {
        s.messages.push(ChatMessage {
            role: role.into(),
            content: text.into(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        });
    }

    /// `/new` 真的换 ID 并清消息; 落盘能读回
    #[test]
    fn new_session_rotates_id_and_persists() {
        let mut s = sess();
        push(&mut s, "user", "你好");
        let old = s.id.clone();
        let cmd = s.exec(slash::find("/new").unwrap(), "谈需求");
        assert!(matches!(cmd, Cmd::Say(_)));
        assert_ne!(s.id, old);
        assert!(s.messages.is_empty());
        assert_eq!(s.title, "谈需求");
        assert!(s.path().exists(), "新会话要落盘");
        let mut other = sess();
        other.dir = s.dir.clone();
        other.load_into(&s.id).unwrap();
        assert_eq!(other.title, "谈需求");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// `/undo 1` 少一轮并把那条消息**放回输入框** (不是直接重发)
    #[test]
    fn undo_prefills_the_turn_you_backed_to() {
        let mut s = sess();
        push(&mut s, "user", "一");
        push(&mut s, "assistant", "回一");
        push(&mut s, "user", "二");
        push(&mut s, "assistant", "回二");
        let cmd = s.exec(slash::find("/undo").unwrap(), "1");
        assert_eq!(cmd, Cmd::Prefill("二".into()));
        assert_eq!(s.messages.len(), 2, "只该回退最后一轮");

        let cmd2 = s.exec(slash::find("/undo").unwrap(), "5");
        assert!(matches!(cmd2, Cmd::Say(ref v) if v[0].contains("回退不了")));
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// `/retry` 丢掉最后一条回复, 重发用户那条
    #[test]
    fn retry_resends_last_user_message() {
        let mut s = sess();
        push(&mut s, "user", "问题");
        push(&mut s, "assistant", "半截回复");
        let cmd = s.exec(slash::find("/retry").unwrap(), "");
        assert_eq!(cmd, Cmd::Send("问题".into()));
        assert!(s.messages.is_empty(), "重发前要把这条也摘掉 (由发送逻辑重新入列)");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// `/compress here 1` 只留最后一轮, 且如实说明是截断
    #[test]
    fn compress_keeps_recent_turns_and_says_it_is_truncation() {
        let mut s = sess();
        for i in 1..=5 {
            push(&mut s, "user", &format!("问{i}"));
            push(&mut s, "assistant", &format!("答{i}"));
        }
        let out = s.exec(slash::find("/compress").unwrap(), "here 1");
        let text = format!("{out:?}");
        assert!(text.contains("截断"), "{text}");
        assert_eq!(s.turns(), 1);
        assert!(s.messages[0].content.contains("问5"));
        // --preview 不改动
        let before = s.messages.len();
        let _ = s.exec(slash::find("/compress").unwrap(), "--preview 1");
        assert_eq!(s.messages.len(), before, "preview 不许动上下文");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// `/save` 三种格式都真出文件; redact 会把像私钥的内容打码
    #[test]
    fn save_exports_three_formats_and_redacts() {
        let mut s = sess();
        let secret = "a".repeat(64);
        push(&mut s, "user", "普通一句");
        push(&mut s, "assistant", &secret);
        for fmt in ["json", "md", "html"] {
            let cmd = s.exec(slash::find("/save").unwrap(), fmt);
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
        let cmd = s.exec(slash::find("/save").unwrap(), "md out-redact.md redact");
        assert!(matches!(cmd, Cmd::Say(ref v) if v.join(" ").contains("已脱敏")));
        let body = std::fs::read_to_string("out-redact.md").unwrap();
        assert!(!body.contains(&secret), "redact 必须真的打码");
        let _ = std::fs::remove_file("out-redact.md");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// 裸 `/save` 只给用法 (不许静默失败)
    #[test]
    fn bare_save_shows_usage() {
        let mut s = sess();
        let cmd = s.exec(slash::find("/save").unwrap(), "");
        assert!(matches!(cmd, Cmd::Say(ref v) if v[0].contains("用法")));
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// `/status` 与 `/context` 里的数字来自真消息, 不是编的
    #[test]
    fn status_and_context_report_real_numbers() {
        let mut s = sess();
        push(&mut s, "user", "12345678");
        push(&mut s, "assistant", "12345678");
        let st = format!("{:?}", s.exec(slash::find("/status").unwrap(), ""));
        assert!(st.contains("2 条消息"), "{st}");
        assert!(st.contains("≈4 tokens"), "{st}");
        let ctx = format!("{:?}", s.exec(slash::find("/context").unwrap(), "all"));
        assert!(ctx.contains("user") && ctx.contains("assistant"), "{ctx}");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// `/sessions` + `/resume` 真能列出来再恢复
    #[test]
    fn sessions_list_and_resume() {
        let mut a = sess();
        a.title = "甲".into();
        push(&mut a, "user", "甲的消息");
        a.save().unwrap();
        let mut b = sess();
        b.dir = a.dir.clone();
        push(&mut b, "user", "乙的消息");
        b.save().unwrap();

        let listed = format!("{:?}", b.exec(slash::find("/sessions").unwrap(), ""));
        assert!(listed.contains(&a.id), "{listed}");

        let resumed = format!("{:?}", b.exec(slash::find("/resume").unwrap(), "甲"));
        assert!(resumed.contains("已恢复"), "{resumed}");
        assert_eq!(b.messages[0].content, "甲的消息");
        let _ = std::fs::remove_dir_all(&a.dir);
    }

    /// `/quit --delete` 真删会话文件; 不带的只是保存
    #[test]
    fn quit_can_delete_session_file() {
        let mut s = sess();
        push(&mut s, "user", "x");
        s.save().unwrap();
        let path = s.path();
        assert!(path.exists());
        let cmd = s.exec(slash::find("/quit").unwrap(), "--delete");
        assert_eq!(cmd, Cmd::Quit { delete: true });
        assert!(!path.exists(), "--delete 要真删");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// `/title` 空参数是查看, 有参数才改
    #[test]
    fn title_show_and_set() {
        let mut s = sess();
        assert!(matches!(s.exec(slash::find("/title").unwrap(), ""), Cmd::Say(ref v) if v[0].contains("当前标题")));
        let _ = s.exec(slash::find("/title").unwrap(), "新名字");
        assert_eq!(s.title, "新名字");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// `/image` 不存在的路径必须报错 (不许假装附加成功)
    #[test]
    fn image_rejects_missing_path() {
        let mut s = sess();
        let cmd = s.exec(slash::find("/image").unwrap(), "/nope/x.png");
        assert!(matches!(cmd, Cmd::Say(ref v) if v[0].contains("没有这个文件")));
        assert!(s.attachments.is_empty());
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// 附件会拼进下一条消息 (但如实标 `[图片] @路径`, 不冒充多模态)
    #[test]
    fn attachments_are_appended_to_outgoing_text() {
        let mut s = sess();
        s.attachments.push("/tmp/a.png".into());
        let out = s.outgoing("看图");
        assert!(out.contains("看图") && out.contains("[图片] @/tmp/a.png"));
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// `/plan` 真写文件, 且明说没执行
    #[test]
    fn plan_writes_markdown_and_says_not_executed() {
        let mut s = sess();
        let cmd = s.exec(slash::find("/plan").unwrap(), "接入支付");
        let text = format!("{cmd:?}");
        assert!(text.contains("计划已写"), "{text}");
        assert!(text.contains("没执行"), "{text}");
        let dir = s.dir.join("plans");
        assert!(std::fs::read_dir(&dir).unwrap().next().is_some());
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// `/help` 无参出全表, 带名字出细节, 带关键词就过滤
    #[test]
    fn help_variants() {
        let mut s = sess();
        let all = format!("{:?}", s.exec(slash::find("/help").unwrap(), ""));
        assert!(all.contains("/new") && all.contains("/exit"));
        let one = format!("{:?}", s.exec(slash::find("/help").unwrap(), "/undo"));
        assert!(one.contains("用法: /undo"), "{one}");
        let filtered = format!("{:?}", s.exec(slash::find("/help").unwrap(), "worktree"));
        assert!(filtered.contains("/worktree") && !filtered.contains("/handoff"));
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    /// 标了 Ready 就必须有实现 —— 真跑一遍全部 Ready 命令, 不许出现"没接实现"
    #[test]
    fn every_ready_command_has_an_impl() {
        let mut s = sess();
        let mut bad: Vec<String> = Vec::new();
        for sp in slash::specs().iter().filter(|s| s.status.is_ready()) {
            // 只跑不会起交互/网络的分支: 编辑器/更新在测试里跳过
            if matches!(sp.name, "/prompt" | "/compose" | "/update") {
                continue;
            }
            let cmd = s.exec(sp, "");
            let text = format!("{cmd:?}");
            if text.contains("没接实现") {
                bad.push(sp.name.to_string());
            }
        }
        assert!(bad.is_empty(), "这些 Ready 命令没有实现: {bad:?}");
        let _ = std::fs::remove_dir_all(&s.dir);
    }
}
