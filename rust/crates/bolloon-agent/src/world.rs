//! World / Intent Network — 意图 → 机会匹配 → 校准环
//!
//! 对齐 TS 版 `intent-store.ts` / `opportunity-match.ts` / `world-cards.ts`:
//! - 默认世界流: 无意图也流入, 永远不空流
//! - 匹配 = 自动校准 (透明打分 + reason), 不做"输入→扫描→结果"
//! - ignore/accept 校准环: 同源不再流入
//! - 世界卡片: 复用 p2p SignedEnvelope (签名防伪, scope 防伪造公域标记)

use serde::{Deserialize, Serialize};

use bolloon_p2p::envelope::{SignedEnvelope, TOPIC_WORLD_CARD};
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

/// 卡片媒体类型 (enum 化, 对齐 TS `CardMediaType`)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardMediaKind {
    Text,
    Audio,
    Image,
    Video,
}

impl Default for CardMediaKind {
    fn default() -> Self {
        Self::Text
    }
}

/// 卡片媒体项 (对齐 TS `CardMedia`: {type,url,mime,name})
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CardMedia {
    pub kind: CardMediaKind,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// 封面类型 —— **决定卡片高度档位** (video=高卡 16:9, image=中卡 4:3)
///
/// 注: TS 侧无 cover 概念 (多模态是 `media[]` 内联平铺), 本仓新增, 与 `media` 并列。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverKind {
    Image,
    Video,
}

/// 卡片封面 (有才显示封面区, 高度由 `kind` 决定)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CardCover {
    pub url: String,
    pub kind: CoverKind,
}

/// 验签结论 (**本地判定, 不进签名载荷**, 对齐 TS `verified|signature-invalid|unverified`)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardVerification {
    Verified,
    SignatureInvalid,
    Unverified,
}

impl Default for CardVerification {
    fn default() -> Self {
        Self::Unverified
    }
}

/// 世界卡片 (文本/音频/图片/视频 多媒体)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorldCard {
    pub title: String,
    pub summary: String,
    /// 多模态内容 (**可多项**, 对齐 TS `media: CardMedia[]`)
    #[serde(default)]
    pub media: Vec<CardMedia>,
    /// 封面 (决定卡片高度档位; None = 矮卡)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<CardCover>,
    /// provider DID
    pub provider_did: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    /// private=好友定向 (默认) | public=公域广播
    pub scope: CardScope,
    pub issued_at_ms: u64,
    /// 验签结论 (收卡时本地写入; 不参与签名)
    #[serde(default)]
    pub verification: CardVerification,
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

/// 世界卡片签名 (防伪: scope / media / cover 全进签名载荷, 改任一验签必败)
#[derive(serde::Serialize)]
struct CardUnsigned<'a> {
    title: &'a str,
    summary: &'a str,
    media: &'a [CardMedia],
    cover: &'a Option<CardCover>,
    provider_did: &'a str,
    scope: CardScope,
    issued_at_ms: u64,
}

/// 卡片错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CardError {
    #[error("签名无效")]
    BadSignature,
    #[error("主题不对: {0} (应为 world.card)")]
    BadTopic(String),
    #[error("卡片载荷无法解析")]
    BadPayload,
    #[error("卡片 provider 与信封发送者不一致")]
    ProviderMismatch,
    #[error("信封不可信: {0}")]
    BadEnvelope(String),
    #[error("好友模式卡片只收好友的 (非好友投递)")]
    NotFriend,
}

/// 卡片 canonical 字节串 (**签名覆盖对象**: 不含 verification, 那是本地判定)
pub fn card_canonical_bytes(card: &WorldCard) -> String {
    let unsigned = CardUnsigned {
        title: &card.title,
        summary: &card.summary,
        media: &card.media,
        cover: &card.cover,
        provider_did: &card.provider_did,
        scope: card.scope,
        issued_at_ms: card.issued_at_ms,
    };
    bolloon_p2p::envelope::canonical_json(&unsigned)
}

/// 签发世界卡片 (provider 私钥签名)
pub fn seal_card(kp: &KeyPair, mut card: WorldCard) -> WorldCard {
    card.provider_did = kp.did.as_str().to_string();
    card // 签名在信封层做 (发送走 SignedEnvelope); 这里归一 provider
}

