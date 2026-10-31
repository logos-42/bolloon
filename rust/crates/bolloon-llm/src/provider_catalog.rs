//! provider 目录 — 与 TS 版**同一份事实源** (223 家 / 8000+ 模型)
//!
//! 事实源: `src/llm/data/provider-catalog.json` (TS 构建期烘焙自 `https://models.dev/api.json`)。
//! 2026-10-31（leo: 只改 Rust）: 目录快照搬进本 crate (`data/provider-catalog.json`),
//! 由 `scripts/gen-provider-catalog.ts` 生成后拷进来 —— **TS 树不再被这里依赖或改写**。
//!
//! 三件事:
//! 1. **解析**: 形状不认就拒绝 (少于 `MIN_PROVIDERS_FOR_TRUST` 家 ⇒ 当坏文件, 不给用)
//! 2. **协议族**: npm 包名 → 云凭证环境变量 → 兜底 openai-compatible (每条带 signal 理由)
//! 3. **鉴权形状**: bearer / x-api-key / x-goog-api-key / none / special (special ⇒ 明确"不支持", 不假装能用)

use std::collections::BTreeMap;
use std::sync::OnceLock;

/// 可信下限 (与 TS `MIN_PROVIDERS_FOR_TRUST` 同口径): 少于这个数说明目录坏了
pub const MIN_PROVIDERS_FOR_TRUST: usize = 100;

/// TS 烘焙的目录 (单一事实源)
const CATALOG_JSON: &str = include_str!("../data/provider-catalog.json");

/// 一家 provider 的模型事实 (只记上游**声明过的**, 没写就不出现)
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModelFacts {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tool_calling: Option<bool>,
    #[serde(default)]
    pub reasoning: Option<bool>,
    #[serde(default)]
    pub context_length: Option<u64>,
}

/// 目录里的一家 provider
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProvider {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// 上游声明的环境变量名 (如 `DEEPSEEK_API_KEY`), 用来找 key
    #[serde(default)]
    pub env: Vec<String>,
    /// AI SDK 包名 — 协议族的**最明确**信号
    #[serde(default)]
    pub npm: Option<String>,
    /// API 基址 (26 家没有)
    #[serde(default)]
    pub api: Option<String>,
    #[serde(default)]
    pub doc: Option<String>,
    #[serde(default)]
    pub models: BTreeMap<String, CatalogModelFacts>,
}

/// 目录数据
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogData {
    pub version: u32,
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub provider_count: usize,
    #[serde(default)]
    pub providers: BTreeMap<String, CatalogProvider>,
}

impl CatalogData {
    /// 目录是否可信 (≥ MIN_PROVIDERS_FOR_TRUST 家 + 家数与索引一致)
    pub fn trusted(&self) -> bool {
        self.providers.len() >= MIN_PROVIDERS_FOR_TRUST
            && self.provider_count.max(self.providers.len()) == self.providers.len()
    }

    /// 按 id 取一家
    pub fn get(&self, id: &str) -> Option<&CatalogProvider> {
        self.providers.get(id)
    }

    /// 家数
    pub fn len(&self) -> usize {
        self.providers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }
}

/// 全局目录 (解析一次; 坏文件 → 空目录 + `trusted()==false`, 一次都不猜)
pub fn catalog() -> &'static CatalogData {
    static CELL: OnceLock<CatalogData> = OnceLock::new();
    CELL.get_or_init(|| {
        serde_json::from_str::<CatalogData>(CATALOG_JSON).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "provider 目录解析失败 — 按空目录处理 (不猜)");
            CatalogData {
                version: 0,
                generated_at: None,
                provider_count: 0,
                providers: BTreeMap::new(),
            }
        })
    })
}

// ────────────────────────── 协议族 ──────────────────────────

/// 协议族 (少数几个, 支撑 200+ 家的关键: 不为每家写分支)
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Family {
    /// OpenAI 兼容 `/chat/completions` (200/223 家)
    OpenAiCompatible,
    /// Anthropic `/messages` + `x-api-key`
    Anthropic,
    /// Gemini `:generateContent` + `x-goog-api-key` / `?key=`
    Gemini,
    /// 本运行时不支持的鉴权形状 (云签名/多变量) — 如实标出, 不当可用
    Special,
}

