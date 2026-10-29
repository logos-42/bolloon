use crate::audit::ConfigAuditLog;
use crate::coordinator::{CoordError, Lease, LeaseCoordinator};
use crate::error::ConfigError;
use crate::event::ConfigChangeEvent;
use crate::evidence::{ConfigEvidence, TaskBinding};
use crate::metrics::{ConfigMetrics, MetricsSnapshot};
use crate::policy::{apply_ai_whitelist, check_category_auth};
use crate::schema::*;
use crate::validator::validate;
use crate::ConfigView;
use std::collections::VecDeque;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use tokio::sync::broadcast;

const HISTORY_LIMIT: usize = 64;

/// 配置提案: 一次更新尝试的全部上下文。
pub struct ConfigProposal {
    /// 乐观并发控制: 提交基于的版本; 若与当前不符则拒绝 (StaleVersion)。
    pub based_on: Option<u64>,
    pub config: AppConfig,
    pub auth: ConfigAuth,
    pub source: String,
    pub operator: String,
    pub reason: String,
}

impl ConfigProposal {
    /// 系统级提案 (最高权限, 无版本乐观锁)。
    pub fn system(config: AppConfig, reason: &str) -> Self {
        Self {
            based_on: None,
            config,
            auth: ConfigAuth::System,
            source: "system".into(),
            operator: "system".into(),
            reason: reason.into(),
        }
    }
}

/// 受治理配置管理器。
///
/// 不变量:
/// - `view` 原子持有当前不可变快照; 读者 `read().clone()` 拿完整 `Arc`, 无部分可见。
/// - 版本号单调 (`AtomicU64`); 任一成功应用使版本 +1。
/// - `apply` 在写锁内串行化; 校验/授权失败前**绝不** swap, 旧配置保持不变。
/// - 事件在成功应用后发布; 审计落盘 (或仅内存)。
/// - 远程不可用 / 超时 / 恶意内容时 fail-closed: 当前配置不变。
pub struct ConfigManager {
    view: ConfigView,
    version: AtomicU64,
    history: std::sync::Mutex<VecDeque<Arc<ConfigSnapshot>>>,
    tx: broadcast::Sender<ConfigChangeEvent>,
    audit: ConfigAuditLog,
    /// 读取/更新/回滚的轻量指标 (全原子, 不加锁)
    metrics: ConfigMetrics,
    /// 任务 ↔ 配置版本 证据链 (追加式 JSONL)
    evidence: ConfigEvidence,
    file: Option<PathBuf>,
}

impl ConfigManager {
    /// 以默认配置初始化 (version 0)。不自动加载文件 (见 `load_from_file` / `with_file`)。
    pub fn new(file: Option<PathBuf>) -> Self {
        let initial = AppConfig::default();
        let snap = ConfigSnapshot::new(0, initial, "default", "system", "initial defaults");
        let (tx, _rx) = broadcast::channel(256);
        let audit = ConfigAuditLog::new(file.as_ref().map(|f| f.with_file_name("config-audit.jsonl")));
        let evidence = ConfigEvidence::beside(file.as_deref());
        Self {
            view: Arc::new(RwLock::new(Arc::new(snap))),
            version: AtomicU64::new(0),
            history: std::sync::Mutex::new(VecDeque::new()),
            tx,
            audit,
            metrics: ConfigMetrics::default(),
            evidence,
            file,
        }
    }

    /// 异步构造: 若 `file` 存在则尝试加载 (失败回退默认, 不崩溃)。
    pub async fn with_file(file: Option<PathBuf>) -> Self {
        let mgr = Self::new(file);
        if mgr.file.as_ref().map(|f| f.exists()).unwrap_or(false) {
            let _ = mgr.load_from_file().await;
        }
        mgr
    }

    /// 运行期配置视图 (可克隆引用, 跨组件共享)。
    pub fn view(&self) -> ConfigView {
        self.view.clone()
    }

    /// 当前有效快照 (完整 Arc, 无部分可见)。同步读取, 不在持有 guard 时 await。
    /// 附带指标: 计数 + 单次耗时 (仅两次 relaxed 原子 + 一次 Instant, 不上锁)。
    pub fn current(&self) -> Arc<ConfigSnapshot> {
        let t0 = std::time::Instant::now();
        let snap = self.view.read().unwrap().clone();
        self.metrics.record_read(t0.elapsed().as_nanos() as u64);
        snap
    }

