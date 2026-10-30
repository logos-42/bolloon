//! K7 Harness — 系统调用唯一门
//!
//! 管道（每步返回结构化结果，不吞异常）:
//!   discover → permission → policy → budget → idempotency → execute → verify → evidence → event
//!
//! 三条铁律（对应 TS 版 kernel-design-principles.md）:
//! 1. 工具不能直接改权限 / 改预算 —— 只有 Harness 能做
//! 2. 工具执行前被拒 → 零执行 → 记录 → 可见结果（fail-closed）
//! 3. 判据只加不减，禁为过测试而放宽门

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use async_trait::async_trait;
use tokio::sync::Mutex;
use bolloon_config::{policy::RuntimePolicy, ConfigView};

/// 工具调用（模型发来的原始调用）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// 工具定义（注册表条目）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// 参数 schema（JSON Schema 子集）
    pub parameters: serde_json::Value,
    /// 副作用类别: read | write | shell | network | payment
    pub effect: EffectKind,
    /// 是否默认允许（只读工具默认允许）
    pub default_allowed: bool,
}

/// 副作用类别（权限判定的输入）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum EffectKind {
    Read,
    Write,
    Shell,
    Network,
    Payment,
    /// 内部 scratch 目录跑临时脚本 (与 Shell 同级的高风险, 默认不放开)
    Scratch,
}

/// 结构化拒绝（permission 门返回）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Denial {
    pub reason: String,
    pub tool: String,
    pub effect: EffectKind,
    pub policy: String,
}

/// 预算口径
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Budget {
    /// 本轮允许的工具调用次数上限
    pub max_calls: u32,
    /// 已用次数
    pub used: u32,
    /// 单次调用耗时上限
    pub max_ms: u64,
}

impl Budget {
    pub fn new(max_calls: u32, max_ms: u64) -> Self {
        Self {
            max_calls,
            used: 0,
            max_ms,
        }
    }
    pub fn remaining(&self) -> u32 {
        self.max_calls.saturating_sub(self.used)
    }
}

/// 工具执行结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolResult {
    pub ok: bool,
    pub output: String,
    /// 执行耗时
    pub elapsed_ms: u64,
    /// 执行后的校验结果（写工具: 读回核对）
    pub verified: Option<bool>,
    /// 证据（落盘/网络回执等）
    pub evidence: Option<serde_json::Value>,
}

/// 执行端口（工具真正的实现注入到这里）
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    async fn execute(&self, call: ToolCall) -> ToolResult;
}

/// 工具注册表（不负责执行副作用，只描述与查找）
#[derive(Debug, Default)]
pub struct ToolRegistry {
    tools: Arc<Mutex<HashMap<String, ToolDef>>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(&self, def: ToolDef) {
        self.tools.lock().await.insert(def.name.clone(), def);
    }

    pub async fn get(&self, name: &str) -> Option<ToolDef> {
        self.tools.lock().await.get(name).cloned()
    }