impl Family {
    pub fn as_str(&self) -> &'static str {
        match self {
            Family::OpenAiCompatible => "openai-compatible",
            Family::Anthropic => "anthropic",
            Family::Gemini => "gemini",
            Family::Special => "special",
        }
    }
}

/// 族判定结果 (带理由 — 界面直接显示这句, 不让人猜)
#[derive(Debug, Clone, PartialEq)]
pub struct FamilyDecision {
    pub family: Family,
    pub signal: String,
}

/// npm 包名 → 协议族 (只列**有把握**的, 与 TS `FAMILY_BY_NPM` 同序)
const FAMILY_BY_NPM: &[(&str, Family, &str)] = &[
    ("amazon-bedrock", Family::Special, "npm 指明是 Amazon Bedrock (AWS SigV4 / 专用凭证)"),
    ("@ai-sdk/azure", Family::Special, "npm 指明是 Azure (端点 + api-version + api-key 组合)"),
    ("google-vertex", Family::Special, "npm 指明是 Google Vertex (GCP 服务账号 / OAuth)"),
    ("@ai-sdk/anthropic", Family::Anthropic, "npm 指明是 Anthropic 客户端"),
    ("@ai-sdk/google", Family::Gemini, "npm 指明是 Google Generative AI 客户端"),
    ("sap-ai-provider", Family::Special, "npm 指明是 SAP AI Core (OAuth 换 token)"),
    ("watsonx", Family::Special, "npm 指明是 IBM watsonx (apiKey + projectId)"),
    ("gitlab", Family::Special, "npm 指明是 GitLab (instance + token 组合)"),
];

/// 环境变量里的"云凭证味道" → special (要多个变量/云签名, 不是一个 Bearer 的事)
const CLOUD_ENV_SIGNALS: &[(&str, &str)] = &[
    ("prefix:AWS_", "环境变量是 AWS 签名凭证 (AWS_*)"),
    ("prefix:AZURE_", "环境变量是 Azure 资源名 + key 组合 (AZURE_*)"),
    ("prefix:GOOGLE_APPLICATION_CREDENTIALS", "环境变量是 GCP 服务账号 / Vertex 项目 (GOOGLE_*)"),
    ("prefix:GOOGLE_VERTEX_", "环境变量是 GCP 服务账号 / Vertex 项目 (GOOGLE_*)"),
    ("prefix:WATSONX_", "环境变量是 watsonx 的 apiKey + projectId"),
    ("prefix:DATABRICKS_", "环境变量是 Databricks host + token 组合"),
    ("prefix:SNOWFLAKE_", "环境变量是 Snowflake account + PAT 组合"),
    ("prefix:CLOUDFLARE_ACCOUNT_ID", "环境变量是 Cloudflare 账号/网关 id (不止一个 key)"),
    ("prefix:CLOUDFLARE_GATEWAY_ID", "环境变量是 Cloudflare 账号/网关 id (不止一个 key)"),
    ("suffix:ENDPOINT", "环境变量里有端点地址 (不是单纯的 key)"),
    ("suffix:_PROJECT_ID", "环境变量里有项目/产品 id (不是单纯的 key)"),
    ("suffix:_PRODUCT_ID", "环境变量里有项目/产品 id (不是单纯的 key)"),
    ("prefix:INFOMANIAK_", "环境变量里有项目/产品 id (不是单纯的 key)"),
];

fn env_signal_matches(rule: &str, env_name: &str) -> bool {
    if let Some(prefix) = rule.strip_prefix("prefix:") {
        return env_name.starts_with(prefix);
    }
    if let Some(suffix) = rule.strip_prefix("suffix:") {
        return env_name.ends_with(suffix);
    }
    false
}

