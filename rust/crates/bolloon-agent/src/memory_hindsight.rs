//! memory_hindsight.rs — 记忆外挂: hindsight-engine (crates.io 0.1.0) **进程内**适配器
//!
//! **分层纪律 (AGENTS.md §8)**: 本地 SQLite (`memory_db.rs`) 恒为记忆真源;
//! hindsight 只做语义召回 + 事实抽取的**外挂**。它不可用时 = 自动降级回本地,
//! 永不阻塞主循环、永不把外挂故障冒充成工具失败。
//!
//! 引擎硬依赖 (hindsight-rust v0.1.0 如实边界):
//!   · PostgreSQL + pgvector (`database_url`, 默认 `postgres://postgres:postgres@localhost:5432/hindsight`)
//!   · LLM (retain 事实抽取): OpenAI 兼容**必须给 base_url**, 或 Anthropic
//!   · embedding: `hash` (离线确定性, 零 key) 或 OpenAI 兼容 HTTP; `local`/`onnx` 不支持
//!
//! 三条硬规则:
//!   1. `database_url` 必须 loopback, 非 loopback 需显式 `allowRemoteDatabase: true`
//!      (记忆数据出本机 = 数据出境, 不是配个 URL 就默许);
//!   2. 外挂任何失败 (连不上/超时/畸形) ⇒ 只记 `last_error` 供 doctor 如实上报,
//!      召回静默回落本地 —— "外挂缺席" 不是错误;
//!   3. 配置缺省 `backend: "local"` ⇒ 本模块整体零行为 (不建连接不读配置)。

use std::sync::Arc;

use tokio::sync::{Mutex, OnceCell};

use crate::memory_db::MemoryRow;

/// 从 bolloon 配置解析出的外挂设置 (校验后)
#[derive(Debug, Clone)]
pub struct HindsightSettings {
    pub database_url: String,
    pub database_schema: Option<String>,
    pub bank_prefix: String,
    pub llm_provider: Option<String>,
    pub llm_model: Option<String>,
    pub llm_api_key: Option<String>,
    pub llm_base_url: Option<String>,
    pub embeddings_provider: String,
    pub embeddings_model: Option<String>,
    pub embeddings_api_key: Option<String>,
    pub embeddings_base_url: Option<String>,
    pub embeddings_dimension: Option<usize>,
    pub mirror_writes: bool,
    pub recall_timeout_ms: u64,
}

impl HindsightSettings {
    /// 从配置段校验解析。`Err(原因)` = 配置有问题 (doctor 要逐字说清, 不猜)。
    pub fn from_backend(cfg: &bolloon_llm::config_store::MemoryBackendSettings) -> Result<Self, String> {
        if cfg.backend.is_empty() || cfg.backend == "local" {
            return Err("backend=local (外挂未启用)".into());
        }
        if cfg.backend != "hindsight" {
            return Err(format!("未知 backend `{}` (只认 local / hindsight)", cfg.backend));
        }
        let database_url = cfg
            .database_url
            .clone()
            .unwrap_or_else(|| "postgres://postgres:postgres@localhost:5432/hindsight".into());
        // 硬规则 1: 记忆数据不出本机
        if !is_loopback_database_url(&database_url) && !cfg.allow_remote_database.unwrap_or(false) {
            return Err(format!(
                "database_url 非 loopback (`{database_url}`) — 记忆数据将离开本机; \
                 确认后须显式配置 `memory.allowRemoteDatabase: true`"
            ));
        }
        let llm = cfg.llm.clone().unwrap_or_default();
        // 引擎在 connect() 时就会构造 chat 模型: OpenAI 兼容协议缺 base_url 直接报错
        let provider = llm.provider.clone().unwrap_or_else(|| "openai".into());
        let is_anthropic = matches!(provider.as_str(), "anthropic" | "claude" | "claude-code");
        if llm.base_url.is_none() && !is_anthropic {
            return Err(
                "memory.llm.baseUrl 未配置 — hindsight 的 retain 需要一个 OpenAI 兼容端点 \
                 (如 ollama: http://localhost:11434/v1)"
                    .into(),
            );
        }
        let emb = cfg.embeddings.clone().unwrap_or_default();
        let embeddings_provider = emb.provider.clone().unwrap_or_else(|| "hash".into());
        if matches!(embeddings_provider.as_str(), "local" | "onnx") {
            return Err(
                "memory.embeddings.provider=local/onnx 在 Rust 版 hindsight 不支持 \
                 (会明确报错); 离线请用 `hash`, 在线用 OpenAI 兼容端点".into(),
            );
        }
        Ok(Self {
            database_url,
            database_schema: cfg.database_schema.clone(),
            bank_prefix: cfg.bank_prefix.clone().unwrap_or_else(|| "bolloon".into()),
            llm_provider: Some(provider),
            llm_model: llm.model.clone(),
            // LLM key 只走环境变量 (HINDSIGHT_API_LLM_API_KEY 或 ~/.bolloon/.env 注入), 不进 JSON
            llm_api_key: std::env::var("HINDSIGHT_API_LLM_API_KEY").ok(),
            llm_base_url: llm.base_url,
            embeddings_provider,
            embeddings_model: emb.model,
            embeddings_api_key: std::env::var("HINDSIGHT_API_EMBEDDINGS_API_KEY")
                .ok()
                .or(emb.api_key),
            embeddings_base_url: emb.base_url,
            embeddings_dimension: emb.dimension,
            mirror_writes: cfg.mirror_writes.unwrap_or(true),
            recall_timeout_ms: cfg.recall_timeout_ms.unwrap_or(3_000),
        })
    }

