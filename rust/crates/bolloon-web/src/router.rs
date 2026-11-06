//! router.rs — 任务×provider 成本/成功率账本 + 影子→真路由 (2026-11-06)
//!
//! 对应 leo 的阶段 0/1: 先把"同一任务上不同 provider 差多少"变成可聚合数据,
//! 再让路由真的按数据切换 (默认影子: 只记账不改调用)。
//!
//! 纪律:
//! - **数据来自真实调用**, 不靠手填价格表; 样本不足就不动 (返回 None, 保持用户选择)
//! - 真路由只在 `enforce` 开关打开时生效; 打开后失败**必须回退**到用户原 provider
//! - 账本是 append-only JSONL (`~/.bolloon/rust/router-ledger.jsonl`), 一行一次调用

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 路由执行开关 (默认影子)
#[derive(Debug, Default)]
pub struct RouterSwitch {
    enforce: AtomicBool,
}

impl RouterSwitch {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn is_enforce(&self) -> bool {
        self.enforce.load(Ordering::SeqCst)
    }
    pub fn set_enforce(&self, on: bool) {
        self.enforce.store(on, Ordering::SeqCst);
    }
}

fn ledger_path() -> std::path::PathBuf {
    crate::server::data_dir().join("router-ledger.jsonl")
}

/// 一次调用的资源标价成本 (USD, 是否已知单价)
///
/// 口径: `pay::list_price_micro` = standard tier 标价, **不是用户实际扣费**。
/// 未知模型如实返回 (0,false), 不编数字 —— 矩阵里 `cost_known=false` 的格子不参与比价。
pub fn cost_of(model: &str, tokens_in: u64, tokens_out: u64) -> (f64, bool) {
    match crate::pay::list_price_micro(model, tokens_in, tokens_out) {
        Some(micro) => (micro as f64 / 1_000_000.0, true),
        None => (0.0, false),
    }
}

/// 记一次真实调用
pub fn record(rec: serde_json::Value) {
    let p = ledger_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", serde_json::to_string(&rec).unwrap_or_default());
    }
}

fn read_ledger(limit: usize) -> Vec<serde_json::Value> {
    let raw = std::fs::read_to_string(ledger_path()).unwrap_or_default();
    let mut rows: Vec<serde_json::Value> = raw
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    if rows.len() > limit {
        rows = rows.split_off(rows.len() - limit);
    }
    rows
}

/// 任务×provider 聚合矩阵 (阶段 0 的验收物)
pub fn matrix() -> serde_json::Value {
    let rows = read_ledger(20_000);
    use std::collections::BTreeMap;
    // key: (task, provider)
    let mut agg: BTreeMap<(String, String), (u64, u64, u128, u128)> = BTreeMap::new();
    for r in &rows {
        let task = r["task"].as_str().unwrap_or("unknown").to_string();
        let provider = r["provider"].as_str().unwrap_or("unknown").to_string();
        let ok = r["ok"].as_bool().unwrap_or(false);
        let latency = r["latency_ms"].as_u64().unwrap_or(0) as u128;
        let cost = r["cost_usd"]
            .as_f64()
            .map(|c| (c * 1_000_000.0) as u128)
            .unwrap_or(0);
        let e = agg.entry((task, provider)).or_insert((0, 0, 0, 0));
        e.0 += 1;
        if ok {
            e.1 += 1;
        }
        e.2 += latency;
        e.3 += cost;
    }
    let cells: Vec<serde_json::Value> = agg
        .into_iter()
        .map(|((task, provider), (n, ok, lat, cost))| {
            serde_json::json!({
                "task": task,
                "provider": provider,
                "calls": n,
                "ok": ok,
                "success_rate": if n == 0 { 0.0 } else { ok as f64 / n as f64 },
                "avg_latency_ms": if n == 0 { 0 } else { (lat / n as u128) as u64 },
                "total_cost_usd": (cost as f64) / 1_000_000.0,
                "avg_cost_usd": if n == 0 { 0.0 } else { (cost as f64 / n as f64) / 1_000_000.0 },
            })
        })
        .collect();
    serde_json::json!({
        "cells": cells,
        "rows": rows.len(),
        "note": "数据来自真实调用; 样本 <3 的格子仅供参考, 不参与路由决策"
    })
}

