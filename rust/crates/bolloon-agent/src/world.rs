//! World / Intent Network — 意图 → 机会匹配 → 校准环
//!
//! 对齐 TS 版 `intent-store.ts` / `opportunity-match.ts` / `world-cards.ts`:
//! - 默认世界流: 无意图也流入, 永远不空流
//! - 匹配 = 自动校准 (透明打分 + reason), 不做"输入→扫描→结果"
//! - ignore/accept 校准环: 同源不再流入
//! - 世界卡片: 复用 p2p SignedEnvelope (签名防伪, scope 防伪造公域标记)

use serde::{Deserialize, Serialize};

use bolloon_p2p::identity::KeyPair;

/// 用户意图 (世界流的筛选器; None = 纯默认流)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Intent {
    pub id: String,
    /// 意图文本 (如 "可控核聚变 合作")
    pub text: String,
    /// 提取的标签
    pub tags: Vec<String>,
    pub active: bool,
    pub created_at_ms: u64,
}

/// 世界卡片 (文本/音频/图片/视频 多媒体)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorldCard {
    pub title: String,
    pub summary: String,
    /// media: text | audio | image | video
    pub media_kind: String,
    /// 内容 (文本原文或 CID/URL)
    pub media_ref: String,
    /// provider DID
    pub provider_did: String,
    /// private=好友定向 (默认) | public=公域广播
    pub scope: CardScope,
    pub issued_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardScope {
    Private,
    Public,
}

impl Default for CardScope {
    fn default() -> Self {
        Self::Private
    }
}

/// 机会 (世界流条目)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Opportunity {
    pub id: String,
    pub title: String,
    pub summary: String,
    /// 来源: world=本地 | inbox=✉外部投递 | search=🔎AI搜索
    pub source: String,
    /// 匹配分 (0.0~1.0)
    pub score: f64,
    /// 透明打分理由 (UI 不贴元解释, 但数据层留)
    pub reason: String,
    /// 外部投递卡片 (有才有)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<WorldCard>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// 校准环: ignore/accept 后同源不再流入
#[derive(Debug, Default)]
pub struct CalibrationRing {
    ignored_sources: Vec<String>,
}

impl CalibrationRing {
    pub fn ignore(&mut self, source: &str) {
        if !self.ignored_sources.iter().any(|s| s == source) {
            self.ignored_sources.push(source.to_string());
        }
    }

    pub fn is_ignored(&self, source: &str) -> bool {
        self.ignored_sources.iter().any(|s| s == source)
    }
}

/// 机会流 (含校准环)
#[derive(Debug, Default)]
pub struct OpportunityStream {
    items: Vec<Opportunity>,
    calibration: CalibrationRing,
    next_id: u64,
}

impl OpportunityStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// 加入机会 (信箱恒置顶; 已 ignore 的同源不流入)
    pub fn push(&mut self, mut opp: Opportunity) -> bool {
        if self.calibration.is_ignored(&opp.source) {
            return false; // 校准环: 同源不再流入
        }
        self.next_id += 1;
        opp.id = format!("opp-{0:04}", self.next_id);
        self.items.push(opp);
        true
    }

    /// 读流: 信箱(inbox) > 搜索(search) > 世界(world), 同层按分降序
    pub fn feed(&self) -> Vec<&Opportunity> {
        let rank = |s: &str| match s {
            "inbox" => 0,
            "search" => 1,
            _ => 2,
        };
        let mut items: Vec<&Opportunity> = self.items.iter().collect();
        items.sort_by(|a, b| {
            rank(&a.source)
                .cmp(&rank(&b.source))
                .then(b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
        });
        items
    }

    pub fn ignore(&mut self, id: &str) -> bool {
        if let Some(i) = self.items.iter().position(|o| o.id == id) {
            let source = self.items.remove(i).source;
            self.calibration.ignore(&source);
            // 同源已流入的也移除 (ignore = 该源整个不看了)
            self.items.retain(|o| o.source != source);
            return true;
        }
        false
    }
}

/// 透明打分 (纯函数): 意图标签命中比例 × 来源加成
///
/// - 无意图 (无标签) = 默认世界流, 一律 0.5 (reason=world)
/// - 命中标签 → 0.5 + 0.5 × 命中比 (reason=match)
pub fn score_opportunity(opp_tags: &[String], intent_tags: &[String]) -> (f64, String) {
    if intent_tags.is_empty() {
        return (0.5, "world".into());
    }
    let hits = intent_tags
        .iter()
        .filter(|t| opp_tags.iter().any(|o| o.contains(t.as_str()) || t.contains(o.as_str())))
        .count();
    let ratio = hits as f64 / intent_tags.len() as f64;
    if hits == 0 {
        (0.3, "no-match".into())
    } else {
        (0.5 + 0.5 * ratio, format!("match:{hits}/{}", intent_tags.len()))
    }
}

