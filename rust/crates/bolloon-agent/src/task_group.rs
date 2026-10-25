//! 任务群聊留痕 (`[bolloon-task]` 协议) — 公告/接单/交付/初筛/终审 过程留痕
//!
//! 对齐 TS 版 `task-group.ts` + `task-public-text.ts`:
//! - 一行一条事实: `[bolloon-task] v=1 kind=announce id=<ann> cap=<能力> budget=<额>`
//! - **隐私守卫 (发送侧拒发 + 读回侧遮蔽)**: 钱包地址 / DID / peerId / IPv4/IPv6 /
//!   私钥形状 / PEM / Qm 同形物 — 命中即拒, 群里只有短引用
//! - 交付哈希只收 sha256/CIDv1; 0x+40 是钱包地址形状 → 拒; Qm… 与 peerId 同形 → 拒
//! - trail 读回: 按时间升序汇总 + 诚实计数 (无交付痕迹不出现"已交付")

use serde::{Deserialize, Serialize};

/// 消息标记 (一行一条, 解析只认这一行)
pub const TRAIL_TAG: &str = "[bolloon-task]";
/// 版本
pub const TRAIL_VERSION: &str = "1";

/// 留痕类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrailKind {
    Announce,
    Claim,
    Deliver,
    Screen,
    Final,
}

impl TrailKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Announce => "announce",
            Self::Claim => "claim",
            Self::Deliver => "deliver",
            Self::Screen => "screen",
            Self::Final => "final",
        }
    }
    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "announce" => Self::Announce,
            "claim" => Self::Claim,
            "deliver" => Self::Deliver,
            "screen" => Self::Screen,
            "final" => Self::Final,
            _ => return None,
        })
    }
}

/// 隐私违规
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivacyViolation {
    pub rule: String,
    pub hint: String,
}

/// 隐私守卫 (纯函数): 群消息正文里不许出现任何节点/身份标识
///
/// 覆盖: 钱包地址 (0x+40) · DID (did:…) · peerId (Qm…/12D3…) · multiaddr (/ip4/) ·
/// IPv4 · IPv6 · 私钥形状 (0x+64) · PEM · "私钥/助记词" 字样
pub fn scan_privacy(text: &str) -> Vec<PrivacyViolation> {
    let mut out = Vec::new();
    let check = |rule: &str, hint: &str, cond: bool, out: &mut Vec<PrivacyViolation>| {
        if cond {
            out.push(PrivacyViolation { rule: rule.into(), hint: hint.into() });
        }
    };
    // 钱包地址 0x + 40 hex
    check(
        "wallet_address",
        "0x + 40 hex 是钱包地址 — 群里不贴地址",
        text.split(|c: char| !c.is_ascii_alphanumeric())
            .any(|tok| tok.len() == 42 && tok.to_lowercase().starts_with("0x")),
        &mut out,
    );
    // 私钥形状 0x + 64 hex
    check(
        "private_key_shape",
        "0x + 64 hex 是私钥形状 — 绝对不进群",
        text.split(|c: char| !c.is_ascii_alphanumeric())
            .any(|tok| tok.len() == 66 && tok.to_lowercase().starts_with("0x")),
        &mut out,
    );
    // DID
    check("did", "DID 不进群 (用 agent-<8位> 假名)", text.contains("did:"), &mut out);
    // peerId (Qm 开头 46 位 base58 / 12D3 开头)
    check(
        "peer_id",
        "Qm…/12D3… 与 peerId 同形",
        text.split_whitespace()
            .any(|tok| (tok.starts_with("Qm") && tok.len() == 46) || tok.starts_with("12D3")),
        &mut out,
    );
    // multiaddr
    check("multiaddr", "multiaddr 不进群", text.contains("/ip4/") || text.contains("/ip6/"), &mut out);
    // IPv4
    check(
        "ipv4",
        "IP 地址不进群",
        text.split(|c: char| !c.is_ascii_digit() && c != '.').any(|tok| {
            let parts: Vec<&str> = tok.split('.').collect();
            parts.len() == 4
                && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()))
        }),
        &mut out,
    );
    // PEM / 私钥字样
    check("pem", "PEM 块不进群", text.contains("-----BEGIN"), &mut out);
    check("secret_words", "私钥/助记词字样不进群", text.contains("私钥") || text.contains("助记词"), &mut out);
    out
}