    pub async fn list(&self) -> Vec<ToolDef> {
        let mut v: Vec<ToolDef> = self.tools.lock().await.values().cloned().collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    pub async fn is_empty(&self) -> bool {
        self.tools.lock().await.is_empty()
    }

    pub async fn len(&self) -> usize {
        self.tools.lock().await.len()
    }
}

/// 策略端口（policy 门：调用方可注入额外规则）
#[async_trait]
pub trait PolicyEngine: Send + Sync {
    /// 返回 None = 放行；Some(denial) = 拒绝
    async fn check(&self, call: &ToolCall, def: &ToolDef, budget: &Budget) -> Option<Denial>;
}

/// 默认策略：无额外规则
pub struct DefaultPolicy;

#[async_trait]
impl PolicyEngine for DefaultPolicy {
    async fn check(&self, _call: &ToolCall, _def: &ToolDef, _budget: &Budget) -> Option<Denial> {
        None
    }
}

/// 门控结果（完整管道输出）
#[derive(Debug, Clone, serde::Serialize)]
pub struct GateOutcome {
    pub call_id: String,
    pub tool: String,
    pub denied: Option<Denial>,
    pub result: Option<ToolResult>,
    pub elapsed_ms: u64,
}

/// Harness：唯一执行入口
pub struct Harness {
    registry: Arc<ToolRegistry>,
    executor: Arc<dyn ToolExecutor>,
    policy: Arc<dyn PolicyEngine>,
    budget: Arc<Mutex<Budget>>,
    /// 幂等键 → 结果（同键重放不重复执行）
    idempotency: Arc<Mutex<HashMap<String, ToolResult>>>,
    /// 显式授权集（高风险工具须被授予才可调用；**授权 ≠ 无障碍** —— 授权后
    /// denylist / 白名单 / 路径 / 超时 / 预算各门照跑）
    granted: Arc<Mutex<HashSet<String>>>,
    /// 证据链（append-only）
    evidence_log: Arc<Mutex<Vec<serde_json::Value>>>,
    /// 事件（追加订阅者由上层收）
    events: Arc<Mutex<Vec<GateEvent>>>,
    /// 受治理配置视图 (可选)。提供 A 类安全紧急控制 (emergency_stop/revoked) 与 C 类超时覆盖。
    /// 只读读取, 绝不绕过既有 permission/denylist/budget 门。
    config: Option<ConfigView>,
}

impl std::fmt::Debug for Harness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Harness")
            .field("registry", &self.registry)
            .field("executor", &"<dyn ToolExecutor>")
            .field("policy", &"<dyn PolicyEngine>")
            .field("budget", &self.budget)
            .field("idempotency", &self.idempotency)
            .field("evidence_log", &self.evidence_log)
            .field("events", &self.events)
            .finish()
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum GateEvent {
    Denied {
        tool: String,
        reason: String,
        call_id: String,
    },
    Executed {
        tool: String,
        call_id: String,
        ok: bool,
        elapsed_ms: u64,
    },
}

impl Harness {
    pub fn new(
        registry: Arc<ToolRegistry>,
        executor: Arc<dyn ToolExecutor>,
        budget: Budget,
    ) -> Self {
        Self {
            registry,
            executor,
            policy: Arc::new(DefaultPolicy),
            budget: Arc::new(Mutex::new(budget)),
            granted: Arc::new(Mutex::new(HashSet::new())),
            idempotency: Arc::new(Mutex::new(HashMap::new())),
            evidence_log: Arc::new(Mutex::new(vec![])),
            events: Arc::new(Mutex::new(vec![])),
            config: None,
        }
    }

    pub fn with_policy(mut self, policy: Arc<dyn PolicyEngine>) -> Self {
        self.policy = policy;
        self
    }

    /// 注入受治理配置视图。安全紧急控制 (A) 与超时覆盖 (C) 经此读取; 只读, 不绕过既有门。
    pub fn with_config(mut self, config: ConfigView) -> Self {
        self.config = Some(config);
        self
    }

    /// 就地注入配置视图 (用于已从 `Arc` 取出的场景, 避免 move out of Arc)。
    pub fn set_config(&mut self, config: ConfigView) {
        self.config = Some(config);
    }

    /// 构造期授予（同步）。高风险工具（shell / payment…）走这条路 ——
    /// **不许**把 `default_allowed` 改成 true 来"开权限"，那是把风险门整体拆掉。
    pub fn with_granted(mut self, names: &[&str]) -> Self {
        self.granted = Arc::new(Mutex::new(names.iter().map(|s| s.to_string()).collect()));
        self
    }

    /// 运行期授予（例如用户当面确认后放行某工具）
    pub async fn grant(&self, name: &str) {
        self.granted.lock().await.insert(name.to_string());
    }

