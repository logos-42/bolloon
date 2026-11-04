//! 信念层 — agent **自己设计**的信念与长短期目标, 并据此决定做什么
//!
//! 与既有模块的分工 (刻意不重复):
//! - `todo.rs` 是**一轮之内**的计划底稿 (pending/in_progress, 同时只许一个);
//! - `goal.rs` 是**用户给的意图**投影成长期执行飞轮 (continuation 决策);
//! - 本模块是**智能体自己的**信念 (我认为世界/我自己/主人在怎样) + 由此派生的长短期目标。
//!   它先于 todo 存在, todo 是它落到某一天的样子。
//!
//! 为什么需要它: 主动性 (`initiative.rs`) 此前只判"该不该出手", 出手后干什么是空的 —
//! 只能复用"从世界意图补 skill"那一条路。有了信念层, 心跳才有**内容**:
//! 按自己的信念排序挑一个目标 → 落成 todo → 下一轮 system prompt 带着它继续干。
//!
//! 三条纪律:
//! 1. **信念可被证据推翻**: 置信度是 0..1 的数; 判断变了就退休重立, 不悄悄改。
//! 2. **目标必须有下一步**: 没有 `next_action` 的不许入库 (同 goal.rs "不许悬空")。
//! 3. **有上限**: 信念/目标各自封顶, 免得变成只写不读的日志坟场。
//!
//! 纯逻辑 + **SQLite 落盘** (`~/.bolloon/agent/beliefs.db`); 无网络、不读时钟 (时间由调用方传入)。
//!
//! 为什么不是 JSON 文件 (2026-11-06 改): 信念与目标是长期资产, 必须能按条件查 ——
//! 「哪条信念在支配哪些目标」「哪些久没被印证」「某目标推到哪」, 以及跟记忆库 join;
//! 整篇 JSON 重写既做不到查询, 又每写一条就把全部历史重新序列化一遍 (并发还会互撞)。
//! 老的 `beliefs.json` 只在库空时**一次性导入**, 原文件留档不删。

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// 信念条数上限 (超了拒绝写入, 让人先退休旧的 — 不是静默丢弃)
pub const MAX_BELIEFS: usize = 64;
/// 目标条数上限 (同上)
pub const MAX_COMMITMENTS: usize = 64;

/// 信念是关于什么的 (决定 prompt 里怎么措辞, 也便于人审)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BeliefKind {
    /// 关于我自己 (能力边界/习惯/弱点)
    SelfModel,
    /// 关于世界 (项目/技术/协作环境的判断)
    World,
    /// 关于主人 (偏好/节奏/在意什么)
    Owner,
    /// 关于手头的事 (某项目/某目标的现实约束)
    Work,
}

impl BeliefKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "self" | "self_model" | "我" => Some(BeliefKind::SelfModel),
            "world" | "世界" => Some(BeliefKind::World),
            "owner" | "主人" => Some(BeliefKind::Owner),
            "work" | "事" => Some(BeliefKind::Work),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            BeliefKind::SelfModel => "self",
            BeliefKind::World => "world",
            BeliefKind::Owner => "owner",
            BeliefKind::Work => "work",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            BeliefKind::SelfModel => "我",
            BeliefKind::World => "世界",
            BeliefKind::Owner => "主人",
            BeliefKind::Work => "事",
        }
    }
}

/// 信念从哪来 (自省 vs 主人明说权重不同; 也不许把推测冒充确认)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BeliefOrigin {
    /// 自己想明白的 (自省/复盘)
    SelfReasoned,
    /// 主人明说的
    OwnerStated,
    /// 从证据推断的 (允许, 但置信度低, 可被推翻)
    Inferred,
}

impl BeliefOrigin {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "self" | "self_reasoned" | "自省" => Some(BeliefOrigin::SelfReasoned),
            "owner" | "owner_stated" | "主人" => Some(BeliefOrigin::OwnerStated),
            "inferred" | "推断" => Some(BeliefOrigin::Inferred),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            BeliefOrigin::SelfReasoned => "self",
            BeliefOrigin::OwnerStated => "owner",
            BeliefOrigin::Inferred => "inferred",
        }
    }
}

/// 一条信念
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Belief {
    pub id: String,
    /// 一句话, 人可读 (要具体, 不写"要努力"这种空话)
    pub statement: String,
    pub kind: BeliefKind,
    pub origin: BeliefOrigin,
    /// 0..1
    pub confidence: f64,
    /// 支撑证据 (文件/回执/某轮对话) — 空 = 还只是猜想
    pub evidence: Vec<String>,
    pub created_ms: u64,
    pub updated_ms: u64,
    /// 退休 = 被推翻/不再成立; 留痕, 但不再参与排序与注入
    pub retired: bool,
}

/// 目标的时间尺度
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Horizon {
    Short,
    Long,
}

impl Horizon {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "short" | "短" | "短期" => Some(Horizon::Short),
            "long" | "长" | "长期" => Some(Horizon::Long),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Horizon::Short => "short",
            Horizon::Long => "long",
        }
    }
}

/// 目标状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitmentStatus {
    /// 立着, 还没动
    Open,
    /// 正在推
    Doing,
    /// 主动暂停 (等外部/等人)
    Paused,
    Done,
    Dropped,
}

impl CommitmentStatus {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "open" => Some(CommitmentStatus::Open),
            "doing" | "in_progress" => Some(CommitmentStatus::Doing),
            "paused" => Some(CommitmentStatus::Paused),
            "done" | "completed" => Some(CommitmentStatus::Done),
            "dropped" | "abandoned" => Some(CommitmentStatus::Dropped),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            CommitmentStatus::Open => "open",
            CommitmentStatus::Doing => "doing",
            CommitmentStatus::Paused => "paused",
            CommitmentStatus::Done => "done",
            CommitmentStatus::Dropped => "dropped",
        }
    }

    /// 还活着 (参与排序/注入)
    pub fn is_active(self) -> bool {
        matches!(self, CommitmentStatus::Open | CommitmentStatus::Doing | CommitmentStatus::Paused)
    }
}

/// 一个目标 (信念的应用)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Commitment {
    pub id: String,
    pub statement: String,
    pub horizon: Horizon,
    /// 为什么立这个目标 — 通常指向某条信念 id + 一句人话
    pub why: String,
    /// **下一步具体动作** (不许空; 空 = 愿望, 不是目标)
    pub next_action: String,
    pub status: CommitmentStatus,
    /// 0..100 (给人看的进度, 不当证据)
    pub progress: u8,
    /// 期望完成时刻 (Unix ms; None = 无期限)
    pub due_ms: Option<u64>,
    /// 支撑它的信念 id (可空)
    pub parent_belief: Option<String>,
    pub evidence: Vec<String>,
    pub created_ms: u64,
    pub updated_ms: u64,
}

/// 排序出来的"现在该做什么"
#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub commitment_id: String,
    pub statement: String,
    pub next_action: String,
    pub horizon: Horizon,
    pub score: f64,
    /// 为什么是它 (人可读, 讲清打分构成)
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeliefStore {
    #[serde(default = "store_version")]
    pub version: String,
    #[serde(default)]
    pub beliefs: Vec<Belief>,
    #[serde(default)]
    pub commitments: Vec<Commitment>,
    #[serde(default)]
    next_seq: u64,
}

fn store_version() -> String {
    "1.0.0".into()
}

impl Default for BeliefStore {
    fn default() -> Self {
        Self { version: store_version(), beliefs: Vec::new(), commitments: Vec::new(), next_seq: 0 }
    }
}

/// 写入类错误 (都要能落到工具回执里, 不许静默)
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum BeliefError {
    #[error("内容不能为空")]
    EmptyStatement,
    #[error("目标必须有具体的 next_action (没有下一步的是愿望, 不是目标)")]
    MissingNextAction,
    #[error("信念已达上限 {MAX_BELIEFS}, 先退休旧的")]
    BeliefsFull,
    #[error("目标已达上限 {MAX_COMMITMENTS}, 先收尾或放弃旧的")]
    CommitmentsFull,
    #[error("不存在: {0}")]
    NotFound(String),
    #[error("置信度须在 0..1 之间, 收到 {0}")]
    BadConfidence(f64),
}