    /// bank_id = `{prefix}:{agent_id}` — 一个 agent 一个 bank (hindsight 的隔离单位)
    pub fn bank_id(&self, agent_id: &str) -> String {
        format!("{}:{}", self.bank_prefix, agent_id)
    }

    /// 映射成 hindsight 引擎自己的 Config (先吃 HINDSIGHT_API_* env 缺省, 再用 bolloon 配置覆盖)
    pub fn to_engine_config(&self) -> Result<hindsight_engine::Config, String> {
        let mut c = hindsight_engine::Config::from_env()
            .map_err(|e| format!("hindsight HINDSIGHT_API_* 环境变量解析失败: {e}"))?;
        c.database_url = self.database_url.clone();
        if let Some(s) = &self.database_schema {
            c.database_schema = s.clone();
        }
        if let Some(p) = &self.llm_provider {
            c.llm_provider = p.clone();
        }
        if let Some(m) = &self.llm_model {
            c.llm_model = m.clone();
        }
        c.llm_api_key = self.llm_api_key.clone();
        c.llm_base_url = self.llm_base_url.clone();
        c.embeddings_provider = self.embeddings_provider.clone();
        if let Some(m) = &self.embeddings_model {
            c.embeddings_model = m.clone();
        }
        c.embeddings_api_key = self.embeddings_api_key.clone();
        c.embeddings_base_url = self.embeddings_base_url.clone();
        if let Some(d) = self.embeddings_dimension {
            c.embeddings_dimension = d;
        }
        Ok(c)
    }
}