/// 世界卡片签名 (防伪: scope 进签名载荷, 改 scope 验签必败)
#[derive(serde::Serialize)]
struct CardUnsigned<'a> {
    title: &'a str,
    summary: &'a str,
    media_kind: &'a str,
    media_ref: &'a str,
    provider_did: &'a str,
    scope: CardScope,
    issued_at_ms: u64,
}

/// 卡片错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CardError {
    #[error("签名无效")]
    BadSignature,
}

/// 签发世界卡片 (provider 私钥签名)
pub fn seal_card(kp: &KeyPair, mut card: WorldCard) -> WorldCard {
    card.provider_did = kp.did.as_str().to_string();
    card // 签名在信封层做 (发送走 SignedEnvelope); 这里归一 provider
}

/// 验证收到的卡片 (provider DID 可信 + scope 防伪)
pub fn verify_card(
    card: &WorldCard,
    provider_pubkey: &[u8; 32],
    signature: &[u8; 64],
) -> Result<(), CardError> {
    let unsigned = CardUnsigned {
        title: &card.title,
        summary: &card.summary,
        media_kind: &card.media_kind,
        media_ref: &card.media_ref,
        provider_did: &card.provider_did,
        scope: card.scope,
        issued_at_ms: card.issued_at_ms,
    };
    let bytes = bolloon_p2p::envelope::canonical_json(&unsigned);
    if !KeyPair::verify(provider_pubkey, bytes.as_bytes(), signature) {
        return Err(CardError::BadSignature);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opp(source: &str, score: f64) -> Opportunity {
        Opportunity {
            id: String::new(),
            title: format!("opp-{source}"),
            summary: "s".into(),
            source: source.into(),
            score,
            reason: "world".into(),
            card: None,
            url: None,
        }
    }

    #[test]
    fn feed_ranks_inbox_on_top() {
        let mut s = OpportunityStream::new();
        s.push(opp("world", 0.9));
        s.push(opp("search", 0.8));
        s.push(opp("inbox", 0.6));
        let feed = s.feed();
        assert_eq!(feed[0].source, "inbox", "✉ 外部投递恒置顶");
        assert_eq!(feed[1].source, "search");
        assert_eq!(feed[2].source, "world");
    }

    #[test]
    fn same_layer_sorted_by_score() {
        let mut s = OpportunityStream::new();
        s.push(opp("world", 0.3));
        s.push(opp("world", 0.9));
        let feed = s.feed();
        assert!(feed[0].score > feed[1].score);
    }

    #[test]
    fn ignore_removes_source_forever() {
        let mut s = OpportunityStream::new();
        s.push(opp("search", 0.9));
        s.push(opp("world", 0.5));
        let id = s.feed()[0].id.clone();
        assert!(s.ignore(&id));
        // 同源再投也不进
        assert!(!s.push(opp("search", 0.99)));
        assert_eq!(s.feed().len(), 1, "只剩 world");
    }

    #[test]
    fn default_stream_never_empty_semantics() {
        // 无意图也流入: score_opportunity 无标签 = 0.5 world
        let (score, reason) = score_opportunity(&["聚变".into()], &[]);
        assert_eq!(reason, "world");
        assert!((score - 0.5).abs() < 1e-9);
    }

    #[test]
    fn match_scoring_transparent() {
        let (score, reason) = score_opportunity(
            &["可控核聚变".to_string(), "合作".into(), "论文".into()],
            &["核聚变".to_string(), "合作".into()],
        );
        assert_eq!(reason, "match:2/2");
        assert!((score - 1.0).abs() < 1e-9);
        let (s2, r2) = score_opportunity(&["别的东西".to_string()], &["核聚变".to_string()]);
        assert_eq!(r2, "no-match");
        assert!((s2 - 0.3).abs() < 1e-9);
    }

    #[tokio::test]
    async fn card_scope_tamper_breaks_signature() {
        let kp = KeyPair::generate();
        let card = WorldCard {
            title: "核聚变合作".into(),
            summary: "找合作方".into(),
            media_kind: "text".into(),
            media_ref: "内容".into(),
            provider_did: kp.did.as_str().into(),
            scope: CardScope::Private,
            issued_at_ms: 42,
        };
        let unsigned = CardUnsigned {
            title: &card.title,
            summary: &card.summary,
            media_kind: &card.media_kind,
            media_ref: &card.media_ref,
            provider_did: &card.provider_did,
            scope: card.scope,
            issued_at_ms: card.issued_at_ms,
        };
        let bytes = bolloon_p2p::envelope::canonical_json(&unsigned);
        let sig = kp.sign(bytes.as_bytes());
        assert!(verify_card(&card, &kp.public_bytes(), &sig).is_ok());

        // 篡改 scope → 验签必败 (防伪造公域标记)
        let mut forged = card.clone();
        forged.scope = CardScope::Public;
        assert_eq!(
            verify_card(&forged, &kp.public_bytes(), &sig).unwrap_err(),
            CardError::BadSignature
        );
    }

    #[test]
    fn card_default_scope_is_private() {
        assert_eq!(CardScope::default(), CardScope::Private, "缺省必须 private");
    }
}
