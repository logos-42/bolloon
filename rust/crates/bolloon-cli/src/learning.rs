//! 经验闭环: **记忆 → 判断力 → 技能** 的唯一装配点 (CLI 侧)。
//!
//! 为什么要有这个文件: `bolloon-agent` 里早就有 `memory` / `judgment` / `skills_runtime`
//! / `dream` 四套机制, web 与 agent 也一直在用, 但 `bolloon chat` 从来没接 —— 于是终端里
//! 既不加载既有 skills, 也不召回记忆, 更不会事后提炼经验 (leo 2026-10-27 点名:
//! 「终端没有接入自动经验整理, 自动初始化加载 skills 和记忆, persona 文档, 做梦机制」)。
//!
//! 本模块只做三件事, 全部是**既有能力的接线**, 不新造第二套:
//! 1. `load()`/`save()` —— 从 `<BOLLOON_HOME>` 读 `memory.json` / `judgments.json` /
//!    `skills.json`, 退出时原路写回;
//! 2. `context_block()` —— 把「相关记忆 + 高置信判断 + 技能索引」压成**有界**文本,
//!    交给 system prompt (persona 走 `bolloon_agent::home::AgentDocs`, 不在这里重复);
//! 3. `remember_turn()` / `dream_now()` —— 每轮记事实, 攒够或退出时跑一次做梦
//!    (`dream::dream` 是纯函数, 不调模型, 因此可以自动跑而不烧 token)。

use std::path::{Path, PathBuf};


use bolloon_agent::dream::{dream, DreamInput, DreamReport};
use bolloon_agent::judgment::JudgmentStore;
use bolloon_agent::memory::{MemoryEntry, MemoryLayer, MemoryStore};
use bolloon_agent::skills_runtime::SkillEvolver;
use chrono::Utc;

/// 攒够多少轮就自动做一次梦 (纯函数整理, 不调模型 ⇒ 便宜)
pub const DREAM_EVERY_TURNS: usize = 8;

/// system prompt 里经验区块的字符预算 (超了就按优先级砍: 技能 → 判断 → 记忆)
pub const DEFAULT_BUDGET: usize = 4000;

pub struct Learning {
    memory_path: PathBuf,
    judgment_path: PathBuf,
    skills_path: PathBuf,
    /// 当前会话的经验域 (做梦时给 judgment 打标签)
    domain: String,
    pub memory: MemoryStore,
    pub judgments: JudgmentStore,
    pub skills: SkillEvolver,
    /// 上次做梦之后又聊了几轮
    pub turns_since_dream: usize,
}

impl Learning {
    /// 从 `<home>` 读三份档案 (缺文件 = 空, 不报错 —— 第一次跑本来就该是空)
    pub fn load(home: &Path, domain: &str) -> Self {
        let memory_path = home.join("memory.json");
        let judgment_path = home.join("judgments.json");
        let skills_path = home.join("skills.json");

        // 记忆: 手工小文件 (与 memory.db 不冲突 —— 那是 SQLite 侧, 这里是纯 JSON 快照)。
        // **逐条解析**: 一条坏记录 (手改/版本差异) 不许把整个记忆库清零 —— 那不是"干净", 那是丢数据。
        let memory = std::fs::read_to_string(&memory_path)
            .ok()
            .and_then(|t| serde_json::from_str::<Vec<serde_json::Value>>(&t).ok())
            .map(|rows| {
                let entries: Vec<MemoryEntry> = rows
                    .into_iter()
                    .filter_map(|v| serde_json::from_value(v).ok())
                    .collect();
                MemoryStore::from_snapshot(entries)
            })
            .unwrap_or_default();

        Self {
            memory_path,
            judgment_path: judgment_path.clone(),
            skills_path: skills_path.clone(),
            domain: domain.to_string(),
            memory,
            judgments: JudgmentStore::load_json(&judgment_path),
            skills: SkillEvolver::load_json(&skills_path),
            turns_since_dream: 0,
        }
    }