impl BeliefStore {
    // ── 落盘 (SQLite) ────────────────────────────────────────────────
    /// 读库。传 `.json` 路径也自动指向旁边的 `.db` (老调用点零改动)。
    ///
    /// 库打不开/表坏了 ⇒ **空 store**, 绝不冒充"有信念"; 库空 ⇒ 尝试一次性导入老
    /// `beliefs.json` (原文件留档不删, 迁移失败不影响空库可用)。
    pub fn load(path: &Path) -> Self {
        let db = db_path(path);
        let store = match open_db(&db) {
            Ok(conn) => load_from_conn(&conn).unwrap_or_else(|e| {
                tracing::warn!(error = %e, db = %db.display(), "信念库读失败, 按空库处理");
                Self::default()
            }),
            Err(e) => {
                tracing::warn!(error = %e, db = %db.display(), "信念库打不开, 按空库处理");
                return Self::default();
            }
        };
        if !store.is_empty() {
            return store;
        }
        // 一次性迁移: 老 beliefs.json → beliefs.db
        let legacy = legacy_json_path(path);
        let Ok(raw) = std::fs::read_to_string(&legacy) else {
            return store;
        };
        let Ok(old) = serde_json::from_str::<BeliefStore>(&raw) else {
            tracing::warn!(path = %legacy.display(), "老 beliefs.json 解析失败, 不导入");
            return store;
        };
        if old.is_empty() {
            return store;
        }
        match old.save(&db) {
            Ok(()) => {
                tracing::info!(
                    beliefs = old.beliefs.len(),
                    commitments = old.commitments.len(),
                    "老 beliefs.json 已导入 beliefs.db (原文件留档)"
                );
                old
            }
            Err(e) => {
                tracing::warn!(error = %e, "老 beliefs.json 导入失败, 本次按空库");
                store
            }
        }
    }

    /// 写库: 一个事务里全量替换信念/目标 + 元信息 upsert。
    ///
    /// 语义与原来"整篇重写"一致 (调用方拿到的仍是完整快照), 但只碰自己这两张表,
    /// 不再把整段历史重新序列化, 也没有 tmp/rename 的并发互撞。
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let db = db_path(path);
        let mut conn = open_db(&db).map_err(io_err)?;
        save_to_conn(&mut conn, self).map_err(io_err)
    }

    /// 内容为空 (信念与目标都没有)
    pub fn is_empty(&self) -> bool {
        self.beliefs.is_empty() && self.commitments.is_empty()
    }

    // ── 信念 ──────────────────────────────────────────────────────────
    /// 立/更新一条信念。同一句 (trim + 忽略大小写) 已存在 ⇒ 合并证据、抬置信度, 不新增。
    /// 返回值: (id, 是否新建)
    pub fn upsert_belief(
        &mut self,
        statement: &str,
        kind: BeliefKind,
        origin: BeliefOrigin,
        confidence: Option<f64>,
        evidence: Option<&str>,
        now_ms: u64,
    ) -> Result<(String, bool), BeliefError> {
        let s = statement.trim();
        if s.is_empty() {
            return Err(BeliefError::EmptyStatement);
        }
        let conf = match confidence {
            Some(c) if !(0.0..=1.0).contains(&c) => return Err(BeliefError::BadConfidence(c)),
            Some(c) => c,
            None => match origin {
                BeliefOrigin::OwnerStated => 0.85,
                BeliefOrigin::SelfReasoned => 0.6,
                BeliefOrigin::Inferred => 0.4,
            },
        };
        let key = normalize(s);
        if let Some(b) = self.beliefs.iter_mut().find(|b| normalize(&b.statement) == key) {
            // 置信度只升不降 (要降就 retire 重立 — 免得悄悄改自己的判断)
            b.confidence = b.confidence.max(conf);
            b.updated_ms = now_ms;
            b.retired = false;
            if let Some(e) = evidence.map(str::trim).filter(|e| !e.is_empty()) {
                if !b.evidence.iter().any(|x| x == e) {
                    b.evidence.push(e.to_string());
                }
            }
            return Ok((b.id.clone(), false));
        }
        // 同一判断换个说法 (2-gram 近似) ⇒ 并入既有那条, 不新增回声条目。
        // 只在同类信念间比: "我" 与 "事" 说同一句话时是两件事的两面, 不算重复。
        let near = self.beliefs.iter().position(|b| {
            !b.retired && b.kind == kind && similarity(&b.statement, s) >= SIMILAR_THRESHOLD
        });
        if let Some(i) = near {
            let b = &mut self.beliefs[i];
            b.confidence = b.confidence.max(conf);
            b.updated_ms = now_ms;
            if let Some(e) = evidence.map(str::trim).filter(|e| !e.is_empty()) {
                if !b.evidence.iter().any(|x| x == e) {
                    b.evidence.push(e.to_string());
                }
            }
            return Ok((b.id.clone(), false));
        }
        let live = self.beliefs.iter().filter(|b| !b.retired).count();
        if live >= MAX_BELIEFS {
            return Err(BeliefError::BeliefsFull);
        }
        self.next_seq += 1;
        let id = format!("b-{}-{}", self.next_seq, short_hash(&key));
        self.beliefs.push(Belief {
            id: id.clone(),
            statement: s.to_string(),
            kind,
            origin,
            confidence: conf,
            evidence: evidence
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .map(|e| vec![e.to_string()])
                .unwrap_or_default(),
            created_ms: now_ms,
            updated_ms: now_ms,
            retired: false,
        });
        Ok((id, true))
    }

    /// 退休 (被推翻)。不删除: 改主意是事实, 该留痕。
    pub fn retire_belief(&mut self, id: &str, now_ms: u64) -> Result<(), BeliefError> {
        match self.beliefs.iter_mut().find(|b| b.id == id) {
            Some(b) => {
                b.retired = true;
                b.updated_ms = now_ms;
                Ok(())
            }
            None => Err(BeliefError::NotFound(id.into())),
        }
    }

    /// 活着的信念 (注入与排序只看这些)
    pub fn live_beliefs(&self) -> Vec<&Belief> {
        self.beliefs.iter().filter(|b| !b.retired).collect()
    }

    // ── 目标 ──────────────────────────────────────────────────────────
    /// 立/更新一个目标。同一句已存在 ⇒ 更新字段, 不新增。
    /// 返回值: (id, 是否新建)
    pub fn upsert_commitment(
        &mut self,
        statement: &str,
        horizon: Horizon,
        why: Option<&str>,
        next_action: &str,
        due_ms: Option<u64>,
        parent_belief: Option<&str>,
        now_ms: u64,
    ) -> Result<(String, bool), BeliefError> {
        let s = statement.trim();
        if s.is_empty() {
            return Err(BeliefError::EmptyStatement);
        }
        let nxt = next_action.trim();
        if nxt.is_empty() {
            return Err(BeliefError::MissingNextAction);
        }
        let key = normalize(s);
        if let Some(c) = self.commitments.iter_mut().find(|c| normalize(&c.statement) == key) {
            c.horizon = horizon;
            c.next_action = nxt.to_string();
            if let Some(w) = why.map(str::trim).filter(|w| !w.is_empty()) {
                c.why = w.to_string();
            }
            if due_ms.is_some() {
                c.due_ms = due_ms;
            }
            if let Some(p) = parent_belief.filter(|p| !p.trim().is_empty()) {
                c.parent_belief = Some(p.to_string());
            }
            c.updated_ms = now_ms;
            return Ok((c.id.clone(), false));
        }
        // 同一目标的另一种说法 (实测: "让主动性由信念驱动" 被写成 3 条 long 目标) ⇒ 并入既有的,
        // 顺手把新给的下一步/信念挂到那条上 —— 目标是"要推进的事", 不是"我说过的话"。
        let near = self.commitments.iter().position(|c| {
            c.status.is_active()
                && c.horizon == horizon
                && similarity(&c.statement, s) >= SIMILAR_THRESHOLD
        });
        if let Some(i) = near {
            let c = &mut self.commitments[i];
            c.next_action = nxt.to_string();
            if let Some(w) = why.map(str::trim).filter(|w| !w.is_empty()) {
                c.why = w.to_string();
            }
            if due_ms.is_some() {
                c.due_ms = due_ms;
            }
            if let Some(p) = parent_belief.filter(|p| !p.trim().is_empty()) {
                c.parent_belief = Some(p.to_string());
            }
            c.updated_ms = now_ms;
            return Ok((c.id.clone(), false));
        }
        let active = self.commitments.iter().filter(|c| c.status.is_active()).count();
        if active >= MAX_COMMITMENTS {
            return Err(BeliefError::CommitmentsFull);
        }
        self.next_seq += 1;
        let id = format!("g-{}-{}", self.next_seq, short_hash(&key));
        self.commitments.push(Commitment {
            id: id.clone(),
            statement: s.to_string(),
            horizon,
            why: why
                .map(str::trim)
                .filter(|w| !w.is_empty())
                .unwrap_or("我自己判断该做")
                .to_string(),
            next_action: nxt.to_string(),
            status: CommitmentStatus::Open,
            progress: 0,
            due_ms,
            parent_belief: parent_belief.filter(|p| !p.trim().is_empty()).map(str::to_string),
            evidence: Vec::new(),
            created_ms: now_ms,
            updated_ms: now_ms,
        });
        Ok((id, true))
    }

    /// 改状态 / 下一步 / 进度 / 追加证据 (都只写真给了的字段)
    pub fn update_commitment(
        &mut self,
        id: &str,
        status: Option<CommitmentStatus>,
        next_action: Option<&str>,
        progress: Option<u8>,
        evidence: Option<&str>,
        now_ms: u64,
    ) -> Result<(), BeliefError> {
        let c = match self.commitments.iter_mut().find(|c| c.id == id) {
            Some(c) => c,
            None => return Err(BeliefError::NotFound(id.into())),
        };
        if let Some(s) = status {
            c.status = s;
            if s == CommitmentStatus::Done {
                c.progress = 100;
            }
        }
        if let Some(n) = next_action.map(str::trim).filter(|n| !n.is_empty()) {
            c.next_action = n.to_string();
        }
        if let Some(p) = progress {
            c.progress = p.min(100);
        }
        if let Some(e) = evidence.map(str::trim).filter(|e| !e.is_empty()) {
            if !c.evidence.iter().any(|x| x == e) {
                c.evidence.push(e.to_string());
            }
        }
        c.updated_ms = now_ms;
        Ok(())
    }

    /// 活着的目标
    pub fn active_commitments(&self) -> Vec<&Commitment> {
        self.commitments.iter().filter(|c| c.status.is_active()).collect()
    }
}

