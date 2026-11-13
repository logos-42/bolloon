//! 边缘目录客户端 —— 解决「初次寻找」难：两台从没见过面的机器，只凭手机号就能找到彼此。
//!
//! 2026-11-13：gossip 要先有已连对端、Kademlia DHT 要先有 bootstrap，两者都解决不了
//! 「第一次」。用户提供的 `bolloon.cn` / Cloudflare Workers 边缘节点充当**电话簿**：
//! 只存按 `discovery_topic(phone)` 索引的 DID 签名记录，不存手机号明文、不存密钥。
//!
//! 隐私与信任边界（关键）：
//! - 上行只有 `topic`（加盐哈希）与带签名记录，**手机号明文从不出本机**；
//! - 服务端完全不可信：客户端拿到记录后本地验 DID 签名（v2 覆盖 DIAP 地址），
//!   服务端被投毒 / 被篡改 / 返回别人的记录都会被拒；
//! - 只接受 `v: 2` 记录（签名覆盖地址），避免「换地址」中间人；
//! - `BOLLOON_RENDEZVOUS=off` 可完全关掉，改走纯 DHT/gossip；
//! - 默认基址是用户自己的站点，可用 env 指向任意兼容契约的边缘节点（含 Workers）。
//!
//! 契约（bolloon.cn 与 Cloudflare Worker 实现同一套）：
//!   POST {base}/api/discovery/remote/announce   body = v2 记录
//!   GET  {base}/api/discovery/remote/find?topic=<64hex>  → {ok, found, record}

use std::time::Duration;

use bolloon_agent::directory::discovery_topic_hex;
use serde_json::Value;

use crate::server::AppState;

/// 用户自己的站点；任何 bolloon 节点跑 `bolloon web` 就实现了这套契约。
///
/// 2026-11-13: **默认不启用**。第一次互联必须走去中心化（gossip / Kademlia DHT / mDNS），
/// 绝不暗地里把手机号哈希发给第三方；要用边缘目录必须显式设
/// `BOLLOON_RENDEZVOUS=https://...`（本常量只作为示例地址保留）。
pub const DEFAULT_BASE: &str = "https://bolloon.cn";
const TIMEOUT: Duration = Duration::from_secs(6);

/// 返回目录基址；`off`/空 = 完全禁用（改走 DHT/gossip）。
fn base() -> Option<String> {
    match std::env::var("BOLLOON_RENDEZVOUS") {
        Ok(v) => {
            let t = v.trim();
            if t.is_empty() || t.eq_ignore_ascii_case("off") {
                None
            } else {
                Some(t.trim_end_matches('/').to_string())
            }
        }
        // 未设置 = 关闭。去中心化优先：不擅自把号码哈希发到任何服务器。
        Err(_) => None,
    }
}

pub fn status() -> Value {
    serde_json::json!({
        "enabled": base().is_some(),
        "base": base(),
        "default": "off",
        "opt_in": "默认只走去中心化; 要边缘目录需显式 BOLLOON_RENDEZVOUS=<url>",
        "honest": "只上传手机号加盐哈希与 DID 签名记录; 记录在本地验签, 不信任服务端",
    })
}

/// 绑定手机号后把本机 DIAP 地址登记到边缘目录。失败如实返回，不阻塞本地绑定。
pub async fn announce(st: &AppState, phone: &str) -> Value {
    let Some(base) = base() else {
        return serde_json::json!({
            "ok": false, "skipped": true, "reason": "BOLLOON_RENDEZVOUS=off (走 DHT/gossip)"
        });
    };
    let rec = crate::discovery::signed_record(st, phone);
    let topic = rec["topic"].as_str().unwrap_or_default().to_string();
    let url = format!("{base}/api/discovery/remote/announce");
    let body = rec.clone();
    let res = tokio::task::spawn_blocking(move || {
        let r = ureq::post(&url)
            .timeout(TIMEOUT)
            .send_json(body)
            .map_err(|e| e.to_string())?;
        r.into_json::<Value>().map_err(|e| e.to_string())
    })
    .await;
    match res {
        Ok(Ok(v)) => serde_json::json!({
            "ok": v["ok"] == serde_json::json!(true),
            "topic": topic, "base": base, "remote": v,
        }),
        Ok(Err(e)) => serde_json::json!({
            "ok": false, "topic": topic, "base": base, "error": e,
        }),
        Err(e) => serde_json::json!({
            "ok": false, "topic": topic, "base": base, "error": format!("目录任务失败: {e}"),
        }),
    }
}

/// 只输手机号从边缘目录查对方记录；**本地验签**通过才返回。
pub async fn find(phone: &str) -> Option<Value> {
    let base = base()?;
    let topic = discovery_topic_hex(phone);
    let url = format!("{base}/api/discovery/remote/find?topic={topic}");
    let r = tokio::task::spawn_blocking(move || {
        let resp = ureq::get(&url)
            .timeout(TIMEOUT)
            .call()
            .map_err(|e| e.to_string())?;
        resp.into_json::<Value>().map_err(|e| e.to_string())
    })
    .await
    .ok()?
    .ok()?;
    if r["found"].as_bool() != Some(true) {
        return None;
    }
    let rec = r["record"].clone();
    if rec["v"].as_u64().unwrap_or(1) < 2 {
        return None; // 只要 v2（签名覆盖地址）
    }
    if rec["topic"].as_str() != Some(topic.as_str()) {
        return None; // 目录不能拿别的号码的记录来糊弄
    }
    if !crate::discovery::verify_record(&rec) {
        return None; // 伪造/被改地址 → 拒
    }
    Some(rec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendezvous_is_off_by_default_and_only_opt_in() {
        unsafe { std::env::set_var("BOLLOON_RENDEZVOUS", "off") };
        assert!(base().is_none());
        unsafe { std::env::set_var("BOLLOON_RENDEZVOUS", "") };
        assert!(base().is_none());
        // 关键: 不设 env 时绝不默认连 bolloon.cn / Cloudflare
        unsafe { std::env::remove_var("BOLLOON_RENDEZVOUS") };
        assert!(base().is_none(), "第一次互联必须去中心化, 默认不得连边缘目录");
        unsafe { std::env::set_var("BOLLOON_RENDEZVOUS", "https://edge.example") };
        assert_eq!(base().as_deref(), Some("https://edge.example"));
        unsafe { std::env::remove_var("BOLLOON_RENDEZVOUS") };
    }
}
