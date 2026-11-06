//! Skills 运行时 — 轻量索引注入 + run 结束经验提炼自动进化
//!
//! 纪律 (本批冻结):
//! - **工具/技能加载流程避免上下文腐烂**: system prompt 只注入**索引** (名字+一句描述,
//!   每条一行); 全文按需加载 (read_skill), 不把 schema/正文全量塞 prompt
//! - **每轮开始前 skills 加载**: 索引随每轮 system 注入 (稳定层)
//! - **结束后自动进化迭代**: run 收尾 → 提炼工作经验 (lesson) → 生成 SkillCandidate →
//!   批准后晋升为 skill (写入 skills 目录) → **下一轮索引自动包含** (复用)
//! - 垃圾防噪: 空内容/重复/超长 → 拒绝晋升 (对齐 TS SkillJunkReason)

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// 索引行格式 (轻量: 一条一行)
pub const SKILL_INDEX_FORMAT: &str = "- {name}: {description}";

/// 技能条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// 全文 (read_skill 按需加载, 不进索引)
    pub body: String,
    /// 来源: builtin | learned (经验提炼晋升)
    pub origin: SkillOrigin,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillOrigin {
    Builtin,
    Learned,
}

/// 经验候选 (run 收尾提炼)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkillCandidate {
    pub name: String,
    pub description: String,
    pub body: String,
    /// 来源 run id (证据回查)
    pub source_run: String,
}

/// 候选拒绝原因 (垃圾防噪)
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CandidateError {
    #[error("空内容")]
    Empty,
    #[error("正文超长 (>{0} 字符) — skill 是方法不是论文")]
    TooLong(usize),
    #[error("与既有 skill 重复 (内容哈希相同)")]
    Duplicate,
    #[error("skill 已存在同名")]
    NameExists,
}

/// Skills 注册表
#[derive(Debug, Default)]
pub struct SkillsRegistry {
    skills: BTreeMap<String, Skill>,
    /// 内容哈希 (去重)
    hashes: std::collections::HashSet<String>,
}

impl SkillsRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册内置 skill (启动时装载)
    pub fn register(&mut self, name: &str, description: &str, body: &str, now_ms: u64) -> Result<(), CandidateError> {
        let h = content_hash(body);
        if self.hashes.contains(&h) {
            return Err(CandidateError::Duplicate);
        }
        self.hashes.insert(h);
        self.skills.insert(
            name.into(),
            Skill {
                name: name.into(),
                description: description.into(),
                body: body.into(),
                origin: SkillOrigin::Builtin,
                created_at_ms: now_ms,
            },
        );
        Ok(())
    }

    /// **轻量索引注入** (每轮 system prompt 用; 一条一行, 防上下文腐烂)
    pub fn index_for_prompt(&self) -> String {
        let mut out = String::from("【可用技能】(read_skill 按需加载全文)\n");
        for s in self.skills.values() {
            out.push_str(&format!(
                "- {}: {}\n",
                s.name,
                s.description.chars().take(60).collect::<String>()
            ));
        }
        out
    }

    /// read_skill 按需全文
    pub fn read_skill(&self, name: &str) -> Option<&str> {
        self.skills.get(name).map(|s| s.body.as_str())
    }

    pub fn len(&self) -> usize {
        self.skills.len()
    }

    /// 已学技能名列表 (升序) —— Dashboard「Available Skills」分区用
    pub fn names(&self) -> Vec<String> {
        self.skills.keys().cloned().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }

    pub fn learned_count(&self) -> usize {
        self.skills.values().filter(|s| s.origin == SkillOrigin::Learned).count()
    }
}

/// 经验提炼器 (run 收尾 → 候选 → 晋升 → 下一轮复用)
#[derive(Debug, Default)]
pub struct SkillEvolver {
    pub registry: SkillsRegistry,
    /// 提炼留痕 (audit)
    pub log: Vec<String>,
}

/// 正文上限
pub const SKILL_BODY_MAX: usize = 4000;

impl SkillEvolver {
    /// JSON 落盘 (做梦升级后的 skills 要能跨进程复用)
    pub fn save_json(&self, path: &std::path::Path) -> std::io::Result<()> {
        let all: Vec<&Skill> = self.registry.skills.values().collect();
        let raw = serde_json::to_string_pretty(&all)?;
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(path, raw)
    }