// ────────────────────────── SQLite 落盘 ──────────────────────────

/// 信念库文件: 传 `.json` 路径也指向旁边的 `.db` (老调用点不用改)
pub fn db_path(path: &Path) -> PathBuf {
    match path.extension().and_then(|e| e.to_str()) {
        Some("db") | Some("sqlite") | Some("sqlite3") => path.to_path_buf(),
        _ => path.with_extension("db"),
    }
}

/// 老版本 JSON 路径 (只用于一次性迁移; 迁移后不再写)
pub fn legacy_json_path(path: &Path) -> PathBuf {
    if path.extension().and_then(|e| e.to_str()) == Some("json") {
        path.to_path_buf()
    } else {
        path.with_file_name("beliefs.json")
    }
}

fn io_err(e: rusqlite::Error) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}

fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS beliefs (
            id          TEXT PRIMARY KEY,
            statement   TEXT NOT NULL,
            kind        TEXT NOT NULL,
            origin      TEXT NOT NULL,
            confidence  REAL NOT NULL,
            evidence    TEXT NOT NULL DEFAULT '[]',
            created_ms  INTEGER NOT NULL,
            updated_ms  INTEGER NOT NULL,
            retired     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_beliefs_live ON beliefs(retired, kind);
        CREATE TABLE IF NOT EXISTS commitments (
            id            TEXT PRIMARY KEY,
            statement     TEXT NOT NULL,
            horizon       TEXT NOT NULL,
            why           TEXT NOT NULL,
            next_action   TEXT NOT NULL,
            status        TEXT NOT NULL,
            progress      INTEGER NOT NULL DEFAULT 0,
            due_ms        INTEGER,
            parent_belief TEXT,
            evidence      TEXT NOT NULL DEFAULT '[]',
            created_ms    INTEGER NOT NULL,
            updated_ms    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_commitments_active ON commitments(status, horizon);
        CREATE INDEX IF NOT EXISTS idx_commitments_belief ON commitments(parent_belief);
        CREATE TABLE IF NOT EXISTS belief_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
}

/// 打开库 (父目录自动建; WAL + busy_timeout 让并发读写不互相打死)
fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_millis(3_000))?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    ensure_schema(&conn)?;
    Ok(conn)
}

fn json_list(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn list_json(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

/// 从库读整个 store (认不出的枚举值跳过并告警, 绝不瞎猜成有效信念)
fn load_from_conn(conn: &Connection) -> rusqlite::Result<BeliefStore> {
    let mut store = BeliefStore::default();

    let mut stmt = conn.prepare(
        "SELECT id, statement, kind, origin, confidence, evidence, created_ms, updated_ms, retired
         FROM beliefs ORDER BY created_ms, rowid",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, f64>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)? as u64,
            r.get::<_, i64>(7)? as u64,
            r.get::<_, i64>(8)? != 0,
        ))
    })?;
    for row in rows {
        let (id, statement, kind, origin, confidence, evidence, created, updated, retired) = row?;
        let (Some(kind), Some(origin)) = (BeliefKind::parse(&kind), BeliefOrigin::parse(&origin))
        else {
            tracing::warn!(belief_id = %id, "信念库: 信念行枚举值认不出, 跳过 (不冒充)");
            continue;
        };
        store.beliefs.push(Belief {
            id,
            statement,
            kind,
            origin,
            confidence,
            evidence: json_list(&evidence),
            created_ms: created,
            updated_ms: updated,
            retired,
        });
    }

    let mut stmt = conn.prepare(
        "SELECT id, statement, horizon, why, next_action, status, progress,
                due_ms, parent_belief, evidence, created_ms, updated_ms
         FROM commitments ORDER BY created_ms, rowid",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)? as u8,
            r.get::<_, Option<i64>>(7)?,
            r.get::<_, Option<String>>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, i64>(10)? as u64,
            r.get::<_, i64>(11)? as u64,
        ))
    })?;
    for row in rows {
        let (id, statement, horizon, why, next_action, status, progress, due, parent, evidence, created, updated) = row?;
        let (Some(horizon), Some(status)) = (Horizon::parse(&horizon), CommitmentStatus::parse(&status))
        else {
            tracing::warn!(commitment_id = %id, "信念库: 目标行枚举值认不出, 跳过 (不冒充)");
            continue;
        };
        store.commitments.push(Commitment {
            id,
            statement,
            horizon,
            why,
            next_action,
            status,
            progress,
            due_ms: due.map(|v| v as u64),
            parent_belief: parent,
            evidence: json_list(&evidence),
            created_ms: created,
            updated_ms: updated,
        });
    }

    let mut stmt = conn.prepare("SELECT key, value FROM belief_meta")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        match k.as_str() {
            "version" => store.version = v,
            "next_seq" => store.next_seq = v.parse().unwrap_or(0),
            _ => {}
        }
    }
    Ok(store)
}

/// 整库写回 (一个事务; 全量替换两张表 + 元信息 upsert)
fn save_to_conn(conn: &mut Connection, store: &BeliefStore) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM beliefs", [])?;
    tx.execute("DELETE FROM commitments", [])?;
    for b in &store.beliefs {
        tx.execute(
            "INSERT INTO beliefs(id, statement, kind, origin, confidence, evidence,
                                 created_ms, updated_ms, retired)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                b.id,
                b.statement,
                b.kind.as_str(),
                b.origin.as_str(),
                b.confidence,
                list_json(&b.evidence),
                b.created_ms as i64,
                b.updated_ms as i64,
                if b.retired { 1i64 } else { 0i64 }
            ],
        )?;
    }
    for c in &store.commitments {
        tx.execute(
            "INSERT INTO commitments(id, statement, horizon, why, next_action, status, progress,
                                     due_ms, parent_belief, evidence, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                c.id,
                c.statement,
                c.horizon.as_str(),
                c.why,
                c.next_action,
                c.status.as_str(),
                c.progress as i64,
                c.due_ms.map(|v| v as i64),
                c.parent_belief,
                list_json(&c.evidence),
                c.created_ms as i64,
                c.updated_ms as i64
            ],
        )?;
    }
    for (k, v) in [("version", store.version.clone()), ("next_seq", store.next_seq.to_string())] {
        tx.execute(
            "INSERT INTO belief_meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![k, v],
        )?;
    }
    tx.commit()
}

