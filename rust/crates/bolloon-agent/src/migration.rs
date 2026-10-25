//! 版本迁移 — 状态机 (老数据 → 新 schema, 幂等可重放)
//!
//! 对齐 TS 版 `migration/` 语义:
//! - 迁移链按版本序执行 (v1→v2→v3…), 每步幂等 (重放不二次变更)
//! - 当前版本低于目标 → 逐级升; 已是目标版本 → no-op (不假装修了)
//! - 迁移失败: 停在当前版本并如实报错, 不跳步

use serde::{Deserialize, Serialize};

/// 迁移步骤 (一步: from → to)
pub type MigrationStep = fn(&serde_json::Value) -> Result<serde_json::Value, String>;

/// 迁移注册表 (版本序)
#[derive(Default)]
pub struct MigrationChain {
    steps: Vec<(u32, u32, &'static str, MigrationStep)>,
}

impl MigrationChain {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一步 (from 版本 → to 版本)
    pub fn register(&mut self, from: u32, to: u32, name: &'static str, step: MigrationStep) {
        self.steps.push((from, to, name, step));
    }

    /// 当前 schema 版本 (数据里的 schemaVersion, 缺省 = 1)
    pub fn current_version(data: &serde_json::Value) -> u32 {
        data["schemaVersion"].as_u64().unwrap_or(1) as u32
    }

    /// 执行迁移到目标版本 (幂等: 已到目标 = no-op 返回原数据)
    pub fn migrate_to(
        &self,
        mut data: serde_json::Value,
        target: u32,
    ) -> Result<(serde_json::Value, Vec<String>), String> {
        let mut applied = Vec::new();
        loop {
            let v = Self::current_version(&data);
            if v >= target {
                return Ok((data, applied));
            }
            // 找 v → ? 的步骤
            let step = self
                .steps
                .iter()
                .find(|(from, _, _, _)| *from == v)
                .ok_or_else(|| format!("没有从 schemaVersion {v} 出发的迁移步骤 (目标 {target})"))?;
            let (from, to, name, f) = step;
            data = f(&data).map_err(|e| format!("迁移 {name} (v{from}→v{to}) 失败: {e}"))?;
            // 迁移函数自己负责写 schemaVersion; 这里强校验
            let new_v = Self::current_version(&data);
            if new_v != *to {
                return Err(format!("迁移 {name} 后 schemaVersion={new_v}, 期望 {to}"));
            }
            applied.push(name.to_string());
        }
    }
}

/// 内置迁移: v1 → v2 (agents 数组 → agents 对象带 did)
pub fn migrate_v1_to_v2(data: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut out = data.clone();
    if let Some(agents) = out["agents"].as_array().cloned() {
        let upgraded: Vec<serde_json::Value> = agents
            .into_iter()
            .map(|a| {
                if a.is_object() {
                    a
                } else if let Some(name) = a.as_str() {
                    serde_json::json!({ "name": name, "did": null })
                } else {
                    a
                }
            })
            .collect();
        out["agents"] = serde_json::json!(upgraded);
    }
    out["schemaVersion"] = serde_json::json!(2);
    Ok(out)
}

/// 内置迁移: v2 → v3 (加 sessions 子目录键)
pub fn migrate_v2_to_v3(data: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut out = data.clone();
    if out["sessions"].is_null() {
        out["sessions"] = serde_json::json!({});
    }
    out["schemaVersion"] = serde_json::json!(3);
    Ok(out)
}

/// 幂等演示数据
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MigratedHome {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain() -> MigrationChain {
        let mut c = MigrationChain::new();
        c.register(1, 2, "v1→v2 agents 形状升级", migrate_v1_to_v2);
        c.register(2, 3, "v2→v3 sessions 键", migrate_v2_to_v3);
        c
    }

    #[test]
    fn fresh_v1_migrates_to_v3_through_chain() {
        let data = serde_json::json!({ "schemaVersion": 1, "agents": ["alice", "bob"] });
        let (out, applied) = chain().migrate_to(data, 3).unwrap();
        assert_eq!(out["schemaVersion"], 3);
        assert_eq!(out["agents"][0]["name"], "alice", "字符串 agent 升级为对象");
        assert_eq!(applied.len(), 2, "两级都执行");
    }

    #[test]
    fn already_at_target_is_noop_not_fake() {
        let data = serde_json::json!({ "schemaVersion": 3, "sessions": {} });
        let (out, applied) = chain().migrate_to(data, 3).unwrap();
        assert_eq!(out["schemaVersion"], 3);
        assert!(applied.is_empty(), "已是目标版本 = no-op, 不假装修了");
    }

    #[test]
    fn partial_migration_stops_at_highest_known() {
        let data = serde_json::json!({ "schemaVersion": 2 });
        let (out, applied) = chain().migrate_to(data, 3).unwrap();
        assert_eq!(out["schemaVersion"], 3);
        assert_eq!(applied, vec!["v2→v3 sessions 键"]);
    }

    #[test]
    fn unknown_version_errors_honestly() {
        let data = serde_json::json!({ "schemaVersion": 99 });
        let err = chain().migrate_to(data, 100).unwrap_err();
        assert!(err.contains("没有从 schemaVersion 99 出发"), "如实报错不跳步");
    }

    #[test]
    fn step_failure_stops_chain() {
        let mut c = MigrationChain::new();
        c.register(1, 2, "坏步骤", |_| Err("故意失败".into()));
        let err = c.migrate_to(serde_json::json!({"schemaVersion": 1}), 2).unwrap_err();
        assert!(err.contains("故意失败"), "失败停在当前版本, 不假装成功");
    }

    #[test]
    fn migration_is_replayable() {
        // 幂等: 同数据跑两遍结果一致
        let data = serde_json::json!({ "schemaVersion": 1, "agents": ["a"] });
        let (once, _) = chain().migrate_to(data.clone(), 3).unwrap();
        let (twice, applied2) = chain().migrate_to(once.clone(), 3).unwrap();
        assert_eq!(once, twice);
        assert!(applied2.is_empty(), "重放 = no-op (幂等)");
    }
}