/// 验证收到的卡片 (provider 公钥验签; scope / media / cover 防伪)
pub fn verify_card(
    card: &WorldCard,
    provider_pubkey: &[u8; 32],
    signature: &[u8; 64],
) -> Result<(), CardError> {
    let bytes = card_canonical_bytes(card);
    if !KeyPair::verify(provider_pubkey, bytes.as_bytes(), signature) {
        return Err(CardError::BadSignature);
    }
    Ok(())
}

// ────────────────────────── 跨机传输 (P2P world.card 帧) ──────────────────────────

/// 打包跨机帧: 卡片 → `SignedEnvelope` (topic = `world.card`)
///
/// 对齐 TS `send_world_card` → `buildSignedWorldCard` → `p2p.broadcast('world.card')`:
/// 签名由**信封层**做 (覆盖 canonical 正文 + topic + ts), 卡片本身不重复签名。
pub fn pack_world_card(kp: &KeyPair, card: &WorldCard, ts_ms: u64) -> SignedEnvelope {
    let payload = serde_json::to_value(card).unwrap_or(serde_json::Value::Null);
    SignedEnvelope::seal(kp, TOPIC_WORLD_CARD, payload, ts_ms)
}

/// 拆包跨机帧: 验信封 (协议 + DID/公钥一致 + 签名) → 主题对 → 解析 → provider 必须等于发送者。
///
/// **任一不过即拒收, 不静默降级** —— 对齐 TS `deliverWorldCard`
/// (不可解析 DID / 签名无效 → 直接拒, 不入库)。
pub fn unpack_world_card(env: &SignedEnvelope) -> Result<WorldCard, CardError> {
    if env.topic != TOPIC_WORLD_CARD {
        return Err(CardError::BadTopic(env.topic.clone()));
    }
    env.verify()
        .map_err(|e| CardError::BadEnvelope(e.to_string()))?;
    let mut card: WorldCard =
        serde_json::from_value(env.payload.clone()).map_err(|_| CardError::BadPayload)?;
    // 防伪: 卡片自称的 provider 必须与信封签名者一致 (否则是转发伪造)
    if card.provider_did != env.sender {
        return Err(CardError::ProviderMismatch);
    }
    card.verification = CardVerification::Verified;
    Ok(card)
}

// ────────────────────────── 投递策略 (两种分享路径) ──────────────────────────

/// 卡片投递方式 —— **两条路径语义严格不同, 不能互相兜底**
///
/// - `Friends`: 好友模式 (`scope=private`, **默认**)。发出去是**自动**的:
///   逐个定向投递给好友列表里的每个人, **只给好友看, 绝不进公域**。
/// - `Broadcast`: 公开模式 (`scope=public`)。广播给世界上所有节点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardDelivery {
    /// 定向: 好友 DID 列表 (已去重; **为空 = 没人收到**)
    Friends(Vec<String>),
    /// 广播: 世界所有公开节点 (目标由传输层泛洪, 不在这里枚举)
    Broadcast,
}

impl CardDelivery {
    /// "friends" | "broadcast"
    pub fn mode(&self) -> &'static str {
        match self {
            Self::Friends(_) => "friends",
            Self::Broadcast => "broadcast",
        }
    }

    /// 定向目标 (广播为空 —— 它的目标是"世界", 不是可枚举列表)
    pub fn targets(&self) -> &[String] {
        match self {
            Self::Friends(v) => v,
            Self::Broadcast => &[],
        }
    }
}

/// 按 `scope` 决定投递方式 (**纯函数**)
///
/// 纪律: private 只走好友定向, **不会因为好友列表为空就退化成广播** ——
/// "没人收到" 是如实结果, 不能为了发出去而扩权。
pub fn delivery_for(card: &WorldCard, friends: &[String]) -> CardDelivery {
    match card.scope {
        CardScope::Private => {
            let mut uniq: Vec<String> = Vec::new();
            for f in friends {
                if !f.is_empty() && !uniq.iter().any(|u| u == f) {
                    uniq.push(f.clone());
                }
            }
            CardDelivery::Friends(uniq)
        }
        CardScope::Public => CardDelivery::Broadcast,
    }
}