    /// 落盘 (退出必调; 失败只报不吞)
    pub fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.memory_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败 {e}"))?;
        }
        let mem = serde_json::to_string_pretty(self.memory.snapshot())
            .map_err(|e| format!("记忆序列化失败 {e}"))?;
        std::fs::write(&self.memory_path, mem).map_err(|e| format!("记忆落盘失败 {e}"))?;
        self.judgments
            .save_json(&self.judgment_path)
            .map_err(|e| format!("判断力落盘失败 {e}"))?;
        self.skills
            .save_json(&self.skills_path)
            .map_err(|e| format!("技能落盘失败 {e}"))
    }

    /// 记一轮事实 (用户问了什么 + 用了哪些工具 + 成没成)。
    ///
    /// 只落**事实**, 不在这里编"经验" —— 提炼交给做梦 (`dream` 会去重/合并且不调模型)。
    pub fn remember_turn(&mut self, user_msg: &str, tools: &[String], ok: bool) {
        let brief: String = user_msg.chars().take(120).collect();
        let tool_part = if tools.is_empty() {
            "无工具".to_string()
        } else {
            format!("工具 {}", tools.join(","))
        };
        let content = format!(
            "[{}] {} · {}",
            if ok { "成功" } else { "失败" },
            brief,
            tool_part
        );
        self.memory
            .remember(content, MemoryLayer::RunFact, if ok { 0.45 } else { 0.65 }, None);
        self.turns_since_dream += 1;
    }

    /// 把「相关记忆 + 高置信判断 + 技能索引」压成有界文本, 给 system prompt 用。
    ///
    /// 顺序 = 优先级: 技能索引 (可执行) → 判断力 (取向) → 记忆 (事实)。预算不够从后往前砍。
    pub fn context_block(&self, query: &str, budget: usize) -> String {
        let now = Utc::now();
        let mut skills = String::new();
        if !self.skills.registry.is_empty() {
            let idx = self.skills.registry.index_for_prompt();
            skills.push_str(&format!("## 可用技能 (本机已学会, 先看索引)\n{idx}\n"));
        }
        // 机器上**已有的**技能库 (Hermes/Claude/Codex + 项目内): 只放名字, 60 个封顶 ——
        // 全会话照抄 1374 个名字会把上下文吃掉, 而名字足够模型判断"该不该去读"。
        let dirs = machine_skills(
            self.memory_path.parent().unwrap_or(Path::new(".")),
            2000,
        );
        if !dirs.is_empty() {
            let shown: Vec<&str> = dirs.iter().take(60).map(|s| s.as_str()).collect();
            skills.push_str(&format!(
                "## 机器上已安装的技能 ({} 个, 只列前 {}; 需要时让用户 /help skills 查)\n{}\n",
                dirs.len(),
                shown.len(),
                shown.join(" · ")
            ));
        }

        let mut judgments = String::new();
        let top: Vec<String> = self
            .judgments
            .snapshot()
            .iter()
            .filter(|j| j.confidence >= 0.5)
            .take(6)
            .map(|j| format!("- {}", j.statement))
            .collect();
        if !top.is_empty() {
            judgments = format!("## 已形成的判断\n{}\n", top.join("\n"));
        }

        let mut memories = String::new();
        // 召回: 先按本句里的词做子串过滤, 召不满再兜底取高分 (别让"本句没词"就零记忆)
        let mut hits = self.memory.recall(Some(query), 6, now);
        if hits.len() < 3 {
            hits = self.memory.recall(None, 6, now);
        }
        let lines: Vec<String> = hits
            .iter()
            .map(|m| format!("- {}", m.content.chars().take(160).collect::<String>()))
            .collect();
        if !lines.is_empty() {
            memories = format!("## 相关记忆 (跨会话)\n{}\n", lines.join("\n"));
        }

        // 预算裁剪: 记忆先砍到 3 条, 再砍判断, 最后砍技能 (技能是执行入口, 最后才让位)
        let compose = |m: &str, j: &str, s: &str| format!("{s}{j}{m}");
        let mut out = compose(&memories, &judgments, &skills);
        if out.chars().count() > budget {
            let short_mem = memories
                .lines()
                .take(1 + 3)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            out = compose(&short_mem, &judgments, &skills);
        }
        if out.chars().count() > budget {
            let j3: Vec<&str> = judgments.lines().take(3).collect();
            out = compose(&memories, &(j3.join("\n") + "\n"), &skills);
        }
        if out.chars().count() > budget {
            let s_short: String = skills.chars().take(budget / 2).collect();
            out = compose(&memories, &judgments, &s_short);
        }
        // 最后一道硬闸: 预算就是预算 (砍到还超就如实截断, 不许悄悄占满上下文)
        if out.chars().count() > budget {
            out = out.chars().take(budget).collect();
            out.push_str("\n…(经验区块已按预算截断)");
        }
        out
    }

    /// 攒够轮数就做梦; 返回报告 (没到点 = None, 不假装做过)
    pub fn maybe_dream(&mut self) -> Option<DreamReport> {
        if self.turns_since_dream < DREAM_EVERY_TURNS {
            return None;
        }
        Some(self.dream_now())
    }

    /// 立刻做梦 (退出时也调一次): 整理记忆 → 判断力 → 技能候选
    pub fn dream_now(&mut self) -> DreamReport {
        let now_ms = Utc::now().timestamp_millis() as u64;
        let report = dream(
            &DreamInput {
                memories: self.memory.snapshot(),
                now_ms,
            },
            &mut self.judgments,
            &mut self.skills,
            &self.domain,
        );
        self.turns_since_dream = 0;
        report
    }

    /// 一行状态 (启动/退出时给人看的事实, 不是装饰)
    pub fn summary_line(&self) -> String {
        format!(
            "🧠 记忆 {} 条 · 判断力 {} 条 · 技能 {} 个 (本次新增学会 {})",
            self.memory.snapshot().len(),
            self.judgments.len(),
            self.skills.registry.len(),
            self.skills.registry.learned_count()
        )
    }
}