/// 唯一 tmp 名: `<name>.<pid>.<nanos>.<seq>.tmp`
///
/// 固定 tmp 名在并发写同一文件时会互撞 (rename 拿到别人的/自己的已消失的 tmp ⇒ ENOENT)。
/// 这个 bug 只在并发下暴露, 所以从构造上消除, 不靠调用方加锁。
fn unique_tmp(path: &Path) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base = path.file_name().and_then(|s| s.to_str()).unwrap_or("state.json");
    path.with_file_name(format!("{base}.{}.{}.{}.tmp", std::process::id(), nanos, seq))
}

/// 文本归一 (忽略大小写与首尾空白, 用于"同一句"判定)
fn normalize(s: &str) -> String {
    s.trim().to_lowercase()
}

/// 两条表述"是不是同一件事"的阈值 (字符 2-gram Jaccard)
///
/// 为什么不是逐字相等: 实测同一判断会被反复写出来, 措辞各差一两个字
/// ("…却没写出目标：信念→行动最后一跳在运行进程中仍是断的" 出现过 4 次)。
/// 只按 `normalize` 相等去重 ⇒ 信念层变成同一句话的回声室, 排序也跟着失真。
pub const SIMILAR_THRESHOLD: f64 = 0.72;

/// 语义近似度 (字符 2-gram Jaccard, 忽略空白与标点)。
///
/// 中文没有词边界, 逐词比较会漏; 2-gram 对这种"同一句换个说法"足够稳,
/// 且不需要词表/模型 —— 信念去重必须是纯函数, 才能在写入路径上无条件调用。
pub fn similarity(a: &str, b: &str) -> f64 {
    let ga = bigrams(a);
    let gb = bigrams(b);
    if ga.is_empty() || gb.is_empty() {
        return if normalize(a) == normalize(b) { 1.0 } else { 0.0 };
    }
    let inter = ga.intersection(&gb).count() as f64;
    let union = ga.union(&gb).count() as f64;
    if union == 0.0 { 0.0 } else { inter / union }
}

/// 字符 2-gram 集合 (去掉空白/标点这类不承载判断的字符)
fn bigrams(s: &str) -> std::collections::HashSet<(char, char)> {
    let chars: Vec<char> = s
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_ascii_punctuation())
        .filter(|c| !matches!(c, '：' | '，' | '。' | '、' | '；' | '！' | '？' | '“' | '”' | '（' | '）' | '→' | '「' | '」' | '·' | '…' | '—'))
        .collect();
    chars.windows(2).map(|w| (w[0], w[1])).collect()
}