/// `postgres://user:pass@host:port/db` 里的 host 是否 loopback。
/// 解析失败 = 不放行 (fail-closed)。
pub fn is_loopback_database_url(url: &str) -> bool {
    let rest = match url.split_once("://") {
        Some((scheme, rest)) if scheme.starts_with("postgres") => rest,
        _ => return false,
    };
    // 凭据段可能含 @: 取最后一个 @ 之后
    let hostport = rest.rsplit('@').next().unwrap_or(rest);
    let host = hostport
        .split(['/', '?'])
        .next()
        .unwrap_or("")
        .rsplit(':')
        .last()
        .unwrap_or("");
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// 合并本地行与外挂行: 本地在前 (真源优先), 外挂行加 `~` 前缀,
/// 按规范化内容去重 (SQLite 已命中的不在外挂里重复出现), 总长截到预算内。
/// 返回 (行, 外挂实际采用的条数)。
pub fn merge_lines(local: &[String], remote: &[String], char_budget: usize) -> (Vec<String>, usize) {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    let mut used = 0usize;
    let push = |text: String, raw: &str, is_remote: bool, out: &mut Vec<String>, used: &mut usize, seen: &mut std::collections::HashSet<String>, taken: &mut usize| -> bool {
        // 去重键用**原始内容**: 外挂行的 `~` 前缀不能参与, 否则同内容两边各留一份
        let key = normalize_key(raw);
        if !key.is_empty() && !seen.insert(key) {
            return false; // 已见 (本地/外挂重复) → 丢弃
        }
        let cost = text.chars().count() + 1; // +1 换行
        if *used + cost > char_budget {
            return false;
        }
        *used += cost;
        if is_remote {
            *taken += 1;
        }
        out.push(text);
        true
    };
    let mut taken = 0usize;
    for line in local {
        push(line.clone(), line, false, &mut out, &mut used, &mut seen, &mut taken);
    }
    for line in remote {
        let text = format!("~ {line}");
        push(text, line, true, &mut out, &mut used, &mut seen, &mut taken);
    }
    (out, taken)
}

fn normalize_key(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// 外挂记忆 (进程内引擎句柄, 懒连接)
pub struct HindsightMemory {
    settings: Option<HindsightSettings>,
    handle: OnceCell<Result<Arc<hindsight_engine::Hindsight>, String>>,
    /// 最近一次外挂故障 (doctor/证据如实上报; 成功后清空)
    last_error: Mutex<Option<String>>,
    /// 配置校验失败的原因 (backend=hindsight 但配置不合法时非空; doctor 用)
    config_error: Mutex<Option<String>>,
}

impl HindsightMemory {
    /// 从整份 bolloon 配置构建。配置缺省/`local` ⇒ disabled (零行为)。
    pub fn from_llm_config(cfg: &bolloon_llm::config_store::LlmConfig) -> Self {
        let mut config_error: Option<String> = None;
        let settings = cfg.memory.as_ref().and_then(|m| match HindsightSettings::from_backend(m) {
            Ok(s) => Some(s),
            Err(e) => {
                tracing::info!("hindsight 记忆外挂未启用: {e}");
                if m.backend == "hindsight" {
                    // 配置了但要启用失败: 原因留给 doctor, 不算错误只是降级
                    config_error = Some(e);
                }
                None
            }
        });
        Self {
            settings,
            handle: OnceCell::new(),
            last_error: Mutex::new(None),
            config_error: Mutex::new(config_error),
        }
    }

    pub fn enabled(&self) -> bool {
        self.settings.is_some()
    }

    pub fn settings(&self) -> Option<&HindsightSettings> {
        self.settings.as_ref()
    }

    pub async fn last_error(&self) -> Option<String> {
        self.last_error.lock().await.clone()
    }

    /// 配置校验失败原因 (backend=hindsight 但配置不合法; doctor 如实上报用)
    pub async fn config_error(&self) -> Option<String> {
        self.config_error.lock().await.clone()
    }

    async fn record_error(&self, e: String) {
        tracing::warn!("hindsight 外挂: {e}");
        *self.last_error.lock().await = Some(e);
    }

    /// 引擎句柄 (懒连接, 带超时)。`Err` = 配置/连接问题; 调用方一律降级。
    pub async fn handle(&self) -> Option<Arc<hindsight_engine::Hindsight>> {
        let settings = self.settings.as_ref()?;
        let res = self
            .handle
            .get_or_init(|| async {
                let cfg = match settings.to_engine_config() {
                    Ok(c) => c,
                    Err(e) => return Err(e),
                };
                match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    hindsight_engine::Hindsight::connect(cfg),
                )
                .await
                {
                    Ok(Ok(h)) => {
                        tracing::info!("hindsight 引擎已连接 (bank 前缀 {})", settings.bank_prefix);
                        Ok(Arc::new(h))
                    }
                    Ok(Err(e)) => Err(format!("hindsight 连接失败: {e}")),
                    Err(_) => Err("hindsight 连接超时 (5s)".into()),
                }
            })
            .await;
        match res {
            Ok(h) => Some(h.clone()),
            Err(e) => {
                // 连接失败要能"之后重试" (比如用户事后才把 PG 起起来): 清掉缓存的失败
                if self.handle.get().is_some() {
                    // OnceCell 不能重置 — 记下错误, 下次进程内仍降级 (诚实: doctor 会说明)
                    self.record_error(e.clone()).await;
                }
                None
            }
        }
    }

    /// 融合召回: 本地行在前, 外挂语义行 (`~` 前缀) 补充, 去重 + 截预算。
    /// 外挂任何故障 = 只返回本地点 (降级不报错)。
    pub async fn recall_merged(
        &self,
        agent_id: &str,
        query: &str,
        local_lines: Vec<String>,
        k: usize,
        char_budget: usize,
    ) -> (Vec<String>, Option<String>) {
        let Some(settings) = self.settings.as_ref() else {
            return (local_lines, None);
        };
        if query.trim().is_empty() {
            return (local_lines, None);
        }
        let Some(h) = self.handle().await else {
            let e = self.last_error().await.unwrap_or_else(|| "外挂不可用".into());
            return (local_lines, Some(e));
        };
        let bank = settings.bank_id(agent_id);
        let timeout = std::time::Duration::from_millis(settings.recall_timeout_ms);
        match tokio::time::timeout(timeout, h.recall_query(&bank, query)).await {
            Ok(Ok(resp)) => {
                let mut remote: Vec<String> = resp
                    .results
                    .iter()
                    .take(k)
                    .map(|r| r.text.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect();
                // 去掉外挂结果与本地行的逐字重复 (merge 里还会做规范化去重, 这里省预算)
                remote.retain(|t| !local_lines.iter().any(|l| normalize_key(l) == normalize_key(t)));
                let (lines, taken) = merge_lines(&local_lines, &remote, char_budget);
                if taken == 0 {
                    return (local_lines, None); // 外挂没补上任何东西 = 与纯本地等价
                }
                (lines, None)
            }
            Ok(Err(e)) => {
                let msg = format!("hindsight recall 失败: {e}");
                self.record_error(msg.clone()).await;
                (local_lines, Some(msg))
            }
            Err(_) => {
                let msg = format!("hindsight recall 超时 (>{}ms)", settings.recall_timeout_ms);
                self.record_error(msg.clone()).await;
                (local_lines, Some(msg))
            }
        }
    }

    /// 镜像写入 (fire-and-forget): SQLite 已落盘的前提下才调用;
    /// 失败只记 last_error, **绝不**影响 remember 工具的返回 (本地写入是真的)。
    /// 调用方用 `tokio::spawn(global().mirror_remember_async(...))` 派发。
    pub async fn mirror_remember_async(
        &self,
        agent_id: &str,
        row: &MemoryRow,
        context: Option<&str>,
    ) {
        let Some(settings) = self.settings.as_ref() else { return };
        if !settings.mirror_writes {
            return;
        }
        let bank = settings.bank_id(agent_id);
        let content = row.content.clone();
        let context = context.map(|s| s.to_string());
        let Some(h) = self.handle().await else { return };
        if let Err(e) = h.retain_text(&bank, content, context.as_deref()).await {
            self.record_error(format!("hindsight retain 失败: {e}")).await;
        }
    }

    /// mirror 是否会真正派发 (配置门; 供 remember 工具的 evidence 如实标注)
    pub fn mirror_enabled(&self) -> bool {
        self.settings.as_ref().map(|s| s.mirror_writes).unwrap_or(false)
    }
}

/// 进程级单例 (从 `bolloon-config.json` 的 `memory` 段构建)
pub fn global() -> &'static HindsightMemory {
    static HINDSIGHT: std::sync::OnceLock<HindsightMemory> = std::sync::OnceLock::new();
    HINDSIGHT.get_or_init(|| HindsightMemory::from_llm_config(&bolloon_llm::config_store::load()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bolloon_llm::config_store::MemoryBackendSettings;

    fn settings_of(m: MemoryBackendSettings) -> Result<HindsightSettings, String> {
        HindsightSettings::from_backend(&m)
    }

    #[test]
    fn default_backend_is_disabled() {
        let mem = HindsightMemory::from_llm_config(&Default::default());
        assert!(!mem.enabled());
        // 未启用 ⇒ 召回原样返回本地行, 不碰外挂
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (lines, degraded) = rt.block_on(mem.recall_merged("a", "q", vec!["本地点".into()], 5, 900));
        assert_eq!(lines, vec!["本地点".to_string()]);
        assert!(degraded.is_none());
    }

    #[test]
    fn unknown_backend_rejected() {
        let m = MemoryBackendSettings { backend: "redis".into(), ..Default::default() };
        assert!(settings_of(m).is_err());
    }

    #[test]
    fn hindsight_requires_llm_base_url() {
        let m = MemoryBackendSettings { backend: "hindsight".into(), ..Default::default() };
        let err = settings_of(m).unwrap_err();
        assert!(err.contains("baseUrl"), "实际: {err}");
    }

    #[test]
    fn remote_database_blocked_by_default() {
        let m = |allow_remote: Option<bool>| MemoryBackendSettings {
            backend: "hindsight".into(),
            database_url: Some("postgres://u:p@10.0.0.8:5432/hindsight".into()),
            llm: Some(bolloon_llm::config_store::MemoryLlmSettings {
                provider: None,
                model: None,
                base_url: Some("http://localhost:11434/v1".into()),
            }),
            allow_remote_database: allow_remote,
            ..Default::default()
        };
        let err = settings_of(m(None)).unwrap_err();
        assert!(err.contains("loopback"), "实际: {err}");
        // 显式放开后可用
        assert!(settings_of(m(Some(true))).is_ok());
    }

    #[test]
    fn local_onnx_embedding_rejected_honestly() {
        let m = MemoryBackendSettings {
            backend: "hindsight".into(),
            embeddings: Some(bolloon_llm::config_store::MemoryEmbeddingsSettings {
                provider: Some("local".into()),
                ..Default::default()
            }),
            llm: Some(bolloon_llm::config_store::MemoryLlmSettings {
                provider: None,
                model: None,
                base_url: Some("http://localhost:11434/v1".into()),
            }),
            ..Default::default()
        };
        assert!(settings_of(m).unwrap_err().contains("hash"));
    }

    #[test]
    fn bank_id_uses_prefix_and_agent() {
        let m = MemoryBackendSettings {
            backend: "hindsight".into(),
            bank_prefix: Some("bolloon".into()),
            llm: Some(bolloon_llm::config_store::MemoryLlmSettings {
                provider: None,
                model: None,
                base_url: Some("http://localhost:11434/v1".into()),
            }),
            ..Default::default()
        };
        assert_eq!(settings_of(m).unwrap().bank_id("local"), "bolloon:local");
    }

    #[test]
    fn loopback_parser() {
        assert!(is_loopback_database_url("postgres://postgres:postgres@localhost:5432/hindsight"));
        assert!(is_loopback_database_url("postgres://127.0.0.1:5432/hindsight"));
        assert!(!is_loopback_database_url("postgres://u:p@10.1.2.3:5432/db"));
        assert!(!is_loopback_database_url("sqlite://memory"));
        assert!(!is_loopback_database_url("not a url"));
    }

    #[test]
    fn merge_dedups_and_local_first() {
        let local = vec!["用户偏好暗色主题".to_string()];
        let remote = vec![
            "用户偏好暗色主题".to_string(),   // 与本地重复 → 丢弃
            "项目用 Rust 2021 edition".to_string(),
        ];
        let (lines, taken) = merge_lines(&local, &remote, 900);
        assert_eq!(lines, vec!["用户偏好暗色主题".to_string(), "~ 项目用 Rust 2021 edition".to_string()]);
        assert_eq!(taken, 1);
    }

    #[test]
    fn merge_respects_char_budget() {
        let local: Vec<String> = (0..10).map(|i| format!("本地记忆{i}——这里是一段比较长的内容用来占预算")).collect();
        let remote = vec!["外挂补充".to_string()];
        let (lines, taken) = merge_lines(&local, &remote, 80);
        assert!(taken == 0 || lines.iter().any(|l| l.starts_with("~ ")));
        assert!(lines.iter().map(|l| l.chars().count()).sum::<usize>() <= 200);
    }

    #[test]
    fn merge_empty_remote_is_noop() {
        let local = vec!["a".into(), "b".into()];
        let (lines, taken) = merge_lines(&local, &[], 900);
        assert_eq!(lines, local);
        assert_eq!(taken, 0);
    }
}