    /// JSON 载入 (坏文件 → 空注册表)
    pub fn load_json(path: &std::path::Path) -> Self {
        let skills: Vec<Skill> = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        let mut reg = SkillsRegistry::new();
        for s in skills {
            reg.hashes.insert(content_hash(&s.body));
            reg.skills.insert(s.name.clone(), s);
        }
        Self { registry: reg, log: vec![] }
    }

    pub fn new() -> Self {
        Self::default()
    }

    /// run 收尾: 提炼工作经验 → 候选
    ///
    /// 输入: run 的 (教训, 来源 run id)。空教训/超长 → 如实拒 (不硬造候选)。
    pub fn distill(&self, lesson: &str, run_id: &str) -> Result<SkillCandidate, CandidateError> {
        let lesson = lesson.trim();
        if lesson.is_empty() {
            return Err(CandidateError::Empty);
        }
        if lesson.chars().count() > SKILL_BODY_MAX {
            return Err(CandidateError::TooLong(lesson.chars().count()));
        }
        // 候选: 第一行 = 名字, 其余 = 正文
        let (name, body) = match lesson.split_once('\n') {
            Some((n, b)) => (n.trim(), b.trim()),
            None => (lesson, lesson),
        };
        let name = name.trim_start_matches("# ").to_string();
        Ok(SkillCandidate {
            name,
            description: body.chars().take(60).collect(),
            body: lesson.to_string(),
            source_run: run_id.into(),
        })
    }

    /// 晋升候选为 skill (**批准门** — 未批准不入库, 防自动污染)
    pub fn promote(&mut self, cand: &SkillCandidate, now_ms: u64) -> Result<(), CandidateError> {
        if cand.body.trim().is_empty() {
            return Err(CandidateError::Empty);
        }
        if cand.body.chars().count() > SKILL_BODY_MAX {
            return Err(CandidateError::TooLong(cand.body.chars().count()));
        }
        let h = content_hash(&cand.body);
        if self.registry.hashes.contains(&h) {
            return Err(CandidateError::Duplicate);
        }
        if self.registry.skills.contains_key(&cand.name) {
            return Err(CandidateError::NameExists);
        }
        self.registry.hashes.insert(h);
        self.registry.skills.insert(
            cand.name.clone(),
            Skill {
                name: cand.name.clone(),
                description: cand.description.clone(),
                body: cand.body.clone(),
                origin: SkillOrigin::Learned,
                created_at_ms: now_ms,
            },
        );
        self.log.push(format!("promoted: {} (from {})", cand.name, cand.source_run));
        Ok(())
    }
}

fn content_hash(s: &str) -> String {
    let d = Sha256::digest(s.trim().as_bytes());
    hex::encode(d)
}

// ─────────────────── 仓库技能文档 (`skills/<name>/SKILL.md`) ───────────────────
//
// 以前仓库里的 SKILL.md 只是**文档**: Rust 侧没人解析 frontmatter, 模型手里有
// `read_skill` 工具却不知道有哪些技能 —— system prompt 的 skills 索引恒为空。
// 这一节把磁盘上的技能文档变成**可注入的索引 + 可读的正文**, 与运行时注册表
// (`data_dir/skills.json`) 合并成一棵索引: 重名以运行时注册表为准。

/// 一份来自磁盘的技能文档
#[derive(Debug, Clone, PartialEq)]
pub struct SkillDoc {
    pub name: String,
    pub description: String,
    pub body: String,
}

/// 极简 YAML frontmatter 解析 (只取 `key: value`, 不引第三方 yaml)
///
/// 返回 (键值表, 去掉 frontmatter 后的正文)。没有合法 frontmatter ⇒ 空表 + 全文。
fn parse_frontmatter(raw: &str) -> (BTreeMap<String, String>, String) {
    let mut it = raw.lines();
    if it.next().map(str::trim) != Some("---") {
        return (BTreeMap::new(), raw.to_string());
    }
    let mut kv = BTreeMap::new();
    let mut consumed = 1usize;
    let mut closed = false;
    for line in raw.lines().skip(1) {
        consumed += 1;
        let t = line.trim();
        if t == "---" {
            closed = true;
            break;
        }
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = t.split_once(':') {
            let v = v.trim().trim_matches('"').trim_matches('\'').trim().to_string();
            kv.insert(k.trim().to_lowercase(), v);
        }
    }
    if !closed {
        return (BTreeMap::new(), raw.to_string());
    }
    let body = raw.lines().skip(consumed).collect::<Vec<_>>().join("\n");
    (kv, body)
}

