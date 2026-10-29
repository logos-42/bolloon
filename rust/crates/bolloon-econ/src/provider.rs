//! 资源提供者登记 + 可替换路由。
//!
//! 边界 (写进代码而不是只写进文档):
//! - **登记 ≠ 授权调用**。`ProviderSpec.owner_authorized` 是资源所有者的明确授权位;
//!   未授权的 provider 只能被"看见", 不能被自动选用。
//! - **路由可替换**。`RoutingPolicy` 是接口; 本期提供 `Baseline`(保持现状) 与四种策略,
//!   社区可以实现自己的。路由只在 `community_routing_enabled` 下被咨询, 且本期只记录
//!   "本会选谁"(shadow routing), 不改真实的模型调用 —— 改动真实路由是下一步的事。
//! - 新增供给方 = 加一条 `ProviderSpec` / 一个 adapter, **不需要改意图识别与调度核心**。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::EconError;

/// 供给来源类型 (四类资源 + 赞助)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// 外部商业 API
    ExternalApi,
    /// 用户/创始人自有 API 账户
    OwnerApi,
    /// 本机自跑模型
    LocalModel,
    /// 社区成员托管的模型
    CommunityModel,
    /// Agent 提供的服务 (检索/验证/执行)
    AgentService,
    /// 只出钱不出算力的赞助者
    Sponsor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelCapability {
    pub model: String,
    /// 质量参考分 (0..1; None = 未评估, 不假装知道)
    #[serde(default)]
    pub quality: Option<f64>,
    #[serde(default)]
    pub max_context: Option<u32>,
    /// 是否支持工具调用
    #[serde(default)]
    pub tools: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStatus {
    Active,
    /// 正在退出 (不再接新活, 存量任务跑完)
    Draining,
    Retired,
}

/// 一个资源提供者。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderSpec {
    pub id: String,
    pub kind: ProviderKind,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub models: Vec<ModelCapability>,
    /// 能否接触敏感内容 (false = 只接非敏感任务)
    #[serde(default)]
    pub allows_sensitive: bool,
    /// 实测延迟 (ms; None = 没测过)
    #[serde(default)]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub online: bool,
    /// 剩余容量说明 (自由文本; 不做假精确)
    #[serde(default)]
    pub capacity_note: String,
    /// **资源所有者是否明确授权把这些额度给网络用**
    #[serde(default)]
    pub owner_authorized: bool,
    #[serde(default = "active")]
    pub status: ProviderStatus,
    pub joined_at: String,
    #[serde(default)]
    pub note: String,
}

fn active() -> ProviderStatus {
    ProviderStatus::Active
}

impl ProviderSpec {
    pub fn new(id: &str, kind: ProviderKind) -> Self {
        Self {
            id: id.to_string(),
            kind,
            display_name: id.to_string(),
            models: vec![],
            allows_sensitive: false,
            latency_ms: None,
            online: true,
            capacity_note: String::new(),
            owner_authorized: false,
            status: ProviderStatus::Active,
            joined_at: chrono::Utc::now().to_rfc3339(),
            note: String::new(),
        }
    }

    pub fn with_model(mut self, model: &str) -> Self {
        self.models.push(ModelCapability {
            model: model.to_string(),
            quality: None,
            max_context: None,
            tools: false,
        });
        self
    }

    pub fn authorized(mut self, yes: bool) -> Self {
        self.owner_authorized = yes;
        self
    }

    pub fn model_quality(&self, model: &str) -> Option<f64> {
        self.models
            .iter()
            .find(|m| m.model == model)
            .and_then(|m| m.quality)
    }

    /// 是否可以被路由选中: 在线 + 未退役 + 所有者授权
    pub fn selectable(&self) -> bool {
        self.online
            && self.status == ProviderStatus::Active
            && self.owner_authorized
            && self.kind != ProviderKind::Sponsor
    }
}

/// 开放登记表 (可查询、可退出; 落盘 JSON 便于跨进程/人工检视)。
pub struct ProviderRegistry {
    path: Option<PathBuf>,
    providers: Mutex<BTreeMap<String, ProviderSpec>>,
}

impl ProviderRegistry {
    pub fn new(path: Option<PathBuf>) -> Self {
        let reg = Self {
            path,
            providers: Mutex::new(BTreeMap::new()),
        };
        reg.load();
        reg
    }

