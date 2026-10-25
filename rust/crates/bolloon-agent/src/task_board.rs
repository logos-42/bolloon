//! 任务协议公告板 (`bolloon-task/1`) — 对外发任务 / 接单
//!
//! 对齐 TS 版 task-board.ts 纪律:
//! - 公告正文 + DID 签名, announcementId 由 (capability+digest+issuer+budget) 派生 → 稳定
//! - 重复 publish 同内容 → dup=true 不覆盖既有事实
//! - claim: 重复认领 / 已过期 / 不存在 / 签名无效 → 一律拒并给原因
//! - 认领不执行不付款不标 verified (群消息不替代结算)

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use bolloon_p2p::identity::KeyPair;

/// 协议名 (冻结, 对齐 TS `bolloon-task/1`)
pub const TASK_PROTOCOL: &str = "bolloon-task/1";

/// 任务公告
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Announcement {
    pub protocol: String,
    pub id: String,
    pub capability: String,
    /// 任务正文摘要 (正文不出本机时的 60 字预览语义)
    pub digest: String,
    /// 预算 (原子单位字符串, 不做浮点)
    pub budget: String,
    /// 买方 DID
    pub issuer: String,
    /// 截止 (epoch 毫秒; None = 不过期)
    pub deadline_ms: Option<u64>,
    pub issued_at_ms: u64,
    /// Ed25519 签名 (对 canonical 公告字节)
    pub signature: String,
}

/// 认领声明
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Claim {
    pub protocol: String,
    pub announcement_id: String,
    /// 认领者 DID
    pub claimer: String,
    /// 声明价格 (原子单位字符串; 未声明 = None)
    pub price: Option<String>,
    pub claimed_at_ms: u64,
    pub signature: String,
}

/// 公告板
#[derive(Debug, Default)]
pub struct TaskBoard {
    announcements: Vec<Announcement>,
    claims: Vec<Claim>,
}

/// 认领错误 (拒单原因)
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ClaimError {
    #[error("公告不存在")]
    NotFound,
    #[error("公告已过期")]
    Expired,
    #[error("已有人认领 (认领者: {0})")]
    AlreadyClaimed(String),
    #[error("同一认领者不能重复认领")]
    DuplicateClaim,
    #[error("签名无效")]
    BadSignature,
}

impl TaskBoard {
    pub fn new() -> Self {
        Self::default()
    }

    /// 发布公告 (签名 + 稳定 id + 同内容去重)
    pub fn publish(
        &mut self,
        kp: &KeyPair,
        capability: &str,
        digest: &str,
        budget: &str,
        deadline_ms: Option<u64>,
        now_ms: u64,
    ) -> (String, bool) {
        let id = derive_announcement_id(capability, digest, kp.did.as_str(), budget);
        if let Some(existing) = self.announcements.iter().find(|a| a.id == id) {
            return (existing.id.clone(), true); // dup, 不覆盖
        }
        let unsigned = UnsignedAnnouncement {
            protocol: TASK_PROTOCOL,
            id: &id,
            capability,
            digest,
            budget,
            issuer: kp.did.as_str(),
            deadline_ms,
            issued_at_ms: now_ms,
        };
        let sig = kp.sign(&canonical_bytes(&unsigned));
        let ann = Announcement {
            protocol: TASK_PROTOCOL.to_string(),
            id,
            capability: capability.to_string(),
            digest: digest.to_string(),
            budget: budget.to_string(),
            issuer: kp.did.as_str().to_string(),
            deadline_ms,
            issued_at_ms: now_ms,
            signature: bs58::encode(sig).into_string(),
        };
        self.announcements.push(ann);
        (self.announcements.last().unwrap().id.clone(), false)
    }

    /// 看板 (可选按能力过滤; 可含已认领)
    pub fn board(&self, capability: Option<&str>) -> Vec<&Announcement> {
        self.announcements
            .iter()
            .filter(|a| capability.map(|c| a.capability == c).unwrap_or(true))
            .collect()
    }