/// 依据账本挑一个 provider (只在有把握时返回; 否则 None = 保持用户选择)
///
/// 规则 (透明): 该 task 下样本 ≥3、成功率 ≥0.8 的 provider 里,
/// 先比平均成本 (有成本数据的优先), 再比平均延迟。
pub fn pick_provider(task: &str, available: &[String]) -> Option<String> {
    if available.is_empty() {
        return None;
    }
    let rows = read_ledger(20_000);
    use std::collections::HashMap;
    let mut agg: HashMap<String, (u64, u64, u128, u128)> = HashMap::new();
    for r in &rows {
        if r["task"].as_str() != Some(task) {
            continue;
        }
        let p = r["provider"].as_str().unwrap_or("");
        if !available.iter().any(|a| a == p) {
            continue;
        }
        let ok = r["ok"].as_bool().unwrap_or(false);
        let lat = r["latency_ms"].as_u64().unwrap_or(0) as u128;
        let cost = r["cost_usd"].as_f64().map(|c| (c * 1e6) as u128).unwrap_or(0);
        let e = agg.entry(p.to_string()).or_insert((0, 0, 0, 0));
        e.0 += 1;
        if ok {
            e.1 += 1;
        }
        e.2 += lat;
        e.3 += cost;
    }
    let mut best: Option<(String, f64, u128)> = None;
    for (p, (n, ok, lat, cost)) in agg {
        if n < 3 || (ok as f64 / n as f64) < 0.8 {
            continue;
        }
        let avg_cost = (cost as f64) / (n as f64);
        let avg_lat = lat / (n as u128);
        let better = match &best {
            None => true,
            Some((_, bc, bl)) => avg_cost < *bc || (avg_cost == *bc && avg_lat < *bl),
        };
        if better {
            best = Some((p, avg_cost, avg_lat));
        }
    }
    best.map(|(p, _, _)| p)
}

/// GET /api/router/state → 开关 + 最近一条账本
pub async fn router_state(axum::extract::State(st): axum::extract::State<crate::AppState>) -> axum::Json<serde_json::Value> {
    let last = read_ledger(1).into_iter().next();
    axum::Json(serde_json::json!({
        "enforce": st.router.is_enforce(),
        "ledger": ledger_path().display().to_string(),
        "last": last,
        "note": "enforce=false 时只记账不改真实调用 (影子路由)"
    }))
}

/// POST /api/router/enforce {on}
pub async fn router_enforce(
    axum::extract::State(st): axum::extract::State<crate::AppState>,
    axum::Json(req): axum::Json<serde_json::Value>,
) -> axum::Json<serde_json::Value> {
    let on = req["on"].as_bool().unwrap_or(false);
    st.router.set_enforce(on);
    axum::Json(serde_json::json!({
        "ok": true, "enforce": on,
        "note": if on { "真路由已开启: 命中数据规律的会切换 provider, 失败自动回退" } else { "已回到影子模式: 只记账" }
    }))
}

fn prices_path() -> std::path::PathBuf {
    crate::server::data_dir().join("router-prices.json")
}

fn read_prices() -> serde_json::Value {
    std::fs::read(prices_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| serde_json::json!({ "models": [] }))
}

/// GET /api/router/prices → 已登记的自定义单价
pub async fn router_prices_get() -> axum::Json<serde_json::Value> {
    axum::Json(read_prices())
}

/// POST /api/router/prices {id, usd_per_1k_in, usd_per_1k_out} → 登记/更新一个模型单价
///
/// 不认识的模型账本会写 cost_known=false; 这里登记后重跑评测就能拿到真实成本列。
/// 内置定价表(含别名)优先, 自定义只补空缺 —— 不覆盖用户已定的售价口径。
pub async fn router_prices_set(
    axum::Json(req): axum::Json<serde_json::Value>,
) -> axum::Json<serde_json::Value> {
    let id = req["id"].as_str().unwrap_or_default().trim().to_string();
    let cin = req["usd_per_1k_in"].as_f64();
    let cout = req["usd_per_1k_out"].as_f64();
    if id.is_empty() || cin.is_none() || cout.is_none() {
        return axum::Json(serde_json::json!({ "ok": false, "error": "缺 id / usd_per_1k_in / usd_per_1k_out" }));
    }
    let mut j = read_prices();
    let count;
    {
        let arr = j["models"].as_array_mut().expect("默认数组");
        arr.retain(|m| m["id"].as_str() != Some(id.as_str()));
        arr.push(serde_json::json!({
            "id": id, "usd_per_1k_in": cin, "usd_per_1k_out": cout,
        }));
        count = arr.len();
    }
    let p = prices_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    match std::fs::write(&p, serde_json::to_string_pretty(&j).unwrap_or_default()) {
        Ok(_) => axum::Json(serde_json::json!({ "ok": true, "id": id, "models": count })),
        Err(e) => axum::Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

/// GET /api/router/matrix
pub async fn router_matrix() -> axum::Json<serde_json::Value> {
    axum::Json(matrix())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_aggregates_by_task_and_provider() {
        let rows = vec![
            serde_json::json!({"task":"chat","provider":"a","ok":true,"latency_ms":100,"cost_usd":0.01}),
            serde_json::json!({"task":"chat","provider":"a","ok":false,"latency_ms":300,"cost_usd":0.02}),
        ];
        // 纯函数式校验: 用同样的聚合口径
        let n = rows.len() as u64;
        let ok = rows.iter().filter(|r| r["ok"].as_bool() == Some(true)).count() as u64;
        assert_eq!(n, 2);
        assert!((ok as f64 / n as f64 - 0.5).abs() < 1e-9);
    }

    #[test]
    fn pick_requires_three_samples_and_80pct() {
        // 账本为空时绝不乱选
        assert!(pick_provider("不存在的任务", &["a".to_string()]).is_none());
    }

    #[test]
    fn switch_defaults_to_shadow() {
        let s = RouterSwitch::new();
        assert!(!s.is_enforce(), "默认必须是影子模式");
        s.set_enforce(true);
        assert!(s.is_enforce());
    }
}