    /// 唯一执行入口。管道:
    /// discover → permission → policy → budget → idempotency → execute → verify → evidence → event
    pub async fn gate(&self, call: ToolCall) -> GateOutcome {
        let started = std::time::Instant::now();

        // 1. discover：工具必须已注册
        let def = match self.registry.get(&call.name).await {
            Some(d) => d,
            None => {
                return GateOutcome {
                    call_id: call.id.clone(),
                    tool: call.name.clone(),
                    denied: Some(Denial {
                        reason: format!("工具 {} 未注册（discover 失败）", call.name),
                        tool: call.name.clone(),
                        effect: EffectKind::Read,
                        policy: "discover".into(),
                    }),
                    result: None,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                }
            }
        };

        // 2. permission：默认只放行 default_allowed；高风险工具须**显式授权**才能过
        //    + A 类安全紧急控制 (emergency_stop / revoked_tools) 经独立安全路径, 可覆盖任务级快照
        {
            let snap = self.config.as_ref().map(|v| v.read().unwrap().clone());
            if let Some(snap) = snap.as_ref() {
                if snap.config.safety.emergency_stop {
                    let denial = Denial {
                        reason: "emergency_stop 已生效：所有工具调用被拒".into(),
                        tool: call.name.clone(),
                        effect: def.effect,
                        policy: "safety.emergency_stop".into(),
                    };
                    self.record_event(GateEvent::Denied {
                        tool: call.name.clone(),
                        reason: denial.reason.clone(),
                        call_id: call.id.clone(),
                    })
                    .await;
                    return GateOutcome {
                        call_id: call.id.clone(),
                        tool: call.name.clone(),
                        denied: Some(denial),
                        result: None,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    };
                }
                if snap
                    .config
                    .safety
                    .revoked_tools
                    .iter()
                    .any(|t| t == &call.name)
                {
                    let denial = Denial {
                        reason: format!("工具 {} 已被配置撤销", call.name),
                        tool: call.name.clone(),
                        effect: def.effect,
                        policy: "safety.revoked".into(),
                    };
                    self.record_event(GateEvent::Denied {
                        tool: call.name.clone(),
                        reason: denial.reason.clone(),
                        call_id: call.id.clone(),
                    })
                    .await;
                    return GateOutcome {
                        call_id: call.id.clone(),
                        tool: call.name.clone(),
                        denied: Some(denial),
                        result: None,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    };
                }
            }
        }
        if !def.default_allowed && !self.granted.lock().await.contains(&call.name) {
            let denial = Denial {
                reason: format!("工具 {} 非默认允许（effect={:?}），需显式授权", call.name, def.effect),
                tool: call.name.clone(),
                effect: def.effect,
                policy: "permission".into(),
            };
            self.record_event(GateEvent::Denied {
                tool: call.name.clone(),
                reason: denial.reason.clone(),
                call_id: call.id.clone(),
            })
            .await;
            return GateOutcome {
                call_id: call.id.clone(),
                tool: call.name.clone(),
                denied: Some(denial),
                result: None,
                elapsed_ms: started.elapsed().as_millis() as u64,
            };
        }

        // 3. policy：注入策略
        {
            let budget = self.budget.lock().await;
            if let Some(denial) = self.policy.check(&call, &def, &budget).await {
                self.record_event(GateEvent::Denied {
                    tool: call.name.clone(),
                    reason: denial.reason.clone(),
                    call_id: call.id.clone(),
                })
                .await;
                return GateOutcome {
                    call_id: call.id.clone(),
                    tool: call.name.clone(),
                    denied: Some(denial),
                    result: None,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                };
            }
        }

        // 4. budget：次数上限
        {
            let mut budget = self.budget.lock().await;
            if budget.remaining() == 0 {
                let denial = Denial {
                    reason: "本轮工具调用预算耗尽".into(),
                    tool: call.name.clone(),
                    effect: def.effect,
                    policy: "budget".into(),
                };
                self.record_event(GateEvent::Denied {
                    tool: call.name.clone(),
                    reason: denial.reason.clone(),
                    call_id: call.id.clone(),
                })
                .await;
                return GateOutcome {
                    call_id: call.id.clone(),
                    tool: call.name.clone(),
                    denied: Some(denial),
                    result: None,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                };
            }
            budget.used += 1;
        }

        // 5. idempotency：同 id 重放 → 返回上次结果（不重复执行）
        {
            let idem = self.idempotency.lock().await;
            if let Some(prev) = idem.get(&call.id) {
                return GateOutcome {
                    call_id: call.id.clone(),
                    tool: call.name.clone(),
                    denied: None,
                    result: Some(prev.clone()),
                    elapsed_ms: started.elapsed().as_millis() as u64,
                };
            }
        }

        // 6. execute（带超时）。超时优先取自动态配置 (C 类); 否则用预算 max_ms (修复此前死字段)
        let budget_max_ms = { let b = self.budget.lock().await; b.max_ms };
        let timeout_ms = match &self.config {
            Some(v) => {
                let g = v.read().unwrap();
                RuntimePolicy::tool_timeout_ms(&g)
            }
            None => budget_max_ms,
        };
        let result = match tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            self.executor.execute(call.clone()),
        )
        .await
        {
            Ok(r) => r,
            Err(_) => ToolResult {
                ok: false,
                output: "工具执行超时".into(),
                elapsed_ms: timeout_ms,
                verified: None,
                evidence: None,
            },
        };

        // 7. verify：写类工具读回核对（由执行器自带 verified 标志）
        // 8. evidence：追加证据链
        {
            let mut log = self.evidence_log.lock().await;
            log.push(serde_json::json!({
                "call_id": call.id,
                "tool": call.name,
                "ok": result.ok,
                "verified": result.verified,
                "elapsed_ms": result.elapsed_ms,
            }));
        }

        // 9. event
        self.record_event(GateEvent::Executed {
            tool: call.name.clone(),
            call_id: call.id.clone(),
            ok: result.ok,
            elapsed_ms: result.elapsed_ms,
        })
        .await;

        // 幂等缓存（仅成功结果缓存）
        if result.ok {
            self.idempotency
                .lock()
                .await
                .insert(call.id.clone(), result.clone());
        }

        GateOutcome {
            call_id: call.id.clone(),
            tool: call.name.clone(),
            denied: None,
            result: Some(result),
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    }

