//! 价格表 —— 金额的唯一来源。
//!
//! 硬规则: **价格不写死在业务代码里**。价格表从文件加载, 带版本号; 每次计量事件都记下
//! 当时生效的 `price_version`。没有价格表 ⇒ 只记 token, 金额留 `None` (不编)。

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriceEntry {
    /// provider id; `*` = 任意 provider
    pub provider: String,
    /// model 名; `*` = 任意模型
    pub model: String,
    /// 每百万输入 token 的价格 (USD)
    pub usd_per_mtok_in: f64,
    /// 每百万输出 token 的价格 (USD)
    pub usd_per_mtok_out: f64,
    /// 每百万**缓存命中** token 的价格 (供应商不区分时留 None)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usd_per_mtok_cache: Option<f64>,
    /// 价格来源说明 (官方价目页/合同价/自报价), 便于复核
    #[serde(default)]
    pub source_note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriceTable {
    /// 版本号: 价格一改就换版本 (计量事件里带的就是它)
    pub version: String,
    #[serde(default)]
    pub effective_from: String,
    #[serde(default)]
    pub entries: Vec<PriceEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriceVersion(pub String);

impl Default for PriceTable {
    fn default() -> Self {
        Self {
            version: "none".into(),
            effective_from: String::new(),
            entries: vec![],
        }
    }
}

impl PriceTable {
    pub fn empty() -> Self {
        Self::default()
    }

    /// 从 JSON 文件加载。任何解析失败都**原样返回错误**, 不退回"猜一个价格"。
    pub fn from_file(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path).map_err(|e| format!("读取失败: {e}"))?;
        let t: PriceTable = serde_json::from_str(&raw).map_err(|e| format!("解析失败: {e}"))?;
        if t.version.trim().is_empty() || t.version == "none" {
            return Err("价格表缺 version (没有版本号的价格不能用来记账)".into());
        }
        for e in &t.entries {
            if e.usd_per_mtok_in < 0.0 || e.usd_per_mtok_out < 0.0 {
                return Err("价格不能为负".into());
            }
        }
        Ok(t)
    }

    pub fn has_prices(&self) -> bool {
        !self.entries.is_empty()
    }

    /// 先精确匹配, 再 `provider/*`, 再 `*/model`, 最后 `*/*`。
    pub fn lookup(&self, provider: &str, model: &str) -> Option<&PriceEntry> {
        let find = |p: &str, m: &str| {
            self.entries
                .iter()
                .find(|e| e.provider == p && e.model == m)
        };
        find(provider, model)
            .or_else(|| find(provider, "*"))
            .or_else(|| find("*", model))
            .or_else(|| find("*", "*"))
    }

    /// 估算成本 = (T_in·P_in + T_out·P_out + T_cache·P_cache) / 1e6。
    /// 缺任何必要项就返回 None (宁可"不知道"也不编)。
    pub fn estimate(
        &self,
        provider: &str,
        model: &str,
        tokens_in: Option<u32>,
        tokens_out: Option<u32>,
        tokens_cache: Option<u32>,
    ) -> Option<f64> {
        let e = self.lookup(provider, model)?;
        let tin = tokens_in? as f64;
        let tout = tokens_out? as f64;
        let mut cost = (tin * e.usd_per_mtok_in + tout * e.usd_per_mtok_out) / 1_000_000.0;
        if let (Some(tc), Some(pc)) = (tokens_cache, e.usd_per_mtok_cache) {
            cost += tc as f64 * pc / 1_000_000.0;
        }
        Some(cost)
    }
}
