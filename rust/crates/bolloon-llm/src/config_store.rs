//! provider 配置 — `~/.bolloon/bolloon-config.json` (0600, 明文 JSON, 不加密)
//!
//! 与 TS `src/llm/config-store.ts` 同一路径同一形状 (camelCase), 两家共用一份配置:
//! `{ activeProvider, providers: { <id>: {...} }, customProviders: { <id>: {...} } }`
//!
//! 纪律:
//! - **单写入路径**: `save_to()` 里 tmp + 0600 + 原子 rename (不写坏半截配置)
//! - **坏文件不冒充**: 解析失败 → 默认配置 (空), 不猜
//! - **key 只从文件或环境变量读**, 绝不出现在日志/接口回显里

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::provider_catalog::AuthKind;
use crate::provider_registry::{self, Protocol, ProviderRegistryEntry};

/// 配置文件名 (与 TS 同名)
pub const CONFIG_FILE: &str = "bolloon-config.json";

/// 读时间: 字符串(ISO) 或 数字(ms) 都接受 (TS 写 ISO, 早期 Rust 写过数字)
fn de_flex_time<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => Ok(s),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        // 别的类型 = 文件坏了; 如实报错 (否则会被当成"读到空配置"再盖掉人家)
        other => Err(serde::de::Error::custom(format!(
            "updatedAt 既不是 ISO 字符串也不是数字: {other}"
        ))),
    }
}

/// 当前时间 ISO 字符串 (与 TS `new Date().toISOString()` 同形)
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn default_temperature() -> f32 {
    0.7
}
fn default_max_tokens() -> u32 {
    4096
}

/// 一家 provider 的用户设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    #[serde(default)]
    pub enabled: bool,
    /// 明文 key (文件 0600; 永不回显)
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
}

impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            temperature: default_temperature(),
            max_tokens: default_max_tokens(),
        }
    }
}

/// 用户自定义 provider (目录里没有的那家)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProvider {
    pub provider_id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub base_url: String,
    /// 协议: 不填 → 按 base_url 推
    #[serde(default)]
    pub protocol: Option<Protocol>,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    /// 手填模型清单 (自定义家唯一的模型来源)
    #[serde(default)]
    pub models: Vec<String>,
}

/// 整份配置
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    #[serde(default)]
    pub active_provider: String,
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderSettings>,
    #[serde(default)]
    pub custom_providers: BTreeMap<String, CustomProvider>,
    /// 最后写入时间 (**与 TS 一致: ISO 字符串**; 旧文件里的数字也容忍)
    #[serde(default, deserialize_with = "de_flex_time")]
    pub updated_at: String,
}

/// key 从哪来 (界面上要如实标)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum KeySource {
    /// 配置文件里的 api_key
    Config,
    /// 环境变量 (带变量名)
    Env(String),
    /// 本机服务/不需要 key
    None,
}

impl KeySource {
    pub fn as_str(&self) -> String {
        match self {
            KeySource::Config => "config".into(),
            KeySource::Env(var) => format!("env:{var}"),
            KeySource::None => "none".into(),
        }
    }
}

/// 解析好的一家 (可直接建 runtime)
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub id: String,
    pub protocol: Protocol,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub key_source: KeySource,
}

impl Resolved {
    /// 回显用 (永不带 key 明文)
    pub fn auth_ref(&self) -> String {
        self.key_source.as_str()
    }
}

/// 配置目录: BOLLOON_HOME / ~/.bolloon
pub fn config_dir() -> PathBuf {
    if let Ok(home) = std::env::var("BOLLOON_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }
    let base = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join(".bolloon")
}

/// 配置文件路径
pub fn config_path() -> PathBuf {
    config_dir().join(CONFIG_FILE)
}

/// 读配置 (坏文件 → 默认配置, 不猜)
pub fn load_from(dir: &Path) -> LlmConfig {
    let path = dir.join(CONFIG_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!(path = %path.display(), error = %e, "provider 配置解析失败 — 按空配置处理");
            LlmConfig::default()
        }),
        Err(_) => LlmConfig::default(),
    }
}

