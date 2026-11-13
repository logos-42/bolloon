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

/// 意图场景类别 (场景泛化的第一层; 由 `classify_intent` 词表分类, 未来可接 LLM 增强)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum IntentCategory {
    Food,
    Work,
    Social,
    Learn,
    Trade,
    Travel,
    #[default]
    Other,
}

impl IntentCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Food => "food",
            Self::Work => "work",
            Self::Social => "social",
            Self::Learn => "learn",
            Self::Trade => "trade",
            Self::Travel => "travel",
            Self::Other => "other",
        }
    }

    /// 只认 canonical snake_case (别名归一在 `classify_intent` 里做)
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "food" => Self::Food,
            "work" => Self::Work,
            "social" => Self::Social,
            "learn" => Self::Learn,
            "trade" => Self::Trade,
            "travel" => Self::Travel,
            "other" => Self::Other,
            _ => return None,
        })
    }
}

/// 用户想要的交付形态 (决定差距检测走哪条补能力路径)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum WantKind {
    Links,
    Info,
    People,
    Companion,
    #[default]
    Service,
}

/// 意图清晰度 (Vague ⇒ 交付时必须附一个澄清问题, 不许沉默也不许瞎猜)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum Clarity {
    Clear,
    #[default]
    Vague,
}

/// 场景词表 (中文 + 英文别名; 新场景 = 加词条, 不改主链路)
const CATEGORY_TABLE: &[(&str, IntentCategory)] = &[
    ("吃饭", IntentCategory::Food),
    ("吃", IntentCategory::Food),
    ("餐", IntentCategory::Food),
    ("外卖", IntentCategory::Food),
    ("食堂", IntentCategory::Food),
    ("饿了", IntentCategory::Food),
    ("美食", IntentCategory::Food),
    ("菜", IntentCategory::Food),
    ("工作", IntentCategory::Work),
    ("求职", IntentCategory::Work),
    ("招聘", IntentCategory::Work),
    ("简历", IntentCategory::Work),
    ("面试", IntentCategory::Work),
    ("上班", IntentCategory::Work),
    ("职位", IntentCategory::Work),
    ("岗位", IntentCategory::Work),
    ("兼职", IntentCategory::Work),
    ("job", IntentCategory::Work),
    ("hiring", IntentCategory::Work),
    ("朋友", IntentCategory::Social),
    ("交友", IntentCategory::Social),
    ("搭子", IntentCategory::Social),
    ("社交", IntentCategory::Social),
    ("认识", IntentCategory::Social),
    ("俱乐部", IntentCategory::Social),
    ("friend", IntentCategory::Social),
    ("学习", IntentCategory::Learn),
    ("课程", IntentCategory::Learn),
    ("教程", IntentCategory::Learn),
    ("考试", IntentCategory::Learn),
    ("论文", IntentCategory::Learn),
    ("培训", IntentCategory::Learn),
    ("learn", IntentCategory::Learn),
    ("买", IntentCategory::Trade),
    ("卖", IntentCategory::Trade),
    ("交易", IntentCategory::Trade),
    ("二手", IntentCategory::Trade),
    ("订单", IntentCategory::Trade),
    ("buy", IntentCategory::Trade),
    ("旅行", IntentCategory::Travel),
    ("旅游", IntentCategory::Travel),
    ("出行", IntentCategory::Travel),
    ("机票", IntentCategory::Travel),
    ("酒店", IntentCategory::Travel),
    ("travel", IntentCategory::Travel),
];

/// 分类产物 (matched 留给 reason/透明打分)
#[derive(Debug, Clone, PartialEq)]
pub struct ClassifiedIntent {
    pub category: IntentCategory,
    pub want: WantKind,
    pub clarity: Clarity,
    pub matched: Vec<&'static str>,
}

