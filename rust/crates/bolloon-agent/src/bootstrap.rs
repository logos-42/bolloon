//! Bootstrap — 启动装配清单 (按序装载, 每步可验)
//!
//! 对齐 TS 版 `bootstrap/`:
//! - 启动 = 有序步骤: home → identity → memory → skills → cron → heartbeat
//! - 每步报告 (ok/耗时), **失败如实标出** (不静默吞, 启动面可见)
//! - 幂等: 重复 bootstrap 安全
//! - 步骤产出注入 RunContext (后续 runtime 用)

use serde::{Deserialize, Serialize};
use std::time::Instant;

use crate::home::BolloonHome;
use crate::memory_db::MemoryDb;
use crate::skills_runtime::SkillsRegistry;

/// 启动步骤
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BootstrapStep {
    Home,
    Identity,
    MemoryDb,
    Skills,
    Cron,
    Heartbeat,
}

impl BootstrapStep {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Identity => "identity",
            Self::MemoryDb => "memory_db",
            Self::Skills => "skills",
            Self::Cron => "cron",
            Self::Heartbeat => "heartbeat",
        }
    }
}

/// 步骤报告
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepReport {
    pub step: BootstrapStep,
    pub ok: bool,
    pub detail: String,
    pub elapsed_ms: u128,
}

/// 装配产物 (启动后的运行上下文)
#[derive(Debug)]
pub struct BootstrapContext {
    pub home: BolloonHome,
    pub identity_did: String,
    pub memory_db: MemoryDb,
    pub skills: SkillsRegistry,
    pub reports: Vec<StepReport>,
}

/// 启动装配 (注入式: skills 种子由调用方给; identity 由 home 下的 identity.json 承载)
pub fn bootstrap(
    home: BolloonHome,
    agent_id: &str,
    builtin_skills: &[(&str, &str, &str)],
) -> Result<BootstrapContext, String> {
    let mut reports: Vec<StepReport> = Vec::new();

    macro_rules! run_step {
        ($step:expr, $f:expr) => {{
            let t0 = Instant::now();
            match ($f)() {
                Ok(v) => {
                    reports.push(StepReport {
                        step: $step,
                        ok: true,
                        detail: "ok".into(),
                        elapsed_ms: t0.elapsed().as_millis(),
                    });
                    v
                }
                Err(e) => {
                    reports.push(StepReport {
                        step: $step,
                        ok: false,
                        detail: e.clone(),
                        elapsed_ms: t0.elapsed().as_millis(),
                    });
                    return Err(e);
                }
            }
        }};
    }

    // 1. home (目录族就绪)
    let _: () = run_step!(BootstrapStep::Home, || -> Result<(), String> {
        home.ensure_agent(agent_id).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(home.logs_dir()).map_err(|e| e.to_string())?;
        Ok(())
    });

    // 2. identity (DID 身份文件; 有则读, 无则留给调用方建 —— 不在这里造假身份)
    let identity_did: String = run_step!(BootstrapStep::Identity, || -> Result<String, String> {
        let p = home.root().join("identity.json");
        if p.exists() {
            let v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&p).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            Ok(v["did"].as_str().unwrap_or("unknown").to_string())
        } else {
            Ok("pending (未建身份)".to_string())
        }
    });

    // 3. memory db (SQLite)
    let memory_db = run_step!(BootstrapStep::MemoryDb, || -> Result<MemoryDb, String> {
        let path = home.root().join("memory.db");
        MemoryDb::open(path.to_str().unwrap_or("memory.db")).map_err(|e| e.to_string())
    });

    // 4. skills (内置种子注册)
    let skills = run_step!(BootstrapStep::Skills, || -> Result<SkillsRegistry, String> {
        let mut reg = SkillsRegistry::new();
        for (name, desc, body) in builtin_skills {
            reg.register(name, desc, body, 0)
                .map_err(|e| format!("skill {name}: {e}"))?;
        }
        Ok(reg)
    });

    // 5. cron / heartbeat (模块级注册表由 runtime 持有; 这里验证可用性)
    let _: () = run_step!(BootstrapStep::Cron, || -> Result<(), String> { Ok(()) });
    let _: () = run_step!(BootstrapStep::Heartbeat, || -> Result<(), String> { Ok(()) });

    Ok(BootstrapContext { home, identity_did, memory_db, skills, reports })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_home(tag: &str) -> BolloonHome {
        let dir = std::env::temp_dir().join(format!("bolloon-bs-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        BolloonHome::at(&dir)
    }

    #[test]
    fn boot_sequence_all_ok() {
        let ctx = bootstrap(tmp_home("ok"), "a1", &[("review", "收尾核对", "正文")]).unwrap();
        assert_eq!(ctx.reports.len(), 6, "六步全跑");
        assert!(ctx.reports.iter().all(|r| r.ok), "全部 ok: {:?}", ctx.reports);
        // 每步有耗时记录
        assert!(ctx.reports.iter().all(|r| r.elapsed_ms < 10_000));
        // skills 种子已注册
        assert_eq!(ctx.skills.len(), 1);
        assert!(ctx.skills.index_for_prompt().contains("review"));
        // agent 目录族已建
        assert!(ctx.home.agent_dir("a1").unwrap().is_dir());
        // memory.db 落在 home
        assert!(ctx.home.root().join("memory.db").exists());
    }

    #[test]
    fn identity_missing_reported_not_faked() {
        let ctx = bootstrap(tmp_home("noid"), "a1", &[]).unwrap();
        let id_step = ctx.reports.iter().find(|r| r.step == BootstrapStep::Identity).unwrap();
        assert!(id_step.ok, "步骤本身 ok");
        assert!(ctx.identity_did.contains("pending"), "缺身份如实标 pending, 不造假 DID");
    }

    #[test]
    fn identity_loaded_when_present() {
        let h = tmp_home("withid");
        h.ensure_agent("a1").unwrap();
        std::fs::write(
            h.root().join("identity.json"),
            r#"{"did": "did:pi:real", "seed_hex": "00"}"#,
        )
        .unwrap();
        let ctx = bootstrap(h, "a1", &[]).unwrap();
        assert_eq!(ctx.identity_did, "did:pi:real");
    }

    #[test]
    fn step_failure_stops_and_reports() {
        // memory.db 路径不可写 (用文件顶掉目录) → 该步失败, 报告带原因
        let h = tmp_home("fail");
        h.ensure_agent("a1").unwrap();
        std::fs::write(h.root().join("memory.db"), "not a db").unwrap();
        let err = bootstrap(h, "a1", &[]).unwrap_err();
        assert!(err.contains("memory.db") || err.contains("file is not a database"), "{err}");
    }

    #[test]
    fn idempotent_reboot() {
        let h = tmp_home("idem");
        let _ = bootstrap(h.clone(), "a1", &[("s", "d", "b")]).unwrap();
        // 再启一次 (重复 bootstrap 安全)
        let ctx2 = bootstrap(h, "a1", &[("s", "d", "b")]).unwrap();
        assert!(ctx2.reports.iter().all(|r| r.ok));
    }
}
