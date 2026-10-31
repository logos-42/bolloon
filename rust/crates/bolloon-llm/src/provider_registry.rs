//! provider 注册表 — 把 13 家内置 + 自定义 + 目录 223 家收成**同一个形状**
//!
//! 设计要点 (对齐 TS `src/llm/provider-registry.ts`):
//! - 只有一个 `ProviderRegistryEntry`, `origin` 区分 builtin / custom / catalog
//! - **协议只有 4 条分支** (openai-compatible / anthropic / gemini / ollama) + special 明确拒绝:
//!   任意一家目录 provider 都落到这 4 条上, 所以支撑 200+ 家**不需要 200+ 个分支**
//! - 查找顺序 builtin → custom → catalog; 列表时内置优先去重

use serde::{Deserialize, Serialize};

use crate::provider_catalog::{self, auth_shape_of, family_of, is_local_api, AuthKind, Family};

/// 一家从哪来
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Origin {
    /// 手写内置 (13 家, 有默认模型)
    Builtin,
    /// 用户自定义 (自己填 base_url / 协议)
    Custom,
    /// 目录 (models.dev 烘焙的 223 家)
    Catalog,
}

impl Origin {
    pub fn as_str(&self) -> &'static str {
        match self {
            Origin::Builtin => "builtin",
            Origin::Custom => "custom",
            Origin::Catalog => "catalog",
        }
    }
}

/// 调用协议 (只有 4 条真实现; special 不在其中)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Protocol {
    /// OpenAI 兼容 `POST {base}/chat/completions`
    /// (**串行化名与 TS 逐字一致**: `openai-compatible`, 不是 kebab 自动生成的 `open-ai-compatible`)
    #[default]
    #[serde(rename = "openai-compatible", alias = "open-ai-compatible", alias = "openai_compatible")]
    OpenAiCompatible,
    /// Anthropic `POST {base}/messages` + `x-api-key`
    #[serde(rename = "anthropic")]
    Anthropic,
    /// Gemini `POST {base}/models/{model}:generateContent`
    #[serde(rename = "gemini")]
    Gemini,
    /// 本机 Ollama `POST {base}/api/chat`
    #[serde(rename = "ollama")]
    Ollama,
}

impl Protocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            Protocol::OpenAiCompatible => "openai-compatible",
            Protocol::Anthropic => "anthropic",
            Protocol::Gemini => "gemini",
            Protocol::Ollama => "ollama",
        }
    }

    /// 从字符串解析 (自定义 provider 用); 不认的值 → 按 base_url 推
    pub fn parse(s: &str) -> Option<Protocol> {
        match s.trim().to_lowercase().as_str() {
            "openai-compatible" | "openai" | "compatible" => Some(Protocol::OpenAiCompatible),
            "anthropic" | "claude" => Some(Protocol::Anthropic),
            "gemini" | "google" => Some(Protocol::Gemini),
            "ollama" | "local" => Some(Protocol::Ollama),
            _ => None,
        }
    }

    /// 主机名/基址推协议 (自定义家只填了 base_url 时用)
    pub fn infer_from_base_url(base_url: &str) -> Protocol {
        let b = base_url.to_lowercase();
        if b.contains("anthropic") {
            Protocol::Anthropic
        } else if b.contains("generativelanguage.googleapis.com") || b.contains(":generatecontent") {
            Protocol::Gemini
        } else if b.contains("11434") || b.contains("ollama") {
            Protocol::Ollama
        } else {
            Protocol::OpenAiCompatible
        }
    }
}

/// 注册表里的一条
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderRegistryEntry {
    pub id: String,
    pub display_name: String,
    pub origin: Origin,
    pub protocol: Protocol,
    pub default_base_url: String,
    /// 默认模型 (只有内置家有; 目录家 = 空串, 目录里没有"默认模型"这回事)
    pub default_model: String,
    /// 找 key 用的环境变量名 (按顺序试)
    pub api_key_env_vars: Vec<String>,
    pub auth: AuthKind,
    /// 本运行时是否支持这种鉴权
    pub auth_supported: bool,
    pub auth_note: String,
    pub requires_api_key: bool,
    pub is_local: bool,
    /// 族判定理由 (界面直接显示)
    pub family_signal: String,
    pub models: Vec<ProviderModel>,
}

impl ProviderRegistryEntry {
    /// 目录/内置给的模型 id 列表
    pub fn model_ids(&self) -> Vec<String> {
        self.models.iter().map(|m| m.id.clone()).collect()
    }

    /// 这家能不能在界面上当"可用"来选 (鉴权形状支持才算)
    pub fn selectable(&self) -> bool {
        self.auth_supported
    }
}

