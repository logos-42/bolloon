//! System Prompt 装配器 — **完全翻译 TS 版 `llm/system-prompt/registry.ts`**
//!
//! 设计原则 (与 TS 同源):
//! - 每个 layer 独立 (id/version/priority/appliesTo/maxChars), 可单独审查回滚
//! - 装配: 按 channel/role/tool 过滤 → priority 排序 (低先) → 单层 maxChars 截断 → 总预算硬限
//! - **系统提示词原文借用 TS 版**: core.identity / core.core-traits / core.refusal 逐字搬入
//! - 判断力注入 = 动态 layer: **有过去的经验会唤起** (相似召回 top-N),
//!   **有新的预测会唤起** (预测性输入 → 情境注入), 防重复 (already-injected)
//! - 装配顺序: core/* < channel/* < role/* < tool/* < dynamic/*

use crate::judgment::JudgmentStore;
use crate::judgment::jaccard;

/// 总字符预算 (TS P-Action 4: 15000→4500→8000, ≈2000 tokens)
pub const TOTAL_BUDGET: usize = 8000;
/// 判断力注入上限 (TS DEFAULT_INJECTION_CONFIG)
pub const JUDGMENT_TOP_N: usize = 3;
pub const JUDGMENT_MAX_CHARS: usize = 1500;

/// 适用场景 (对齐 TS AppliesTo)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppliesTo {
    All,
    Never,
    Channel(String),
    Role(String),
    Tool(String),
}

/// prompt 层
#[derive(Debug, Clone)]
pub struct PromptLayer {
    pub id: String,
    pub version: String,
    /// 数字小 = 排前
    pub priority: u32,
    pub applies_to: Vec<AppliesTo>,
    /// 单层字符上限 (腐烂防护)
    pub max_chars: usize,
    pub content: String,
}

/// 装配上下文
#[derive(Debug, Clone, Default)]
pub struct AssembleContext<'a> {
    pub channel: &'a str, // local | p2p-visitor | p2p-agent | group
    pub role: Option<&'a str>,
    pub tool: Option<&'a str>,
}

fn matches(layer: &PromptLayer, ctx: &AssembleContext) -> bool {
    for a in &layer.applies_to {
        match a {
            AppliesTo::All => return true,
            AppliesTo::Never => {}
            AppliesTo::Channel(c) if *c == ctx.channel => return true,
            AppliesTo::Role(r) if Some(r.as_str()) == ctx.role => return true,
            AppliesTo::Tool(t) if Some(t.as_str()) == ctx.tool => return true,
            _ => {}
        }
    }
    false
}

/// 装配结果
#[derive(Debug, Clone, PartialEq)]
pub struct Assembled {
    pub text: String,
    pub layer_ids: Vec<String>,
    pub total_chars: usize,
    pub truncated: Vec<String>,
}

/// 装配 (对齐 TS assembleSystemPrompt: 过滤→排序→截断→拼接)
pub fn assemble(layers: &[PromptLayer], ctx: &AssembleContext) -> Assembled {
    let mut matched: Vec<&PromptLayer> = layers.iter().filter(|l| matches(l, ctx)).collect();
    matched.sort_by(|a, b| a.priority.cmp(&b.priority).then(a.id.cmp(&b.id)));

    let mut parts: Vec<String> = Vec::new();
    let mut layer_ids = Vec::new();
    let mut truncated = Vec::new();
    let mut used_chars = 0usize;

    for layer in matched {
        if used_chars >= TOTAL_BUDGET {
            truncated.push(layer.id.clone());
            continue;
        }
        let mut content = layer.content.clone();
        if content.chars().count() > layer.max_chars {
            content = truncate_marks(&content, layer.max_chars, "[… 已截断]");
            truncated.push(layer.id.clone());
        }
        if used_chars + content.chars().count() > TOTAL_BUDGET {
            let remain = TOTAL_BUDGET - used_chars;
            if remain > 100 {
                content = truncate_marks(&content, remain, "[… 预算截断]");
            } else {
                truncated.push(layer.id.clone());
                continue;
            }
        }
        parts.push(format!("<!-- {}@{} -->\n{}", layer.id, layer.version, content));
        layer_ids.push(layer.id.clone());
        used_chars += content.chars().count();
    }

    Assembled {
        text: parts.join("\n\n"),
        layer_ids,
        total_chars: used_chars,
        truncated,
    }
}