/// 分享一张卡片: 归一 provider → 按 scope 定投递路径 → **信封只签一次** (多路复用)
pub fn share_card(
    kp: &KeyPair,
    card: WorldCard,
    friends: &[String],
    ts_ms: u64,
) -> (SignedEnvelope, CardDelivery) {
    let card = seal_card(kp, card);
    let delivery = delivery_for(&card, friends);
    (pack_world_card(kp, &card, ts_ms), delivery)
}

/// 收卡侧闸门: **好友模式的卡片只收好友的** (非好友投递来的 private 卡 → 拒)
///
/// 与发送侧的 `delivery_for` 成对 —— 只发不给的人, 收到也照样拒, 两端都不放水。
pub fn accept_card(card: &WorldCard, friends: &[String]) -> Result<(), CardError> {
    if card.scope == CardScope::Private
        && !friends.iter().any(|f| f == &card.provider_did)
    {
        return Err(CardError::NotFriend);
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

    fn sample_card(kp: &KeyPair) -> WorldCard {
        WorldCard {
            title: "核聚变合作".into(),
            summary: "找合作方".into(),
            media: vec![CardMedia {
                kind: CardMediaKind::Text,
                url: "内容".into(),
                mime: None,
                name: None,
            }],
            cover: None,
            provider_did: kp.did.as_str().into(),
            provider_name: None,
            scope: CardScope::Private,
            issued_at_ms: 42,
            verification: CardVerification::Unverified,
        }
    }

    #[test]
    fn card_scope_tamper_breaks_signature() {
        let kp = KeyPair::generate();
        let card = sample_card(&kp);
        let sig = kp.sign(card_canonical_bytes(&card).as_bytes());
        assert!(verify_card(&card, &kp.public_bytes(), &sig).is_ok());

        // 篡改 scope → 验签必败 (防伪造公域标记)
        let mut forged = card.clone();
        forged.scope = CardScope::Public;
        assert_eq!(
            verify_card(&forged, &kp.public_bytes(), &sig).unwrap_err(),
            CardError::BadSignature
        );
    }

    /// 媒体与封面同样进签名载荷: 换封面 (把矮卡伪装成视频高卡) 验签必败
    #[test]
    fn card_cover_tamper_breaks_signature() {
        let kp = KeyPair::generate();
        let mut card = sample_card(&kp);
        card.cover = Some(CardCover { url: "ipfs://a".into(), kind: CoverKind::Image });
        let sig = kp.sign(card_canonical_bytes(&card).as_bytes());
        assert!(verify_card(&card, &kp.public_bytes(), &sig).is_ok());

        let mut forged = card.clone();
        forged.cover = Some(CardCover { url: "ipfs://evil".into(), kind: CoverKind::Video });
        assert_eq!(
            verify_card(&forged, &kp.public_bytes(), &sig).unwrap_err(),
            CardError::BadSignature
        );
    }

    /// 跨机帧往返: pack → unpack 验签通过, 并标记 verified
    #[test]
    fn world_card_frame_roundtrip() {
        let kp = KeyPair::generate();
        let mut card = sample_card(&kp);
        card.scope = CardScope::Public;
        card.media = vec![CardMedia {
            kind: CardMediaKind::Video,
            url: "ipfs://v".into(),
            mime: Some("video/mp4".into()),
            name: Some("demo.mp4".into()),
        }];
        card.cover = Some(CardCover { url: "ipfs://cover".into(), kind: CoverKind::Video });

        let env = pack_world_card(&kp, &card, 1000);
        assert_eq!(env.topic, TOPIC_WORLD_CARD, "帧主题必须是 world.card");
        let got = unpack_world_card(&env).expect("自己签的帧必须验签通过");
        assert_eq!(got.verification, CardVerification::Verified);
        assert_eq!(got.cover.expect("封面").kind, CoverKind::Video);
    }

    /// 跨机伪卡一律拒收 (**不静默降级**): 错主题 / 改正文 / provider≠发送者
    #[test]
    fn world_card_frame_rejects_forgery() {
        let kp = KeyPair::generate();
        let env = pack_world_card(&kp, &sample_card(&kp), 1000);
        assert!(unpack_world_card(&env).is_ok());

        // ① 主题不对
        let mut wrong_topic = env.clone();
        wrong_topic.topic = "group.msg".into();
        assert!(matches!(unpack_world_card(&wrong_topic), Err(CardError::BadTopic(_))));

        // ② 改正文 (塞进伪造封面) → 信封签名失效
        let mut forged = env.clone();
        forged.payload = serde_json::to_value(WorldCard {
            cover: Some(CardCover { url: "ipfs://evil".into(), kind: CoverKind::Video }),
            ..sample_card(&kp)
        })
        .unwrap();
        assert!(matches!(unpack_world_card(&forged), Err(CardError::BadEnvelope(_))));

        // ③ 卡片自称的 provider 与信封签名者不一致 → 转发伪造
        let other = KeyPair::generate();
        let mismatch = pack_world_card(&kp, &sample_card(&other), 1000);
        assert!(matches!(unpack_world_card(&mismatch), Err(CardError::ProviderMismatch)));
    }

    #[test]
    fn card_default_scope_is_private() {
        assert_eq!(CardScope::default(), CardScope::Private, "缺省必须 private");
    }

    /// 好友模式: **自动**定向给好友列表里每个人, 去重, 且不进公域
    #[test]
    fn private_card_delivers_only_to_friends() {
        let kp = KeyPair::generate();
        let mut card = sample_card(&kp);
        card.scope = CardScope::Private;
        let friends = vec!["did:pi:a".into(), "did:pi:b".into(), "did:pi:a".into()];
        let d = delivery_for(&card, &friends);
        assert_eq!(d.mode(), "friends");
        assert_eq!(
            d.targets(),
            ["did:pi:a".to_string(), "did:pi:b".to_string()],
            "去重后逐个定向, 不含公域"
        );
    }

    /// 公开模式: 广播给世界 (目标不在这里枚举)
    #[test]
    fn public_card_broadcasts_to_world() {
        let kp = KeyPair::generate();
        let mut card = sample_card(&kp);
        card.scope = CardScope::Public;
        let d = delivery_for(&card, &["did:pi:a".into()]);
        assert_eq!(d.mode(), "broadcast");
        assert!(d.targets().is_empty(), "广播目标是'世界', 不枚举好友");
    }

    /// 好友模式 + 没有好友 = 如实"没人收到", **绝不退化成广播**
    #[test]
    fn private_without_friends_delivers_to_nobody() {
        let kp = KeyPair::generate();
        let card = sample_card(&kp); // scope 默认 Private
        let d = delivery_for(&card, &[]);
        assert_eq!(d.mode(), "friends");
        assert!(d.targets().is_empty(), "不能为了发出去而扩权成广播");
    }

    /// share_card: 信封只签一次, 投递路径与 scope 一致
    #[test]
    fn share_card_keeps_scope_and_delivery_aligned() {
        let kp = KeyPair::generate();
        let mut pub_card = sample_card(&kp);
        pub_card.scope = CardScope::Public;
        let (env, d) = share_card(&kp, pub_card, &["did:pi:a".into()], 7);
        assert_eq!(d.mode(), "broadcast");
        let got = unpack_world_card(&env).expect("自己签的帧");
        assert_eq!(got.scope, CardScope::Public);
        assert_eq!(got.provider_did, kp.did.as_str());

        // 好友模式: 同一张卡换个 scope, 投递路径立刻变定向
        let mut priv_card = sample_card(&kp);
        priv_card.scope = CardScope::Private;
        let (_, d2) = share_card(&kp, priv_card, &["did:pi:a".into()], 7);
        assert_eq!(d2.mode(), "friends");
        assert_eq!(d2.targets(), ["did:pi:a".to_string()]);
    }

    /// 收卡侧: 好友模式的卡只收好友的 (发送侧不放水, 接收侧也不放水)
    #[test]
    fn accept_card_gates_private_to_friends_only() {
        let kp = KeyPair::generate();
        let friend_did = "did:pi:friend".to_string();

        let mut priv_card = sample_card(&kp);
        priv_card.scope = CardScope::Private;
        priv_card.provider_did = friend_did.clone();
        assert!(accept_card(&priv_card, &[friend_did.clone()]).is_ok(), "是好友 → 收");
        assert_eq!(
            accept_card(&priv_card, &["did:pi:other".into()]).unwrap_err(),
            CardError::NotFriend,
            "非好友投递的好友模式卡 → 拒"
        );

        // 公开卡不看好友关系 (世界可见)
        let mut pub_card = sample_card(&kp);
        pub_card.scope = CardScope::Public;
        assert!(accept_card(&pub_card, &[]).is_ok());
    }
}
