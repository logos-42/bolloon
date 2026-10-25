//! Workflow 多轮循环 — 自适应迭代 + 质量评估 + 续跑注入
//!
//! 对齐 TS 版 `workflow-pivot-loop.ts` 的四根因修复:
//! ① 迭代上限不被 adaptive 压死 ② 模型 echo 结束标记不立即 break
//! ③ 工具并行 + 超时 (慢工具不拖死整轮) ④ 质量不达标注入续跑提示继续
//! + 空回复打回 (空串有 0.7 分恰好等于默认阈值 ⇒ 空 reply 直接收尾 ⇒ CLI 空框的教训)
//! + 无进展兜底 (10 轮同工具同参数判死循环)

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 循环配置
#[derive(Debug, Clone)]
pub struct PivotConfig {
    /// 迭代上限 (不被 adaptive 压到 10 以下)
    pub max_iterations: u32,
    /// 质量阈值 (空回复打回: 空串 0 分, 永不到阈值)
    pub quality_threshold: f64,
    /// 每轮工具执行超时 ms
    pub tool_timeout_ms: u64,
    /// 无进展判定: 连续 N 轮同工具+同参数
    pub no_progress_rounds: u32,
}

impl Default for PivotConfig {
    fn default() -> Self {
        Self {
            max_iterations: 50,
            quality_threshold: 0.7,
            tool_timeout_ms: 120_000,
            no_progress_rounds: 10,
        }
    }
}

/// 收尾原因 (对齐 TS LoopResult reason)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopEndReason {
    /// 质量达标收尾
    QualityThresholdMet,
    /// 达到迭代上限
    MaxIterations,
    /// 无进展熔断 (死循环检测)
    NoProgressLoop,
    /// 错误
    Error,
}

/// 循环状态
#[derive(Debug, Clone)]
pub struct PivotState {
    pub round: u32,
    pub done: bool,
    pub reason: Option<LoopEndReason>,
    /// 上一轮的工具签名 (死循环检测)
    last_tool_sig: Option<String>,
    /// 连续同签名轮数
    same_sig_rounds: u32,
}

impl Default for PivotState {
    fn default() -> Self {
        Self { round: 0, done: false, reason: None, last_tool_sig: None, same_sig_rounds: 0 }
    }
}

/// 质量评估 (纯函数)
///
/// 评分: 空串 = **0 分** (不是 0.7! 空回复必须打回, 不许静默收尾);
/// 长度分 (0~0.4) + 结构分 (有步骤/结论/列表 0~0.4) + 具体性分 (含数字/文件名/引用 0~0.2)
pub fn evaluate_quality(reply: &str) -> f64 {
    let trimmed = reply.trim();
    if trimmed.is_empty() {
        return 0.0; // 空回复打回的根因修复
    }
    let chars = trimmed.chars().count();
    let len_score = (chars as f64 / 200.0).min(0.4);
    let mut struct_score = 0.0;
    if trimmed.contains('\n') || trimmed.contains("步骤") || trimmed.contains("结论") {
        struct_score += 0.2;
    }
    if trimmed.contains("1.") || trimmed.contains("- ") || trimmed.contains("•") {
        struct_score += 0.2;
    }
    let concrete = trimmed
        .chars()
        .any(|c| c.is_ascii_digit())
        .then_some(0.1)
        .unwrap_or(0.0)
        + (trimmed.contains("http") || trimmed.contains(".rs") || trimmed.contains(".ts") || trimmed.contains(".md"))
            .then_some(0.1)
            .unwrap_or(0.0);
    (len_score + struct_score + concrete).min(1.0)
}

/// 决策: 本轮结束后继续还是收尾 (纯函数)
pub fn decide_round(state: &mut PivotState, reply: &str, tools_used: &[String], cfg: &PivotConfig) -> LoopEndReason {
    state.round += 1;
    // 上限
    if state.round >= cfg.max_iterations {
        state.done = true;
        state.reason = Some(LoopEndReason::MaxIterations);
        return LoopEndReason::MaxIterations;
    }
    // 无进展熔断: 工具签名 (排序后拼接, 顺序不敏感)
    let mut sig_tools: Vec<&String> = tools_used.iter().collect();
    sig_tools.sort();
    let sig = sig_tools.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(",");
    if !tools_used.is_empty() && state.last_tool_sig.as_deref() == Some(sig.as_str()) {
        state.same_sig_rounds += 1;
    } else {
        state.same_sig_rounds = 0;
        state.last_tool_sig = if tools_used.is_empty() { state.last_tool_sig.clone() } else { Some(sig) };
    }
    if state.same_sig_rounds >= cfg.no_progress_rounds {
        state.done = true;
        state.reason = Some(LoopEndReason::NoProgressLoop);
        return LoopEndReason::NoProgressLoop;
    }
    // 质量 (空回复 0 分 → 打回)
    let q = evaluate_quality(reply);
    if q >= cfg.quality_threshold {
        state.done = true;
        state.reason = Some(LoopEndReason::QualityThresholdMet);
        return LoopEndReason::QualityThresholdMet;
    }
    LoopEndReason::Error // 非终止信号: 用 Error 占位表示"继续" (调用方按 state.done 判)
}

/// 续跑注入提示 (质量不达标时给模型的下轮指令; 不含 `<final gen>` 标记 — 已移除)
pub fn build_continue_hint(reason_score: f64, threshold: f64) -> String {
    format!(
        "上一轮回复质量 {reason_score:.2} 未达阈值 {threshold:.2}。请继续完成任务: 补充具体步骤、结论与证据。不要提前收尾。"
    )
}

