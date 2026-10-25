//! 判断力资产 — 5 维评分 + x402 化打包/调用还原
//!
//! 对齐 TS 版 `judgeness/` (paid-export.ts / call-service.ts):
//! - 判断力 = 可售卖资产: 5 维评分 (taste/evidence/novelty/judgment/value) + basis + scope
//! - 打包 → 可售卖 markdown → 调用侧还原 (打包往返无损)
//! - 调用 = 资产注入 system → 对问题输出裁决 (verdict/confidence/reasoning)

use serde::{Deserialize, Serialize};

/// 判断力资产
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JudgenessAsset {
    pub id: String,
    pub title: String,
    /// 5 维评分 (0.0~1.0)
    pub scores: JudgenessScores,
    /// 评分依据
    pub basis: String,
    /// 适用范围 (什么场景该用这个判断力)
    pub scope: String,
    /// 判断正文的稳定锚 (核心主张)
    pub core_claim: String,
    pub provider_did: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JudgenessScores {
    /// 品味 (选什么不选什么)
    pub taste: f64,
    /// 证据密度
    pub evidence: f64,
    /// 新颖度
    pub novelty: f64,
    /// 判断质量 (裁决可信度)
    pub judgment: f64,
    /// 价值密度
    pub value: f64,
}

/// 裁决
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Approve,
    Reject,
    Modify,
    Escalate,
    Hold,
}

/// 调用输出
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JudgmentCall {
    pub verdict: Verdict,
    /// 0.0~1.0
    pub confidence: f64,
    pub reasoning: String,
}

/// 资产错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum JudgenessError {
    #[error("评分越界: {0} = {1} (必须 0.0~1.0)")]
    ScoreOutOfRange(String, f64),
    #[error("无法解析打包文本: {0}")]
    Unparseable(String),
    #[error("verdict 非法: {0}")]
    BadVerdict(String),
}

impl JudgenessAsset {
    /// 校验评分全部在 [0,1]
    pub fn validate(&self) -> Result<(), JudgenessError> {
        let check = |name: &str, v: f64| {
            if !(0.0..=1.0).contains(&v) {
                return Err(JudgenessError::ScoreOutOfRange(name.into(), v));
            }
            Ok(())
        };
        check("taste", self.scores.taste)?;
        check("evidence", self.scores.evidence)?;
        check("novelty", self.scores.novelty)?;
        check("judgment", self.scores.judgment)?;
        check("value", self.scores.value)?;
        Ok(())
    }
}

/// 打包 → 可售卖 markdown (结构化文本, 调用侧可还原)
pub fn to_paid_markdown(asset: &JudgenessAsset) -> String {
    format!(
        "<!-- jd:{} -->\n# 判断力: {}\n\n**核心主张**: {}\n\n## 评分\n- taste: {:.2}\n- evidence: {:.2}\n- novelty: {:.2}\n- judgment: {:.2}\n- value: {:.2}\n\n## 依据\n{}\n\n## 适用范围\n{}\n\nprovider: {} | issued: {}\n",
        asset.id,
        asset.title,
        asset.core_claim,
        asset.scores.taste,
        asset.scores.evidence,
        asset.scores.novelty,
        asset.scores.judgment,
        asset.scores.value,
        asset.basis,
        asset.scope,
        asset.provider_did,
        asset.created_at_ms,
    )
}

/// 从打包文本还原 (调用侧; 解析不出如实报错不猜)
pub fn parse_paid_markdown(md: &str) -> Result<JudgenessAsset, JudgenessError> {
    let id = md
        .strip_prefix("<!-- jd:")
        .and_then(|s| s.split("-->").next())
        .ok_or_else(|| JudgenessError::Unparseable("缺资产 id 头".into()))?
        .trim()
        .to_string();
    if id.is_empty() {
        return Err(JudgenessError::Unparseable("资产 id 为空".into()));
    }
    let title = md
        .lines()
        .find(|l| l.starts_with("# 判断力: "))
        .map(|l| l.trim_start_matches("# 判断力: ").to_string())
        .ok_or_else(|| JudgenessError::Unparseable("缺标题".into()))?;
    let core_claim = md
        .lines()
        .find(|l| l.starts_with("**核心主张**: "))
        .map(|l| l.trim_start_matches("**核心主张**: ").to_string())
        .ok_or_else(|| JudgenessError::Unparseable("缺核心主张".into()))?;
    let score = |name: &str| -> Result<f64, JudgenessError> {
        md.lines()
            .find(|l| l.starts_with(&format!("- {name}: ")))
            .and_then(|l| l.split(": ").nth(1))
            .and_then(|v| v.trim().parse::<f64>().ok())
            .ok_or_else(|| JudgenessError::Unparseable(format!("缺评分 {name}")))
    };
    let scores = JudgenessScores {
        taste: score("taste")?,
        evidence: score("evidence")?,
        novelty: score("novelty")?,
        judgment: score("judgment")?,
        value: score("value")?,
    };
    let provider_did = md
        .lines()
        .find(|l| l.starts_with("provider: "))
        .map(|l| {
            l.trim_start_matches("provider: ")
                .split(" | ")
                .next()
                .unwrap_or("")
                .to_string()
        })
        .ok_or_else(|| JudgenessError::Unparseable("缺 provider".into()))?;
    let created_at_ms: u64 = md
        .lines()
        .find(|l| l.starts_with("provider: "))
        .and_then(|l| l.rsplit("issued: ").next())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let basis = section(md, "## 依据\n", "\n## ");
    let scope = section(md, "## 适用范围\n", "\nprovider:");
    Ok(JudgenessAsset {
        id,
        title,
        scores,
        basis,
        scope,
        core_claim,
        provider_did,
        created_at_ms,
    })
}