    /// 运行时指标快照 (读次数/开销, 更新耗时/失败率, 回滚成功率)
    pub fn metrics(&self) -> MetricsSnapshot {
        self.metrics.snapshot(self.version())
    }

    /// 任务 ↔ 配置版本 证据链 (追加式落盘)
    pub fn evidence(&self) -> &ConfigEvidence {
        &self.evidence
    }

    /// 当前保留在历史里的版本 (可回滚到的版本集合, 从旧到新)
    pub fn history_versions(&self) -> Vec<u64> {
        self.history
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.version)
            .collect()
    }

    /// 能否回滚到该版本 (当前版本或历史版本)
    pub fn can_restore(&self, version: u64) -> bool {
        if self.version() == version {
            return true;
        }
        self.history
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.version == version)
    }

    /// 记录一次任务 ↔ 配置版本绑定 (启动/结束各一条)。
    pub fn record_binding(&self, b: TaskBinding) {
        self.evidence.record(b);
    }

    pub fn version(&self) -> u64 {
        self.version.load(Ordering::SeqCst)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ConfigChangeEvent> {
        self.tx.subscribe()
    }

    pub fn audit_log(&self) -> &ConfigAuditLog {
        &self.audit
    }

    /// 安全更新流程: 读版本 → 授权过滤 → 重复检测 → 结构校验 → 类别授权 → 原子 swap → 历史 → 落盘 → 审计 → 事件。
    /// 任一步失败均不改当前配置。
    pub async fn apply(&self, p: ConfigProposal) -> Result<Arc<ConfigSnapshot>, ConfigError> {
        let t_apply = std::time::Instant::now();
        let mut w = self.view.write().unwrap(); // 串行化所有 apply
        let cur = w.clone();
        let cur_version = self.version.load(Ordering::SeqCst);

        // 乐观并发: 提交基于过期版本则拒绝
        if let Some(based) = p.based_on {
            if based != cur_version {
                let e = ConfigError::StaleVersion {
                    based_on: based,
                    current: cur_version,
                };
                self.metrics.record_apply(false, 0);
                self.audit.log(
                    "reject",
                    cur_version,
                    p.based_on,
                    &p.source,
                    &p.operator,
                    &p.reason,
                    &e.to_string(),
                );
                let _ = self.tx.send(ConfigChangeEvent::Rejected {
                    reason: e.to_string(),
                });
                return Err(e);
            }
        }

        // 授权过滤 (AI 仅白名单)
        let filtered = match p.auth {
            ConfigAuth::Ai => apply_ai_whitelist(&cur.config, &p.config),
            _ => p.config.clone(),
        };

        // 重复提交: 内容无变更, 不升版本
        if filtered == cur.config {
            self.audit.log(
                "apply",
                cur_version,
                p.based_on,
                &p.source,
                &p.operator,
                &p.reason,
                "no-change (duplicate)",
            );
            return Ok(cur);
        }

        // 结构 / 业务不变量校验 (失败 → 旧配置不变)
        if let Err(e) = validate(&filtered) {
            self.metrics.record_apply(false, 0);
            self.audit.log(
                "reject",
                cur_version,
                p.based_on,
                &p.source,
                &p.operator,
                &p.reason,
                &e.to_string(),
            );
            let _ = self.tx.send(ConfigChangeEvent::Rejected {
                reason: e.to_string(),
            });
            return Err(e);
        }

        // 类别级授权
        if let Err(e) = check_category_auth(&filtered, &cur.config, p.auth) {
            self.metrics.record_apply(false, 0);
            self.audit.log(
                "reject",
                cur_version,
                p.based_on,
                &p.source,
                &p.operator,
                &p.reason,
                &e.to_string(),
            );
            let _ = self.tx.send(ConfigChangeEvent::Rejected {
                reason: e.to_string(),
            });
            return Err(e);
        }

        let new_version = cur_version + 1;
        let snap = ConfigSnapshot::new(
            new_version,
            filtered.clone(),
            &p.source,
            &p.operator,
            &p.reason,
        );
        let arc = Arc::new(snap);
        *w = arc.clone();
        self.version.store(new_version, Ordering::SeqCst);
        drop(w);

        // 历史 (保留近期快照用于回滚)。
        // **先入旧快照再入新快照**: 否则"刚被替换掉的上一版"不在历史里,
        // 改动一落地就失去回退点 (自动优化/误操作都靠它兜底)。
        {
            let mut h = self.history.lock().unwrap();
            if !h.iter().any(|s| s.version == cur.version) {
                h.push_back(cur.clone());
            }
            h.push_back(arc.clone());
            while h.len() > HISTORY_LIMIT {
                h.pop_front();
            }
        }

        // 落盘 (失败仅告警, 不影响内存状态)
        self.save_current(&arc);
        self.audit.log(
            "apply",
            new_version,
            p.based_on,
            &p.source,
            &p.operator,
            &p.reason,
            "ok",
        );
        self.metrics.record_apply(true, t_apply.elapsed().as_nanos() as u64);
        if self.tx.send(ConfigChangeEvent::Applied(arc.clone())).is_ok() {
            self.metrics.record_event();
        }
        Ok(arc)
    }

    /// 回滚到指定历史版本。生成新版本 (restored_from = target), 当前配置内容等于目标版本。
    pub async fn rollback_to(&self, target: u64) -> Result<Arc<ConfigSnapshot>, ConfigError> {
        let mut w = self.view.write().unwrap();
        let cur = w.clone();
        if cur.version == target {
            return Ok(cur);
        }
        let found = {
            let h = self.history.lock().unwrap();
            h.iter().find(|s| s.version == target).cloned()
        };
        let src = match found {
            Some(s) => s,
            None => {
                drop(w);
                let e = ConfigError::RollbackTargetNotFound(target);
                self.metrics.record_rollback(false);
                self.audit.log(
                    "reject",
                    cur.version,
                    Some(target),
                    "rollback",
                    "system",
                    "rollback",
                    &e.to_string(),
                );
                return Err(e);
            }
        };
        let new_version = self.version.load(Ordering::SeqCst) + 1;
        let mut snap =
            ConfigSnapshot::new(new_version, src.config.clone(), "rollback", "system", "rollback");
        snap.restored_from = Some(target);
        let arc = Arc::new(snap);
        *w = arc.clone();
        self.version.store(new_version, Ordering::SeqCst);
        drop(w);
        {
            let mut h = self.history.lock().unwrap();
            if !h.iter().any(|s| s.version == cur.version) {
                h.push_back(cur.clone());
            }
            h.push_back(arc.clone());
            while h.len() > HISTORY_LIMIT {
                h.pop_front();
            }
        }
        self.save_current(&arc);
        self.audit.log(
            "rollback",
            new_version,
            Some(target),
            "rollback",
            "system",
            "rollback",
            "ok",
        );
        self.metrics.record_rollback(true);
        if self
            .tx
            .send(ConfigChangeEvent::RolledBack {
                target,
                snapshot: arc.clone(),
            })
            .is_ok()
        {
            self.metrics.record_event();
        }
        Ok(arc)
    }

    /// **协调应用** (多进程/多节点): 租约 + 栅栏令牌 + 强制显式 `based_on`。
    ///
    /// 与 `apply` 的区别必须分清 (需求要求明确区分, 不许混为一谈):
    /// - `apply` = 单机原子切换: 本进程读不到半个配置, 版本单调; 不保证跨进程顺序。
    /// - `apply_coordinated` = 在上述之上加"同一命名空间只有一个写入者"的租约;
    ///   提交必须带 `based_on`, 与本机当前版本不符即放弃 (防止用旧版本静默覆盖新版本)。
    /// - 两者都**不是**分布式事务: 跨节点可见性仍需对端拉取 (`sync_from_peer`)。
    pub async fn apply_coordinated<C: LeaseCoordinator>(
        &self,
        coord: &C,
        holder: &str,
        ttl_ms: u64,
        p: ConfigProposal,
    ) -> Result<(Arc<ConfigSnapshot>, Lease), CoordError> {
        let based_on = p.based_on.ok_or(CoordError::MissingBasedOn)?;
        let lease = coord.acquire(holder, ttl_ms)?;
        let cur_version = self.version();
        if cur_version != based_on {
            let _ = coord.release(&lease);
            return Err(CoordError::FencedOut {
                mine: based_on,
                current: cur_version,
            });
        }
        let res = self.apply(p).await;
        let _ = coord.release(&lease);
        match res {
            Ok(snap) => Ok((snap, lease)),
            Err(e) => Err(CoordError::Io(format!("apply 失败: {e}"))),
        }
    }

    /// 从对端节点拉取配置: 对端版本更高时本地应用 (最终一致, 后写覆盖)。
    /// 对端不可用 / 返回畸形内容 → 本地配置**不动** (fail-closed)。返回 None = 无需同步。
    pub async fn sync_from_peer(
        &self,
        base_url: &str,
        timeout_ms: u64,
        operator: &str,
    ) -> Result<Option<Arc<ConfigSnapshot>>, ConfigError> {
        #[derive(serde::Deserialize)]
        struct PeerView {
            version: u64,
            config: AppConfig,
        }
        let url = format!("{}/api/config/current", base_url.trim_end_matches('/'));
        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .send()
            .await
            .map_err(|e| ConfigError::RemoteUnavailable(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(ConfigError::RemoteUnavailable(format!(
                "HTTP {}",
                resp.status()
            )));
        }
        let txt = resp
            .text()
            .await
            .map_err(|e| ConfigError::RemoteUnavailable(e.to_string()))?;
        let peer: PeerView = serde_json::from_str(&txt)
            .map_err(|e| ConfigError::RemoteUnavailable(format!("畸形内容: {e}")))?;
        if peer.version <= self.version() {
            return Ok(None);
        }
        let snap = self
            .apply(ConfigProposal {
                based_on: Some(self.version()),
                config: peer.config,
                auth: ConfigAuth::System,
                source: format!("peer:{url}"),
                operator: operator.into(),
                reason: format!("sync from peer (peer v{})", peer.version),
            })
            .await?;
        Ok(Some(snap))
    }

    /// 原子写当前快照到文件 (tmp + rename)。
    fn save_current(&self, snap: &ConfigSnapshot) {
        if let Some(f) = &self.file {
            if let Some(dir) = f.parent() {
                let _ = create_dir_all(dir);
            }
            let tmp = f.with_extension("tmp");
            if let Ok(s) = serde_json::to_string_pretty(snap) {
                if let Ok(mut fh) = OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&tmp)
                {
                    if fh.write_all(s.as_bytes()).is_ok() {
                        let _ = std::fs::rename(&tmp, f);
                    }
                }
            }
        }
    }

    /// 从文件加载 (重启恢复)。解析失败 / 校验失败均返回错误且**保持当前内存配置不变** (fail-closed)。
    pub async fn load_from_file(&self) -> Result<Arc<ConfigSnapshot>, ConfigError> {
        let f = match &self.file {
            Some(f) => f.clone(),
            None => return Err(ConfigError::Load("未配置文件路径".into())),
        };
        let txt = std::fs::read_to_string(&f).map_err(|e| ConfigError::Load(e.to_string()))?;
        let snap: ConfigSnapshot =
            serde_json::from_str(&txt).map_err(|e| ConfigError::Load(e.to_string()))?;
        validate(&snap.config)?;
        let arc = Arc::new(snap);
        let v = arc.version;
        {
            let mut w = self.view.write().unwrap();
            *w = arc.clone();
            self.version.store(v, Ordering::SeqCst);
        }
        self.audit.log(
            "load",
            v,
            None,
            "file",
            "system",
            "restart recovery",
            "ok",
        );
        Ok(arc)
    }

    /// 从远程拉取配置 (超时 / 非 2xx / 畸形 JSON 均视为不可用 → fail-closed)。
    pub async fn fetch_remote(url: &str, timeout_ms: u64) -> Result<AppConfig, ConfigError> {
        let client = reqwest::Client::new();
        let resp = client
            .get(url)
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .send()
            .await
            .map_err(|e| ConfigError::RemoteUnavailable(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(ConfigError::RemoteUnavailable(format!(
                "HTTP {}",
                resp.status()
            )));
        }
        let txt = resp
            .text()
            .await
            .map_err(|e| ConfigError::RemoteUnavailable(e.to_string()))?;
        let cfg: AppConfig = serde_json::from_str(&txt)
            .map_err(|e| ConfigError::RemoteUnavailable(format!("畸形内容: {e}")))?;
        Ok(cfg)
    }

    /// 拉取远程并应用。远程不可用时返回错误, 当前配置不变 (fail-closed)。
    pub async fn apply_remote(
        &self,
        url: &str,
        timeout_ms: u64,
        auth: ConfigAuth,
        operator: &str,
        reason: &str,
    ) -> Result<Arc<ConfigSnapshot>, ConfigError> {
        let cfg = Self::fetch_remote(url, timeout_ms).await?;
        self.apply(ConfigProposal {
            based_on: None,
            config: cfg,
            auth,
            source: format!("remote:{url}"),
            operator: operator.into(),
            reason: reason.into(),
        })
        .await
    }
}