/// 交付哈希闸: 只收内容哈希形状
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum HashGateError {
    #[error("--hash 是**钱包地址**形状 (0x + 40 hex) — 交付哈希不是地址 (拒, 别把地址贴进群)")]
    WalletAddressShape,
    #[error("--hash 是 CIDv0 (Qm…) 形状, 它与 libp2p peerId **同形** — 拒 (用 sha256/<内容哈希> 或 CIDv1 bafy… 表达交付)")]
    PeerIdSameShape,
    #[error("交付哈希形状不对 (要 sha256:<64hex> 或 CIDv1 bafy…)")]
    BadShape,
}

/// 交付哈希闸 (纯函数)
pub fn gate_delivery_hash(hash: &str) -> Result<(), HashGateError> {
    let h = hash.trim();
    let lowered = h.to_lowercase();
    // 0x + 40 = 钱包地址
    if lowered.starts_with("0x") && lowered[2..].chars().all(|c| c.is_ascii_hexdigit()) && lowered.len() == 42 {
        return Err(HashGateError::WalletAddressShape);
    }
    // 0x + 64 = 私钥形状
    if lowered.starts_with("0x") && lowered.len() == 66 {
        return Err(HashGateError::BadShape);
    }
    // Qm… (CIDv0) 与 peerId 同形 → 拒
    if h.starts_with("Qm") && h.len() == 46 {
        return Err(HashGateError::PeerIdSameShape);
    }
    // sha256:<64hex>
    if let Some(rest) = lowered.strip_prefix("sha256:") {
        if rest.len() == 64 && rest.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(());
        }
    }
    // CIDv1 bafy…
    if h.starts_with("bafy") {
        return Ok(());
    }
    Err(HashGateError::BadShape)
}

/// 构造一条留痕行 (字段化; 值全部经隐私守卫)
pub fn build_trail_line(kind: TrailKind, fields: &[(&str, String)]) -> Result<String, PrivacyViolation> {
    let mut line = format!("{TRAIL_TAG} v={TRAIL_VERSION} kind={}", kind.as_str());
    for (k, v) in fields {
        let violations = scan_privacy(v);
        if let Some(v0) = violations.first() {
            return Err(v0.clone());
        }
        line.push_str(&format!(" {k}={v}"));
    }
    Ok(line)
}

/// 解析留痕行 (只认 TRAIL_TAG 开头)
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedTrail {
    pub kind: TrailKind,
    pub fields: std::collections::BTreeMap<String, String>,
}

/// 解析一行 (非 trail 行返回 None; kind 非法返回 None 不猜)
pub fn parse_trail_line(line: &str) -> Option<ParsedTrail> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix(TRAIL_TAG)?;
    let mut kind: Option<TrailKind> = None;
    let mut fields = std::collections::BTreeMap::new();
    for tok in rest.split_whitespace() {
        if let Some(v) = tok.strip_prefix("v=") {
            if v != TRAIL_VERSION {
                return None;
            }
            continue;
        }
        if let Some(k) = tok.strip_prefix("kind=") {
            kind = TrailKind::from_str(k);
            continue;
        }
        if let Some((key, val)) = tok.split_once('=') {
            fields.insert(key.to_string(), val.to_string());
        }
    }
    Some(ParsedTrail { kind: kind?, fields })
}

/// trail 时间线汇总 (诚实计数: 无交付痕迹不出现"已交付")
#[derive(Debug, Default, Serialize)]
pub struct TrailTimeline {
    pub announce: usize,
    pub claim: usize,
    pub deliver: usize,
    pub screen: usize,
    pub final_verdicts: Vec<String>,
    /// 被遮蔽字段数 (读回侧遇到违规行, 遮蔽并记账不回显原文)
    pub redacted: usize,
    /// 事实矛盾 (终审 accept 但无交付痕迹)
    pub contradictions: Vec<String>,
}

