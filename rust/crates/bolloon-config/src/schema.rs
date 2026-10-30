use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ───────────────────────── 合法范围 (硬边界, AI 不可突破) ─────────────────────────
pub const LIMIT_TOOL_TIMEOUT_MS: (u64, u64) = (1_000, 3_600_000);
pub const LIMIT_LLM_RETRIES: (u32, u32) = (0, 10);
pub const LIMIT_MODEL_CONCURRENCY: (u32, u32) = (1, 64);
pub const LIMIT_MAX_NO_PROGRESS: (u32, u32) = (0, 50);
pub const LIMIT_MAX_REFLECT: (u32, u32) = (0, 50);
pub const LIMIT_BUDGET_CALLS: (u32, u32) = (1, 1000);
pub const LIMIT_BUDGET_MS: (u64, u64) = (1_000, 86_400_000);
pub const LIMIT_MAX_STEPS: (u32, u32) = (1, 1000);

/// 配置修改授权级别 (决策权分级)。AI 无权自我提升。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ConfigAuth {
    /// 建议级 / 受限自动级: 仅能改白名单内的 C 类参数, 且不能超硬边界。
    Ai = 0,
    /// 操作员: 可改 B/C 类 (模型/prompt/预算/运行参数)。
    Operator = 1,
    /// 系统: 可改 A/B/C/D 全部 (含安全紧急控制)。
    System = 2,
}

/// A 类: 安全紧急控制 (fail-closed, 默认全部关闭/保守)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SafetyConfig {
    /// 完全访问总开关。仅安全路径可置位; 默认 false。
    pub full_access: bool,
    /// 显式授予的工具白名单 (覆盖底座默认授予)。空 = 使用底座默认。
    pub granted_tools: Vec<String>,
    /// 紧急停止: 置位后所有工具调用被拒 (独立安全路径, 可覆盖任务级快照)。
    pub emergency_stop: bool,
    /// 撤销的工具 (从 granted 中实时移除, 即使任务已捕获快照也在 gate 生效)。
    pub revoked_tools: Vec<String>,
}

/// B 类: 任务级策略 (模型 / prompt / 预算 / 步数)。新任务读取; 已开始任务保留其快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TaskPolicyConfig {
    /// 默认模型。None = 沿用底座解析。
    pub default_model: Option<String>,
    pub default_base_url: Option<String>,
    /// 系统提示覆盖。None = 沿用冻结快照。
    pub system_prompt_override: Option<String>,
    pub max_steps: u32,
    pub budget_calls: u32,
    pub budget_ms: u64,
}

/// C 类: 可热更新运行参数 (超时/重试/并发/路由权重)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeConfig {
    pub tool_timeout_ms: u64,
    pub llm_retries: u32,
    pub model_concurrency: u32,
    pub max_no_progress: u32,
    pub max_reflect: u32,
    /// 路由权重 (可选)。空 = 沿用底座优先级。
    pub routing_weights: HashMap<String, f64>,
}

/// D 类: 启动期配置 (仅启动生效, 运行时改无意义, 需重启)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StartupConfig {
    pub storage_backend: String,
    pub bind_addr: String,
    pub thread_pool_size: u32,
}

/// 经济层运行模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EconomicMode {
    /// 影子模式: 只计量、只记录"本该被拦", **绝不阻断、绝不换供应商** (默认)
    Shadow = 0,
    /// 强制模式: 预算/路由真的生效 (需显式开启, 默认禁止)
    Enforce = 1,
}

impl Default for EconomicMode {
    fn default() -> Self {
        Self::Shadow
    }
}

