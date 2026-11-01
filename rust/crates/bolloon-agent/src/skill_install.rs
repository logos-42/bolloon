//! skill_install.rs — 技能安装源登记面 + 验真安装 (Install 路径的真执行)
//!
//! 纪律 (对齐 executable-resource-protocol):
//! - **登记面**: `~/.bolloon/rust/skills/registry.json` 登记可安装技能
//!   `{name, description, url, sha256, categories}` — 来源可信是登记的事, 不是装的事
//! - **验真才装**: 下载正文后 sha256 必须等于登记值; 登记条目没有 sha256 = 未验真 = **拒装**
//! - **批准门**: 安装走 `SkillEvolver::promote` 唯一入库口 (用户发起 install = 批准语义),
//!   `source_run = "install:<url>"` 留证据回查
//! - **诚实失败**: 无登记源 / 哈希不符 / 超长 / 重复 / 同名, 全部如实报, 不假装修好

use sha2::{Digest, Sha256};

use crate::skills_runtime::{SkillCandidate, SkillEvolver, SKILL_BODY_MAX};
use crate::world::IntentCategory;

/// 登记条目 (一条 = 一个可安装技能)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct SkillSourceEntry {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// 技能正文 (markdown) 的 http(s) 地址
    pub url: String,
    /// 正文 sha256 (hex) — **必填语义**: 没有就不许装 (未验真)
    #[serde(default)]
    pub sha256: String,
    /// 适用的意图类别 (food/work/social/learn/trade/travel/other; 空 = 任意)
    #[serde(default)]
    pub categories: Vec<String>,
}

/// 安装源注册表 (落盘 `skills/registry.json`; 与 skills.json 分开 — 源是源, 装好的是装好的)
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SkillSourceRegistry {
    #[serde(default)]
    pub entries: Vec<SkillSourceEntry>,
}

impl SkillSourceRegistry {
    /// 载入 (不存在/坏文件 = 空登记面, 如实 — 不装就是了, 不报错炸端点)
    pub fn load(path: &std::path::Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &std::path::Path) -> std::io::Result<()> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)
    }

    /// 按意图类别找可安装技能 (categories 精确匹配优先; 无则退回名字含类别词)
    pub fn find_for_category(&self, category: IntentCategory) -> Option<&SkillSourceEntry> {
        let cat = category.as_str();
        self.entries
            .iter()
            .find(|e| e.categories.iter().any(|c| c == cat))
            .or_else(|| {
                self.entries
                    .iter()
                    .find(|e| e.name.contains(cat) && e.categories.is_empty())
            })
    }
}

/// 安装错误 (全部如实人话)
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum InstallError {
    #[error("登记面没有这个类别的可安装技能")]
    NotFound,
    #[error("登记条目缺 sha256 — 未验真的来源不许装")]
    Unverified,
    #[error("正文 sha256 不符 (登记 {expected}, 实算 {actual}) — 来源被篡改, 拒装")]
    BadDigest { expected: String, actual: String },
    #[error("正文超长 (>{0} 字符) — skill 是方法不是论文")]
    TooLong(usize),
    #[error("与既有 skill 重复 (内容哈希相同)")]
    Duplicate,
    #[error("skill 已存在同名")]
    NameExists,
    #[error("空内容")]
    Empty,
    #[error("URL 非 http(s): {0}")]
    BadUrl(String),
}

fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// 从 web_fetch 的输出里剥出**原始正文** (验真对象必须是原始字节, 不是装饰过的展示文本)
///
/// 输出形状: `[已抓取] {url} ({content_type})[截断注]\n\n{正文}`
/// - 正文被截断 ⇒ 返回 None (截断后的哈希必然对不上, 与其 BadDigest 不如如实说截断)
/// - 形状不对 (非 web_fetch 输出) ⇒ None, 调用方如实报"下载结果不可用"
pub fn parse_fetch_output(output: &str) -> Option<&str> {
    let rest = output.strip_prefix("[已抓取] ")?;
    let header_end = rest.find("\n\n")?;
    let header = &rest[..header_end];
    if header.contains("[截断:") {
        return None;
    }
    Some(rest[header_end + 2..].trim_start())
}

/// 验真 (纯函数): URL 形状 + 哈希一致 + 长度上限
pub fn verify_body(entry: &SkillSourceEntry, body: &str) -> Result<(), InstallError> {
    if !entry.url.starts_with("http://") && !entry.url.starts_with("https://") {
        return Err(InstallError::BadUrl(entry.url.clone()));
    }
    if entry.sha256.trim().is_empty() {
        return Err(InstallError::Unverified);
    }
    if body.trim().is_empty() {
        return Err(InstallError::Empty);
    }
    let actual = sha256_hex(body);
    if actual != entry.sha256.trim().to_lowercase() {
        return Err(InstallError::BadDigest {
            expected: entry.sha256.trim().to_lowercase(),
            actual,
        });
    }
    if body.chars().count() > SKILL_BODY_MAX {
        return Err(InstallError::TooLong(body.chars().count()));
    }
    Ok(())
}