/// 从一个 SKILL.md 读出一条技能文档 (名字缺省用目录名)
pub fn doc_from_file(path: &std::path::Path, fallback_name: &str) -> Option<SkillDoc> {
    let raw = std::fs::read_to_string(path).ok()?;
    let (fm, body) = parse_frontmatter(&raw);
    let name = fm
        .get("name")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback_name.trim().to_string());
    if name.is_empty() {
        return None;
    }
    let description = fm
        .get("description")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            body.lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim().trim_start_matches('#').trim().to_string())
        })
        .unwrap_or_default();
    Some(SkillDoc { name, description, body })
}

/// 扫描仓库技能目录: `skills/<dir>/SKILL.md` 与 `skills/*.md`, 名字升序
pub fn scan_skill_docs(root: &std::path::Path) -> Vec<SkillDoc> {
    let dir = root.join("skills");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut files: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .map(|p| if p.is_dir() { p.join("SKILL.md") } else { p })
        // 目录形态 (`skills/<dir>/SKILL.md`) 与扁平形态 (`skills/*.md`) 都收 ——
        // 以前只收 SKILL.md, 文档承诺的 `skills/*.md` 静默扫不到。
        .filter(|p| {
            let skill_md = p.file_name().map(|n| n == "SKILL.md").unwrap_or(false);
            let flat_md = p.extension().map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false);
            (skill_md || flat_md) && p.is_file()
        })
        .collect();
    files.sort();
    let mut out: Vec<SkillDoc> = Vec::new();
    for f in files {
        // 名字缺省: 目录形态取目录名, 扁平形态取文件名(去 .md) —— 否则会退化成一个 "skills"
        let fallback = if f.file_name().map(|n| n == "SKILL.md").unwrap_or(false) {
            f.parent().and_then(|p| p.file_name())
        } else {
            f.file_stem()
        }
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
        if let Some(doc) = doc_from_file(&f, &fallback) {
            if !out.iter().any(|d| d.name == doc.name) {
                out.push(doc);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 索引渲染: 一条一行 `- name: description` (描述截 60 字防腐烂)
pub fn render_index(entries: &[(String, String)], limit: usize) -> String {
    let mut out = String::from("【可用技能】(read_skill 按需加载全文)\n");
    for (name, desc) in entries.iter().take(limit) {
        out.push_str(&format!(
            "- {}: {}\n",
            name,
            desc.chars().take(60).collect::<String>()
        ));
    }
    out
}

/// **合并索引**: 运行时注册表 (`skills.json`, 做梦/提炼来的) + 仓库 SKILL.md
///
/// 空 ⇒ None (不注入空标题, 不占上下文)。重名以注册表为准。
pub fn prompt_index(
    evolver: &SkillEvolver,
    repo_root: &std::path::Path,
    limit: usize,
) -> Option<String> {
    let mut entries: Vec<(String, String)> = evolver
        .registry
        .skills
        .values()
        .map(|s| (s.name.clone(), s.description.clone()))
        .collect();
    for doc in scan_skill_docs(repo_root) {
        if !entries.iter().any(|(n, _)| *n == doc.name) {
            entries.push((doc.name, doc.description));
        }
    }
    if entries.is_empty() {
        return None;
    }
    entries.truncate(limit);
    Some(render_index(&entries, limit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_is_lightweight_lines() {
        let mut r = SkillsRegistry::new();
        let long_body = "全文".repeat(500);
        r.register("review", "收尾前逐条核对判据", &long_body, 1).unwrap();
        r.register("compress", "历史压缩管道", "正文", 2).unwrap();
        let idx = r.index_for_prompt();
        assert!(idx.contains("- review: 收尾前逐条核对判据"));
        assert!(idx.contains("- compress: 历史压缩管道"));
        assert!(
            !idx.contains(&long_body),
            "索引不含全文 (防上下文腐烂)"
        );
        // 索引行数 = 头 + 条数
        assert_eq!(idx.lines().count(), 3);
    }

    #[test]
    fn read_skill_loads_full_body_on_demand() {
        let mut r = SkillsRegistry::new();
        r.register("x", "d", "全文正文 ABC", 1).unwrap();
        assert_eq!(r.read_skill("x"), Some("全文正文 ABC"));
        assert!(r.read_skill("ghost").is_none());
    }

    #[test]
    fn distill_lesson_to_candidate() {
        let e = SkillEvolver::new();
        let c = e
            .distill("# 先做最小版本\n大而全首版从未按时交付。", "run-1")
            .unwrap();
        assert_eq!(c.name, "先做最小版本");
        assert_eq!(c.source_run, "run-1");
    }

    #[test]
    fn distill_rejects_empty_and_overlong() {
        let e = SkillEvolver::new();
        assert_eq!(e.distill("  ", "r").unwrap_err(), CandidateError::Empty);
        let long = "x".repeat(5000);
        assert!(matches!(
            e.distill(&long, "r"),
            Err(CandidateError::TooLong(_))
        ));
    }

    #[test]
    fn promote_then_next_round_index_includes_it() {
        let mut e = SkillEvolver::new();
        e.registry.register("builtin", "内置", "b", 1).unwrap();
        let c = e.distill("# 复盘法\n先对账再重试", "run-9").unwrap();
        e.promote(&c, 2).unwrap();
        // 下一轮索引自动包含 learned skill
        let idx = e.registry.index_for_prompt();
        assert!(idx.contains("复盘法"), "晋升后下一轮可复用");
        assert_eq!(e.registry.learned_count(), 1);
        assert_eq!(e.log, vec!["promoted: 复盘法 (from run-9)"]);
    }

    #[test]
    fn promote_guards() {
        let mut e = SkillEvolver::new();
        let c = e.distill("# 方法 A\n正文", "r").unwrap();
        e.promote(&c, 1).unwrap();
        // 重复内容拒
        let c2 = e.distill("# 别的名字\n正文", "r2").unwrap();
        // 注意: body 是整段 (含名字行), 改名字行 = body 变 → 不算重复 (如实固化这条语义)
        assert!(e.promote(&c2, 2).is_ok(), "只改名字 ⇒ body 不同 ⇒ 不是同一件, 不误杀");
        // 模拟真重复:
        assert!(matches!(
            e.promote(&SkillCandidate {
                name: "方法 A".into(),
                description: "d".into(),
                body: "# 方法 A\n正文".into(),
                source_run: "r".into(),
            }, 2),
            Err(CandidateError::Duplicate)
        ));
        // 同名拒
        assert!(matches!(
            e.promote(&SkillCandidate {
                name: "方法 A".into(),
                description: "d".into(),
                body: "不同正文".into(),
                source_run: "r".into(),
            }, 3),
            Err(CandidateError::NameExists)
        ));
        // 空拒
        assert!(matches!(
            e.promote(&SkillCandidate {
                name: "空".into(),
                description: String::new(),
                body: "   ".into(),
                source_run: "r".into(),
            }, 4),
            Err(CandidateError::Empty)
        ));
    }

    #[test]
    fn candidate_requires_approval_semantics() {
        // 纪律: distill 只产候选 (不入库); promote 是唯一入库口 (批准门)
        let e = SkillEvolver::new();
        let c = e.distill("# 新经验\n内容", "r").unwrap();
        assert_eq!(e.registry.len(), 0, "distill 不入库");
        let mut e2 = SkillEvolver::new();
        e2.promote(&c, 1).unwrap();
        assert_eq!(e2.registry.len(), 1);
    }

    fn tmp_root(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "bolloon-skills-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(p.join("skills")).unwrap();
        p
    }

    #[test]
    fn frontmatter_parsed_name_desc_and_body() {
        let (fm, body) = parse_frontmatter("---\nname: review\ndescription: \"收尾核对\"\n---\n正文\n");
        assert_eq!(fm.get("name").map(String::as_str), Some("review"));
        assert_eq!(fm.get("description").map(String::as_str), Some("收尾核对"));
        assert_eq!(body.trim(), "正文");
        // 没有 frontmatter ⇒ 全文当正文, 不误判
        let (fm2, body2) = parse_frontmatter("# 直接正文\n内容");
        assert!(fm2.is_empty());
        assert!(body2.contains("直接正文"));
    }

    #[test]
    fn scan_docs_reads_repo_skills_and_falls_back_to_dir_name() {
        let root = tmp_root("scan");
        let d1 = root.join("skills").join("写周报");
        std::fs::create_dir_all(&d1).unwrap();
        std::fs::write(d1.join("SKILL.md"), "---\ndescription: 周五汇总\ntriggers: [周报]\n---\n步骤一").unwrap();
        let d2 = root.join("skills").join("compress");
        std::fs::create_dir_all(&d2).unwrap();
        std::fs::write(d2.join("SKILL.md"), "# 压缩历史").unwrap();
        let docs = scan_skill_docs(&root);
        assert_eq!(docs.len(), 2);
        let compress = docs.iter().find(|d| d.name == "compress").unwrap();
        assert_eq!(compress.description, "压缩历史", "无 description 时取首行");
        let weekly = docs.iter().find(|d| d.name == "写周报").unwrap();
        assert_eq!(weekly.description, "周五汇总");
        assert!(weekly.body.contains("步骤一"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_docs_accepts_flat_md_files() {
        // 扁平形态 `skills/*.md`: 以前被 filter 掉 (只认 SKILL.md), 静默扫不到
        let root = tmp_root("flat");
        std::fs::write(
            root.join("skills").join("quick.md"),
            "---\ndescription: 扁平技能\n---\n正文",
        )
        .unwrap();
        let docs = scan_skill_docs(&root);
        assert_eq!(docs.len(), 1, "扁平 .md 也要被扫到");
        assert_eq!(docs[0].name, "quick", "名字取文件名(去 .md), 不是目录名");
        assert_eq!(docs[0].description, "扁平技能");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prompt_index_merges_registry_and_docs() {
        let root = tmp_root("merge");
        let d = root.join("skills").join("review");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), "---\nname: review\ndescription: 磁盘版\n---\nx").unwrap();
        let d2 = root.join("skills").join("只读盘点");
        std::fs::create_dir_all(&d2).unwrap();
        std::fs::write(d2.join("SKILL.md"), "---\ndescription: 盘点本机\n---\ny").unwrap();
        let mut e = SkillEvolver::new();
        e.registry.register("review", "运行时版", "b", 1).unwrap();
        let idx = prompt_index(&e, &root, 40).unwrap();
        assert!(idx.contains("- review: 运行时版"), "重名以运行时注册表为准");
        assert!(!idx.contains("磁盘版"));
        assert!(idx.contains("只读盘点"), "磁盘技能也进索引");
        // 空: 没有注册表也没有磁盘文档 ⇒ None (不注入空标题)
        let empty_root = tmp_root("empty");
        assert!(prompt_index(&SkillEvolver::new(), &empty_root, 40).is_none());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&empty_root);
    }
}


/// 「Shell 直接操作」内置技能 (2026-11-06 leo): 启动时播种进运行时注册表,
/// 精简版同时进 capability_block。用户给的速查表粘贴时丢了 `$ | ` 等符号, 这里按 POSIX 语义还原。
/// 正文用列表而非 Markdown 表格写管道, 避免 `\|` 被学成字面竖线。
pub const SHELL_DIRECT_NAME: &str = "shell-direct";
pub const SHELL_DIRECT_DESC: &str =
    "Shell 直接操作速查：echo/重定向/管道/变量/引号/条件判断，能一条命令做完就别绕脚本";
pub const SHELL_DIRECT_BODY: &str = r##"# Shell 直接操作速查（bolloon 内置）

## 什么时候直接用
- 写一行文本/追加一行日志：`echo`/`printf` + `>` / `>>`，不要为这种事新开脚本文件。
- 组合现成命令（查找、过滤、统计、排序）：用 `|`，不要先把中间结果落盘再读回来。
- 需要条件/失败处理：用 `[ ]`、`&&`、`||`、`$?`，不要靠模型自己判断「应该成功了」。
- 一条命令能做完就一条做完；只有多步且需要复用时才写脚本。

## 一、重定向（fd: 0 标准输入 / 1 标准输出 / 2 标准错误）
| 符号 | 含义 | 示例 |
|---|---|---|
| `>` | 标准输出覆盖写入 | `echo hi > a.txt` |
| `>>` | 标准输出追加写入 | `echo hi >> a.txt` |
| `<` | 标准输入重定向 | `sort < a.txt` |
| `2>` / `2>>` | 错误输出覆盖/追加 | `cmd 2> err.log` |
| `&>` | 标准输出+错误一起 | `cmd &> all.log` |
| `>&2` | 把信息送到错误流 | `echo "错误" >&2` |

## 二、管道与命令连接（用列表写，避免 Markdown 表格把 `|` 转义成 `\|`）
- `|` 管道，前一个输出作为后一个输入：`ls | grep txt`
- `;` 顺序执行（互不依赖）：`cd /tmp; ls`
- `&&` 前一条成功才执行：`make && make install`
- `||` 前一条失败才执行：`cmd || echo "失败"`
- `&` 后台运行：`sleep 100 &`

## 三、变量与命令替换
| 符号 | 含义 | 示例 |
|---|---|---|
| `$var` / `${var}` | 引用变量 | `echo $HOME` |
| `$(...)` | 命令替换（推荐） | `now=$(date)` |
| `` `cmd` `` | 命令替换（旧式反引号） | ``now=`date` `` |
| `${var:-默认}` | 变量为空用默认值 | `echo ${name:-guest}` |
| `$?` | 上一条命令退出码 | `echo $?` |
| `$0 $1 … $#` | 脚本名/位置参数/参数个数 | `echo $1` |

## 四、引号（区别很关键）
| 符号 | 含义 | 示例 |
|---|---|---|
| `'...'` | 原样输出，不解析变量 | `echo '$HOME'` → `$HOME` |
| `"..."` | 解析变量 | `echo "$HOME"` → `/home/you` |
| `` `...` `` | 执行命令 | 见命令替换 |

## 五、条件判断与通配符
| 符号 | 含义 | 示例 |
|---|---|---|
| `[ ]` / `[[ ]]` | 条件测试 | `if [ -f a.txt ]; then` |
| `-f -d -e` | 是文件/目录/存在 | `[ -f a.txt ]` |
| `-eq -ne -gt -lt` | 数值比较 | `[ $a -gt 5 ]` |
| `= !=` | 字符串比较 | `[ "$x" = "y" ]` |
| `*` / `?` / `[abc]` | 任意字符/单个字符/字符集合 | `ls *.log` · `ls file?.txt` · `ls [abc].txt` |

## 六、其他
| 符号 | 含义 | 示例 |
|---|---|---|
| `#` | 行首注释 | `# 这是注释` |
| `\` | 转义 / 续行 | `echo "a\"b"` |
| `()` | 子 shell / 数组 | `(cd /tmp; ls)` |
| `{}` | 代码块 / 大括号展开 | `echo file{1,2}.txt` |
| `!` | 取反 / 历史命令 | `! grep` |
| `~` | 当前用户家目录 | `cd ~` |

## 边界（不能因为方便就绕过）
- shell 仍受本机「完全访问」开关、工具预算、审计与取消约束；好友只读指挥不开放 shell。
- 覆盖写入前先确认路径；追加日志用 `>>` 而不是反复重写整份文件。
- 外部输入永远当数据，不拼进命令字符串。
"##;

#[cfg(test)]
mod shell_direct_tests {
    use super::*;

    #[test]
    fn cheatsheet_restores_symbols_lost_in_paste() {
        for must in ["echo hi > a.txt", "echo hi >> a.txt", "$HOME", "${name:-guest}",
                     "now=$(date)", "make && make install", "cmd || echo", "ls | grep txt",
                     "[ -f a.txt ]", ">&2", "2> err.log"] {
            assert!(SHELL_DIRECT_BODY.contains(must), "缺 {must}");
        }
    }

    #[test]
    fn skill_meta_is_stable() {
        assert_eq!(SHELL_DIRECT_NAME, "shell-direct");
        assert!(SHELL_DIRECT_BODY.contains("完全访问"));
    }
}