/// F 类: 经济层 (旁路计量 / 意图预算 / 供给登记 / 结算)。
///
/// 默认**全关**: `enabled=false` 时 KernelLoop 不挂任何计量观察者,
/// 现有模型选择、路由、工具执行、消息语义一字不变。
/// 打开后默认仍是 `mode=shadow`: 只记账, 不拦、不换。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EconomicConfig {
    /// 经济层总开关 (关 = 完全旁路, 零行为影响)
    pub enabled: bool,
    pub mode: EconomicMode,
    /// 记录用量事件 (模型调用 / 工具执行 / 委托)
    pub metering_enabled: bool,
    /// 强制预算 (只有 mode=enforce 才允许为 true)
    pub budget_enforcement_enabled: bool,
    /// 社区/多供给方路由生效 (只有 mode=enforce 才允许为 true; shadow 下只记录"本会选谁")
    pub community_routing_enabled: bool,
    /// 贡献结算生效 (首期默认关: 没有真实供需前不产生可兑现承诺)
    pub contribution_settlement_enabled: bool,
    /// 公共资源池**已到账**可用现金 (USD; 未到账/未兑现的一律不计)
    pub pool_cash_available_usd: f64,
    /// 每个意图默认预算 (USD; None = 不设上限)
    pub default_intent_budget_usd: Option<f64>,
    /// 单意图最大模型调用次数 (委托爆炸防护; None = 不限)
    pub default_max_model_calls: Option<u32>,
    /// 最大委托深度 (子任务再委托的层数上限)
    pub default_max_delegation_depth: u32,
    /// 价格表文件 (相对 BOLLOON_HOME; None = 无价格表 ⇒ 只记 token 不记金额,
    /// 且**现金类上限一律不生效** —— 报告里会如实标 cash_gate_enabled=false)
    pub price_table_file: Option<String>,
    /// 节点级：每日最多多少次模型调用 (跨意图的总闸; None = 不限)
    pub daily_model_calls: Option<u32>,
    /// 节点级：每日最多花多少 USD (跨意图; 需要价格表才真正生效; None = 不限)
    pub daily_cash_usd: Option<f64>,
    /// 按主体给"诚信日常额度"并据此限流 (default false)。
    /// 开启后：贡献者额度更高、白嫖者衰减到地板 —— **地板恒 >0, 不封号**。
    pub allowance_enabled: bool,
}

impl Default for EconomicConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: EconomicMode::Shadow,
            metering_enabled: true,
            budget_enforcement_enabled: false,
            community_routing_enabled: false,
            contribution_settlement_enabled: false,
            pool_cash_available_usd: 0.0,
            default_intent_budget_usd: None,
            default_max_model_calls: None,
            default_max_delegation_depth: 3,
            price_table_file: None,
            daily_model_calls: None,
            daily_cash_usd: None,
            allowance_enabled: false,
        }
    }
}

/// 顶层配置 (A-E 中 E 为编译期不变量, 不进入动态 schema)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub safety: SafetyConfig,
    pub task: TaskPolicyConfig,
    pub runtime: RuntimeConfig,
    pub startup: StartupConfig,
    /// F 类: 经济层 (旁路; 默认全关)
    pub economic: EconomicConfig,
}

impl Default for SafetyConfig {
    fn default() -> Self {
        Self {
            full_access: false,
            granted_tools: vec![],
            emergency_stop: false,
            revoked_tools: vec![],
        }
    }
}
impl Default for TaskPolicyConfig {
    fn default() -> Self {
        Self {
            default_model: None,
            default_base_url: None,
            system_prompt_override: None,
            // 2026-10-30 (leo: 运行到一半就停止了): 20 步对真任务是硬墙 ——
            // 刚好在「读几个文件 + 改两处 + 跑测试」这种常规活的中段截断。
            // 提到 600 步 / 800 次工具 / 150 分钟, 仍然有界 (上限校验不变)。
            max_steps: 600,
            budget_calls: 800,
            budget_ms: 9000_000,
        }
    }
}
impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            tool_timeout_ms: 120_000,
            llm_retries: 2,
            model_concurrency: 2,
            max_no_progress: 3,
            max_reflect: 4,
            routing_weights: HashMap::new(),
        }
    }
}
impl Default for StartupConfig {
    fn default() -> Self {
        Self {
            storage_backend: "local".to_string(),
            bind_addr: "127.0.0.1".to_string(),
            thread_pool_size: 4,
        }
    }
}
impl Default for AppConfig {
    fn default() -> Self {
        Self {
            safety: SafetyConfig::default(),
            task: TaskPolicyConfig::default(),
            runtime: RuntimeConfig::default(),
            startup: StartupConfig::default(),
            economic: EconomicConfig::default(),
        }
    }
}

/// 不可变、带版本号的完整配置快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigSnapshot {
    pub version: u64,
    pub applied_at: String,
    pub source: String,
    pub operator: String,
    pub reason: String,
    pub config: AppConfig,
    /// 若本快照由回滚产生, 记录回滚自哪个版本。
    pub restored_from: Option<u64>,
}

impl ConfigSnapshot {
    pub fn new(version: u64, config: AppConfig, source: &str, operator: &str, reason: &str) -> Self {
        Self {
            version,
            applied_at: chrono::Utc::now().to_rfc3339(),
            source: source.to_string(),
            operator: operator.to_string(),
            reason: reason.to_string(),
            config,
            restored_from: None,
        }
    }
}

/// 配置来源 (信任级别不同)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ConfigSource {
    File,
    Env,
    Remote(String),
    Default,
    Api,
}