    /// 预算状态（对外只读）
    pub async fn budget_state(&self) -> Budget {
        self.budget.lock().await.clone()
    }

    /// 证据链（append-only, 可审计）
    pub async fn evidence(&self) -> Vec<serde_json::Value> {
        self.evidence_log.lock().await.clone()
    }

    /// 事件（测试/观测用）
    pub async fn drain_events(&self) -> Vec<GateEvent> {
        let mut events = self.events.lock().await;
        std::mem::take(&mut *events)
    }

    async fn record_event(&self, ev: GateEvent) {
        self.events.lock().await.push(ev);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoExecutor;
    #[async_trait]
    impl ToolExecutor for EchoExecutor {
        async fn execute(&self, call: ToolCall) -> ToolResult {
            ToolResult {
                ok: true,
                output: format!("echo:{}", call.arguments),
                elapsed_ms: 1,
                verified: None,
                evidence: None,
            }
        }
    }

    async fn registry_with_read_tool() -> Arc<ToolRegistry> {
        let reg = Arc::new(ToolRegistry::new());
        let def = ToolDef {
            name: "read_file".into(),
            description: "读取文件".into(),
            parameters: serde_json::json!({}),
            effect: EffectKind::Read,
            default_allowed: true,
        };
        let def2 = ToolDef {
            name: "shell".into(),
            description: "执行 shell".into(),
            parameters: serde_json::json!({}),
            effect: EffectKind::Shell,
            default_allowed: false,
        };
        reg.register(def).await;
        reg.register(def2).await;
        reg
    }

    #[tokio::test]
    async fn read_tool_executes() {
        let h = Harness::new(
            registry_with_read_tool().await,
            Arc::new(EchoExecutor),
            Budget::new(10, 60_000),
        );
        let outcome = h
            .gate(ToolCall {
                id: "c1".into(),
                name: "read_file".into(),
                arguments: serde_json::json!({"path": "/tmp/x"}),
            })
            .await;
        assert!(outcome.denied.is_none());
        assert!(outcome.result.unwrap().ok);
    }

    #[tokio::test]
    async fn write_tool_denied_by_default() {
        let h = Harness::new(
            registry_with_read_tool().await,
            Arc::new(EchoExecutor),
            Budget::new(10, 60_000),
        );
        let outcome = h
            .gate(ToolCall {
                id: "c2".into(),
                name: "shell".into(),
                arguments: serde_json::json!({"cmd": "rm -rf /"}),
            })
            .await;
        let denial = outcome.denied.expect("写工具应被 permission 门拒绝");
        assert_eq!(denial.policy, "permission");
    }

    #[tokio::test]
    async fn unknown_tool_discovered_denied() {
        let h = Harness::new(
            registry_with_read_tool().await,
            Arc::new(EchoExecutor),
            Budget::new(10, 60_000),
        );
        let outcome = h
            .gate(ToolCall {
                id: "c3".into(),
                name: "no_such_tool".into(),
                arguments: serde_json::json!({}),
            })
            .await;
        assert_eq!(outcome.denied.unwrap().policy, "discover");
    }

    #[tokio::test]
    async fn budget_exhausted_denies() {
        let h = Harness::new(
            registry_with_read_tool().await,
            Arc::new(EchoExecutor),
            Budget::new(1, 60_000),
        );
        let call = ToolCall {
            id: "c4".into(),
            name: "read_file".into(),
            arguments: serde_json::json!({}),
        };
        assert!(h.gate(call.clone()).await.result.is_some());
        let second = h.gate(call.clone()).await;
        assert_eq!(second.denied.unwrap().policy, "budget");
    }

    #[tokio::test]
    async fn idempotent_replay_returns_cached() {
        struct CountingExecutor {
            calls: std::sync::atomic::AtomicU32,
        }
        #[async_trait]
        impl ToolExecutor for CountingExecutor {
            async fn execute(&self, _call: ToolCall) -> ToolResult {
                let n = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ToolResult {
                    ok: true,
                    output: format!("run#{n}"),
                    elapsed_ms: 1,
                    verified: None,
                    evidence: None,
                }
            }
        }
        let h = Harness::new(
            registry_with_read_tool().await,
            Arc::new(CountingExecutor {
                calls: std::sync::atomic::AtomicU32::new(0),
            }),
            Budget::new(10, 60_000),
        );
        let call = ToolCall {
            id: "same-id".into(),
            name: "read_file".into(),
            arguments: serde_json::json!({}),
        };
        let first = h.gate(call.clone()).await;
        let second = h.gate(call.clone()).await;
        assert_eq!(first.result.unwrap().output, "run#0");
        assert_eq!(second.result.unwrap().output, "run#0", "同 id 重放应返回缓存结果");
    }
}