//! 确定性头像 — 稳定 ID → 永远同一张图 (hashavatar 本地生成, 不依赖任何远程图片服务)
//!
//! 为什么换掉前端那版手写 SVG: 旧版每个身份都是同一张"渐变脸", 只换颜色 —— 人和智能体
//! 摆在同一条列表里分不出来。hashavatar 从同一个 id 派生**家族 (31 种) + 配色 + 装饰层**,
//! 视觉上一眼可辨, 而且是纯本地代码生成 (SVG ~1KB / 0.1ms), 不进 git 也不发网络请求。
//!
//! 口径:
//! - seed = 稳定身份串 (`agent-001` / `did:pi:…`) —— 改名不改图, 换 id 才换图
//! - 家族缺省从 seed 的 sha256 首字节派生的 (同一 seed 永远同一家族)
//! - `?k=` 可显式指定家族 (UI 里"换头像家族"用), 白名单 = `AvatarKind::ALL`

use std::collections::HashMap;
use std::sync::Mutex;

use hashavatar::prelude::*;

/// 家族目录: 索引 = 前端 `?k=` 的取值
pub fn families() -> Vec<serde_json::Value> {
    AvatarKind::ALL
        .iter()
        .enumerate()
        .map(|(i, k)| {
            let name = format!("{k:?}");
            serde_json::json!({ "i": i, "name": name })
        })
        .collect()
}

/// 稳定家族: sha256(seed) 首字节取模 ⇒ 同一身份永远同一家族
pub fn kind_for(seed: &str) -> u8 {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(seed.as_bytes());
    (d[0] as usize % AvatarKind::ALL.len()) as u8
}

/// 越界的 `k` 一律回落成按身份派生 (不报错, 也不悄悄换成一个固定家族)
fn resolve_kind(seed: &str, k: Option<u8>) -> u8 {
    match k {
        Some(i) if (i as usize) < AvatarKind::ALL.len() => i,
        _ => kind_for(seed),
    }
}

/// SVG 字串 (带缓存: 同一 (seed, 家族) 只算一次)
pub fn svg(seed: &str, k: Option<u8>) -> String {
    static CACHE: Mutex<Option<HashMap<(String, u8), String>>> = Mutex::new(None);
    let kind = resolve_kind(seed, k);
    let key = (seed.to_string(), kind);
    if let Ok(mut guard) = CACHE.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some(hit) = map.get(&key) {
            return hit.clone();
        }
        // 浏览器会话级缓存足够; 超出就整表清掉 (头像不是长期资产, 不做出向淘汰)
        if map.len() >= 512 {
            map.clear();
        }
        let out = render(seed, kind);
        map.insert(key, out.clone());
        out
    } else {
        render(seed, kind)
    }
}

fn render(seed: &str, kind: u8) -> String {
    AvatarBuilder::for_id(seed)
        .size(128, 128)
        .kind(AvatarKind::ALL[kind as usize])
        .background(AvatarBackground::Themed)
        .shape(AvatarShape::Circle)
        .render_svg()
        // 渲染失败绝不 500: 退一张最小可用图, 页面上是空白圆而不是破图
        .unwrap_or_else(|_| {
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><circle cx="64" cy="64" r="64" fill="#c4d640"/></svg>"##.to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同一个 seed 两次必须逐字节相同 (确定性 = 头像的全部意义)
    #[test]
    fn same_seed_same_bytes() {
        let a = svg("agent-001", None);
        let b = svg("agent-001", None);
        assert_eq!(a, b);
        assert!(a.starts_with("<svg"), "{a:.80}");
    }

    /// 不同身份不能都落到同一张图 (旧版的问题就是"人人同脸")
    #[test]
    fn different_seeds_differ() {
        let a = svg("agent-001", None);
        let b = svg("agent-002", None);
        assert_ne!(a, b);
    }

    /// 家族号越界 → 回落成按身份派生, 不是固定家族
    #[test]
    fn out_of_range_kind_falls_back() {
        let seed = "did:pi:abc";
        assert_eq!(svg(seed, Some(200)), svg(seed, None));
    }

    /// 显式家族真的生效 (否则 UI 的"换家族"是假的)
    #[test]
    fn explicit_kind_applies() {
        let seed = "agent-001";
        assert_ne!(svg(seed, Some(2)), svg(seed, Some(3)));
        assert_eq!(kind_for(seed), resolve_kind(seed, None));
    }

    /// 家族目录与 hashavatar 的家族数一致 (前端按钮数 = 真正的家族数)
    #[test]
    fn families_cover_all_kinds() {
        let f = families();
        assert_eq!(f.len(), AvatarKind::ALL.len());
        assert_eq!(f[0]["i"], 0);
    }
}