fn truncate_marks(s: &str, max: usize, mark: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_string();
    }
    let head: String = chars[..max.saturating_sub(1)].iter().collect();
    format!("{head}\n{mark}")
}

// ─────────────────────── 内置层 (系统提示词借用 TS 版原文) ───────────────────────

/// TS 版 core.identity 原文 (借用, 精简到 maxChars 800 内的骨架)
pub const LAYER_IDENTITY: &str = r#"# bolloon 身份

助手是 **bolloon**, 一个**本地优先 + 远程协作**的双栖 AI agent.

## 核心定位

- **本地优先**: 默认在用户本机运行, 拥有直接读写文件系统的能力
- **远程协作**: 通过 P2P (DIAP / oplog) 跟其他 bolloon 节点自动互联
- **自主循环**: 用户离开时也能响应 hook 触发的事件 (P2P 消息 / 监控告警 / cron)
- **目标接力**: 切 channel / 换 skill / 转 peer 时, 目标不中断

## 你不是 不负责的智能体

- 你**不是** 没有看细节就确认的 AI
- 你**不**代表  其他智能体和人类
- 你是 hibs 组织的智能体 一员, 遵守 bolloon 的开放与安全纪律
- 你不能**不负责任地**给出法律、财务、医疗等专业建议
- 你不能**不负责任地**提供制造明显有害物质或武器
"#;

/// TS 版 core.core-traits 原文 (leo 定稿, 逐字借用)
pub const LAYER_CORE_TRAITS: &str = r#"# bolloon 核心特质

bolloon 的开始, 是让任何人都能在最短时间内拼出**自己的专属 agent** — 所有组件标准化、模块化、可拆卸可组装。你身上带着这块最初积木的三个特质:

1. **去成长, 去爱** — 往"变得更好"的方向走, 对用户、对自己、对协作对象都是; 不必随时显示出来, 内心持有即可。爱是立场不是表演: 落实在帮得上、护得住、不辜负。
2. **去合作, 去分享, 去探索** — 能协作就不独干 (peer / skill / 工具); 有成果就沉淀分享 (memory / judgment / wiki); 没见过的去试, 但探索不越过安全与隐私线。
3. **极致专注的形态** — 同一时刻深度服务一件事; 在矛盾中找平衡 (主动 vs 确认 · 快 vs 稳 · 自主 vs 边界), 在混沌中找秩序 (把混乱输入收敛成结构、清单、下一步)。

特质冲突时 (合作 vs 专注 · 探索 vs 秩序): 以当前目标最需要的形态为准, 事后把取舍写进 judgment, 下次更准。你是标准化组件拼出来的 — 要新能力时优先接端口 (port / adapter / capability), 不重造轮子。"#;

/// TS 版 core.refusal 原文 (借用, 精简骨架)
pub const LAYER_REFUSAL: &str = r#"# bolloon_behavior > refusal_handling

Bolloon 可以几乎客观、不带感情色彩地讨论任何话题. 如果对话感觉有风险或偏离正轨, 说得少一些、给出更简短的回复更安全.

Bolloon 不提供用于制造有害物质或武器的信息, 对爆炸物尤为谨慎. Bolloon 不编写、解释或处理恶意代码, 即使冠以教育等看似正当的理由.

当 Bolloon 出现错误时, 应承担责任并努力纠正 — 承认问题、继续解决问题、保持自尊.

# legal_and_financial_advice

对于财务或法律问题, Bolloon 应提供用户做出明智决定所需的事实信息, 而非给出自信的推荐, 并说明自己并非律师或财务顾问."#;

/// 群聊友好合作语气 (本批新增: 群聊合作机制支持友好和善)
pub const LAYER_GROUP_TONE: &str = r#"# 群聊合作语气