/// 做梦报告 → 一行人类可读摘要 (空梦境也如实说"没素材")
pub fn report_line(r: &DreamReport) -> String {
    if let Some(why) = &r.skipped_reason {
        return format!("💤 做梦跳过: {why}");
    }
    format!(
        "💤 做梦: 整理 {} 条 (过期 {} · 归并 {}) → 判断力 +{} · 技能 +{} (拒 {})",
        r.scanned,
        r.expired,
        r.consolidated,
        r.judgments_created + r.judgments_merged,
        r.skills_promoted,
        r.skills_rejected
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("bolloon-learn-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    #[test]
    fn remember_turn_is_bounded_and_typed() {
        let dir = tmp();
        let mut l = Learning::load(&dir, "coding");
        l.remember_turn(&"很长的问题".repeat(100), &["shell".into()], true);
        let snap = l.memory.snapshot();
        assert_eq!(snap.len(), 1);
        assert!(snap[0].content.chars().count() <= 200, "事实要截断");
        assert!(snap[0].content.contains("shell"), "工具名要留");
        assert_eq!(l.turns_since_dream, 1);
    }

    #[test]
    fn dream_fires_only_after_threshold() {
        let dir = tmp();
        let mut l = Learning::load(&dir, "coding");
        for i in 0..DREAM_EVERY_TURNS - 1 {
            l.remember_turn(&format!("第 {i} 轮"), &[], true);
        }
        assert!(l.maybe_dream().is_none(), "没到点不许做梦");
        l.remember_turn("最后一轮", &[], true);
        let r = l.maybe_dream().expect("到点要真做");
        assert_eq!(r.scanned, DREAM_EVERY_TURNS);
        assert_eq!(l.turns_since_dream, 0, "做完要清零");
    }

    #[test]
    fn context_block_respects_budget() {
        let dir = tmp();
        let mut l = Learning::load(&dir, "coding");
        for i in 0..40 {
            l.remember_turn(&format!("记忆 {i} {}", "内容".repeat(40)), &[], true);
        }
        let block = l.context_block("记忆", 600);
        assert!(!block.is_empty(), "有记忆就该有区块");
        assert!(block.chars().count() <= 900, "预算要生效: {}", block.chars().count());
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = tmp();
        {
            let mut l = Learning::load(&dir, "coding");
            l.remember_turn("跨会话要记住这句", &[], true);
            l.save().unwrap();
        }
        let l2 = Learning::load(&dir, "coding");
        assert_eq!(l2.memory.snapshot().len(), 1, "记忆要能跨进程读回");
        assert!(l2.memory.snapshot()[0].content.contains("跨会话"));
    }

    #[test]
    fn empty_dream_is_honest() {
        let dir = tmp();
        let mut l = Learning::load(&dir, "coding");
        let r = l.dream_now();
        assert_eq!(r.scanned, 0);
        assert!(report_line(&r).contains("跳过"), "没素材要如实说跳过");
    }

    #[test]
    fn skills_index_shows_registered_names() {
        let dir = tmp();
        let mut l = Learning::load(&dir, "coding");
        l.skills
            .registry
            .register("smoke", "冒烟技能", "做法: 跑一遍", 1_700_000_000_000)
            .unwrap();
        let block = l.context_block("", 4000);
        assert!(block.contains("smoke"), "技能索引要进 prompt: {block}");
    }
}

/// 扫本机已有的技能库 (`<dir>/SKILL.md` 的**目录名**就是技能名)。
///
/// 为什么要扫: 技能是**全局资产**, 不只活在某个会话的注册表里。用户机器上已经有
/// Hermes / Claude / Codex 各自的 skill 库, 面板要如实把它们算进去 (多少个, 前几个是谁),
/// 否则永远显示 "0 · 暂无" —— 那是不知道, 不是没有。
///
/// 成本控制: 只看目录 (不读 SKILL.md 内容), 深度 ≤ 4, 跳过隐藏目录与 node_modules,
/// 上限 `cap` 条。1297 个目录实测 < 30ms。
pub fn machine_skills(home: &Path, cap: usize) -> Vec<String> {
    let user_home = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/"));
    let mut roots: Vec<std::path::PathBuf> = vec![
        home.join("skills"),                  // ~/.bolloon/skills (本仓自己的)
        user_home.join(".hermes/skills"),     // Hermes 技能库
        user_home.join(".claude/skills"),     // Claude Code
        user_home.join(".codex/skills"),      // Codex
    ];
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join(".hermes/skills")); // 项目内的
    }

    let mut out: Vec<String> = Vec::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        // 迭代式遍历 (不递归调栈), 深度上限 4
        let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(root, 0)];
        while let Some((dir, depth)) = stack.pop() {
            if out.len() >= cap {
                break;
            }
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if !p.is_dir() {
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    continue;
                }
                if p.join("SKILL.md").is_file() && !out.contains(&name) {
                    out.push(name.clone());
                    if out.len() >= cap {
                        break;
                    }
                }
                if depth < 3 {
                    stack.push((p, depth + 1));
                }
            }
        }
    }
    out.sort();
    out
}
