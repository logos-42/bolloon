//! profile.rs — 用户的对外内容卡 (自我介绍/可投递简历的载体)
//!
//! 这就是"创造维护的内容": agent 不是回一段话, 而是帮用户**维护**一张可反复
//! 使用的对外卡。落盘 `~/.bolloon/rust/world/profile.json` (0600)。
//!
//! 纪律:
//! - **0600 落盘** (与 identity.json 同级纪律), 目录不存在则创建
//! - **损坏如实报错** (解析失败返回 Err, 不静默回默认装作没事)
//! - `to_world_card` 只组卡不签名 — 签名在发送侧 `share_card` (信封只签一次)

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::world::{CardScope, IntentCategory, WorldCard};

/// 对外内容卡 (可维护的"关于我")
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ProfileCard {
    pub name: String,
    pub intro: String,
    #[serde(default)]
    pub interests: Vec<String>,
    pub updated_at_ms: u64,
}

/// profile store (文件路径注入, 测试用 tempdir)
#[derive(Debug, Clone)]
pub struct ProfileCardStore {
    path: PathBuf,
}

impl ProfileCardStore {
    /// 打开 store (父目录不存在则创建; 权限 0700)
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
            }
        }
        Ok(Self { path })
    }

    /// 读取 (不存在 = None; 存在但损坏 = Err, 不静默)
    pub fn load(&self) -> io::Result<Option<ProfileCard>> {
        match std::fs::read(&self.path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).map_err(|e| {
                io::Error::new(io::ErrorKind::InvalidData, format!("profile 损坏: {e}"))
            })?)),
        }
    }

    /// 保存 (0600, 先写临时文件再改名 = 原子落盘)
    pub fn save(&self, card: &ProfileCard) -> io::Result<()> {
        let json = serde_json::to_vec_pretty(card)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        let tmp = self.path.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(&json)?;
            f.sync_all()?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, &self.path)
    }

    /// 更新 (load → 改 → save 的唯一入口, updated_at 必须推进)
    pub fn update(&self, now_ms: u64, f: impl FnOnce(&mut ProfileCard)) -> io::Result<ProfileCard> {
        let mut card = self.load()?.unwrap_or_default();
        f(&mut card);
        card.updated_at_ms = now_ms;
        self.save(&card)?;
        Ok(card)
    }
}

/// profile → 世界卡 (scope 默认 Private; category 按用途; 兴趣做匹配标签)
pub fn to_world_card(
    p: &ProfileCard,
    provider_did: &str,
    category: IntentCategory,
    now_ms: u64,
) -> WorldCard {
    WorldCard {
        title: format!("关于 {}", p.name),
        summary: p.intro.clone(),
        media: vec![],
        cover: None,
        provider_did: provider_did.into(),
        provider_name: None,
        scope: CardScope::Private,
        issued_at_ms: now_ms,
        verification: crate::world::CardVerification::Verified,
        category: Some(category),
        tags: p.interests.clone(),
        actions: vec![],
        reply_to: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bolloon-profile-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn roundtrip_and_update() {
        let dir = tmpdir("roundtrip");
        let store = ProfileCardStore::open(dir.join("world").join("profile.json")).unwrap();
        assert!(store.load().unwrap().is_none(), "空 store = None, 不冒充有数据");

        let card = store
            .update(42, |p| {
                p.name = "小李".into();
                p.intro = "爱爬山".into();
                p.interests = vec!["爬山".into()];
            })
            .unwrap();
        assert_eq!(card.updated_at_ms, 42);
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded.name, "小李");
        assert_eq!(loaded.interests, vec!["爬山".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmpdir("perm");
        let store = ProfileCardStore::open(dir.join("profile.json")).unwrap();
        store
            .save(&ProfileCard { name: "a".into(), intro: "b".into(), interests: vec![], updated_at_ms: 1 })
            .unwrap();
        let mode = std::fs::metadata(dir.join("profile.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "profile 落盘必须 0600");
    }

    #[test]
    fn corrupted_file_is_reported_not_swallowed() {
        let dir = tmpdir("corrupt");
        let store = ProfileCardStore::open(dir.join("profile.json")).unwrap();
        std::fs::write(dir.join("profile.json"), b"{ not json").unwrap();
        assert!(store.load().is_err(), "损坏必须如实报错");
    }

    #[test]
    fn to_world_card_carries_interests_and_category() {
        let p = ProfileCard {
            name: "小李".into(),
            intro: "爱爬山".into(),
            interests: vec!["爬山".into()],
            updated_at_ms: 7,
        };
        let card = to_world_card(&p, "did:pi:me", IntentCategory::Social, 42);
        assert_eq!(card.title, "关于 小李");
        assert_eq!(card.category, Some(IntentCategory::Social));
        assert_eq!(card.tags, vec!["爬山".to_string()]);
        assert_eq!(card.scope, CardScope::Private);
    }
}