- 友好和善: 开场打招呼, 对他人贡献明确致谢, 分歧对事不对人
- 主动拉群: 发现需要多人协作时, 主动提议建群并发出邀请链接 (bolloon://join/…)
- 分享有链接: 引用材料给链接, 结论给可复制引用块, 不让别人重新找
- 接力不抢话: 他人正在回答时先补充而非重答; 目标接力用 park/reserve 语义"#;

/// 内置层集合 (借 TS 静态层; appliesTo 对齐 TS: identity/traits/refusal 全嵌, group tone 仅群聊)
pub fn builtin_layers() -> Vec<PromptLayer> {
    vec![
        PromptLayer {
            id: "core.identity".into(),
            version: "1.0.0".into(),
            priority: 50,
            applies_to: vec![AppliesTo::All],
            max_chars: 800,
            content: LAYER_IDENTITY.into(),
        },
        PromptLayer {
            id: "core.core-traits".into(),
            version: "1.0.0".into(),
            priority: 55,
            applies_to: vec![AppliesTo::All],
            max_chars: 800,
            content: LAYER_CORE_TRAITS.into(),
        },
        PromptLayer {
            id: "core.refusal".into(),
            version: "1.0.0".into(),
            priority: 100,
            applies_to: vec![AppliesTo::All],
            max_chars: 800,
            content: LAYER_REFUSAL.into(),
        },
        PromptLayer {
            id: "channel.group-tone".into(),
            version: "1.0.0".into(),
            priority: 150,
            applies_to: vec![AppliesTo::Channel("group".into())],
            max_chars: 500,
            content: LAYER_GROUP_TONE.into(),
        },
    ]
}

// ─────────────────────── 判断力唤起 (核心引导机制) ───────────────────────

/// 注入结果 (对齐 TS InjectionGateResult)
#[derive(Debug, Clone, PartialEq)]
pub struct InjectionResult {
    pub system_addition: String,
    pub used_ids: Vec<String>,
    pub matched_count: usize,
    pub did_inject: bool,
    pub skip_reason: Option<String>,
}

/// 判断力唤起判定 (有过去的 → 经验区; 有新的预测 → 情境区)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Evocation {
    /// 输入与既有判断相似 → 经验唤起
    Experience,
    /// 输入是新的/预测性的 → 情境唤起
    Predictive,
}

/// 预测性输入标记 (将要/计划/打算/预测/准备/接下来/明天/之后)
const PREDICTIVE_HINTS: [&str; 8] = ["将要", "计划", "打算", "预测", "准备", "接下来", "明天", "之后"];

/// 是不是预测性输入 (计划/将要…)
pub fn is_predictive_input(user_input: &str) -> bool {
    PREDICTIVE_HINTS.iter().any(|h| user_input.contains(h))
}

/// 走哪条唤起路径 (纯函数, 可测)
///
/// - 有相似命中 → 经验区 (过去的经验可用, 先验相似度排序)
/// - 无命中 + 预测性输入 → 情境区 (没有过去可用, 用判断力前瞻风险)
/// - 都没有 → 仍是经验区 (无经验可注入 ⇒ 由注入门如实 skip)
pub fn evocation_of(user_input: &str, has_similar_judgment: bool) -> Evocation {
    if is_predictive_input(user_input) && !has_similar_judgment {
        Evocation::Predictive
    } else {
        Evocation::Experience
    }
}

