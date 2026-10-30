//! 经济层 agent 侧工具：`econ_probe` / `econ_claim`。
//!
//! 为什么要在 agent 侧开这两个口子：
//! - 智能体得能**自己看见**「今天还剩多少额度、池子里多少钱、谁能供给」，否则共享只是人肉操作；
//! - 智能体得能**自己申领**（claim）额度，拿到明确的 granted / queued 结果，而不是盲目撞闸。
//!
//! 边界（不越界）：
//! - 只读探针 + 只读申领判定，**不直接改账本**（认捐/确认仍走 HTTP 端点 + 独立验收）；
//! - 没有经济层时如实回「未启用」，不假装成功。

use std::sync::Arc;

use bolloon_econ::ShadowEconomy;
use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolResult};

/// 经济工具的执行上下文：绑定"这个 agent 以谁的身份探针/申领"
#[derive(Clone)]
pub struct EconTools {
    pub econ: Arc<ShadowEconomy>,
    /// 主体 id（人类 DID 或 agent id）—— 决定算谁的额度
    pub principal: String,
    /// 所属群（用于把群接话规则一起带出来）
    pub group: Option<String>,
}

pub fn econ_tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "econ_probe".into(),
            description: "查看经济层现状：公共池余额、今日已用/上限、我的诚信额度（含增减理由）、\
可选用的资源提供者、群聊接话规则。只读，不改任何账本。"
                .into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "principal": { "type": "string", "description": "要看谁（默认就是我自己）" },
                    "intent_kind": { "type": "string", "description": "chat|research|code|verify|analysis|task" }
                }
            }),
            effect: EffectKind::Read,
            default_allowed: true,
        },
        ToolDef {
            name: "econ_claim".into(),
            description: "申领共享额度：按我的诚信额度判断这次 `calls` 次模型调用能否放行。\
返回 granted / queued（额度不够时给出地板额度和赞助入口）。只读判定，不扣别人钱。"
                .into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "calls": { "type": "integer", "description": "这次想用几次模型调用（默认 1）" },
                    "intent_kind": { "type": "string", "description": "意图类型，影响额度权重" },
                    "note": { "type": "string", "description": "为什么需要（写进回执，便于赞助者判断）" }
                }
            }),
            effect: EffectKind::Read,
            default_allowed: true,
        },
    ]
}

fn ok(v: serde_json::Value) -> ToolResult {
    ToolResult {
        ok: true,
        output: serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string()),
        elapsed_ms: 0,
        verified: Some(true),
        evidence: Some(v),
    }
}

impl EconTools {
    pub fn probe(&self, args: &serde_json::Value) -> ToolResult {
        let who = args
            .get("principal")
            .and_then(|v| v.as_str())
            .unwrap_or(&self.principal)
            .to_string();
        let kind = args.get("intent_kind").and_then(|v| v.as_str());
        let r = self.econ.report();
        let a = self.econ.allowance_for(&who, kind);
        let providers: Vec<serde_json::Value> = self
            .econ
            .registry()
            .selectable()
            .iter()
            .map(|p| serde_json::json!({ "id": p.id, "kind": p.kind, "online": p.online }))
            .collect();
        ok(serde_json::json!({
            "enabled": r.enabled,
            "mode": r.mode,
            "cash_gate_enabled": r.cash_gate_enabled,
            "pool": {
                "cash_available_usd": r.pool.cash_available_usd,
                "contribution_cash_usd": r.pool.contribution_cash_usd,
                "committed_usd": r.pool.committed_usd,
                "spent_usd": r.pool.spent_usd,
            },
            "daily": { "calls": r.daily_model_calls, "cash_usd": r.daily_cash_usd,
                       "max_calls": r.daily_max_model_calls, "max_cash_usd": r.daily_max_cash_usd },
            "my_allowance": a,
            "providers": providers,
            "group_reply": {
                "group": self.group,
                "large_threshold": bolloon_web_consts::GROUP_LARGE_THRESHOLD,
                "default_when_large": bolloon_web_consts::DEFAULT_REPLIES_WHEN_LARGE,
            },
        }))
    }