/// 意图分类 (纯函数, 词表兜底; LLM 增强走 bolloon-llm 咽喉由调用方可选叠加)
///
/// - category: 场景词表命中 (英文名词做 ASCII 小写匹配); 无命中 = Other
/// - want: 类别默认交付形态 (Food/Trade/Travel→Links, Work→Links, Learn→Info,
///   Social→People; Other→Info)
/// - clarity: Other (不知场景) 或文本 ≤ 8 字 (细节不足) = Vague, 否则 Clear
pub fn classify_intent(text: &str) -> ClassifiedIntent {
    let lower = text.to_lowercase();
    let mut matched: Vec<&'static str> = Vec::new();
    let mut category = IntentCategory::Other;
    for (kw, cat) in CATEGORY_TABLE {
        let hit = if kw.is_ascii() {
            lower.contains(kw)
        } else {
            text.contains(kw)
        };
        if hit {
            if !matched.iter().any(|m| *m == *kw) {
                matched.push(kw);
            }
            if category == IntentCategory::Other {
                category = *cat;
            }
        }
    }
    let want = match category {
        IntentCategory::Social => WantKind::People,
        IntentCategory::Learn => WantKind::Info,
        IntentCategory::Other => WantKind::Info,
        _ => WantKind::Links,
    };
    let vague_chars = text.chars().count() <= 8;
    let clarity = if category == IntentCategory::Other || vague_chars {
        Clarity::Vague
    } else {
        Clarity::Clear
    };
    ClassifiedIntent { category, want, clarity, matched }
}

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
    /// 场景类别 (serde default: Other — 旧落盘数据照常解)
    #[serde(default)]
    pub category: IntentCategory,
    /// 想要的交付形态 (serde default: Service)
    #[serde(default)]
    pub want: WantKind,
    /// 清晰度 (serde default: Vague)
    #[serde(default)]
    pub clarity: Clarity,
}

/// 卡片媒体类型 (enum 化, 对齐 TS `CardMediaType`)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum CardMediaKind {
    #[default]
    Text,
    Audio,
    Image,
    Video,
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
#[derive(Default)]
pub enum CardVerification {
    Verified,
    SignatureInvalid,
    #[default]
    Unverified,
}


/// 行动类型 (行动链接与 media 的内容 URL 语义不同: media=看, action=做)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ActionKind {
    #[default]
    Link,
    Join,
    Contact,
}

/// 行动链接 (交付物卡片的"下一步"语义: label 展示 / url 跳转 / kind 语义)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CardAction {
    pub label: String,
    pub url: String,
    #[serde(default)]
    pub kind: ActionKind,
}

/// 内容分级 (2026-11-13 青少年模式)：默认 General；Mature 在青少年模式下被过滤。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContentRating {
    /// 全年龄段
    #[default]
    General,
    /// 成人/限制级（色情、赌博、暴力、毒品、武器、血腥等）
    Mature,
}

/// 青少年模式词表（中英文）：命中即判为成人级。
/// 这是服务端兜底，不依赖 AI 自觉打标；词表可后续扩充。
fn mature_keywords() -> &'static [&'static str] {
    &[
        "色情", "性爱", "裸", "成人", "18禁", "黄", "约炮", "援交",
        "赌博", "赌场", "博彩", "彩票", "赌球",
        "暴力", "血腥", "凶杀", "武器", "枪支", "军火",
        "毒品", "吸毒", "毒品", "冰毒", "大麻", "摇头丸",
        "porn", "nsfw", "xxx", "sex", "nude", "adult", "erotic",
        "gambling", "casino", "bet", "violence", "drug", "weapon",
    ]
}