fn section(md: &str, start: &str, end: &str) -> String {
    md.find(start)
        .map(|i| {
            let rest = &md[i + start.len()..];
            match rest.find(end) {
                Some(j) => rest[..j].trim().to_string(),
                None => rest.trim().to_string(),
            }
        })
        .unwrap_or_default()
}

/// verdict 解析 (容错: json 围栏/杂讯/非法如实报错)
pub fn parse_verdict(text: &str) -> Result<JudgmentCall, JudgenessError> {
    // 剥 json 围栏
    let inner = text.trim();
    let inner = inner
        .strip_prefix("```json")
        .or_else(|| inner.strip_prefix("```"))
        .unwrap_or(inner)
        .trim_end_matches("```")
        .trim();
    let v: serde_json::Value = serde_json::from_str(inner)
        .map_err(|e| JudgenessError::Unparseable(format!("非 JSON: {e}")))?;
    let verdict_str = v["verdict"].as_str().unwrap_or("").to_lowercase();
    let verdict = match verdict_str.as_str() {
        "approve" => Verdict::Approve,
        "reject" => Verdict::Reject,
        "modify" => Verdict::Modify,
        "escalate" => Verdict::Escalate,
        "hold" => Verdict::Hold,
        other => return Err(JudgenessError::BadVerdict(other.to_string())),
    };
    Ok(JudgmentCall {
        verdict,
        confidence: v["confidence"].as_f64().unwrap_or(0.0).clamp(0.0, 1.0),
        reasoning: v["reasoning"].as_str().unwrap_or("").to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset() -> JudgenessAsset {
        JudgenessAsset {
            id: "jd-0001".into(),
            title: "先做最小版本".into(),
            scores: JudgenessScores { taste: 0.9, evidence: 0.7, novelty: 0.5, judgment: 0.92, value: 0.8 },
            basis: "多次项目复盘: 大而全首版从未按时交付".into(),
            scope: "新功能首版决策".into(),
            core_claim: "先做最小版本再迭代, 不要过度设计".into(),
            provider_did: "did:pi:seller".into(),
            created_at_ms: 42,
        }
    }

    #[test]
    fn pack_parse_roundtrip_lossless() {
        let a = asset();
        let md = to_paid_markdown(&a);
        let b = parse_paid_markdown(&md).unwrap();
        assert_eq!(a, b, "打包往返必须无损");
    }

    #[test]
    fn scores_validated() {
        let mut a = asset();
        a.scores.taste = 1.5;
        assert!(matches!(
            a.validate().unwrap_err(),
            JudgenessError::ScoreOutOfRange(name, _) if name == "taste"
        ));
    }

    #[test]
    fn unparseable_reported_honestly() {
        assert!(parse_paid_markdown("随便一段文字").is_err(), "解析不出如实报错不猜");
    }

    #[test]
    fn verdict_parse_json_fence_tolerant() {
        let call = parse_verdict("```json\n{\"verdict\":\"approve\",\"confidence\":0.9,\"reasoning\":\"依据资产依据\"}\n```").unwrap();
        assert_eq!(call.verdict, Verdict::Approve);
        assert!((call.confidence - 0.9).abs() < 1e-9);
    }

    #[test]
    fn verdict_invalid_reported() {
        assert!(matches!(
            parse_verdict("{\"verdict\":\"maybe\"}"),
            Err(JudgenessError::BadVerdict(s)) if s == "maybe"
        ));
        assert!(parse_verdict("不是 json").is_err());
    }

    #[test]
    fn confidence_clamped() {
        let call = parse_verdict("{\"verdict\":\"hold\",\"confidence\":5.0}").unwrap();
        assert!((call.confidence - 1.0).abs() < 1e-9, "越界收敛到 [0,1]");
    }
}