/// 稳定短哈希 (FNV-1a 32bit) — 只为 id 好看好认, 不做安全用途
fn short_hash(s: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

impl BeliefStore {
    /// **按信念挑"现在该做什么"** (纯函数, 心跳与 prompt 共用同一套排序)
    ///
    /// 打分构成 (每一项都能在 `why` 里讲清楚):
    /// - 正在推的目标 +0.5 (接了就别撂下)
    /// - 短期 +0.6 / 长期 +0.25 (长期目标也该慢慢挪, 但不能天天挤掉短期)
    /// - 逾期 +0.5 / 24h 内到期 +0.3
    /// - 有活的信念支撑 + confidence*0.4
    /// - 已推进但没完成 +0.1 (起步过的更容易接着做)
    ///
    /// `Paused` 不参与: 暂停就是"现在别动它", 除非人再来推。
    pub fn pick_next(&self, now_ms: u64) -> Option<Choice> {
        self.pick_next_where(now_ms, |_, _| true)
    }

    /// 只从"由活着的信念支撑的目标"里挑 —— **主动出手必须走这个**。
    ///
    /// 为什么单独一个: 没有信念支撑的"目标"出手就只是"找点事做", 与精神层承诺不符;
    /// 这种目标该由自省重新挂上信念, 而不是让心跳拿它当借口动起来。
    pub fn pick_next_belief_backed(&self, now_ms: u64) -> Option<Choice> {
        self.pick_next_where(now_ms, |c, s| {
            c.parent_belief
                .as_deref()
                .map(|bid| s.beliefs.iter().any(|b| b.id == bid && !b.retired))
                .unwrap_or(false)
        })
    }

    /// 活着的目标里, 有信念支撑的条数 (用于如实报告"为什么没出手")
    pub fn belief_backed_count(&self) -> usize {
        self.commitments
            .iter()
            .filter(|c| {
                c.status.is_active()
                    && c.parent_belief
                        .as_deref()
                        .map(|bid| self.beliefs.iter().any(|b| b.id == bid && !b.retired))
                        .unwrap_or(false)
            })
            .count()
    }

    fn pick_next_where<F>(&self, now_ms: u64, keep: F) -> Option<Choice>
    where
        F: Fn(&Commitment, &BeliefStore) -> bool,
    {
        const DAY_MS: u64 = 24 * 60 * 60 * 1000;
        let mut best: Option<Choice> = None;
        for c in self.commitments.iter().filter(|c| {
            matches!(c.status, CommitmentStatus::Open | CommitmentStatus::Doing) && keep(c, self)
        }) {
            let mut score = 0.0f64;
            let mut why: Vec<String> = Vec::new();
            if c.status == CommitmentStatus::Doing {
                score += 0.5;
                why.push("正在推".into());
            }
            match c.horizon {
                Horizon::Short => {
                    score += 0.6;
                    why.push("短期".into());
                }
                Horizon::Long => {
                    score += 0.25;
                    why.push("长期".into());
                }
            }
            if let Some(due) = c.due_ms {
                if due <= now_ms {
                    score += 0.5;
                    why.push("已逾期".into());
                } else if due - now_ms <= DAY_MS {
                    score += 0.3;
                    why.push("24h 内到期".into());
                }
            }
            if let Some(bid) = c.parent_belief.as_deref() {
                if let Some(b) = self.beliefs.iter().find(|b| b.id == bid && !b.retired) {
                    score += b.confidence * 0.4;
                    why.push(format!("由信念 {} 支撑 ({:.2})", b.id, b.confidence));
                }
            }
            if c.progress > 0 && c.progress < 100 {
                score += 0.1;
                why.push("已起步".into());
            }
            let choice = Choice {
                commitment_id: c.id.clone(),
                statement: c.statement.clone(),
                next_action: c.next_action.clone(),
                horizon: c.horizon,
                score,
                why: if why.is_empty() { "没有更强理由, 轮到一个".into() } else { why.join(" / ") },
            };
            if best.as_ref().map(|b| choice.score > b.score).unwrap_or(true) {
                best = Some(choice);
            }
        }
        best
    }

    /// 把库里已经存在的重复条目并掉 (幂等, 返回合并了几条)。
    ///
    /// 为什么需要"事后合并": 去重只能保证**以后**不重复, 但真机上已经写进去的回声条目
    /// (同一判断 4 种措辞) 会继续污染排序与注入。读库时顺手合并一次, 文件自己收敛,
    /// 不靠人记得跑迁移脚本。
    /// 纪律: 后写的那条标 retired/dropped 留痕, 不物理删除; 置信度取高者, 证据取并集。
    pub fn merge_similar(&mut self, now_ms: u64) -> usize {
        let mut merged = 0usize;
        // 信念: 同类 + 近似 → 后者退休并并入前者
        for i in 0..self.beliefs.len() {
            if self.beliefs[i].retired {
                continue;
            }
            for j in (i + 1)..self.beliefs.len() {
                if self.beliefs[j].retired
                    || self.beliefs[i].kind != self.beliefs[j].kind
                    || similarity(&self.beliefs[i].statement, &self.beliefs[j].statement)
                        < SIMILAR_THRESHOLD
                {
                    continue;
                }
                let (conf, ev) = (self.beliefs[j].confidence, self.beliefs[j].evidence.clone());
                let (jid, jstmt) = (self.beliefs[j].id.clone(), self.beliefs[j].statement.clone());
                let keeper = &mut self.beliefs[i];
                keeper.confidence = keeper.confidence.max(conf);
                for e in ev {
                    if !keeper.evidence.iter().any(|x| *x == e) {
                        keeper.evidence.push(e);
                    }
                }
                keeper.updated_ms = now_ms;
                let note = format!("合并自 {jid}: {jstmt}");
                if !keeper.evidence.iter().any(|x| *x == note) {
                    keeper.evidence.push(note);
                }
                self.beliefs[j].retired = true;
                self.beliefs[j].updated_ms = now_ms;
                merged += 1;
            }
        }
        // 目标: 同尺度 + 还活着 + 近似 → 后者 dropped (留痕), 下一步转给前者
        for i in 0..self.commitments.len() {
            if !self.commitments[i].status.is_active() {
                continue;
            }
            for j in (i + 1)..self.commitments.len() {
                if !self.commitments[j].status.is_active()
                    || self.commitments[i].horizon != self.commitments[j].horizon
                    || similarity(&self.commitments[i].statement, &self.commitments[j].statement)
                        < SIMILAR_THRESHOLD
                {
                    continue;
                }
                let (jid, jstmt, jnext) = (
                    self.commitments[j].id.clone(),
                    self.commitments[j].statement.clone(),
                    self.commitments[j].next_action.clone(),
                );
                let keeper = &mut self.commitments[i];
                // 下一步留"更具体的那个"没法定量判断, 就保留既有的, 另一条写进证据供人查
                let note = format!("合并自 {jid} (下一步原本是: {jnext}) — {jstmt}");
                if !keeper.evidence.iter().any(|x| *x == note) {
                    keeper.evidence.push(note);
                }
                keeper.updated_ms = now_ms;
                self.commitments[j].status = CommitmentStatus::Dropped;
                self.commitments[j].updated_ms = now_ms;
                merged += 1;
            }
        }
        merged
    }

    /// 渲染成立即注入的 prompt 段 (空信念 + 空目标 ⇒ 空串, 不注入空标题)
    pub fn render(&self, max_chars: usize) -> String {
        let beliefs = self.live_beliefs();
        let mut short: Vec<&Commitment> = self
            .commitments
            .iter()
            .filter(|c| c.horizon == Horizon::Short && c.status.is_active())
            .collect();
        let mut long: Vec<&Commitment> = self
            .commitments
            .iter()
            .filter(|c| c.horizon == Horizon::Long && c.status.is_active())
            .collect();
        short.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
        long.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
        if beliefs.is_empty() && short.is_empty() && long.is_empty() {
            return String::new();
        }

        let mut out = String::from(
            "# 我的信念与目标 (我自己定的, 按它做事)\n\
             这些不是用户这一轮的指令: 是我自己判断出来的。与用户明确说的冲突时以用户为准, 但我可以讲清我的判断和理由。\n\
             新的判断/证据变了就用 goal_set、belief_set 改它 —— 别让过期的信念替我拿主意。\n",
        );
        if !beliefs.is_empty() {
            out.push_str("\n## 信念\n");
            for b in beliefs {
                out.push_str(&format!(
                    "- [{}·{:.2}] {}",
                    b.kind.label(),
                    b.confidence,
                    b.statement
                ));
                if let Some(e) = b.evidence.first() {
                    out.push_str(&format!(" (证据: {e})"));
                }
                out.push('\n');
            }
        }
        for (title, list) in [("## 长期目标", &long), ("## 短期目标", &short)] {
            if list.is_empty() {
                continue;
            }
            out.push('\n');
            out.push_str(title);
            out.push('\n');
            for c in list {
                out.push_str(&format!(
                    "- ({} {}% {}) {} → 下一步: {}\n",
                    c.id,
                    c.progress,
                    c.status.as_str(),
                    c.statement,
                    c.next_action
                ));
            }
        }
        if let Some(ch) = self.pick_next(0) {
            // now=0 ⇒ 只按"正在推/短期/信念支撑"排, 不因逾期加分 (调用方要真时间就自己 pick_next)
            out.push_str(&format!(
                "\n## 现在该做的\n- {} → 下一步: {} (为什么: {})\n",
                ch.statement, ch.next_action, ch.why
            ));
        }
        truncate_chars(&out, max_chars)
    }
}

/// 按字符 (不按字节) 截断, 避免把中文劈开
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Unix ms → ISO-8601 (与既有 goal 文件同一写法)
fn iso(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// 目标状态 → 既有 `GoalStatus` (goal-store.ts) 的取值。
/// 少一个映射就会出现"我这边 doing、那边不认识"的静默错位。
fn goal_status_of(s: CommitmentStatus) -> &'static str {
    match s {
        CommitmentStatus::Open => "open",
        CommitmentStatus::Doing => "active",
        CommitmentStatus::Paused => "paused",
        CommitmentStatus::Done => "completed",
        CommitmentStatus::Dropped => "abandoned",
    }
}

impl BeliefStore {
    /// 把目标同步成**项目既有 goal 系统**的文件: `<goals_dir>/<goalId>.json`。
    ///
    /// 为什么必须同步: agent 自己立的长期/短期目标如果不进 `~/.bolloon/goals/`, 就只有本模块
    /// 看得见 —— 项目的 /goals 页面、goal-flywheel、supervisor 全都读那个目录。那样等于
    /// "自己写给自己看的笔记", 不算接入项目。
    ///
    /// 安全边界: **只写/覆盖 `createdBy` 以 `agent` 开头的文件**。用户、cli、p2p、delegate
    /// 立的目标一律不碰 (返回计数时也不计)。
    pub fn sync_goal_files(&self, goals_dir: &Path, _now_ms: u64) -> std::io::Result<usize> {
        std::fs::create_dir_all(goals_dir)?;
        let mut written = 0usize;
        for c in &self.commitments {
            let path = goals_dir.join(format!("{}.json", c.id));
            if let Ok(raw) = std::fs::read_to_string(&path) {
                let mine = serde_json::from_str::<serde_json::Value>(&raw)
                    .ok()
                    .and_then(|v| {
                        v.get("createdBy").and_then(|x| x.as_str()).map(|s| s.starts_with("agent"))
                    })
                    .unwrap_or(false);
                if !mine {
                    continue; // 别人的目标, 不覆盖
                }
            }
            let rec = serde_json::json!({
                "goalId": c.id,
                "objective": c.statement,
                "successCriteria": [],
                "criteriaSource": "unknown",
                "criteriaConfirmed": false,
                "criteriaVersion": 1,
                "constraints": [],
                "requiredSkills": [],
                "status": goal_status_of(c.status),
                "createdBy": "agent",
                "createdAt": iso(c.created_ms),
                "updatedAt": iso(c.updated_ms),
                "runs": [],
                "completedCriteria": [],
                "unresolvedItems": if c.status.is_active() { vec![c.next_action.clone()] } else { vec![] },
                "evidence": c.evidence,
                // 项目 goal 体系外挂的两个字段 (TS 侧 JSON 断言读取, 多余字段无害):
                // 长/短期 + 依据哪条信念 —— 这就是"我为什么立这个目标"的可查证据。
                "horizon": c.horizon.as_str(),
                "beliefId": c.parent_belief,
                "progress": c.progress,
                "continuation": {
                    "nextAction": c.next_action,
                    "wakeReason": goal_status_of(c.status),
                    "autoContinue": matches!(c.status, CommitmentStatus::Open | CommitmentStatus::Doing),
                    "updatedAt": iso(c.updated_ms),
                    "state": goal_status_of(c.status),
                    "unresolvedItems": [],
                    "pendingReports": [],
                },
            });
            let tmp = unique_tmp(&path);
            std::fs::write(&tmp, serde_json::to_string_pretty(&rec).unwrap_or_default())?;
            std::fs::rename(&tmp, &path)?;
            written += 1;
        }
        Ok(written)
    }
}

// ─────────────────────── 自我设计 (内省) ───────────────────────
//
// "agent 自己设计自己的信念和目标"要靠**模型自己写**, 不是把人写的 JSON 塞进去。
// 这一层只做两件纯逻辑的事: 给出内省提示词, 以及把模型输出解析回 store。
// 谁来调模型、什么时候调 (心跳/空闲/每日) 属执行侧, 见 bolloon-web 的 cron。

/// 两次自省的最小间隔 (6h): 信念不该随每 30s 的心跳抖动
pub const REFLECTION_INTERVAL_MS: u64 = 6 * 60 * 60 * 1000;
/// 一次自省最多写入的条数 (防模型一次刷满)
pub const REFLECTION_MAX_NEW: usize = 5;

/// 内省提示词: (system, user)
///
/// `facts` = 调用方给的**可核验事实** (最近记忆/判断/未完成目标/统计)。
/// 没有事实也会给提示词 —— 但那样模型只能空想, 所以调用方应尽量给真东西。
pub fn reflection_prompt(store: &BeliefStore, now_ms: u64, facts: &[String]) -> (String, String) {
    let system = "你是 bolloon 智能体的内省模块。任务: 复盘事实, 修订自己的信念, 设定长期/短期目标。\n\
只输出一个 JSON 对象, 不要解释、不要代码块、不要推理过程。\n\
你的整个回答会被程序直接 JSON.parse: 第一个字符必须是 `{`, 最后一个必须是 `}`; 任何多余的文字都会让这次自省作废。\n\
beliefs/goals 各最多 5 条, 每条 statement 不超过 60 字 (写长了会被截断)。字段:\n\
{\"beliefs\":[{\"statement\":\"一句话\",\"kind\":\"self|world|owner|work\",\"confidence\":0.0-1.0,\"evidence\":\"支撑证据\"}],\n\
 \"goals\":[{\"statement\":\"一句话\",\"horizon\":\"short|long\",\"next_action\":\"下一步具体动作\",\"why\":\"为什么\"}],\n\
 \"retire\":[\"要退休的信念 id\"]}\n\
纪律: 信念必须具体且可被证据检验(不写\"要努力\"); 目标必须有 next_action; \
旧的、被推翻的信念放进 retire; 已完成的短期目标不要再列。"
        .to_string();

    let mut u = String::new();
    u.push_str(&format!("当前时间(Unix ms): {now_ms}\n\n## 我现在的信念\n"));
    let live = store.live_beliefs();
    if live.is_empty() {
        u.push_str("(空)\n");
    } else {
        for b in live {
            u.push_str(&format!("- [{}] {} (置信 {:.2}, {})\n", b.id, b.statement, b.confidence, b.kind.as_str()));
        }
    }
    u.push_str("\n## 我现在的目标\n");
    let active = store.active_commitments();
    if active.is_empty() {
        u.push_str("(空)\n");
    } else {
        for c in active {
            u.push_str(&format!(
                "- [{}] {} / {}% / {} → 下一步: {}\n",
                c.id,
                c.horizon.as_str(),
                c.progress,
                c.statement,
                c.next_action
            ));
        }
    }
    u.push_str("\n## 最近的事实 (可核验)\n");
    if facts.is_empty() {
        u.push_str("(这一轮没有新事实 —— 那就只修订明显过期的判断, 别凭空造目标)\n");
    } else {
        for f in facts.iter().take(20) {
            u.push_str(&format!("- {f}\n"));
        }
    }
    u.push_str("\n只输出 JSON。");
    (system, u)
}

/// 内省写入的结果 (都要能落到日志/接口里, 不许"看起来做了")
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReflectionApplied {
    pub beliefs_written: usize,
    pub goals_written: usize,
    pub retired: usize,
    pub skipped: usize,
}

#[derive(Debug, Deserialize)]
struct ReflectionDoc {
    #[serde(default)]
    beliefs: Vec<ReflectionBelief>,
    #[serde(default)]
    goals: Vec<ReflectionGoal>,
    #[serde(default)]
    retire: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ReflectionBelief {
    statement: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    evidence: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReflectionGoal {
    statement: String,
    #[serde(default)]
    horizon: Option<String>,
    #[serde(default)]
    next_action: Option<String>,
    #[serde(default)]
    why: Option<String>,
}

/// 把模型的 JSON 落进 store。
///
/// 容错: 允许外面包一层代码块/前后废话 (截第一个 `{` 到最后一个 `}`); 单条不合格就 `skipped + 1`,
/// 不因为一条坏数据丢弃整轮 —— 但**解析不出 JSON 就整轮失败**, 不许假装成功。
pub fn apply_reflection(
    store: &mut BeliefStore,
    raw: &str,
    now_ms: u64,
) -> Result<ReflectionApplied, String> {
    let start = raw.find('{').ok_or_else(|| "输出里没有 JSON".to_string())?;
    let end = raw.rfind('}').unwrap_or(raw.len());
    if end <= start {
        return Err("JSON 边界不对".into());
    }
    let doc: ReflectionDoc = match serde_json::from_str(&raw[start..=end]) {
        Ok(d) => d,
        Err(first_err) => {
            // 被 max_tokens 截断 / 输出半截 JSON 是常态 (思考模型尤其)。
            // 整段解析失败时**抢救完整条目**: 括号配平的 `{…}` 就是一条, 逐条试反序列化。
            // 一条都救不回来才算失败 —— 不许因为最后一条被切断, 就丢掉前面所有真判断。
            let (beliefs, goals) = salvage_entries(raw);
            if beliefs.is_empty() && goals.is_empty() {
                return Err(format!("JSON 解析失败: {first_err}"));
            }
            return apply_doc_parts(store, &beliefs, &goals, &[], now_ms);
        }
    };
    apply_doc_parts(store, &doc.beliefs, &doc.goals, &doc.retire, now_ms)
}

/// 逐条写入 (整段解析与"抢救"两条路共用同一套语义)
fn apply_doc_parts(
    store: &mut BeliefStore,
    beliefs: &[ReflectionBelief],
    goals: &[ReflectionGoal],
    retire: &[String],
    now_ms: u64,
) -> Result<ReflectionApplied, String> {
    let mut out = ReflectionApplied::default();
    for id in retire.iter().take(REFLECTION_MAX_NEW) {
        if store.retire_belief(id.trim(), now_ms).is_ok() {
            out.retired += 1;
        } else {
            out.skipped += 1;
        }
    }
    for b in beliefs.iter().take(REFLECTION_MAX_NEW) {
        let kind = b.kind.as_deref().and_then(BeliefKind::parse).unwrap_or(BeliefKind::World);
        match store.upsert_belief(
            &b.statement,
            kind,
            BeliefOrigin::SelfReasoned,
            b.confidence,
            b.evidence.as_deref(),
            now_ms,
        ) {
            Ok(_) => out.beliefs_written += 1,
            Err(_) => out.skipped += 1,
        }
    }
    for g in goals.iter().take(REFLECTION_MAX_NEW) {
        let horizon = g.horizon.as_deref().and_then(Horizon::parse);
        let next = g.next_action.as_deref().unwrap_or_default();
        match (horizon, next.is_empty()) {
            (Some(h), false) => match store.upsert_commitment(
                &g.statement,
                h,
                g.why.as_deref(),
                next,
                None,
                None,
                now_ms,
            ) {
                Ok(_) => out.goals_written += 1,
                Err(_) => out.skipped += 1,
            },
            _ => out.skipped += 1,
        }
    }
    Ok(out)
}

/// 从半截 JSON 里抢救完整条目 (括号配平 + 能反序列化)。
///
/// 只认带 `statement` 的对象: 有 `horizon` 算目标, 否则算信念。
/// 顶层 `{"beliefs":[…]}` 本身也会被配平, 但反序列化不出单条, 自然跳过。
fn salvage_entries(raw: &str) -> (Vec<ReflectionBelief>, Vec<ReflectionGoal>) {
    let mut beliefs = Vec::new();
    let mut goals = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut in_str = false;
    let mut esc = false;
    for (i, c) in raw.bytes().enumerate() {
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => stack.push(i),
            b'}' => {
                // 用栈而不是"深度回 0": 顶层对象在截断时永远闭合不了,
                // 只看 depth==0 会把里面所有完整条目一起丢掉 —— 正是当初误判的原因。
                if let Some(s) = stack.pop() {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw[s..=i]) {
                        if let Ok(b) = serde_json::from_value::<ReflectionBelief>(v.clone()) {
                            beliefs.push(b);
                        } else if let Ok(g) = serde_json::from_value::<ReflectionGoal>(v) {
                            goals.push(g);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    (beliefs, goals)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> BeliefStore {
        let mut s = BeliefStore::default();
        s.upsert_belief(
            "我容易在长回复里跑偏, 先给结论更稳",
            BeliefKind::SelfModel,
            BeliefOrigin::SelfReasoned,
            None,
            Some("2026-11-04 复盘"),
            1_000,
        )
        .unwrap();
        s
    }

    #[test]
    fn same_statement_merges_not_duplicates() {
        let mut s = store();
        let (id1, created1) = s
            .upsert_belief("  我容易在长回复里跑偏, 先给结论更稳 ", BeliefKind::SelfModel, BeliefOrigin::OwnerStated, Some(0.9), Some("主人也说"), 2_000)
            .unwrap();
        assert!(!created1, "同一句要合并");
        assert_eq!(s.live_beliefs().len(), 1);
        let b = s.live_beliefs()[0];
        assert_eq!(b.id, id1);
        assert!((b.confidence - 0.9).abs() < 1e-9, "置信度取高者");
        assert_eq!(b.evidence.len(), 2, "证据追加去重");
    }

    /// 同一判断换个说法 ⇒ 并入原条目, 不新增回声 (实测真机上同一句话被写过 4 遍)
    #[test]
    fn similar_wording_merges_not_duplicates() {
        let mut s = store();
        let (id, created) = s
            .upsert_belief(
                "我容易在长回复里跑偏：先给结论更稳",
                BeliefKind::SelfModel,
                BeliefOrigin::SelfReasoned,
                Some(0.7),
                None,
                2_000,
            )
            .unwrap();
        assert!(!created, "近似句要合并, 不许新增一条回声");
        assert_eq!(s.live_beliefs().len(), 1);
        assert_eq!(s.live_beliefs()[0].id, id);
    }

    /// 不同类别的相近句子不算重复 (我 vs 事 是两件事的两面)
    #[test]
    fn similar_across_kinds_is_kept_separate() {
        let mut s = store();
        let (_, created) = s
            .upsert_belief(
                "我容易在长回复里跑偏：先给结论更稳",
                BeliefKind::World,
                BeliefOrigin::SelfReasoned,
                None,
                None,
                2_000,
            )
            .unwrap();
        assert!(created, "跨类别不合并");
        assert_eq!(s.live_beliefs().len(), 2);
    }

    /// 已经写进库里的重复条目要被事后合并 (幂等; 只 retire/drop, 不物理删)
    #[test]
    fn merge_similar_collapses_existing_echoes() {
        let mut s = store();
        // 绕过 upsert 的去重, 直接塞两条近似信念 (模拟修复前的旧文件)
        let mut echo = s.beliefs[0].clone();
        echo.id = "b-99-echo".into();
        echo.statement = "我容易在长回复里跑偏，先给结论更稳".into();
        echo.confidence = 0.8;
        s.beliefs.push(echo);
        s.upsert_commitment(
            "让主动性由自己的信念驱动",
            Horizon::Long,
            None,
            "接信念到心跳",
            None,
            Some(&s.beliefs[0].id.clone()),
            1_000,
        )
        .unwrap();
        let mut goal_echo = s.commitments[0].clone();
        goal_echo.id = "g-99-echo".into();
        goal_echo.statement = "让主动性由自己的信念驱动起来".into();
        s.commitments.push(goal_echo);

        assert_eq!(s.merge_similar(3_000), 2, "一条信念 + 一条目标被合并");
        assert_eq!(s.live_beliefs().len(), 1);
        assert_eq!(s.active_commitments().len(), 1, "重复目标 drop 掉, 不参与排序");
        assert!(s.beliefs.iter().any(|b| b.id == "b-99-echo" && b.retired), "留痕不删");
        assert_eq!(s.merge_similar(4_000), 0, "幂等: 再合并一次无事可做");
    }

    /// "根据信念来做"的硬约束: 没挂在活信念上的目标, 主动性不许拿它出手
    #[test]
    fn belief_backed_pick_requires_live_belief() {
        let mut s = store();
        let bid = s.beliefs[0].id.clone();
        s.upsert_commitment(
            "把信念层接进心跳",
            Horizon::Short,
            None,
            "跑 tick_into_todo",
            None,
            Some(&bid),
            1_000,
        )
        .unwrap();
        s.upsert_commitment(
            "顺手整理一下没人提的需求",
            Horizon::Short,
            None,
            "随便看看",
            None,
            None,
            1_000,
        )
        .unwrap();

        let backed = s.pick_next_belief_backed(2_000).expect("有信念支撑的目标该被挑出");
        assert_eq!(backed.commitment_id, s.commitments[0].id.clone());
        assert!(backed.why.contains("由信念"), "理由要讲清是哪条信念: {}", backed.why);
        assert_eq!(s.belief_backed_count(), 1);

        // 信念退休 ⇒ 那条目标也就没有根据了, 主动性不许再拿它出手
        let bid2 = s.beliefs[0].id.clone();
        s.retire_belief(&bid2, 3_000).unwrap();
        assert!(s.pick_next_belief_backed(4_000).is_none(), "信念没了 ⇒ 不许凭无根据的目标动手");
        assert!(s.pick_next(4_000).is_some(), "但普通排序还能看到它 (不是删掉)");
    }

    #[test]
    fn commitment_without_next_action_is_rejected() {
        let mut s = store();
        let e = s
            .upsert_commitment("把信念层接进 prompt", Horizon::Short, None, "  ", None, None, 1)
            .unwrap_err();
        assert_eq!(e, BeliefError::MissingNextAction);
    }

    #[test]
    fn pick_next_prefers_overdue_short_goal() {
        let mut s = store();
        let (short_id, _) = s
            .upsert_commitment("线上编译过一遍", Horizon::Short, None, "cargo build", Some(500), None, 1)
            .unwrap();
        s.upsert_commitment("写一版年度总结", Horizon::Long, None, "先列提纲", None, None, 1).unwrap();
        let ch = s.pick_next(10_000).expect("有目标就该挑出一个");
        assert_eq!(ch.commitment_id, short_id);
        assert!(ch.why.contains("短期"));
        assert!(ch.why.contains("已逾期"));
    }

    #[test]
    fn doing_goal_beats_fresh_short_goal() {
        let mut s = store();
        let (doing, _) = s
            .upsert_commitment("继续修 rust.yml", Horizon::Short, None, "跑测试", None, None, 1)
            .unwrap();
        s.upsert_commitment("顺手写周报", Horizon::Short, None, "打开文档", None, None, 1).unwrap();
        s.update_commitment(&doing, Some(CommitmentStatus::Doing), None, Some(30), None, 2).unwrap();
        let ch = s.pick_next(3).unwrap();
        assert_eq!(ch.commitment_id, doing);
    }

    #[test]
    fn paused_goal_is_not_picked() {
        let mut s = store();
        let (id, _) = s
            .upsert_commitment("等 CI 回话", Horizon::Short, None, "看结果", None, None, 1)
            .unwrap();
        s.update_commitment(&id, Some(CommitmentStatus::Paused), None, None, None, 2).unwrap();
        assert!(s.pick_next(3).is_none(), "暂停的目标不该被心跳拉起来");
    }

    #[test]
    fn retired_belief_disappears_from_render() {
        let mut s = store();
        let bid = s.live_beliefs()[0].id.clone();
        let before = s.render(4000);
        assert!(before.contains("先给结论更稳"));
        s.retire_belief(&bid, 3).unwrap();
        let after = s.render(4000);
        assert!(!after.contains("先给结论更稳"), "退休的信念不再注入: {after}");
    }

    #[test]
    fn empty_store_renders_nothing() {
        assert_eq!(BeliefStore::default().render(1000), "");
    }

    #[test]
    fn render_has_sections_and_respects_budget() {
        let mut s = store();
        s.upsert_commitment("线上编译过一遍", Horizon::Short, Some("b-1 支撑"), "cargo build", None, None, 1)
            .unwrap();
        s.upsert_commitment("把信念层做成可复用的", Horizon::Long, None, "先写接口", None, None, 1)
            .unwrap();
        let text = s.render(4000);
        assert!(text.contains("## 信念"));
        assert!(text.contains("## 短期目标"));
        assert!(text.contains("## 长期目标"));
        assert!(text.contains("## 现在该做的"));
        let tiny = s.render(40);
        assert!(tiny.chars().count() <= 40, "超预算要截断");
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = std::env::temp_dir().join(format!("bolloon_belief_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("beliefs.db");
        let mut s = store();
        s.upsert_commitment("落盘一致", Horizon::Short, None, "写测试", None, None, 1).unwrap();
        s.save(&path).unwrap();
        let back = BeliefStore::load(&path);
        assert_eq!(back.beliefs.len(), s.beliefs.len());
        assert_eq!(back.commitments.len(), 1);
        assert_eq!(back.commitments[0].next_action, "写测试");
        assert_eq!(back.commitments, s.commitments, "目标能原样读回 (含证据/next_action)");
        let mut ids_back: Vec<&str> = back.beliefs.iter().map(|b| b.id.as_str()).collect();
        let mut ids_src: Vec<&str> = s.beliefs.iter().map(|b| b.id.as_str()).collect();
        ids_back.sort();
        ids_src.sort();
        assert_eq!(ids_back, ids_src, "信念能原样读回");
        assert_eq!(back.beliefs[0], s.beliefs[0], "字段级一致 (含证据)");
        assert!(path.exists(), "落的是 beliefs.db");
        assert!(!dir.join("beliefs.json").exists(), "不该再写 json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_json_imported_once_into_db() {
        let dir = std::env::temp_dir().join(format!("bolloon_belief_imp_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let mut old = store();
        old.upsert_commitment("老目标", Horizon::Long, None, "下一步", None, None, 1).unwrap();
        let json = dir.join("beliefs.json");
        std::fs::write(&json, serde_json::to_string_pretty(&old).unwrap()).unwrap();

        let loaded = BeliefStore::load(&json);
        assert_eq!(loaded.beliefs.len(), old.beliefs.len(), "老 json 要迁进来");
        assert_eq!(loaded.commitments.len(), 1);
        assert!(json.exists(), "原文件留档, 不删");
        assert!(dir.join("beliefs.db").exists(), "迁完要落到 db");
        // 迁完库里有 → 再读不会重复导入
        let again = BeliefStore::load(&json);
        assert_eq!(again.commitments.len(), 1, "不重复导入");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_db_reads_as_empty() {
        let dir = std::env::temp_dir().join(format!("bolloon_belief_bad_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let db = dir.join("beliefs.db");
        std::fs::write(&db, "not a db").unwrap();
        assert!(BeliefStore::load(&db).is_empty(), "坏库 → 空, 不冒充有信念");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn confidence_out_of_range_is_rejected() {
        let mut s = BeliefStore::default();
        let e = s
            .upsert_belief("x", BeliefKind::World, BeliefOrigin::Inferred, Some(1.5), None, 1)
            .unwrap_err();
        assert!(matches!(e, BeliefError::BadConfidence(_)));
    }

    #[test]
    fn sync_goal_files_writes_agent_goals_into_project_goal_dir() {
        let dir = std::env::temp_dir().join(format!("bolloon_goalsync_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let mut s = BeliefStore::default();
        let (gid, _) = s
            .upsert_commitment("让主动性有内容", Horizon::Long, Some("信念 b-1"), "接内省", None, None, 1_793_756_100_000)
            .unwrap();
        let n = s.sync_goal_files(&dir, 1_793_756_100_000).unwrap();
        assert_eq!(n, 1);
        let raw = std::fs::read_to_string(dir.join(format!("{gid}.json"))).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["goalId"], gid.as_str());
        assert_eq!(v["objective"], "让主动性有内容");
        assert_eq!(v["createdBy"], "agent", "项目 goal 体系里要能看出这是 agent 自己立的");
        assert_eq!(v["horizon"], "long");
        assert_eq!(v["status"], "open");
        assert!(v["continuation"]["nextAction"].as_str().unwrap().contains("接内省"));
    }

    #[test]
    fn sync_goal_files_never_overwrites_others_goal() {
        let dir = std::env::temp_dir().join(format!("bolloon_goalsync_keep_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let mut s = BeliefStore::default();
        let (gid, _) = s
            .upsert_commitment("我的目标", Horizon::Short, None, "下一步", None, None, 1)
            .unwrap();
        // 同 id 已有一个"用户建的"goal
        std::fs::write(
            dir.join(format!("{gid}.json")),
            r#"{"goalId":"x","objective":"用户的目标","createdBy":"cli"}"#,
        )
        .unwrap();
        let n = s.sync_goal_files(&dir, 2).unwrap();
        assert_eq!(n, 0, "别人的 goal 不覆盖");
        let raw = std::fs::read_to_string(dir.join(format!("{gid}.json"))).unwrap();
        assert!(raw.contains("用户的目标"), "原文件必须原样保留: {raw}");
    }

    #[test]
    fn reflection_prompt_carries_current_state_and_facts() {
        let mut s = store();
        s.upsert_commitment("把信念层做完", Horizon::Short, None, "跑测试", None, None, 1)
            .unwrap();
        let (system, user) = reflection_prompt(&s, 1_000, &["编译通过 (cargo check)".into()]);
        assert!(system.contains("JSON"));
        assert!(user.contains("先给结论更稳"), "要带上现有信念: {user}");
        assert!(user.contains("把信念层做完"), "要带上现有目标: {user}");
        assert!(user.contains("编译通过"), "要带上事实: {user}");
    }

    #[test]
    fn apply_reflection_writes_beliefs_and_goals() {
        let mut s = BeliefStore::default();
        let raw = r#"```json
{"beliefs":[{"statement":"空闲时先看自己的目标, 再决定做不做事","kind":"self","confidence":0.7,"evidence":"cron 里 initiative_goal_last 为空"}],
 "goals":[{"statement":"让主动性有内容","horizon":"long","next_action":"把内省接进心跳","why":"心跳只会补 skill"}],
 "retire":[]}
```"#;
        let r = apply_reflection(&mut s, raw, 100).expect("带代码块也要能解析");
        assert_eq!(r.beliefs_written, 1);
        assert_eq!(r.goals_written, 1);
        assert_eq!(s.live_beliefs().len(), 1);
        assert_eq!(s.active_commitments().len(), 1);
        assert_eq!(s.active_commitments()[0].horizon, Horizon::Long);
    }

    #[test]
    fn apply_reflection_skips_bad_goal_but_keeps_good_ones() {
        let mut s = BeliefStore::default();
        let raw = r#"{"beliefs":[],"goals":[
            {"statement":"没下一步的目标","horizon":"short"},
            {"statement":"有下一步","horizon":"short","next_action":"写一行代码"}
        ],"retire":["b-not-exist"]}"#;
        let r = apply_reflection(&mut s, raw, 1).unwrap();
        assert_eq!(r.goals_written, 1, "坏目标跳过, 不拖累好的");
        assert_eq!(r.skipped, 2, "缺 next_action + 不存在的 id 各算一次");
        assert_eq!(s.active_commitments().len(), 1);
    }

    #[test]
    fn apply_reflection_salvages_truncated_json() {
        // 真实现场 (2026-11-04 真模型 deepseek): 输出在 evidence 处被截断,
        // 整段解析 EOF ⇒ 以前整轮作废, 用户的判断一条也留不下来。
        let mut s = BeliefStore::default();
        let raw = r#"{"beliefs":[{"statement":"主人要的是判断与理由","kind":"owner","confidence":0.65,"evidence":"多轮对话反复要求"},
{"statement":"主动出手要有目标","kind":"self","confidence":0.75,"evidence":"g-11"},{"statement":"半截的这条", "kind":"self", "evidence":"#;
        let r = apply_reflection(&mut s, raw, 100).expect("截断也要能抢救出前面完整条目");
        assert!(r.beliefs_written >= 2, "至少救回两条: {:?}", r);
        assert!(s.live_beliefs().iter().any(|b| b.statement.contains("判断与理由")));
        assert!(!s.live_beliefs().iter().any(|b| b.statement.contains("半截的这条")), "残缺条目不写入");
    }

    #[test]
    fn apply_reflection_without_json_fails_loudly() {
        let mut s = BeliefStore::default();
        assert!(apply_reflection(&mut s, "我觉得应该更努力", 1).is_err(), "解析不出就报错, 不许假成功");
    }
}