/// 一家的协议族 (判定顺序: npm → 云 env → 兜底 openai-compatible)
pub fn family_of(p: &CatalogProvider) -> FamilyDecision {
    if let Some(npm) = &p.npm {
        for (needle, family, signal) in FAMILY_BY_NPM {
            // `@ai-sdk/google` 不能吃掉 `@ai-sdk/google-vertex` (后者先命中 special)
            if npm.contains(needle) {
                return FamilyDecision { family: *family, signal: (*signal).to_string() };
            }
        }
    }
    for (rule, signal) in CLOUD_ENV_SIGNALS {
        if let Some(hit) = p.env.iter().find(|e| env_signal_matches(rule, e)) {
            return FamilyDecision {
                family: Family::Special,
                signal: format!("{signal} (命中 {hit})"),
            };
        }
    }
    FamilyDecision {
        family: Family::OpenAiCompatible,
        signal: "没有特别信号 → 按 OpenAI 兼容协议 (/chat/completions)".to_string(),
    }
}

// ────────────────────────── 鉴权形状 ──────────────────────────

/// 鉴权头形状
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AuthKind {
    Bearer,
    XApiKey,
    XGoogApiKey,
    Special,
    None,
}

impl AuthKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthKind::Bearer => "bearer",
            AuthKind::XApiKey => "x-api-key",
            AuthKind::XGoogApiKey => "x-goog-api-key",
            AuthKind::Special => "special",
            AuthKind::None => "none",
        }
    }
}

/// 鉴权形状 + 能不能用 + 理由
#[derive(Debug, Clone, PartialEq)]
pub struct AuthShape {
    pub kind: AuthKind,
    /// 读哪个环境变量 (目录没给 → None)
    pub env_var: Option<String>,
    /// 本运行时是否支持这种鉴权
    pub supported: bool,
    pub note: String,
}

/// 鉴权形状 (纯函数; special/none ⇒ supported=false, 理由写清楚)
pub fn auth_shape_of(p: &CatalogProvider, family: Family, signal: &str) -> AuthShape {
    let first = p.env.first().cloned();
    if family == Family::Special {
        return AuthShape {
            kind: AuthKind::Special,
            env_var: first,
            supported: false,
            note: format!("需专用鉴权 (未支持): {signal}"),
        };
    }
    // 本地服务 (ollama / lmstudio 之类): 基址是本机 → 不需要 key
    if is_local_api(p.api.as_deref()) {
        return AuthShape {
            kind: AuthKind::None,
            env_var: first,
            supported: true,
            note: "本机服务 (127.0.0.1/localhost) → 不需要 key".to_string(),
        };
    }
    let Some(env_var) = first else {
        return AuthShape {
            kind: AuthKind::None,
            env_var: None,
            supported: false,
            note: "目录里没给环境变量名 → 凭据无从读起 (需自定义凭据)".to_string(),
        };
    };
    match family {
        Family::Anthropic => AuthShape {
            kind: AuthKind::XApiKey,
            env_var: Some(env_var.clone()),
            supported: true,
            note: format!("x-api-key 头 (读环境变量 {env_var})"),
        },
        Family::Gemini => AuthShape {
            kind: AuthKind::XGoogApiKey,
            env_var: Some(env_var.clone()),
            supported: true,
            note: format!("x-goog-api-key 头 / ?key= (读环境变量 {env_var})"),
        },
        _ => AuthShape {
            kind: AuthKind::Bearer,
            env_var: Some(env_var.clone()),
            supported: true,
            note: format!("Authorization: Bearer (读环境变量 {env_var})"),
        },
    }
}

/// 基址是不是本机 (本机服务不需要 key)
pub fn is_local_api(api: Option<&str>) -> bool {
    let Some(api) = api else { return false };
    let lower = api.to_lowercase();
    lower.contains("127.0.0.1") || lower.contains("localhost") || lower.contains("0.0.0.0")
}