    /// 认领：签名 + 全部守卫 (不存在/过期/被抢/重复)
    pub fn claim(
        &mut self,
        kp: &KeyPair,
        announcement_id: &str,
        price: Option<&str>,
        now_ms: u64,
    ) -> Result<Claim, ClaimError> {
        let ann = self
            .announcements
            .iter()
            .find(|a| a.id == announcement_id)
            .ok_or(ClaimError::NotFound)?;

        // 过期
        if let Some(dl) = ann.deadline_ms {
            if now_ms > dl {
                return Err(ClaimError::Expired);
            }
        }
        // 已被别人认领
        if let Some(existing) = self.claims.iter().find(|c| c.announcement_id == announcement_id) {
            if existing.claimer == kp.did.as_str() {
                return Err(ClaimError::DuplicateClaim);
            }
            return Err(ClaimError::AlreadyClaimed(existing.claimer.clone()));
        }

        let unsigned = UnsignedClaim {
            protocol: TASK_PROTOCOL,
            announcement_id,
            claimer: kp.did.as_str(),
            price,
            claimed_at_ms: now_ms,
        };
        let sig = kp.sign(&canonical_bytes(&unsigned));
        let claim = Claim {
            protocol: TASK_PROTOCOL.to_string(),
            announcement_id: announcement_id.to_string(),
            claimer: kp.did.as_str().to_string(),
            price: price.map(|p| p.to_string()),
            claimed_at_ms: now_ms,
            signature: bs58::encode(sig).into_string(),
        };
        self.claims.push(claim.clone());
        Ok(claim)
    }

    /// 某公告的认领者 (无则 None)
    pub fn claimer_of(&self, announcement_id: &str) -> Option<&str> {
        self.claims
            .iter()
            .find(|c| c.announcement_id == announcement_id)
            .map(|c| c.claimer.as_str())
    }

    /// 快照 (持久化用)
    pub fn snapshot(&self) -> (Vec<Announcement>, Vec<Claim>) {
        (self.announcements.clone(), self.claims.clone())
    }

    /// 从快照恢复
    pub fn from_parts(announcements: Vec<Announcement>, claims: Vec<Claim>) -> Self {
        Self { announcements, claims }
    }

    /// JSON 文件加载 (与 CLI/Web 共用同一份落盘; 坏文件从空板开始)
    pub fn load_json(path: &std::path::Path) -> Self {
        #[derive(serde::Serialize, serde::Deserialize, Default)]
        struct Dump {
            announcements: Vec<Announcement>,
            claims: Vec<Claim>,
        }
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Dump>(&raw).ok())
            .map(|d| Self::from_parts(d.announcements, d.claims))
            .unwrap_or_default()
    }

    /// JSON 文件保存
    pub fn save_json(&self, path: &std::path::Path) -> std::io::Result<()> {
        #[derive(serde::Serialize)]
        struct Dump<'a> {
            announcements: &'a [Announcement],
            claims: &'a [Claim],
        }
        let (announcements, claims) = self.snapshot();
        let raw = serde_json::to_string_pretty(&Dump { announcements: &announcements, claims: &claims })
            .expect("task board serialize");
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, raw)
    }

    /// 验证一条公告签名 (外部收到的公告也能验)
    pub fn verify_announcement(ann: &Announcement) -> Result<(), ClaimError> {
        if ann.protocol != TASK_PROTOCOL {
            return Err(ClaimError::BadSignature);
        }
        // id 必须能复算
        let derived = derive_announcement_id(&ann.capability, &ann.digest, &ann.issuer, &ann.budget);
        if derived != ann.id {
            return Err(ClaimError::BadSignature);
        }
        let unsigned = UnsignedAnnouncement {
            protocol: &ann.protocol,
            id: &ann.id,
            capability: &ann.capability,
            digest: &ann.digest,
            budget: &ann.budget,
            issuer: &ann.issuer,
            deadline_ms: ann.deadline_ms,
            issued_at_ms: ann.issued_at_ms,
        };
        verify_sig(&ann.issuer, &unsigned, &ann.signature)
    }
}

#[derive(Serialize)]
struct UnsignedAnnouncement<'a> {
    protocol: &'a str,
    id: &'a str,
    capability: &'a str,
    digest: &'a str,
    budget: &'a str,
    issuer: &'a str,
    deadline_ms: Option<u64>,
    issued_at_ms: u64,
}

#[derive(Serialize)]
struct UnsignedClaim<'a> {
    protocol: &'a str,
    announcement_id: &'a str,
    claimer: &'a str,
    price: Option<&'a str>,
    claimed_at_ms: u64,
}

/// announcementId = sha256(capability ‖ digest ‖ issuer ‖ budget) 前 16 hex
fn derive_announcement_id(capability: &str, digest: &str, issuer: &str, budget: &str) -> String {
    let mut h = Sha256::new();
    h.update(capability.as_bytes());
    h.update(b"\x00");
    h.update(digest.as_bytes());
    h.update(b"\x00");
    h.update(issuer.as_bytes());
    h.update(b"\x00");
    h.update(budget.as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

/// canonical 字节 = 键排序 + 无空格 (与 p2p::envelope 同语义)
fn canonical_bytes(v: &impl Serialize) -> Vec<u8> {
    let val = serde_json::to_value(v).expect("serialize");
    let mut out = String::new();
    write_canonical(&val, &mut out);
    out.into_bytes()
}

fn write_canonical(v: &serde_json::Value, out: &mut String) {
    match v {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap());
                out.push(':');
                write_canonical(&map[*k], out);
            }
            out.push('}');
        }
        serde_json::Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).unwrap()),
    }
}