/// 装入 (验真 → 走 promote 批准门; source_run 留 URL 证据)
pub fn apply_install(
    evolver: &mut SkillEvolver,
    entry: &SkillSourceEntry,
    body: &str,
    now_ms: u64,
) -> Result<(), InstallError> {
    verify_body(entry, body)?;
    let cand = SkillCandidate {
        name: entry.name.clone(),
        description: if entry.description.is_empty() {
            body.lines().next().unwrap_or_default().chars().take(60).collect()
        } else {
            entry.description.clone()
        },
        body: body.to_string(),
        source_run: format!("install:{}", entry.url),
    };
    evolver.promote(&cand, now_ms).map_err(|e| match e {
        crate::skills_runtime::CandidateError::Duplicate => InstallError::Duplicate,
        crate::skills_runtime::CandidateError::NameExists => InstallError::NameExists,
        crate::skills_runtime::CandidateError::Empty => InstallError::Empty,
        crate::skills_runtime::CandidateError::TooLong(n) => InstallError::TooLong(n),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(sha: &str) -> SkillSourceEntry {
        SkillSourceEntry {
            name: "简历投递法".into(),
            description: "生成并维护可投递简历卡".into(),
            url: "https://skills.example.com/resume.md".into(),
            sha256: sha.into(),
            categories: vec!["work".into()],
        }
    }

    #[test]
    fn verified_body_installs_into_index() {
        let body = "# 简历投递法\n先维护 profile 卡再投递";
        let e = entry(&sha256_hex(body));
        let mut ev = SkillEvolver::new();
        apply_install(&mut ev, &e, body, 1).unwrap();
        assert!(ev.registry.index_for_prompt().contains("简历投递法"), "装完下一轮索引可见");
        assert_eq!(ev.registry.read_skill("简历投递法"), Some(body));
        assert!(ev.log[0].contains("install:https://skills.example.com/resume.md"), "来源留证据");
    }

    #[test]
    fn digest_mismatch_refuses_install() {
        let e = entry("deadbeef");
        let mut ev = SkillEvolver::new();
        let err = apply_install(&mut ev, &e, "被篡改的正文", 1).unwrap_err();
        assert!(matches!(err, InstallError::BadDigest { .. }));
        assert_eq!(ev.registry.len(), 0, "验签不过不许入库");
    }

    /// 纪律: 登记条目没有 sha256 = 未验真 = 拒装 (不降级不冒充)
    #[test]
    fn missing_digest_is_unverified_not_installed() {
        let e = entry("");
        let mut ev = SkillEvolver::new();
        assert_eq!(
            apply_install(&mut ev, &e, "正文", 1).unwrap_err(),
            InstallError::Unverified
        );
        assert_eq!(ev.registry.len(), 0);
    }

    #[test]
    fn duplicate_and_name_exists_are_honest() {
        let body = "# 法\n正文";
        let e = entry(&sha256_hex(body));
        let mut ev = SkillEvolver::new();
        apply_install(&mut ev, &e, body, 1).unwrap();
        // 同内容再装 = 重复
        assert_eq!(apply_install(&mut ev, &e, body, 2).unwrap_err(), InstallError::Duplicate);
        // 同名不同正文 = 同名拒
        let mut e2 = entry(&sha256_hex("别的正文"));
        e2.name = "简历投递法".into();
        assert_eq!(
            apply_install(&mut ev, &e2, "别的正文", 3).unwrap_err(),
            InstallError::NameExists
        );
    }

    #[test]
    fn registry_finds_by_category_then_name() {
        let reg = SkillSourceRegistry {
            entries: vec![
                entry(&sha256_hex("x")),                       // categories: work
                SkillSourceEntry { name: "点餐指南food".into(), description: String::new(), url: "https://s.example/f.md".into(), sha256: "aa".into(), categories: vec![] },
            ],
        };
        // work 精确命中第一条
        assert_eq!(reg.find_for_category(IntentCategory::Work).unwrap().name, "简历投递法");
        // food 无 categories 命中 → 名字含 "food" 兜底
        assert_eq!(reg.find_for_category(IntentCategory::Food).unwrap().name, "点餐指南food");
        // other 没有任何命中
        assert!(reg.find_for_category(IntentCategory::Other).is_none());
    }

    #[test]
    fn load_missing_file_is_empty_registry_not_error() {
        let reg = SkillSourceRegistry::load(std::path::Path::new("/nonexistent/registry.json"));
        assert!(reg.entries.is_empty(), "空登记面 = 如实没有可装的, 不炸");
    }

    #[test]
    fn parse_fetch_output_strips_header_and_refuses_truncation() {
        let body = "# 简历投递法\n先维护 profile 卡";
        let full = format!("[已抓取] https://s.example/r.md (text/markdown)\n\n{body}");
        assert_eq!(parse_fetch_output(&full), Some(body));

        let trunc = format!("[已抓取] https://s.example/r.md (text/markdown) [截断: 显示前 32000 字符]\n\n{body}");
        assert_eq!(parse_fetch_output(&trunc), None, "截断 ⇒ 验真必败 ⇒ 如实拒");

        assert_eq!(parse_fetch_output("这不是 web_fetch 的输出"), None);
    }
}