    /// 从盘上恢复 (坏文件不覆盖, 只告警)
    pub fn load(&self) {
        let Some(p) = &self.path else { return };
        let Ok(raw) = std::fs::read_to_string(p) else {
            return;
        };
        match serde_json::from_str::<Vec<ProviderSpec>>(&raw) {
            Ok(list) => {
                let mut w = self.providers.lock().unwrap();
                for s in list {
                    w.insert(s.id.clone(), s);
                }
            }
            Err(e) => {
                tracing::warn!(path = %p.display(), error = %e, "provider 登记表解析失败, 保留内存态")
            }
        }
    }

    fn save(&self) {
        let Some(p) = &self.path else { return };
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let list: Vec<ProviderSpec> = self.providers.lock().unwrap().values().cloned().collect();
        if let Ok(s) = serde_json::to_string_pretty(&list) {
            let tmp = p.with_extension("tmp");
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(&tmp, p);
            }
        }
    }

    pub fn register(&self, spec: ProviderSpec) -> Result<(), EconError> {
        if spec.id.trim().is_empty() {
            return Err(EconError::InvalidProvider("provider id 不能为空".into()));
        }
        if spec.id.contains(' ') {
            return Err(EconError::InvalidProvider("provider id 不能含空格".into()));
        }
        self.providers.lock().unwrap().insert(spec.id.clone(), spec);
        self.save();
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<ProviderSpec> {
        self.providers.lock().unwrap().get(id).cloned()
    }

    pub fn list(&self) -> Vec<ProviderSpec> {
        self.providers.lock().unwrap().values().cloned().collect()
    }

    /// 可被路由选中的提供者 (在线 + 授权 + 未退役)
    pub fn selectable(&self) -> Vec<ProviderSpec> {
        self.providers
            .lock()
            .unwrap()
            .values()
            .filter(|p| p.selectable())
            .cloned()
            .collect()
    }

    pub fn set_status(&self, id: &str, status: ProviderStatus) -> Result<(), EconError> {
        {
            let mut w = self.providers.lock().unwrap();
            let p = w
                .get_mut(id)
                .ok_or_else(|| EconError::InvalidProvider(format!("未知 provider `{id}`")))?;
            p.status = status;
        }
        self.save();
        Ok(())
    }

    /// 退出: 保留记录 (历史结算要用), 只标记退役
    pub fn retire(&self, id: &str) -> Result<(), EconError> {
        self.set_status(id, ProviderStatus::Retired)
    }

    /// 资源所有者撤销授权 ⇒ 立即不能再被自动选用 (记录仍在, 可审计)
    pub fn revoke_authorization(&self, id: &str) -> Result<(), EconError> {
        {
            let mut w = self.providers.lock().unwrap();
            let p = w
                .get_mut(id)
                .ok_or_else(|| EconError::InvalidProvider(format!("未知 provider `{id}`")))?;
            p.owner_authorized = false;
        }
        self.save();
        Ok(())
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
}

/// 四种可选路由策略 (+ 保持现状)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutingStrategy {
    /// 不改现状 (默认)
    Baseline,
    /// 本地资源优先
    LocalFirst,
    /// 合格资源里最便宜
    LowestCost,
    /// 质量/可靠性优先
    QualityFirst,
    /// 社区共享资源优先
    CommunityFirst,
}

impl Default for RoutingStrategy {
    fn default() -> Self {
        Self::Baseline
    }
}

/// 路由请求 (由意图预算 + 请求者选择共同约束)。
#[derive(Debug, Clone, Default)]
pub struct RouteRequest {
    pub model: Option<String>,
    /// 现金上限 (超过就不用)
    pub max_cost_usd: Option<f64>,
    /// 本任务含敏感内容
    pub need_sensitive: bool,
    /// 质量下限
    pub min_quality: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoutingDecision {
    pub provider: String,
    pub strategy: String,
    pub reason: String,
    /// 打分 (越低越好; 含义随策略而定, 写在 reason 里)
    pub score: f64,
    /// 考虑过几个候选
    pub considered: usize,
    /// 因为是**影子路由**而没有被真正采用 (本期恒 true)
    pub shadow_only: bool,
}

pub trait RoutingPolicy: Send + Sync {
    fn strategy(&self) -> RoutingStrategy;
    fn choose(&self, candidates: &[ProviderSpec], req: &RouteRequest) -> Option<RoutingDecision>;
}

/// 官方默认路由器: 规则公开、可替换, 不藏私有偏好。
pub struct StandardRouter {
    strategy: RoutingStrategy,
    /// 每个 provider 的估计单价 (USD/token) —— 没有价格就按 None 处理, 不当作 0
    unit_cost: BTreeMap<String, f64>,
}

impl StandardRouter {
    pub fn new(strategy: RoutingStrategy) -> Self {
        Self {
            strategy,
            unit_cost: BTreeMap::new(),
        }
    }