/// 根据标题/摘要/标签自动判定分级（服务端兜底层）。
pub fn auto_rate(title: &str, summary: &str, tags: &[String]) -> ContentRating {
    let hay = format!("{} {} {}", title, summary, tags.join(" ")).to_lowercase();
    if mature_keywords().iter().any(|k| hay.contains(&k.to_lowercase())) {
        ContentRating::Mature
    } else {
        ContentRating::General
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
    /// 场景类别 (参与意图匹配; None = 不声明)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<IntentCategory>,
    /// 匹配标签 (serde default: 空 — 旧帧照常解; 缺省不进签名载荷, 新旧互通)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// 行动链接 (serde default: 空; 缺省不进签名载荷, 新旧互通)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<CardAction>,
    /// 回应哪条意图 (intent id; 缺省不进签名载荷, 新旧互通)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// 内容分级 (2026-11-13 青少年模式)：None = 未声明（按 General 处理，且不进签名载荷，
    /// 旧帧照常解）。None 在落库/分发时会被 auto_rate 兜底补全。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_rating: Option<ContentRating>,
}

/// 取卡片的生效分级：显式声明优先，否则按内容自动判定（服务端兜底）。
pub fn effective_rating(card: &WorldCard) -> ContentRating {
    card.content_rating.unwrap_or_else(|| auto_rate(&card.title, &card.summary, &card.tags))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum CardScope {
    #[default]
    Private,
    Public,
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
    /// 回应哪条意图 (交付物/匹配卡有, 默认流没有)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_id: Option<String>,
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

/// 场景打分 (透明): 基础标签分 + 类别一致性加成/减分, 收敛 [0.0, 1.0]
///
/// - 意图没分类 (Other) 或无标签 → 纯基础分, 不做类别加减
/// - 卡片声明了同类 category → +0.15 (reason 加 `+cat`)
/// - 声明了异类 category → -0.10 (reason 加 `-cat`)
/// - 卡片未声明 category → 纯基础分
pub fn score_with_category(
    opp_tags: &[String],
    opp_category: Option<IntentCategory>,
    intent: &Intent,
) -> (f64, String) {
    let (base, reason) = score_opportunity(opp_tags, &intent.tags);
    if intent.category == IntentCategory::Other || intent.tags.is_empty() {
        return (base, reason);
    }
    match opp_category {
        Some(c) if c == intent.category => {
            ((base + 0.15).clamp(0.0, 1.0), format!("{reason}+cat:{}", c.as_str()))
        }
        Some(c) => ((base - 0.10).clamp(0.0, 1.0), format!("{reason}-cat:{}", c.as_str())),
        None => (base, reason),
    }
}

/// 世界卡片签名 (防伪: scope / media / cover / category / tags / actions / reply_to
/// 全进签名载荷, 改任一验签必败; 全缺省时序列化形状与旧版逐字节一致 ⇒ 新旧互通)
#[derive(serde::Serialize)]
struct CardUnsigned<'a> {
    title: &'a str,
    summary: &'a str,
    media: &'a [CardMedia],
    cover: &'a Option<CardCover>,
    provider_did: &'a str,
    scope: CardScope,
    issued_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: &'a Option<IntentCategory>,
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    tags: &'a [String],
    #[serde(skip_serializing_if = "<[CardAction]>::is_empty")]
    actions: &'a [CardAction],
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_to: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_rating: &'a Option<ContentRating>,
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
        category: &card.category,
        tags: &card.tags,
        actions: &card.actions,
        reply_to: &card.reply_to,
        content_rating: &card.content_rating,
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
            intent_id: None,
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
            category: None,
            tags: vec![],
            actions: vec![],
            reply_to: None,
            content_rating: None,
        }
    }

    fn intent_of(text: &str) -> Intent {
        let c = classify_intent(text);
        Intent {
            id: "intent-1".into(),
            text: text.into(),
            tags: vec![text.into()],
            active: true,
            created_at_ms: 1,
            category: c.category,
            want: c.want,
            clarity: c.clarity,
        }
    }

    #[test]
    fn classify_food_work_social() {
        // 吃饭: 场景=food / 想要链接 / 短句=Vague (必须附澄清问题, 不许沉默)
        let c = classify_intent("我想吃饭");
        assert_eq!(c.category, IntentCategory::Food);
        assert_eq!(c.want, WantKind::Links);
        assert_eq!(c.clarity, Clarity::Vague);

        // 找工作: 场景=work / 细节足=Clear
        let c2 = classify_intent("我在杭州找后端开发的工作");
        assert_eq!(c2.category, IntentCategory::Work);
        assert_eq!(c2.clarity, Clarity::Clear);

        // 找朋友: 场景=social / 想要人
        let c3 = classify_intent("想认识一些爬山的朋友");
        assert_eq!(c3.category, IntentCategory::Social);
        assert_eq!(c3.want, WantKind::People);

        // 不认识的话 → Other + Vague (不瞎猜场景)
        let c4 = classify_intent("可控核聚变 合作");
        assert_eq!(c4.category, IntentCategory::Other);
        assert_eq!(c4.clarity, Clarity::Vague);

        // 英文别名 (ASCII 小写匹配)
        let c5 = classify_intent("find a job inHangzhou");
        assert_eq!(c5.category, IntentCategory::Work);
    }

    #[test]
    fn card_action_tamper_breaks_signature() {
        let kp = KeyPair::generate();
        let mut card = sample_card(&kp);
        card.category = Some(IntentCategory::Food);
        card.tags = vec!["食堂".into()];
        card.actions = vec![CardAction {
            label: "查看地图".into(),
            url: "https://maps.example.com/x".into(),
            kind: ActionKind::Link,
        }];
        card.reply_to = Some("intent-1".into());
        let sig = kp.sign(card_canonical_bytes(&card).as_bytes());
        assert!(verify_card(&card, &kp.public_bytes(), &sig).is_ok());

        // 篡改行动链接 (钓鱼) → 验签必败
        let mut forged = card.clone();
        forged.actions[0].url = "https://evil.example.com".into();
        assert_eq!(
            verify_card(&forged, &kp.public_bytes(), &sig).unwrap_err(),
            CardError::BadSignature
        );

        // 篡改 reply_to (冒充回应别的意图) → 验签必败
        let mut forged2 = card.clone();
        forged2.reply_to = Some("intent-999".into());
        assert_eq!(
            verify_card(&forged2, &kp.public_bytes(), &sig).unwrap_err(),
            CardError::BadSignature
        );
    }

    /// 新增字段全缺省时 canonical 形状与旧版一致 (新旧帧互通; 有值才进签名)
    #[test]
    fn card_default_fields_keep_canonical_compatible() {
        let kp = KeyPair::generate();
        let old_shape = WorldCard {
            category: None,
            tags: vec![],
            actions: vec![],
            reply_to: None,
            ..sample_card(&kp)
        };
        let sig = kp.sign(card_canonical_bytes(&old_shape).as_bytes());
        assert!(verify_card(&old_shape, &kp.public_bytes(), &sig).is_ok());

        // 跨机帧往返: 新字段缺省的卡 pack → unpack 照常 verified
        let env = pack_world_card(&kp, &old_shape, 1000);
        let got = unpack_world_card(&env).expect("缺省新字段的旧形卡必须照常收");
        assert!(got.actions.is_empty());
        assert_eq!(got.verification, CardVerification::Verified);
    }

    #[test]
    fn category_scoring_transparent() {
        // 同类 +0.15, 异类 -0.10, 未声明不动, 未分类意图不动
        let mut intent = intent_of("我在杭州找后端开发的工作"); // work / Clear
        intent.tags = vec!["工作".into(), "杭州".into()]; // 2 个标签只中 1 个 → base 0.75 (不被 clamp 吃掉)
        let tags = vec!["工作".to_string()];
        let (base, base_r) = score_opportunity(&tags, &intent.tags);
        assert!((base - 0.75).abs() < 1e-9, "base 应为 0.75, 实际 {base}");

        let (s_same, r_same) = score_with_category(&tags, Some(IntentCategory::Work), &intent);
        assert!((s_same - 0.90).abs() < 1e-9, "0.75 + 0.15 = 0.90");
        assert!(r_same.ends_with("+cat:work"));

        let (s_diff, r_diff) = score_with_category(&tags, Some(IntentCategory::Food), &intent);
        assert!((s_diff - 0.65).abs() < 1e-9, "0.75 - 0.10 = 0.65");
        assert!(r_diff.ends_with("-cat:food"));

        let (s_none, r_none) = score_with_category(&tags, None, &intent);
        assert!((s_none - base).abs() < 1e-9);
        assert_eq!(r_none, base_r);

        // 收敛: 1.0 封顶
        intent.tags = vec!["工作".into(), "杭州".into(), "后端".into(), "开发".into()];
        let (s_top, _) = score_with_category(&[], Some(IntentCategory::Work), &intent);
        assert!(s_top <= 1.0);
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
        assert!(accept_card(&priv_card, std::slice::from_ref(&friend_did)).is_ok(), "是好友 → 收");
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