/// 模型事实 (目录里声明过的)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calling: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
}

// ────────────────────────── 内置 13 家 ──────────────────────────

struct Builtin {
    id: &'static str,
    name: &'static str,
    protocol: Protocol,
    base_url: &'static str,
    model: &'static str,
    env: &'static [&'static str],
    requires_key: bool,
    /// 目录里对应的 id（两家命名不同时挂模型清单用；None = 与 id 同名）
    catalog_id: Option<&'static str>,
}

/// 与 TS `DEFAULT_PROVIDER_CONFIGS` 一一对应 (id/基址/默认模型逐条对齐)
const BUILTINS: &[Builtin] = &[
    Builtin { id: "openai", name: "OpenAI", protocol: Protocol::OpenAiCompatible, base_url: "https://api.openai.com/v1", model: "gpt-6-astra", env: &["OPENAI_API_KEY"], requires_key: true, catalog_id: None },
    Builtin { id: "anthropic", name: "Anthropic", protocol: Protocol::Anthropic, base_url: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5", env: &["ANTHROPIC_API_KEY"], requires_key: true, catalog_id: None },
    Builtin { id: "openrouter", name: "OpenRouter", protocol: Protocol::OpenAiCompatible, base_url: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5-5", env: &["OPENROUTER_API_KEY"], requires_key: true, catalog_id: None },
    Builtin { id: "gemini", name: "Google Gemini", protocol: Protocol::Gemini, base_url: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.8-flash", env: &["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"], requires_key: true, catalog_id: Some("google") },
    Builtin { id: "ollama", name: "Ollama (本机)", protocol: Protocol::Ollama, base_url: "http://localhost:11434", model: "llama4", env: &[], requires_key: false, catalog_id: None },
    Builtin { id: "minimax", name: "MiniMax", protocol: Protocol::OpenAiCompatible, base_url: "https://api.minimaxi.com/v1", model: "MiniMax-M3.1-Flash", env: &["MINIMAX_API_KEY"], requires_key: true, catalog_id: None },
    Builtin { id: "deepseek", name: "DeepSeek", protocol: Protocol::OpenAiCompatible, base_url: "https://api.deepseek.com/v1", model: "deepseek-v4-pro", env: &["DEEPSEEK_API_KEY"], requires_key: true, catalog_id: None },
    Builtin { id: "kimi", name: "Kimi (Moonshot)", protocol: Protocol::OpenAiCompatible, base_url: "https://api.moonshot.cn/v1", model: "kimi-k3.1-pro", env: &["MOONSHOT_API_KEY", "KIMI_API_KEY"], requires_key: true, catalog_id: Some("moonshotai") },
    Builtin { id: "glm", name: "智谱 GLM", protocol: Protocol::OpenAiCompatible, base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.3", env: &["ZHIPU_API_KEY", "GLM_API_KEY"], requires_key: true, catalog_id: Some("zhipuai") },
    Builtin { id: "qwen", name: "通义千问 (DashScope)", protocol: Protocol::OpenAiCompatible, base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.8-max", env: &["DASHSCOPE_API_KEY", "QWEN_API_KEY"], requires_key: true, catalog_id: Some("alibaba") },
    Builtin { id: "mimo", name: "小米 MiMo", protocol: Protocol::OpenAiCompatible, base_url: "https://api.xiaomi.com/v1", model: "mimo-v2.6-pro", env: &["MIMO_API_KEY"], requires_key: true, catalog_id: Some("xiaomi") },
    Builtin { id: "local", name: "本地 (OpenAI 兼容)", protocol: Protocol::Ollama, base_url: "http://localhost:11434", model: "llama4", env: &[], requires_key: false, catalog_id: None },
    Builtin { id: "grok", name: "xAI Grok", protocol: Protocol::OpenAiCompatible, base_url: "https://api.x.ai/v1", model: "grok-4.7", env: &["XAI_API_KEY", "GROK_API_KEY"], requires_key: true, catalog_id: Some("xai") },
];

/// 内置 13 家 (顺序固定)
///
/// 内置表本身只给「基址 + 默认模型」；若目录里也有同一家，把它声明的模型清单挂过来
/// （界面才能给出可选模型，而不是只让用户手打模型名）。
pub fn list_builtin() -> Vec<ProviderRegistryEntry> {
    let cat = provider_catalog::catalog();
    BUILTINS
        .iter()
        .map(|b| {
            let models: Vec<ProviderModel> = cat
                .get(b.catalog_id.unwrap_or(b.id))
                .map(|p| {
                    p.models
                        .iter()
                        .map(|(mid, f)| ProviderModel {
                            id: mid.clone(),
                            name: f.name.clone().unwrap_or_else(|| mid.clone()),
                            tool_calling: f.tool_calling,
                            reasoning: f.reasoning,
                            context_length: f.context_length,
                        })
                        .collect()
                })
                .unwrap_or_default();
            ProviderRegistryEntry {
                id: b.id.to_string(),
                display_name: b.name.to_string(),
                origin: Origin::Builtin,
                protocol: b.protocol,
                default_base_url: b.base_url.to_string(),
                default_model: b.model.to_string(),
                api_key_env_vars: b.env.iter().map(|s| s.to_string()).collect(),
                auth: if b.requires_key { AuthKind::Bearer } else { AuthKind::None },
                auth_supported: true,
                auth_note: if b.requires_key {
                    format!("Authorization: Bearer (读环境变量 {})", b.env.join(" / "))
                } else {
                    "本机服务 → 不需要 key".to_string()
                },
                requires_api_key: b.requires_key,
                is_local: !b.requires_key && b.base_url.contains("localhost"),
                family_signal: "内置手写 (基址与默认模型已核对)".to_string(),
                // 目录里同名的模型清单挂在下面（没有就留空：模型走上游 /v1/models 或手填）
                models,
            }
        })
        .collect()
}

/// 某一家内置
pub fn builtin(id: &str) -> Option<ProviderRegistryEntry> {
    list_builtin().into_iter().find(|e| e.id == id)
}

// ────────────────────────── 目录 → 注册表 ──────────────────────────

fn protocol_of_family(family: Family, api: Option<&str>, id: &str) -> Option<Protocol> {
    match family {
        Family::Special => None,
        Family::Anthropic => Some(Protocol::Anthropic),
        Family::Gemini => Some(Protocol::Gemini),
        Family::OpenAiCompatible => {
            let local = is_local_api(api);
            if local && (id.contains("ollama") || api.map(|a| a.contains("11434")).unwrap_or(false)) {
                Some(Protocol::Ollama)
            } else {
                Some(Protocol::OpenAiCompatible)
            }
        }
    }
}

/// 目录一家 → 注册表条目
pub fn entry_from_catalog(p: &provider_catalog::CatalogProvider) -> ProviderRegistryEntry {
    let dec = family_of(p);
    let auth = auth_shape_of(p, dec.family, &dec.signal);
    let protocol = protocol_of_family(dec.family, p.api.as_deref(), &p.id)
        .unwrap_or(Protocol::OpenAiCompatible);
    let models = p
        .models
        .iter()
        .map(|(mid, f)| ProviderModel {
            id: mid.clone(),
            name: f.name.clone().unwrap_or_else(|| mid.clone()),
            tool_calling: f.tool_calling,
            reasoning: f.reasoning,
            context_length: f.context_length,
        })
        .collect();
    let mut env_vars: Vec<String> = p.env.clone();
    if let Some(first) = &auth.env_var {
        if !env_vars.contains(first) {
            env_vars.insert(0, first.clone());
        }
    }
    ProviderRegistryEntry {
        id: p.id.clone(),
        display_name: if p.name.is_empty() { p.id.clone() } else { p.name.clone() },
        origin: Origin::Catalog,
        protocol,
        default_base_url: p.api.clone().unwrap_or_default(),
        default_model: String::new(), // 目录里没有"默认模型"这回事
        api_key_env_vars: env_vars,
        auth: auth.kind,
        auth_supported: auth.supported,
        auth_note: auth.note,
        requires_api_key: auth.kind != AuthKind::None,
        is_local: is_local_api(p.api.as_deref()),
        family_signal: dec.signal,
        models,
    }
}

/// 目录全部家 (按 id 字典序)
pub fn list_catalog() -> Vec<ProviderRegistryEntry> {
    provider_catalog::catalog()
        .providers
        .values()
        .map(entry_from_catalog)
        .collect()
}

/// **在册 + 目录** (内置优先去重; 这是界面"200+ 家"的数据源)
pub fn list_with_catalog() -> Vec<ProviderRegistryEntry> {
    let builtins = list_builtin();
    // 内置家的 id 与其目录别名都算"已列过" (gemini↔google / kimi↔moonshotai …)
    let mut builtin_ids: std::collections::BTreeSet<String> =
        builtins.iter().map(|e| e.id.clone()).collect();
    for b in BUILTINS {
        if let Some(alias) = b.catalog_id {
            builtin_ids.insert(alias.to_string());
        }
    }
    let mut out = builtins;
    for e in list_catalog() {
        if !builtin_ids.contains(&e.id) {
            out.push(e);
        }
    }
    out
}

/// 查找顺序: 内置 → 目录 (自定义由配置层在前面插队)
pub fn get(id: &str) -> Option<ProviderRegistryEntry> {
    builtin(id).or_else(|| {
        provider_catalog::catalog()
            .get(id)
            .map(entry_from_catalog)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_matches_ts_table() {
        let b = list_builtin();
        assert_eq!(b.len(), 13, "内置 13 家 (与 TS DEFAULT_PROVIDER_CONFIGS 同数)");
        let ds = builtin("deepseek").unwrap();
        assert_eq!(ds.default_base_url, "https://api.deepseek.com/v1");
        assert_eq!(ds.default_model, "deepseek-v4-pro");
        assert_eq!(ds.protocol, Protocol::OpenAiCompatible);
        let anth = builtin("anthropic").unwrap();
        assert_eq!(anth.protocol, Protocol::Anthropic);
        assert!(anth.requires_api_key);
        let ollama = builtin("ollama").unwrap();
        assert_eq!(ollama.protocol, Protocol::Ollama);
        assert!(!ollama.requires_api_key, "本机 ollama 不需要 key");
    }

    #[test]
    fn list_with_catalog_is_200_plus_and_deduped() {
        let all = list_with_catalog();
        assert!(all.len() >= 200, "200+ 家, 实际 {}", all.len());
        // 去重: id 不重复
        let mut ids: Vec<&str> = all.iter().map(|e| e.id.as_str()).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "内置与目录同名要合并, 不许重复列");
        // 内置排前面 (选择器里先看到熟的)
        assert_eq!(all[0].origin, Origin::Builtin);
        // 至少 180 家可直接用 (openai-compatible)
        let usable = all
            .iter()
            .filter(|e| e.selectable() && e.protocol == Protocol::OpenAiCompatible)
            .count();
        assert!(usable >= 180, "openai-compatible 可用家数 {usable}");
    }

    #[test]
    fn catalog_entry_has_protocol_and_models() {
        let all = list_catalog();
        // 302ai 是目录第一家 (openai 兼容, 有 models)
        if let Some(e) = all.iter().find(|e| e.id == "302ai") {
            assert_eq!(e.protocol, Protocol::OpenAiCompatible);
            assert!(!e.models.is_empty(), "目录里带模型清单: {e:?}");
            assert!(!e.default_base_url.is_empty());
            assert!(e.auth_supported);
        }
        // 每家都要有协议 (special 也映射到 openai-compatible 分支但 auth_supported=false)
        assert!(all.iter().all(|e| !e.family_signal.is_empty()));
    }

    #[test]
    fn builtin_models_enriched_from_catalog() {
        // 内置表只给基址/默认模型; 目录里同名(或别名)那家的模型清单要挂过来
        let ds = builtin("deepseek").expect("deepseek 内置");
        assert!(!ds.models.is_empty(), "deepseek 应从目录拿到模型清单");
        assert!(ds.models.iter().any(|m| m.id.contains("deepseek")));
        // 别名: gemini ↔ google
        let g = builtin("gemini").expect("gemini 内置");
        assert!(!g.models.is_empty(), "gemini 应通过别名 google 拿到模型");
        assert_eq!(g.protocol, Protocol::Gemini, "别名不影响协议判定");
        // 别名 id 不该在总表里再出现一次
        let all = list_with_catalog();
        assert!(!all.iter().any(|e| e.id == "google"), "别名不应重复列出");
        assert!(all.iter().any(|e| e.id == "gemini"));
    }

    #[test]
    fn protocol_infer_from_base_url() {
        assert_eq!(
            Protocol::infer_from_base_url("https://api.anthropic.com/v1"),
            Protocol::Anthropic
        );
        assert_eq!(
            Protocol::infer_from_base_url("https://generativelanguage.googleapis.com/v1beta"),
            Protocol::Gemini
        );
        assert_eq!(Protocol::infer_from_base_url("http://127.0.0.1:11434"), Protocol::Ollama);
        assert_eq!(Protocol::infer_from_base_url("https://api.deepseek.com/v1"), Protocol::OpenAiCompatible);
        assert_eq!(Protocol::parse("gemini"), Some(Protocol::Gemini));
        assert_eq!(Protocol::parse("nonsense"), None);
    }

    #[test]
    fn get_prefers_builtin() {
        // 内置与目录都有 openai 时, 取内置 (默认模型来自内置)
        let e = get("openai").expect("openai 必须查得到");
        assert_eq!(e.origin, Origin::Builtin);
        assert_eq!(e.default_model, "gpt-6-astra");
        assert!(get("definitely-not-a-provider").is_none());
    }
}