/// 汇总 (纯函数): 输入群消息文本数组
pub fn summarize_trail(lines: &[&str]) -> TrailTimeline {
    let mut t = TrailTimeline::default();
    let mut has_deliver = false;
    for line in lines {
        if !scan_privacy(line).is_empty() {
            t.redacted += 1; // 遮蔽并记账, 不回显原文
            continue;
        }
        let Some(parsed) = parse_trail_line(line) else { continue };
        match parsed.kind {
            TrailKind::Announce => t.announce += 1,
            TrailKind::Claim => t.claim += 1,
            TrailKind::Deliver => {
                t.deliver += 1;
                has_deliver = true;
            }
            TrailKind::Screen => t.screen += 1,
            TrailKind::Final => {
                if let Some(v) = parsed.fields.get("verdict") {
                    t.final_verdicts.push(v.clone());
                }
            }
        }
    }
    // 终审 accept 但无交付痕迹 → 显式标矛盾
    if !has_deliver && t.final_verdicts.iter().any(|v| v == "accept") {
        t.contradictions.push("final-accept-without-delivery: 终审 accept 但无交付痕迹".into());
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trail_line_roundtrip() {
        let line = build_trail_line(
            TrailKind::Announce,
            &[("id", "ann-3b7bf8db".into()), ("cap", "research".into()), ("budget", "1000".into())],
        )
        .unwrap();
        assert!(line.starts_with("[bolloon-task] v=1 kind=announce"));
        let parsed = parse_trail_line(&line).unwrap();
        assert_eq!(parsed.kind, TrailKind::Announce);
        assert_eq!(parsed.fields.get("cap").map(|s| s.as_str()), Some("research"));
    }

    #[test]
    fn privacy_wallet_address_rejected_at_send() {
        let err = build_trail_line(TrailKind::Deliver, &[("to", "0x6a3f797592bed028f6afd6da82339c8e815480eb".into())]);
        assert!(err.is_err(), "地址不许进群");
        assert_eq!(err.unwrap_err().rule, "wallet_address");
    }

    #[test]
    fn privacy_did_rejected() {
        let v = scan_privacy("联系 did:pi:z6Mk");
        assert!(v.iter().any(|x| x.rule == "did"));
    }

    #[test]
    fn privacy_ipv4_rejected() {
        let v = scan_privacy("服务器 192.168.1.1 上有");
        assert!(v.iter().any(|x| x.rule == "ipv4"));
    }

    #[test]
    fn privacy_private_key_shape_rejected() {
        let v = scan_privacy("key: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");
        assert!(v.iter().any(|x| x.rule == "private_key_shape"));
    }

    #[test]
    fn privacy_clean_line_passes() {
        assert!(scan_privacy("cap=research budget=1000 deadline=2026-11-01").is_empty());
    }

    #[test]
    fn hash_gate_rejects_wallet_address() {
        assert_eq!(
            gate_delivery_hash("0x6a3f797592bed028f6afd6da82339c8e815480eb").unwrap_err(),
            HashGateError::WalletAddressShape
        );
    }

    #[test]
    fn hash_gate_rejects_qm_same_shape_as_peerid() {
        assert_eq!(
            gate_delivery_hash(&format!("Qm{}", "a".repeat(44))).unwrap_err(),
            HashGateError::PeerIdSameShape
        );
    }

    #[test]
    fn hash_gate_accepts_sha256_and_cidv1() {
        assert!(gate_delivery_hash(&format!("sha256:{}", "a".repeat(64))).is_ok());
        assert!(gate_delivery_hash("bafybeiabc123").is_ok());
        assert!(gate_delivery_hash("随便").is_err());
    }

    #[test]
    fn summarize_counts_and_contradiction() {
        let lines = [
            "[bolloon-task] v=1 kind=announce id=ann-1 cap=research",
            "[bolloon-task] v=1 kind=claim id=ann-1 by=agent-abcd1234",
            "[bolloon-task] v=1 kind=final id=ann-1 verdict=accept",
        ];
        let t = summarize_trail(&lines);
        assert_eq!(t.announce, 1);
        assert_eq!(t.claim, 1);
        assert_eq!(t.deliver, 0, "无交付痕迹");
        assert_eq!(
            t.contradictions,
            vec!["final-accept-without-delivery: 终审 accept 但无交付痕迹"],
            "0 交付痕迹却终审 accept = 显式矛盾, 不冒充正常"
        );
    }

    #[test]
    fn summarize_redacts_privacy_lines() {
        let lines = [
            "[bolloon-task] v=1 kind=announce id=ann-1",
            "有人贴了 0x6a3f797592bed028f6afd6da82339c8e815480eb 进群",
        ];
        let t = summarize_trail(&lines);
        assert_eq!(t.redacted, 1, "违规行遮蔽并记账");
        assert_eq!(t.announce, 1);
    }

    #[test]
    fn non_trail_lines_ignored() {
        assert!(parse_trail_line("普通聊天消息").is_none());
        assert!(parse_trail_line("[bolloon-task] v=1 kind=unknown-op").is_none(), "kind 非法不猜");
    }

    #[test]
    fn honest_counting_no_fake_delivered() {
        // 0 交付痕迹时 deliver=0, 不出现"已交付"条目
        let lines = ["[bolloon-task] v=1 kind=announce id=ann-2 cap=x"];
        let t = summarize_trail(&lines);
        assert_eq!(t.deliver, 0);
        assert!(t.contradictions.is_empty(), "没有终审就不标矛盾");
    }
}