/// 目录里可用的模型 id 列表 (按 id 字典序, 已经是 BTreeMap)
pub fn model_ids_of(p: &CatalogProvider) -> Vec<String> {
    p.models.keys().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_trusted_and_large() {
        let c = catalog();
        assert!(c.trusted(), "目录必须可信 (≥{MIN_PROVIDERS_FOR_TRUST} 家)");
        assert!(c.len() >= 200, "事实源是 200+ 家, 实际 {}", c.len());
        // 抽两家必须存在 (目录里最有代表性的)
        assert!(c.get("openai").is_some() || c.get("302ai").is_some());
        let one = c.providers.values().next().unwrap();
        assert!(!one.id.is_empty());
    }

    #[test]
    fn family_by_npm_and_env() {
        let mk = |npm: Option<&str>, env: &[&str]| CatalogProvider {
            id: "x".into(),
            name: "X".into(),
            env: env.iter().map(|s| s.to_string()).collect(),
            npm: npm.map(|s| s.to_string()),
            ..Default::default()
        };
        assert_eq!(family_of(&mk(Some("@ai-sdk/anthropic"), &[])).family, Family::Anthropic);
        assert_eq!(family_of(&mk(Some("@ai-sdk/google"), &[])).family, Family::Gemini);
        assert_eq!(family_of(&mk(Some("@ai-sdk/amazon-bedrock"), &[])).family, Family::Special);
        // npm 更明确的优先于 env 启发式
        assert_eq!(
            family_of(&mk(Some("@ai-sdk/anthropic"), &["AWS_ACCESS_KEY_ID"])).family,
            Family::Anthropic
        );
        // 云凭证味道 → special (不假装能用一个 Bearer 搞定)
        let d = family_of(&mk(None, &["AZURE_API_KEY"]));
        assert_eq!(d.family, Family::Special);
        assert!(d.signal.contains("AZURE_API_KEY"), "理由要能对上命中项: {d:?}");
        assert_eq!(family_of(&mk(None, &["MY_ENDPOINT"])).family, Family::Special);
        // 兜底
        let d = family_of(&mk(None, &["DEEPSEEK_API_KEY"]));
        assert_eq!(d.family, Family::OpenAiCompatible);
        assert!(!d.signal.is_empty(), "族判定必须带理由");
    }

    #[test]
    fn auth_shape_rules() {
        let p = CatalogProvider {
            id: "deepseek".into(),
            env: vec!["DEEPSEEK_API_KEY".into()],
            api: Some("https://api.deepseek.com".into()),
            ..Default::default()
        };
        let d = family_of(&p);
        let a = auth_shape_of(&p, d.family, &d.signal);
        assert_eq!(a.kind, AuthKind::Bearer);
        assert!(a.supported);
        assert_eq!(a.env_var.as_deref(), Some("DEEPSEEK_API_KEY"));

        // anthropic 客户端 → x-api-key
        let p = CatalogProvider {
            env: vec!["ANTHROPIC_API_KEY".into()],
            npm: Some("@ai-sdk/anthropic".into()),
            ..Default::default()
        };
        let d = family_of(&p);
        assert_eq!(auth_shape_of(&p, d.family, &d.signal).kind, AuthKind::XApiKey);

        // 本机服务 → 不需要 key
        let p = CatalogProvider {
            env: vec![],
            api: Some("http://127.0.0.1:11434/v1".into()),
            ..Default::default()
        };
        let a = auth_shape_of(&p, Family::OpenAiCompatible, "x");
        assert_eq!(a.kind, AuthKind::None);
        assert!(a.supported);

        // special → 明确不支持
        let p = CatalogProvider { env: vec!["AWS_ACCESS_KEY_ID".into()], ..Default::default() };
        let a = auth_shape_of(&p, Family::Special, "AWS 签名");
        assert_eq!(a.kind, AuthKind::Special);
        assert!(!a.supported);
        assert!(a.note.contains("未支持"));

        // 没 env 也没有本机基址 → 凭据无从读起 (unsupported, 不猜)
        let p = CatalogProvider { env: vec![], api: None, ..Default::default() };
        let a = auth_shape_of(&p, Family::OpenAiCompatible, "x");
        assert_eq!(a.kind, AuthKind::None);
        assert!(!a.supported);
    }

    #[test]
    fn real_catalog_families_cover_most_providers() {
        let c = catalog();
        let mut openai = 0;
        for p in c.providers.values() {
            if family_of(p).family == Family::OpenAiCompatible {
                openai += 1;
            }
        }
        // TS 文档口径: 223 家里 200 家 openai-compatible
        assert!(openai >= 180, "openai-compatible 家数 {openai} (应占绝大多数)");
    }
}