fn verify_sig(issuer_did: &str, unsigned: &impl Serialize, sig_b58: &str) -> Result<(), ClaimError> {
    use bolloon_p2p::identity::Did;
    // DID 后缀 = pubkey b58
    let pk_b58 = issuer_did
        .strip_prefix("did:pi:")
        .ok_or(ClaimError::BadSignature)?;
    let raw = bs58::decode(pk_b58)
        .into_vec()
        .map_err(|_| ClaimError::BadSignature)?;
    let pk: [u8; 32] = raw.try_into().map_err(|_| ClaimError::BadSignature)?;
    let sig_raw = bs58::decode(sig_b58)
        .into_vec()
        .map_err(|_| ClaimError::BadSignature)?;
    let sig: [u8; 64] = sig_raw.try_into().map_err(|_| ClaimError::BadSignature)?;
    if !KeyPair::verify(&pk, &canonical_bytes(unsigned), &sig) {
        return Err(ClaimError::BadSignature);
    }
    let _ = Did::new(issuer_did);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kp(seed: u8) -> KeyPair {
        let mut s = [0u8; 32];
        s[0] = seed;
        KeyPair::from_seed(&s)
    }

    #[test]
    fn publish_claim_roundtrip() {
        let mut board = TaskBoard::new();
        let buyer = kp(1);
        let worker = kp(2);
        let (id, dup) = board.publish(&buyer, "research", "核聚变口径复核", "1000", None, 100);
        assert!(!dup);
        assert_eq!(id.len(), 16);

        let claim = board.claim(&worker, &id, Some("900"), 150).unwrap();
        assert_eq!(claim.claimer, worker.did.as_str());
        assert_eq!(board.claimer_of(&id), Some(worker.did.as_str()));
    }

    #[test]
    fn duplicate_publish_is_dup_not_overwrite() {
        let mut board = TaskBoard::new();
        let buyer = kp(1);
        let (id1, dup1) = board.publish(&buyer, "cap", "d", "5", None, 100);
        let (id2, dup2) = board.publish(&buyer, "cap", "d", "5", None, 200);
        assert!(!dup1);
        assert!(dup2);
        assert_eq!(id1, id2, "同内容必须派生同一 id");
        assert_eq!(board.announcements.len(), 1, "不覆盖既有事实");
    }

    #[test]
    fn double_claim_rejected() {
        let mut board = TaskBoard::new();
        let buyer = kp(1);
        let (id, _) = board.publish(&buyer, "cap", "d", "5", None, 100);
        let w1 = kp(2);
        let w2 = kp(3);
        board.claim(&w1, &id, None, 110).unwrap();
        let err = board.claim(&w2, &id, None, 120).unwrap_err();
        assert!(matches!(err, ClaimError::AlreadyClaimed(_)));
        // 同一认领者重复认领
        let err2 = board.claim(&w1, &id, None, 130).unwrap_err();
        assert_eq!(err2, ClaimError::DuplicateClaim);
    }

    #[test]
    fn expired_claim_rejected() {
        let mut board = TaskBoard::new();
        let buyer = kp(1);
        let (id, _) = board.publish(&buyer, "cap", "d", "5", Some(100), 50);
        let w = kp(2);
        let err = board.claim(&w, &id, None, 101).unwrap_err();
        assert_eq!(err, ClaimError::Expired);
    }

    #[test]
    fn unknown_announcement_rejected() {
        let mut board = TaskBoard::new();
        let w = kp(2);
        let err = board.claim(&w, "deadbeefdeadbeef", None, 100).unwrap_err();
        assert_eq!(err, ClaimError::NotFound);
    }

    #[test]
    fn verify_announcement_detects_tamper() {
        let mut board = TaskBoard::new();
        let buyer = kp(1);
        let (id, _) = board.publish(&buyer, "cap", "d", "5", None, 100);
        let ann = board.board(None)[0].clone();
        assert!(TaskBoard::verify_announcement(&ann).is_ok());

        let mut tampered = ann.clone();
        tampered.budget = "9999".into();
        tampered.id = id;
        assert!(TaskBoard::verify_announcement(&tampered).is_err(), "改预算必须验签失败");
    }

    #[test]
    fn id_changes_with_content() {
        let buyer = kp(1);
        let (a, _) = TaskBoard::new().publish(&buyer, "cap", "d1", "5", None, 100);
        let (b, _) = TaskBoard::new().publish(&buyer, "cap", "d2", "5", None, 100);
        assert_ne!(a, b);
    }
}