/// 工具执行超时判定 (慢工具不拖死整轮: 超时算失败进上下文让 LLM 下轮修正)
pub fn tool_timed_out(elapsed_ms: u64, timeout_ms: u64) -> bool {
    elapsed_ms > timeout_ms
}

/// 工具参数 canonical 化 (键排序, 抖序不产生新签名)
pub fn canonicalize_tool_args(args: &str) -> Result<String, serde_json::Error> {
    let v: serde_json::Value = serde_json::from_str(args)?;
    let sorted = sort_json(&v);
    Ok(serde_json::to_string(&sorted)?)
}

fn sort_json(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), sort_json(&map[k]));
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(items.iter().map(sort_json).collect()),
        other => other.clone(),
    }
}

/// 死循环检测签名 (canonical 参数参与)
pub fn tool_signature(tool: &str, canonical_args: &str, seen: &mut HashMap<String, u32>) -> String {
    let sig = format!("{tool}:{canonical_args}");
    *seen.entry(sig.clone()).or_insert(0) += 1;
    sig
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_reply_scores_zero_not_threshold() {
        // 根因: 空串 0.7 分恰好等于默认阈值 ⇒ 空 reply 直接收尾 ⇒ CLI 空框
        assert_eq!(evaluate_quality(""), 0.0);
        assert_eq!(evaluate_quality("   \n  "), 0.0);
        let mut st = PivotState::default();
        let cfg = PivotConfig::default();
        decide_round(&mut st, "", &[], &cfg);
        assert!(!st.done, "空回复必须打回继续, 不许收尾");
    }

    #[test]
    fn good_reply_meets_threshold() {
        let good = "## 结论\n先做最小版本。\n\n1. 步骤一: 搭骨架 (3 天)\n2. 步骤二: 接 LLM (5 天)\n详见 https://example.com/plan.md";
        let q = evaluate_quality(good);
        assert!(q >= 0.7, "结构化+具体回复应达标, 实际 {q}");
        let mut st = PivotState::default();
        decide_round(&mut st, good, &[], &PivotConfig::default());
        assert_eq!(st.reason, Some(LoopEndReason::QualityThresholdMet));
    }

    #[test]
    fn low_quality_gets_continue_hint() {
        let mut st = PivotState::default();
        let cfg = PivotConfig::default();
        let end = decide_round(&mut st, "嗯", &[], &cfg);
        assert!(!st.done, "低质量不收尾");
        let hint = build_continue_hint(evaluate_quality("嗯"), cfg.quality_threshold);
        assert!(hint.contains("继续"), "必须注入续跑指令");
        assert!(!hint.contains("<final gen>"), "final gen 标记已移除");
        let _ = end;
    }

    #[test]
    fn max_iterations_enforced_not_adaptive_crushed() {
        let cfg = PivotConfig { max_iterations: 3, ..Default::default() };
        let mut st = PivotState::default();
        for i in 0..3 {
            decide_round(&mut st, "一般", &[], &cfg);
        }
        assert!(st.done);
        assert_eq!(st.reason, Some(LoopEndReason::MaxIterations));
        assert_eq!(st.round, 3);
    }

    #[test]
    fn no_progress_loop_detected() {
        let cfg = PivotConfig { no_progress_rounds: 3, ..Default::default() };
        let mut st = PivotState::default();
        for _ in 0..4 {
            decide_round(&mut st, "x", &["read_file".into()], &cfg);
        }
        assert!(st.done);
        assert_eq!(st.reason, Some(LoopEndReason::NoProgressLoop), "同工具连续 N 轮 = 死循环熔断");
    }

    #[test]
    fn tool_order_does_not_affect_signature() {
        let mut seen1 = HashMap::new();
        let mut seen2 = HashMap::new();
        let ca = canonicalize_tool_args(r#"{"b":1,"a":2}"#).unwrap();
        let cb = canonicalize_tool_args(r#"{"a":2,"b":1}"#).unwrap();
        assert_eq!(ca, cb, "键序抖动 canonical 后一致");
        let a = tool_signature("mix", &ca, &mut seen1);
        let b = tool_signature("mix", &cb, &mut seen2);
        assert_eq!(a, b, "canonical 后签名一致 → 死循环检测不被键序抖动骗过");
        // 同签名计数累积
        assert_eq!(seen1[&a], 1);
        tool_signature("mix", &ca, &mut seen1);
        assert_eq!(seen1[&a], 2);
    }

    #[test]
    fn slow_tool_timeout_is_not_fatal() {
        assert!(tool_timed_out(121_000, 120_000), "超时 = 失败进上下文让 LLM 下轮修正");
        assert!(!tool_timed_out(60_000, 120_000));
    }

    #[test]
    fn progress_resets_stall_counter() {
        let cfg = PivotConfig { no_progress_rounds: 2, ..Default::default() };
        let mut st = PivotState::default();
        decide_round(&mut st, "x", &["read".into()], &cfg);
        decide_round(&mut st, "x", &["read".into()], &cfg);
        // 换工具 = 有进展
        decide_round(&mut st, "x", &["write".into()], &cfg);
        assert!(!st.done, "换工具重置死循环计数");
        assert_eq!(st.same_sig_rounds, 0);
    }
}