    pub fn claim(&self, args: &serde_json::Value) -> ToolResult {
        let want = args.get("calls").and_then(|v| v.as_u64()).unwrap_or(1).max(1) as u32;
        let kind = args.get("intent_kind").and_then(|v| v.as_str());
        let note = args.get("note").and_then(|v| v.as_str()).unwrap_or("");
        let a = self.econ.allowance_for(&self.principal, kind);
        let granted = a.remaining >= want;
        ok(serde_json::json!({
            "granted": granted,
            "queued": !granted,
            "principal": self.principal,
            "want": want,
            "allowance": a,
            "why": if granted {
                format!("额度充足：还剩 {} 次（今日 {} / {}，档位 {}）", a.remaining, a.used, a.calls, a.tier.as_str())
            } else if a.remaining > 0 {
                format!(
                    "只剩 {} 次，够不了一次 {} 次的请求；先用剩的，或请赞助者补额度。注意：额度不够只是排队/降级，不封号，明天按地板 {} 次恢复",
                    a.remaining, want, a.calls
                )
            } else {
                format!("今日额度用完（{} 次），但地板额度保证明天 {} 次自动恢复 —— 不封号", a.used, a.calls)
            },
            "sponsor_hint": {
                "endpoint": "POST /api/econ/pool/topup",
                "note": note,
                "说明": "赞助者补已到账现金进公共池；也可 POST /api/econ/contributions 认捐算力/额度",
            },
        }))
    }
}

/// 群聊常量（避免 agent 侧复制一份会漂移的数字）。
pub mod bolloon_web_consts {
    pub const GROUP_LARGE_THRESHOLD: usize = 10;
    pub const DEFAULT_REPLIES_WHEN_LARGE: usize = 5;
}

/// 统一入口：按工具名分派，未知名字返回 None（交给别的执行器）
pub fn try_execute(tools: &EconTools, call: &ToolCall) -> Option<ToolResult> {
    match call.name.as_str() {
        "econ_probe" => Some(tools.probe(&call.arguments)),
        "econ_claim" => Some(tools.claim(&call.arguments)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bolloon_config::EconomicConfig;

    fn econ() -> Arc<ShadowEconomy> {
        let cfg = EconomicConfig { enabled: true, metering_enabled: true, ..Default::default() };
        Arc::new(ShadowEconomy::new(cfg, None))
    }

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: "call-1".into(),
            name: name.into(),
            arguments: args,
        }
    }

    #[test]
    fn probe_reports_pool_and_allowance_with_reasons() {
        let t = EconTools { econ: econ(), principal: "agent-a".into(), group: Some("g1".into()) };
        let r = t.probe(&serde_json::json!({}));
        assert!(r.ok);
        let v: serde_json::Value = serde_json::from_str(&r.output).unwrap();
        assert_eq!(v["enabled"], serde_json::json!(true));
        assert!(v["my_allowance"]["calls"].as_u64().unwrap() >= 5, "地板额度必须 >0");
        assert!(!v["my_allowance"]["reasons"].as_array().unwrap().is_empty(), "额度必须给理由");
        assert_eq!(v["group_reply"]["default_when_large"], serde_json::json!(5));
    }

    #[test]
    fn claim_grants_when_within_allowance_and_queues_when_not() {
        let t = EconTools { econ: econ(), principal: "agent-b".into(), group: None };
        let ok1 = t.claim(&serde_json::json!({ "calls": 3 }));
        let v: serde_json::Value = serde_json::from_str(&ok1.output).unwrap();
        assert_eq!(v["granted"], serde_json::json!(true), "{v}");

        // 要一个远超额度的量 ⇒ queued，且明确说"不封号、明天恢复"
        let big = t.claim(&serde_json::json!({ "calls": 100_000, "note": "大规模研究" }));
        let v2: serde_json::Value = serde_json::from_str(&big.output).unwrap();
        assert_eq!(v2["queued"], serde_json::json!(true), "{v2}");
        let why = v2["why"].as_str().unwrap_or("");
        assert!(why.contains("不封号"), "拒绝也要给善意出口: {why}");
        assert!(v2["sponsor_hint"]["endpoint"].as_str().unwrap().contains("topup"));
    }

    #[test]
    fn unknown_tool_falls_through() {
        let t = EconTools { econ: econ(), principal: "x".into(), group: None };
        assert!(try_execute(&t, &call("read_file", serde_json::json!({}))).is_none());
    }
}