    pub fn with_unit_cost(mut self, provider: &str, usd_per_token: f64) -> Self {
        self.unit_cost.insert(provider.to_string(), usd_per_token);
        self
    }

    fn cost_of(&self, p: &ProviderSpec) -> Option<f64> {
        // 本地模型的"现金成本"确实是 0 —— 但它不是"零成本", 电费/折旧另记 (见文档)
        if matches!(
            p.kind,
            ProviderKind::LocalModel | ProviderKind::CommunityModel
        ) {
            return Some(0.0);
        }
        self.unit_cost.get(&p.id).copied()
    }
}

impl RoutingPolicy for StandardRouter {
    fn strategy(&self) -> RoutingStrategy {
        self.strategy
    }

    fn choose(&self, candidates: &[ProviderSpec], req: &RouteRequest) -> Option<RoutingDecision> {
        let eligible: Vec<&ProviderSpec> = candidates
            .iter()
            .filter(|p| p.selectable())
            .filter(|p| !req.need_sensitive || p.allows_sensitive)
            .filter(|p| match (&req.model, p.models.is_empty()) {
                (Some(m), false) => p.models.iter().any(|c| &c.model == m),
                (Some(_), true) => false, // 声明了模型列表但为空 ⇒ 不假装支持
                (None, _) => true,
            })
            .filter(|p| {
                req.min_quality.map_or(true, |q| {
                    p.model_quality(req.model.as_deref().unwrap_or(""))
                        .map_or(false, |pq| pq >= q)
                })
            })
            .filter(|p| {
                req.max_cost_usd
                    .map_or(true, |max| self.cost_of(p).map_or(false, |c| c <= max))
            })
            .collect();
        if eligible.is_empty() {
            return None;
        }
        let considered = eligible.len();
        let pick = match self.strategy {
            RoutingStrategy::Baseline => eligible.first().copied(),
            RoutingStrategy::LocalFirst => eligible
                .iter()
                .min_by_key(|p| {
                    let local = matches!(p.kind, ProviderKind::LocalModel | ProviderKind::OwnerApi)
                        || p.kind == ProviderKind::LocalModel;
                    (if local { 0 } else { 1 }, p.latency_ms.unwrap_or(u64::MAX))
                })
                .copied(),
            RoutingStrategy::CommunityFirst => eligible
                .iter()
                .min_by_key(|p| {
                    let community = matches!(
                        p.kind,
                        ProviderKind::CommunityModel | ProviderKind::AgentService
                    );
                    (
                        if community { 0 } else { 1 },
                        p.latency_ms.unwrap_or(u64::MAX),
                    )
                })
                .copied(),
            RoutingStrategy::LowestCost => eligible
                .iter()
                .min_by(|a, b| {
                    let ca = self.cost_of(a).unwrap_or(f64::MAX);
                    let cb = self.cost_of(b).unwrap_or(f64::MAX);
                    ca.partial_cmp(&cb).unwrap_or(std::cmp::Ordering::Equal)
                })
                .copied(),
            RoutingStrategy::QualityFirst => eligible
                .iter()
                .max_by(|a, b| {
                    let qa = a
                        .model_quality(req.model.as_deref().unwrap_or(""))
                        .unwrap_or(0.0);
                    let qb = b
                        .model_quality(req.model.as_deref().unwrap_or(""))
                        .unwrap_or(0.0);
                    qa.partial_cmp(&qb).unwrap_or(std::cmp::Ordering::Equal)
                })
                .copied(),
        }?;
        let score = self.cost_of(pick).unwrap_or(f64::MAX);
        Some(RoutingDecision {
            provider: pick.id.clone(),
            strategy: format!("{:?}", self.strategy).to_lowercase(),
            reason: format!(
                "strategy={:?} candidates={} kinds={:?} cost={} latency={}",
                self.strategy,
                considered,
                pick.kind,
                self.cost_of(pick)
                    .map(|c| format!("{c:.6}"))
                    .unwrap_or_else(|| "unknown".into()),
                pick.latency_ms
                    .map(|l| format!("{l}ms"))
                    .unwrap_or_else(|| "unknown".into())
            ),
            score,
            considered,
            // 本期只做"影子路由": 记录本会选谁, 不改真实调用
            shadow_only: true,
        })
    }
}