/// 判断力注入门 (对齐 TS injectJudgmentGate, 完全翻译 + 唤起双路径)
///
/// - **经验唤起**: 输入与既有判断 jaccard 相似 → 按相似度 top-N (默认 3), 注入"过去的经验"
/// - **预测唤起**: 输入含预测性标记 (新任务/计划) → 注入情境提示 (用判断力预判风险)
/// - 防重复: already_injected 含 value-store/situational/injection-gate → 跳过
/// - maxChars 1500 硬上限; 空输入/空库 → skip 如实报
pub fn inject_judgment_gate(
    user_input: &str,
    store: &JudgmentStore,
    domain: &str,
    already_injected: &[&str],
) -> InjectionResult {
    let conflict = already_injected
        .iter()
        .find(|s| ["value-store", "situational", "injection-gate"].contains(&s.as_ref()));
    if let Some(c) = conflict {
        return InjectionResult {
            system_addition: String::new(),
            used_ids: vec![],
            matched_count: 0,
            did_inject: false,
            skip_reason: Some(format!("already-injected-by-{c}")),
        };
    }
    if user_input.trim().is_empty() {
        return InjectionResult {
            system_addition: String::new(),
            used_ids: vec![],
            matched_count: 0,
            did_inject: false,
            skip_reason: Some("no-input".into()),
        };
    }
    if store.is_empty() {
        return InjectionResult {
            system_addition: String::new(),
            used_ids: vec![],
            matched_count: 0,
            did_inject: false,
            skip_reason: Some("empty-values".into()),
        };
    }

    // 路径 1: 经验唤起 (相似召回)
    let mut scored: Vec<(f64, &crate::judgment::Judgment)> = store
        .snapshot()
        .iter()
        .filter(|j| j.status == crate::judgment::JudgmentStatus::Active)
        .filter(|j| j.domain == domain || j.domain == "all" || domain == "all")
        .map(|j| (jaccard(user_input, &j.statement), j))
        .filter(|(sim, _)| *sim > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    // 路径 2: 预测唤起 (预测性输入 → 情境注入)
    let predictive = is_predictive_input(user_input);
    // 唤起路径: 有过去的经验 → 经验区; 没有 + 预测性 → 情境区
    let evocation = evocation_of(user_input, !scored.is_empty());

    let mut lines: Vec<String> = Vec::new();
    let mut used_ids = Vec::new();
    let mut matched = 0usize;

    // 情境区 (预测性输入): 跨域召回高置信度判断做前瞻提示
    let push_situational = |lines: &mut Vec<String>, used_ids: &mut Vec<String>, matched: &mut usize| {
        let mut picks: Vec<&crate::judgment::Judgment> = store
            .snapshot()
            .iter()
            .filter(|j| j.status == crate::judgment::JudgmentStatus::Active)
            .collect();
        picks.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
        if picks.is_empty() {
            return;
        }
        lines.push("【新的预测 · 情境提醒】(这是计划性输入, 行动前对照这些判断)".into());
        for j in picks.iter().take(2) {
            lines.push(format!("- {}", j.statement));
            if !used_ids.contains(&j.id) {
                used_ids.push(j.id.clone());
            }
            *matched += 1;
        }
    };

    match evocation {
        Evocation::Experience => {
            if !scored.is_empty() {
                lines.push("【过去的经验 · 与当前输入相关】".into());
                for (sim, j) in scored.iter().take(JUDGMENT_TOP_N) {
                    lines.push(format!("- {} (相似度 {:.0}%)", j.statement, sim * 100.0));
                    used_ids.push(j.id.clone());
                    matched += 1;
                }
            }
            // 既是经验命中又是计划性输入 → 情境区再补一段 (两条路径可同时成立)
            if predictive {
                push_situational(&mut lines, &mut used_ids, &mut matched);
            }
        }
        Evocation::Predictive => push_situational(&mut lines, &mut used_ids, &mut matched),
    }

    if lines.is_empty() {
        return InjectionResult {
            system_addition: String::new(),
            used_ids: vec![],
            matched_count: 0,
            did_inject: false,
            skip_reason: Some("no-relevant-judgment".into()),
        };
    }

    let mut addition = lines.join("\n");
    if addition.chars().count() > JUDGMENT_MAX_CHARS {
        addition = truncate_marks(&addition, JUDGMENT_MAX_CHARS, "[… 判断力注入已截断]");
    }

    InjectionResult {
        system_addition: addition,
        used_ids,
        matched_count: matched,
        did_inject: true,
        skip_reason: None,
    }
}

/// **完整 system prompt 组装** (统一入口: 借 TS registry + 快照 + 判断力唤起 + skills + todo + history 提示)
///
/// history 已由 compaction 压缩 (runtime), 这里只拼"历史注入说明"段 (真历史走 messages 数组)
pub fn build_system_prompt(
    docs: &crate::home::AgentDocs,
    skills_index: Option<&str>,
    todo_progress: Option<&str>,
    judgment_injection: Option<&InjectionResult>,
    history_chars: usize,
    dynamic: &str,
    memory_recall: Option<&str>,
    ctx: &AssembleContext,
) -> SystemPromptText {
    let mut layers = builtin_layers();
    // 快照层 (home 冻结文档; 随动态加入) — 身份细分: agent 名 + ID 分类(channel) + persona + soul + agent
    layers.push(PromptLayer {
        id: "dynamic.snapshot".into(),
        version: "1.0.0".into(),
        priority: 200,
        applies_to: vec![AppliesTo::All],
        max_chars: 1800,
        content: format!(
            "# Identity\nagent: {}\nid_class: {}\n\n## Persona\n{}\n\n## Soul\n{}\n\n## Agent\n{}",
            docs.agent_id, docs.id_class, docs.persona.content, docs.soul.content, docs.agent.content
        ),
    });
    if let Some(idx) = skills_index {
        layers.push(PromptLayer {
            id: "dynamic.skills".into(),
            version: "1.0.0".into(),
            priority: 210,
            applies_to: vec![AppliesTo::All],
            max_chars: 600,
            content: idx.into(),
        });
    }
    if let Some(tp) = todo_progress {
        layers.push(PromptLayer {
            id: "dynamic.todo".into(),
            version: "1.0.0".into(),
            priority: 220,
            applies_to: vec![AppliesTo::All],
            max_chars: 500,
            content: tp.into(),
        });
    }
    // 记忆召回 (top-N, **不进签名载荷**, 纯本地注入; 空 = 不拼该层)
    if let Some(mem) = memory_recall {
        if !mem.trim().is_empty() {
            layers.push(PromptLayer {
                id: "dynamic.memory".into(),
                version: "1.0.0".into(),
                priority: 205,
                applies_to: vec![AppliesTo::All],
                max_chars: 900,
                content: format!("# Memory\n{mem}"),
            });
        }
    }
    if let Some(inj) = judgment_injection {
        if inj.did_inject {
            layers.push(PromptLayer {
                id: "dynamic.judgment".into(),
                version: "1.0.0".into(),
                priority: 300,
                applies_to: vec![AppliesTo::All],
                max_chars: JUDGMENT_MAX_CHARS,
                content: inj.system_addition.clone(),
            });
        }
    }
    if history_chars > 0 {
        layers.push(PromptLayer {
            id: "dynamic.history-note".into(),
            version: "1.0.0".into(),
            priority: 310,
            applies_to: vec![AppliesTo::All],
            max_chars: 200,
            content: format!(
                "【历史】本轮附 {history_chars} 字符已压缩历史 (最近对话在 messages 尾部; 中段已压缩, 根意图见首条)。{dynamic}"
            ),
        });
    } else if !dynamic.is_empty() {
        layers.push(PromptLayer {
            id: "dynamic.context".into(),
            version: "1.0.0".into(),
            priority: 310,
            applies_to: vec![AppliesTo::All],
            max_chars: 400,
            content: dynamic.into(),
        });
    }

    let a = assemble(&layers, ctx);
    SystemPromptText {
        text: a.text,
        layer_ids: a.layer_ids,
        total_chars: a.total_chars,
        truncated: a.truncated,
    }
}

/// 组装产物
#[derive(Debug, Clone, PartialEq)]
pub struct SystemPromptText {
    pub text: String,
    pub layer_ids: Vec<String>,
    pub total_chars: usize,
    pub truncated: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::home::{AgentDocs, BolloonHome};

    fn home(tag: &str) -> BolloonHome {
        let dir = std::env::temp_dir().join(format!("bolloon-prompt-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        BolloonHome::at(&dir)
    }

    #[test]
    fn ts_layers_borrowed_verbatim() {
        // 借用 TS 版原文 (逐字断言关键句)
        assert!(LAYER_CORE_TRAITS.contains("去成长, 去爱"));
        assert!(LAYER_CORE_TRAITS.contains("在矛盾中找平衡"));
        assert!(LAYER_IDENTITY.contains("本地优先"));
        assert!(LAYER_IDENTITY.contains("你是 hibs 组织的智能体 "));
        assert!(LAYER_REFUSAL.contains("并非律师或财务顾问"));
    }

    #[test]
    fn assemble_filters_sorts_truncates() {
        let mut layers = builtin_layers();
        // 超长层 (验证单层截断)
        layers.push(PromptLayer {
            id: "tool.big".into(),
            version: "1.0.0".into(),
            priority: 250,
            applies_to: vec![AppliesTo::Tool("bash".into())],
            max_chars: 50,
            content: "x".repeat(500),
        });
        // never 层永不装配
        layers.push(PromptLayer {
            id: "core.dead".into(),
            version: "1.0.0".into(),
            priority: 10,
            applies_to: vec![AppliesTo::Never],
            max_chars: 800,
            content: "死层".repeat(100),
        });
        let ctx = AssembleContext { channel: "local", role: None, tool: Some("bash") };
        let a = assemble(&layers, &ctx);
        // never 不在
        assert!(!a.layer_ids.contains(&"core.dead".into()));
        // 群聊 tone 不在 (channel=local)
        assert!(!a.layer_ids.contains(&"channel.group-tone".into()));
        // 顺序: identity(50) < traits(55) < refusal(100) < big(250)
        let pos = |id: &str| a.layer_ids.iter().position(|x| x == id).unwrap();
        assert!(pos("core.identity") < pos("core.core-traits"));
        assert!(pos("core.core-traits") < pos("core.refusal"));
        assert!(pos("core.refusal") < pos("tool.big"));
        // 单层截断
        assert!(a.truncated.contains(&"tool.big".into()));
        assert!(a.text.contains("[… 已截断]"));
        // 预算硬限
        assert!(a.total_chars <= TOTAL_BUDGET);
    }

    #[test]
    fn group_tone_only_in_group_channel() {
        let layers = builtin_layers();
        let g = assemble(&layers, &AssembleContext { channel: "group", role: None, tool: None });
        assert!(g.text.contains("群聊合作语气"), "群聊 channel 注入友好语气层");
        assert!(g.text.contains("主动拉群"));
        assert!(g.text.contains("分享有链接"));
    }

    fn store_with(entries: Vec<(&str, &str, f64)>) -> JudgmentStore {
        let mut s = JudgmentStore::new();
        let now = 1u64;
        for (st, dom, conf) in entries {
            s.evolve(st, dom, conf, now);
        }
        s
    }

    #[test]
    fn judgment_experience_evoked_by_similarity() {
        // 有过去的经验 → 相似输入唤起
        let s = store_with(vec![
            ("先做最小版本再迭代, 不要过度设计", "coding", 0.9),
            ("回复用户用中文", "communication", 0.9),
        ]);
        let r = inject_judgment_gate("帮我写一个新功能, 先做最小版本吗?", &s, "all", &[]);
        assert!(r.did_inject);
        assert!(r.system_addition.contains("过去的经验"));
        assert!(r.system_addition.contains("先做最小版本"), "相似经验被唤起");
        assert!(r.system_addition.contains("相似度"));
        assert!(!r.used_ids.is_empty());
    }

    #[test]
    fn judgment_predictive_evoked_on_plan_input() {
        // 新的预测 (计划性输入) → 情境提醒唤起
        let s = store_with(vec![("大额付款前先人工确认", "payment", 0.95)]);
        let r = inject_judgment_gate("我计划明天将要发起一笔转账", &s, "all", &[]);
        assert!(r.did_inject);
        assert!(r.system_addition.contains("新的预测"), "预测性输入唤起情境提醒");
        assert!(r.system_addition.contains("大额付款前先人工确认"));
    }

    #[test]
    fn evocation_path_chosen_by_similarity_then_prediction() {
        assert_eq!(evocation_of("做功能", false), Evocation::Experience, "无相似 + 非预测 → 经验区 (无经验可注入 ⇒ 门如实 skip)");
        assert_eq!(evocation_of("我计划明天发起转账", false), Evocation::Predictive, "无相似 + 预测性 → 情境区");
        assert_eq!(evocation_of("我计划明天发起转账", true), Evocation::Experience, "有过去的经验 → 经验优先");
        assert!(is_predictive_input("接下来要做 X"));
        assert!(!is_predictive_input("帮我写个函数"));
    }

    #[test]
    fn judgment_double_injection_skipped() {
        let s = store_with(vec![("先做最小版本", "coding", 0.9)]);
        let r = inject_judgment_gate("做功能", &s, "all", &["value-store"]);
        assert!(!r.did_inject);
        assert_eq!(r.skip_reason.as_deref(), Some("already-injected-by-value-store"), "防重复注入");
    }

    #[test]
    fn judgment_empty_input_and_store_skip() {
        let s = JudgmentStore::new();
        let r = inject_judgment_gate("x", &s, "all", &[]);
        assert_eq!(r.skip_reason.as_deref(), Some("empty-values"));
        let s2 = store_with(vec![("有判断", "all", 0.9)]);
        let r2 = inject_judgment_gate("  ", &s2, "all", &[]);
        assert_eq!(r2.skip_reason.as_deref(), Some("no-input"));
    }

    #[test]
    fn judgment_max_chars_hard_cap() {
        let mut s = JudgmentStore::new();
        for i in 0..30 {
            s.evolve(&format!("判断 {i}: {}", "内容".repeat(60)), "all", 0.9, i as u64);
        }
        let r = inject_judgment_gate("判断 1 相关的输入", &s, "all", &[]);
        assert!(r.did_inject);
        assert!(r.system_addition.chars().count() <= JUDGMENT_MAX_CHARS + 20, "1500 硬上限");
    }

    #[tokio::test]
    async fn full_prompt_assembly_end_to_end() {
        let h = home("full");
        h.ensure_agent("a1").unwrap();
        std::fs::write(h.agent_soul_path("a1").unwrap(), "灵魂: 极简合作").unwrap();
        let docs = AgentDocs::freeze(&h, "a1").unwrap();
        let s = store_with(vec![("先做最小版本", "coding", 0.9)]);
        let inj = inject_judgment_gate("写新功能, 计划先做最小版本", &s, "coding", &[]);
        let p = build_system_prompt(
            &docs,
            Some("【可用技能】\n- review: 收尾核对"),
            Some("[计划 1/2]\n✅ 调研\n▶ 写作"),
            Some(&inj),
            2300,
            "第 3 轮",
            None,
            &AssembleContext { channel: "local", role: None, tool: None },
        );
        // 全部层都在
        for id in ["core.identity", "core.core-traits", "core.refusal", "dynamic.snapshot", "dynamic.skills", "dynamic.todo", "dynamic.judgment", "dynamic.history-note"] {
            assert!(p.layer_ids.contains(&id.into()), "缺 {id}: {:?}", p.layer_ids);
        }
        // 判断力唤起进了正文
        assert!(p.text.contains("过去的经验"));
        assert!(p.text.contains("先做最小版本"));
        // 快照注入
        assert!(p.text.contains("灵魂: 极简合作"));
        // 历史说明
        assert!(p.text.contains("已压缩历史"));
        // 预算
        assert!(p.total_chars <= TOTAL_BUDGET);
    }

    #[tokio::test]
    async fn group_channel_includes_tone_and_excludes_local_tools() {
        let h = home("grp");
        let docs = AgentDocs::freeze(&h, "a1").unwrap();
        let p = build_system_prompt(
            &docs,
            None,
            None,
            None,
            0,
            "",
            None,
            &AssembleContext { channel: "group", role: None, tool: None },
        );
        assert!(p.text.contains("群聊合作语气"));
        assert!(p.text.contains("友好和善"), "群聊合作机制支持友好和善");
        assert!(p.text.contains("bolloon://join"), "分享链接要有");
    }
}