/// 落盘 (tmp + 0600 + 原子 rename; 唯一写入路径)
pub fn save_to(dir: &Path, cfg: &LlmConfig) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(CONFIG_FILE);
    let tmp = dir.join(format!("{CONFIG_FILE}.tmp"));

    // **不许默默盖掉别人的配置**: 盘上那份解析不了 (例如 TS 改了形状) ⇒ 拒绝覆盖,
    //   除非显式 BOLLOON_CONFIG_FORCE=1。能解析的则先留一份 .bak (只留最近一份)。
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if !existing.trim().is_empty() {
            match serde_json::from_str::<LlmConfig>(&existing) {
                Ok(_) => {
                    let _ = std::fs::write(path.with_extension("json.bak"), existing.as_bytes());
                }
                Err(e) => {
                    if std::env::var("BOLLOON_CONFIG_FORCE").is_err() {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            format!(
                                "现有配置无法解析, 拒绝覆盖 ({}) — 原因: {e}; \
                                 确认要重建就设 BOLLOON_CONFIG_FORCE=1",
                                path.display()
                            ),
                        ));
                    }
                }
            }
        }
    }

    let raw = serde_json::to_string_pretty(cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    {
        let mut f = std::fs::File::create(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        f.write_all(raw.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 读配置 (默认路径)
pub fn load() -> LlmConfig {
    load_from(&config_dir())
}

/// 写配置 (默认路径)
pub fn save(cfg: &LlmConfig) -> std::io::Result<()> {
    save_to(&config_dir(), cfg)
}

/// 写一家的设置 (空字符串字段 = 不改)
pub fn set_provider(
    id: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
) -> std::io::Result<LlmConfig> {
    let mut cfg = load();
    apply_provider(&mut cfg, id, api_key, base_url, model);
    save(&cfg)?;
    Ok(cfg)
}

/// 纯函数: 改一家的设置 (测试直接用, 不碰盘)
pub fn apply_provider(
    cfg: &mut LlmConfig,
    id: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
) {
    let entry = cfg.providers.entry(id.to_string()).or_default();
    if let Some(k) = api_key {
        if !k.trim().is_empty() {
            entry.api_key = k.trim().to_string();
        }
    }
    if let Some(b) = base_url {
        if !b.trim().is_empty() {
            entry.base_url = b.trim().to_string();
        }
    }
    if let Some(m) = model {
        if !m.trim().is_empty() {
            entry.model = m.trim().to_string();
        }
    }
    entry.enabled = true;
    // 自定义家: 同一份设置**镜像**进 customProviders (解析时以那一格为准, 不镜像就等于白填)
    if let Some(custom) = cfg.custom_providers.get_mut(id) {
        if let Some(k) = api_key {
            if !k.trim().is_empty() {
                custom.api_key = k.trim().to_string();
            }
        }
        if let Some(b) = base_url {
            if !b.trim().is_empty() {
                custom.base_url = b.trim().to_string();
            }
        }
        if let Some(m) = model {
            if !m.trim().is_empty() {
                custom.model = m.trim().to_string();
            }
        }
    }
    cfg.active_provider = id.to_string();
    cfg.updated_at = now_iso();
}

/// 设当前使用的一家 (不存在则只记 id, 解析时再报)
pub fn set_active(cfg: &mut LlmConfig, id: &str) {
    cfg.active_provider = id.to_string();
    cfg.updated_at = now_iso();
}

/// 新增/更新自定义 provider
#[allow(clippy::too_many_arguments)]
pub fn upsert_custom(
    cfg: &mut LlmConfig,
    id: &str,
    display_name: &str,
    base_url: &str,
    protocol: Option<Protocol>,
    api_key: Option<&str>,
    model: Option<&str>,
) {
    let protocol = protocol.unwrap_or_else(|| Protocol::infer_from_base_url(base_url));
    let entry = cfg
        .custom_providers
        .entry(id.to_string())
        .or_insert_with(|| CustomProvider {
            provider_id: id.to_string(),
            display_name: display_name.to_string(),
            base_url: base_url.to_string(),
            protocol: Some(protocol),
            api_key: String::new(),
            model: String::new(),
            models: vec![],
        });
    entry.display_name = display_name.to_string();
    entry.base_url = base_url.to_string();
    entry.protocol = Some(protocol);
    if let Some(k) = api_key {
        if !k.trim().is_empty() {
            entry.api_key = k.trim().to_string();
        }
    }
    if let Some(m) = model {
        if !m.trim().is_empty() {
            entry.model = m.trim().to_string();
        }
    }
    cfg.updated_at = now_iso();
}

/// 这家的 key 从哪来（配置优先 → 环境变量按注册表顺序）; 拿到返回值 = 有 key
pub fn key_of(cfg: &LlmConfig, entry: &ProviderRegistryEntry) -> Option<(String, KeySource)> {
    if let Some(custom) = cfg.custom_providers.get(&entry.id) {
        if !custom.api_key.trim().is_empty() {
            return Some((custom.api_key.trim().to_string(), KeySource::Config));
        }
    }
    if let Some(k) = cfg
        .providers
        .get(&entry.id)
        .map(|s| s.api_key.trim())
        .filter(|k| !k.is_empty())
    {
        return Some((k.to_string(), KeySource::Config));
    }
    for var in &entry.api_key_env_vars {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() {
                return Some((v.trim().to_string(), KeySource::Env(var.clone())));
            }
        }
    }
    None
}

/// 目录/内置家 + 配置 + 环境变量 → 解析结果
///
/// 顺序: 配置里的 base_url/model/key 优先 → 环境变量 (按注册表给的变量名顺序) → 注册表默认
pub fn resolve_with(cfg: &LlmConfig, entry: &ProviderRegistryEntry) -> Result<Resolved, String> {
    // 自定义家优先走自己的那一格
    if let Some(custom) = cfg.custom_providers.get(&entry.id) {
        let key = if !custom.api_key.trim().is_empty() {
            Some(custom.api_key.clone())
        } else {
            None
        };
        let base_url = if !custom.base_url.trim().is_empty() {
            custom.base_url.clone()
        } else {
            entry.default_base_url.clone()
        };
        let model = if !custom.model.trim().is_empty() {
            custom.model.clone()
        } else {
            entry.default_model.clone()
        };
        if base_url.trim().is_empty() {
            return Err(format!("{} 没有 base_url (自定义家必须填)", entry.display_name));
        }
        if model.trim().is_empty() {
            return Err(format!("{} 还没选模型", entry.display_name));
        }
        return Ok(Resolved {
            id: entry.id.clone(),
            protocol: custom.protocol.unwrap_or_else(|| Protocol::infer_from_base_url(&base_url)),
            base_url,
            api_key: key.clone(),
            model,
            temperature: default_temperature(),
            max_tokens: default_max_tokens(),
            key_source: if key.is_some() { KeySource::Config } else { KeySource::None },
        });
    }

    let settings = cfg.providers.get(&entry.id);

    let (api_key, key_source) = match key_of(cfg, entry) {
        Some((k, src)) => (Some(k), src),
        None => (None, KeySource::None),
    };

    let base_url = settings
        .map(|s| s.base_url.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| entry.default_base_url.clone());
    if base_url.trim().is_empty() {
        return Err(format!(
            "{} 目录里没给 API 基址 — 需自己填一个 (或选别的家)",
            entry.display_name
        ));
    }

    let model = settings
        .map(|s| s.model.trim().to_string())
        .filter(|m| !m.is_empty())
        .or_else(|| {
            if entry.default_model.trim().is_empty() {
                // 目录家没有默认模型: 唯一模型时直接用, 多个就让人选
                if entry.models.len() == 1 {
                    Some(entry.models[0].id.clone())
                } else {
                    None
                }
            } else {
                Some(entry.default_model.clone())
            }
        })
        .ok_or_else(|| {
            format!(
                "{} 还没选模型 (目录里有 {} 个可选)",
                entry.display_name,
                entry.models.len()
            )
        })?;

    let needs_key = entry.auth != AuthKind::None && entry.requires_api_key;
    if needs_key && api_key.is_none() {
        let hint = if entry.api_key_env_vars.is_empty() {
            "在 `bolloon model` 里填 key".to_string()
        } else {
            format!("填 key 或设置环境变量 {}", entry.api_key_env_vars.join(" / "))
        };
        return Err(format!("{} 缺少 API key — {hint}", entry.display_name));
    }

    Ok(Resolved {
        id: entry.id.clone(),
        protocol: entry.protocol,
        base_url,
        api_key,
        model,
        temperature: settings.map(|s| s.temperature).unwrap_or_else(default_temperature),
        max_tokens: settings.map(|s| s.max_tokens).unwrap_or_else(default_max_tokens),
        key_source,
    })
}

/// 解析任一家 (自定义 → 内置 → 目录)
pub fn resolve(cfg: &LlmConfig, id: &str) -> Result<Resolved, String> {
    if let Some(custom) = cfg.custom_providers.get(id) {
        let entry = ProviderRegistryEntry {
            id: custom.provider_id.clone(),
            display_name: if custom.display_name.is_empty() {
                custom.provider_id.clone()
            } else {
                custom.display_name.clone()
            },
            origin: provider_registry::Origin::Custom,
            protocol: custom
                .protocol
                .unwrap_or_else(|| Protocol::infer_from_base_url(&custom.base_url)),
            default_base_url: custom.base_url.clone(),
            default_model: custom.model.clone(),
            api_key_env_vars: vec![],
            auth: if custom.api_key.is_empty() { AuthKind::None } else { AuthKind::Bearer },
            auth_supported: true,
            auth_note: "自定义 (自己填的 base_url/协议)".to_string(),
            requires_api_key: false,
            is_local: crate::provider_catalog::is_local_api(Some(&custom.base_url)),
            family_signal: "自定义".to_string(),
            models: custom
                .models
                .iter()
                .map(|m| provider_registry::ProviderModel {
                    id: m.clone(),
                    name: m.clone(),
                    tool_calling: None,
                    reasoning: None,
                    context_length: None,
                })
                .collect(),
        };
        return resolve_with(cfg, &entry);
    }
    let entry = provider_registry::get(id).ok_or_else(|| format!("未知 provider: {id}"))?;
    resolve_with(cfg, &entry)
}

/// 当前该用的那家 (active_provider; 没设 → 第一家能解析成功的)
pub fn active_resolved(cfg: &LlmConfig) -> Result<Resolved, String> {
    if !cfg.active_provider.trim().is_empty() {
        return resolve(cfg, cfg.active_provider.trim()).map_err(|e| {
            format!("{e} (当前 activeProvider={})", cfg.active_provider)
        });
    }
    usable(cfg)
        .into_iter()
        .next()
        .ok_or_else(|| "还没有可用的 provider — 跑 `bolloon model` 选一家并填 key".to_string())
}

/// 全部**解析成功**的家 (key 齐/本机服务), 用来建 runtime 与列表标注
pub fn usable(cfg: &LlmConfig) -> Vec<Resolved> {
    let mut out = vec![];
    for id in cfg.custom_providers.keys() {
        if let Ok(r) = resolve(cfg, id) {
            out.push(r);
        }
    }
    for entry in provider_registry::list_with_catalog() {
        if cfg.custom_providers.contains_key(&entry.id) {
            continue;
        }
        if let Ok(r) = resolve_with(cfg, &entry) {
            out.push(r);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bolloon-cfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn save_load_roundtrip_0600() {
        let dir = temp_dir("rt");
        let mut cfg = LlmConfig::default();
        apply_provider(&mut cfg, "deepseek", Some("sk-test"), None, Some("deepseek-v4-flash"));
        save_to(&dir, &cfg).unwrap();

        let back = load_from(&dir);
        assert_eq!(back.active_provider, "deepseek");
        assert_eq!(back.providers["deepseek"].api_key, "sk-test");
        assert_eq!(back.providers["deepseek"].model, "deepseek-v4-flash");
        assert!(!back.updated_at.is_empty(), "updatedAt 要写 ISO 字符串: {}", back.updated_at);
        assert!(back.updated_at.contains('T'), "形如 2026-10-26T…Z: {}", back.updated_at);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(CONFIG_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "配置文件必须 0600");
        }
        // 没有 tmp 残留 (原子写)
        assert!(!dir.join(format!("{CONFIG_FILE}.tmp")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_file_falls_back_to_default() {
        let dir = temp_dir("bad");
        std::fs::write(dir.join(CONFIG_FILE), "{not json").unwrap();
        let cfg = load_from(&dir);
        assert!(cfg.providers.is_empty(), "坏文件 → 空配置, 不猜");
        assert!(cfg.active_provider.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_builtin_with_config_key() {
        let mut cfg = LlmConfig::default();
        apply_provider(&mut cfg, "deepseek", Some("sk-x"), None, None);
        let r = resolve(&cfg, "deepseek").expect("应能解析");
        assert_eq!(r.protocol, Protocol::OpenAiCompatible);
        assert_eq!(r.base_url, "https://api.deepseek.com/v1");
        assert_eq!(r.model, "deepseek-v4-flash", "没填模型 → 内置默认");
        assert_eq!(r.key_source, KeySource::Config);
        assert_eq!(r.auth_ref(), "config", "回显只给 authRef, 不给 key");
    }

    #[test]
    fn missing_key_is_actionable_error() {
        // 用合成条目 + 绝不会存在的环境变量名 (不吃开发机上的真 key)
        let cfg = LlmConfig::default();
        let entry = ProviderRegistryEntry {
            id: "ghost".into(),
            display_name: "Ghost".into(),
            origin: provider_registry::Origin::Catalog,
            protocol: Protocol::OpenAiCompatible,
            default_base_url: "https://api.ghost.example/v1".into(),
            default_model: "ghost-1".into(),
            api_key_env_vars: vec!["BOLLOON_TEST_ABSENT_KEY_XYZ".into()],
            auth: AuthKind::Bearer,
            auth_supported: true,
            auth_note: "Bearer".into(),
            requires_api_key: true,
            is_local: false,
            family_signal: "测试".into(),
            models: vec![],
        };
        let err = resolve_with(&cfg, &entry).unwrap_err();
        assert!(err.contains("API key"), "{err}");
        assert!(
            err.contains("BOLLOON_TEST_ABSENT_KEY_XYZ"),
            "要告诉人设哪个环境变量: {err}"
        );
    }

    #[test]
    fn local_provider_needs_no_key() {
        let cfg = LlmConfig::default();
        let r = resolve(&cfg, "ollama").expect("本机不需要 key");
        assert_eq!(r.protocol, Protocol::Ollama);
        assert_eq!(r.key_source, KeySource::None);
        assert!(r.api_key.is_none());
    }

    #[test]
    fn catalog_provider_single_model_resolves_auto() {
        // 找一个目录里只有一个模型的家 → 不需要手选模型
        let mut found = None;
        for e in provider_registry::list_catalog() {
            if e.models.len() == 1 && e.auth_supported && !e.default_base_url.is_empty() {
                found = Some(e);
                break;
            }
        }
        let Some(entry) = found else { return };
        let mut cfg = LlmConfig::default();
        apply_provider(&mut cfg, &entry.id, Some("sk-test"), None, None);
        let r = resolve(&cfg, &entry.id).expect("单模型家应能自动选模型");
        assert_eq!(r.model, entry.models[0].id);
    }

    #[test]
    fn catalog_provider_multi_model_requires_choice() {
        // 多家多模型且无默认 → 如实报"还没选模型"
        let mut found = None;
        for e in provider_registry::list_catalog() {
            if e.models.len() > 1 && e.auth_supported && !e.default_base_url.is_empty() {
                found = Some(e);
                break;
            }
        }
        let Some(entry) = found else { return };
        let mut cfg = LlmConfig::default();
        apply_provider(&mut cfg, &entry.id, Some("sk-test"), None, None);
        let err = resolve(&cfg, &entry.id).unwrap_err();
        assert!(err.contains("还没选模型"), "{err}");
        // 选了就能解析
        let model = entry.models[0].id.clone();
        apply_provider(&mut cfg, &entry.id, None, None, Some(&model));
        assert_eq!(resolve(&cfg, &entry.id).unwrap().model, model);
    }

    #[test]
    fn custom_provider_resolves_by_inferred_protocol() {
        let mut cfg = LlmConfig::default();
        upsert_custom(
            &mut cfg,
            "my-claude",
            "我的 Claude 代理",
            "https://proxy.example.com/anthropic",
            None,
            Some("sk-custom"),
            Some("claude-x"),
        );
        let r = resolve(&cfg, "my-claude").unwrap();
        assert_eq!(r.protocol, Protocol::Anthropic, "base_url 含 anthropic → 推 Anthropic");
        assert_eq!(r.base_url, "https://proxy.example.com/anthropic");
        assert_eq!(r.api_key.as_deref(), Some("sk-custom"));
    }

    #[test]
    fn active_gives_actionable_hint_when_unset() {
        // 干净配置 + 明确没有 active → 要么兜底到本机可用家, 要么给可操作提示
        let cfg = LlmConfig::default();
        match active_resolved(&cfg) {
            Ok(r) => assert!(!r.id.is_empty(), "兜底出来的家必须能解析"),
            Err(e) => assert!(e.contains("bolloon model"), "空配置要给可操作提示: {e}"),
        }
    }

    #[test]
    fn active_reports_bad_active_provider() {
        let mut cfg = LlmConfig::default();
        set_active(&mut cfg, "no-such-provider");
        let err = active_resolved(&cfg).unwrap_err();
        assert!(err.contains("no-such-provider"), "要指出是哪家坏: {err}");
    }

    /// TS 写的配置 (updatedAt 是 **ISO 字符串**, protocol 是 `openai-compatible`) 必须能读
    #[test]
    fn reads_ts_written_config() {
        let raw = r#"{
          "activeProvider": "goaichat",
          "providers": { "goaichat": { "enabled": true, "apiKey": "k", "baseUrl": "https://x/v1", "model": "kimi-k3" } },
          "customProviders": { "goaichat": { "providerId": "goaichat", "displayName": "GoAI",
             "baseUrl": "https://x/v1", "protocol": "openai-compatible", "apiKey": "k", "model": "kimi-k3", "models": [] } },
          "updatedAt": "2026-10-24T03:02:26.665Z"
        }"#;
        let cfg: LlmConfig = serde_json::from_str(raw).expect("TS 形状必须能读");
        assert_eq!(cfg.active_provider, "goaichat");
        assert_eq!(cfg.updated_at, "2026-10-24T03:02:26.665Z");
        let r = resolve(&cfg, "goaichat").expect("自定义家可解析");
        assert_eq!(r.protocol, Protocol::OpenAiCompatible, "protocol 串要与 TS 一致");
        // 写回去仍是 ISO 字符串 + TS 认的协议名
        let out = serde_json::to_string(&cfg).unwrap();
        assert!(out.contains("\"updatedAt\":\"2026-10-24T03:02:26.665Z\""), "{out}");
        assert!(out.contains("\"protocol\":\"openai-compatible\""), "{out}");
    }

    /// 自定义家: apply_provider 改的 key/基址/模型要**镜像**进 customProviders
    #[test]
    fn apply_provider_mirrors_into_custom() {
        let mut cfg = LlmConfig::default();
        upsert_custom(&mut cfg, "goaichat", "GoAI", "https://a/v1", None, Some("k1"), Some("m1"));
        apply_provider(&mut cfg, "goaichat", Some("k2"), Some("https://b/v1"), Some("m2"));
        let c = &cfg.custom_providers["goaichat"];
        assert_eq!(c.api_key, "k2");
        assert_eq!(c.base_url, "https://b/v1");
        assert_eq!(c.model, "m2");
        let r = resolve(&cfg, "goaichat").unwrap();
        assert_eq!(r.model, "m2", "解析要用新值, 不能被旧 custom.model 盖住");
        assert_eq!(r.base_url, "https://b/v1");
    }

    /// 盘上那份解析不了 ⇒ **拒绝覆盖** (不许把别人的配置默默盖成空)
    #[test]
    fn refuses_to_overwrite_unparseable_config() {
        let dir = std::env::temp_dir().join(format!("bolloon-cfg-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CONFIG_FILE);
        std::fs::write(&path, r#"{"activeProvider":"x","updatedAt":{"weird":1}}"#).unwrap();
        let cfg = LlmConfig::default();
        let err = save_to(&dir, &cfg).expect_err("必须拒绝");
        assert!(err.to_string().contains("拒绝覆盖"), "{err}");
        // 原文件一个字节没动
        assert!(std::fs::read_to_string(&path).unwrap().contains("weird"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 能解析的旧文件 → 覆盖前留 .bak (可回滚)
    #[test]
    fn keeps_backup_before_overwrite() {
        let dir = std::env::temp_dir().join(format!("bolloon-cfg-bak-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut cfg = LlmConfig::default();
        apply_provider(&mut cfg, "a", Some("k1"), None, Some("m1"));
        save_to(&dir, &cfg).unwrap();
        apply_provider(&mut cfg, "b", Some("k2"), None, Some("m2"));
        save_to(&dir, &cfg).unwrap();
        let bak = std::fs::read_to_string(dir.join(format!("{CONFIG_FILE}.bak"))).unwrap();
        assert!(bak.contains("\"a\""), "备份里应有上一次的 a: {bak}");
        assert!(!bak.contains("\"b\""), "备份不该含本次: {bak}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
