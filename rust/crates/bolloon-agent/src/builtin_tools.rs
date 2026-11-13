//! builtin_tools.rs — Rust 内置工具族（迁移第一批: read_file）
//!
//! **为什么有这个文件**：2026-10-26 迁移审计确认 Rust 侧 `Harness::gate` 九步门控
//! （discover→permission→policy→budget→idempotency→execute→verify→evidence→event）实现完整，
//! 但**零生产 `ToolExecutor`** · 注册表**零注册** · `ToolDef→ToolSchema` **无桥** ——
//! 工具从未真正发给模型，也从未被执行。本文件是「Rust 生产执行链最小闭环」的第一块砖。
//!
//! 迁移原则（用户 2026-10-26 批准）:
//!   **业务能力等价 + 安全性不退化 + 运行机制完整**（不要求与 TS 逐字节一致）。
//!
//! **有意行为变更**（安全升级；由本文件 tests 钉住，
//!   不许以后有人为追求"与 TS 行为一致"又把它们改回去）:
//!   1. TS `read_file` 无路径禁区（禁区只挂在 shell 写路径上）。
//!      Rust 版对**敏感凭据文件** (.env / *.pem / *.key /
//!      .bolloon/{identity,keypair,llm-config,accounts,wallets,bindings,eas-bind}) 拒绝读取。
//!      依据决策 1: 私钥/凭据不进 Agent 上下文、工具轨迹与常规日志 —— **只读工具同样受此约束**。
//!   2. 超长输出截断并**显式标注**（防上下文爆炸；TS 侧只靠遥测观测，不截断）。
//!   3. 参数必填在执行器**入口**校验（对齐 TS 基线 `pi-sdk-tools-validation`:
//!      `path` 必填必须在入口拒绝，不能让 fs 抛原生 `ERR_INVALID_ARG_TYPE`）。
//!   4. `verified` 如实: 读到 → `Some(true)`；失败/未读 → `Some(false)`。
//!      依据决策 2: **无法验证的结果不得报告为已验证成功**。

use async_trait::async_trait;
use bolloon_harness::{
    Budget, EffectKind, Harness, ToolCall, ToolDef, ToolExecutor, ToolRegistry, ToolResult,
};
use bolloon_llm::{FunctionSchema, ToolSchema};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::tool_contract::{ErrorCode, error_evidence, with_error};

pub use crate::shell_tool::{ShellExecutor, shell_def};

/// 单次读取输出上限（字符）—— 超出截断并标注
pub const MAX_OUTPUT_CHARS: usize = 200_000;

/// 敏感凭据路径片段（**只读也绝不读进模型上下文** —— 决策 1 安全升级）
const SENSITIVE_PATTERNS: &[&str] = &[
    ".env",
    ".bolloon/identity",
    ".bolloon/keypair",
    ".bolloon/llm-config",
    // 2026-10-31: 实测 bolloon-config.json 里躺过两家 provider 的明文 apiKey,
    // 而 read_file 只拦了 llm-config ⇒ 一条工具调用就能把 key 读进上下文。把
    // 「本机的配置/凭据库/钱包/支付」整体划进禁区, 不只补单个文件名。
    ".bolloon/bolloon-config",
    ".bolloon/config.json",
    ".bolloon/keys",
    ".bolloon/agent-keys",
    ".bolloon/wallets",
    ".bolloon/accounts",
    ".bolloon/bindings",
    ".bolloon/eas-bind",
    ".bolloon/pay/",
    ".bolloon/rust/identity",
];

fn is_sensitive(path: &str) -> bool {
    let p = path.replace('\\', "/");
    SENSITIVE_PATTERNS.iter().any(|s| p.contains(s)) || p.ends_with(".pem") || p.ends_with(".key")
}

/// `read_file` 执行器（只读）
pub struct ReadFileExecutor;

#[async_trait]
impl ToolExecutor for ReadFileExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        let started = std::time::Instant::now();
        let elapsed_ms = started.elapsed().as_millis() as u64;

        let path = call
            .arguments
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if path.is_empty() {
            return ToolResult {
                ok: false,
                output: "read_file: path 必填（参数校验在入口发生，不把错误推给 fs）".into(),
                elapsed_ms,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::InvalidArgument, "path 必填")),
            };
        }
        if is_sensitive(&path) {
            return ToolResult {
                ok: false,
                output: format!(
                    "read_file 拒绝读取敏感凭据文件: {path}（有意安全升级: 私钥/凭据不进模型上下文）"
                ),
                elapsed_ms,
                verified: Some(false),
                evidence: Some(with_error(
                    serde_json::json!({ "denied": "sensitive_path", "path": path }),
                    ErrorCode::Denied,
                    "敏感凭据文件（有意安全升级）",
                )),
            };
        }

        let limit = call
            .arguments
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);

        match std::fs::read_to_string(&path) {
            Ok(content) => {
                let body = match limit {
                    Some(n) if n > 0 => content.lines().take(n).collect::<Vec<_>>().join("\n"),
                    _ => content,
                };
                let chars = body.chars().count();
                let (out, truncated) = if chars > MAX_OUTPUT_CHARS {
                    (
                        format!(
                            "{}\n…[已截断: 输出 {} 字符 > 上限 {}]",
                            body.chars().take(MAX_OUTPUT_CHARS).collect::<String>(),
                            chars,
                            MAX_OUTPUT_CHARS
                        ),
                        true,
                    )
                } else {
                    (body, false)
                };
                let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                ToolResult {
                    ok: true,
                    output: out,
                    elapsed_ms,
                    verified: Some(true),
                    evidence: Some(serde_json::json!({
                        "path": path,
                        "bytes": bytes,
                        "chars": chars,
                        "limit": limit,
                        "truncated": truncated,
                    })),
                }
            }
            Err(e) => ToolResult {
                ok: false,
                output: format!("read_file 读取失败: {e}"),
                elapsed_ms,
                verified: Some(false),
                evidence: Some(with_error(
                    serde_json::json!({ "path": path, "io_error": e.to_string() }),
                    ErrorCode::NotFound,
                    "读取失败",
                )),
            },
        }
    }
}

/// `read_file` 工具定义（对齐 TS 基线 `read_file(path, limit)`；**真 JSON Schema**）
pub fn read_file_def() -> ToolDef {
    ToolDef {
        name: "read_file".into(),
        description: "读取文件内容（只读）。返回文件正文；可用 limit 限制读取的行数。".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "文件路径（必填）" },
                "limit": { "type": "integer", "description": "最多读取的行数（可选，缺省读全文）" }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
        effect: EffectKind::Read,
        // 只读 = 默认允许（决策 2: 只读与高风险用不同风险策略，不用一把尺子）
        default_allowed: true,
    }
}

/// 内置工具定义清单（**单一真源**）：注册、模型 schema、dashboard 展示都取这里。
///
/// 纪律: dashboard 的「可用工具」必须是**真实注册且能执行**的工具 —— 不许再把
/// 硬编码名字清单（或移植台账的 184 个名字）当成已具备的能力。
pub fn builtin_tool_defs() -> Vec<ToolDef> {
    let mut defs = vec![read_file_def(), crate::shell_tool::shell_def()];
    defs.extend(crate::file_tools::file_tool_defs());
    defs.extend(crate::search_tools::search_tool_defs());
    defs.extend(crate::git_tools::git_tool_defs());
    defs.extend(crate::net_tools::net_tool_defs());
    // SQL 工具类 (2026-11-04): 只读查询本地库; 与 web_fetch 同级注册, 三端共用同一份
    defs.extend(crate::sql_tools::sql_tool_defs());
    // AI 自己生成/分发世界媒体卡片 (2026-11-06)
    defs.extend(crate::world_card_tools::world_card_tool_defs());
    defs.extend(crate::domain_tools::domain_tool_defs());
    defs.extend(crate::updater_tools::updater_tool_defs());
    defs.extend(crate::scratch_tools::scratch_tool_defs());
    // 经济层工具：只有注入了 econ 上下文才真正可用（否则执行时如实说未启用）
    defs.extend(crate::econ_tools::econ_tool_defs());
    defs.extend(crate::invite_tools::invite_tool_defs());
    // 信念层 (2026-11-04): agent 自己写信念与长短期目标的入口 + 按信念挑下一步
    defs.extend(crate::belief_tools::belief_tool_defs());
    // IPFS 原语 (2026-10-31): TS 侧早有, Rust 版智能体一直没有 ⇒ 现在补上并默认授予
    defs.extend(crate::ipfs_tools::ipfs_tool_defs());
    // 邮件 (2026-11-13): Agent 自主读写邮件; 硬拒在 mail::service, 不靠工具默认值
    defs.extend(crate::mail_tools::mail_tool_defs());
    defs
}

/// 内置工具**统一分发执行器**（按 tool 名分派到对应工具族）。
///
/// 186 个工具不逐个造执行循环 —— 走共享执行器 + 工具族适配，
/// 但**每个**对外工具的参数、权限、副作用与验收行为仍各自独立（映射与测试独立）。
pub struct BuiltinExecutor {
    read_file: Arc<ReadFileExecutor>,
    file: Arc<crate::file_tools::FileExecutor>,
    search: Arc<crate::search_tools::SearchExecutor>,
    git: Arc<crate::git_tools::GitExecutor>,
    net: Arc<crate::net_tools::NetExecutor>,
    domain: Arc<crate::domain_tools::DomainExecutor>,
    updater: Arc<crate::updater_tools::UpdaterExecutor>,
    shell: Arc<ShellExecutor>,
    scratch: Arc<crate::scratch_tools::ScratchExecutor>,
    /// 经济层工具上下文（None = 未接线，执行时如实说"未启用"）
    econ: Option<crate::econ_tools::EconTools>,
    /// 邮件工具上下文（None = 没配账号 / 未注入，执行时如实说"未接线"）
    mail: Option<Arc<crate::mail_tools::MailExecutor>>,
}

impl BuiltinExecutor {
    /// `cancel` = 会话级取消标志（Ctrl+C 置位 ⇒ shell 当前/下一条命令被 kill）
    /// `bypass` = 完全访问（所有权限开放；超时/取消/预算/审计不撤）
    /// `script_run` = scratch 子系统执行端口 (宿主注入真执行器; 默认 noop)
    pub fn new(
        cancel: Arc<AtomicBool>,
        bypass: bool,
        script_run: crate::scratch::ScriptRunPort,
    ) -> Self {
        Self {
            read_file: Arc::new(ReadFileExecutor),
            file: Arc::new(crate::file_tools::FileExecutor),
            search: Arc::new(crate::search_tools::SearchExecutor),
            git: Arc::new(crate::git_tools::GitExecutor),
            net: Arc::new(crate::net_tools::NetExecutor),
            domain: Arc::new(crate::domain_tools::DomainExecutor),
            updater: Arc::new(crate::updater_tools::UpdaterExecutor),
            shell: Arc::new(ShellExecutor::with_mode(cancel, bypass)),
            scratch: Arc::new(crate::scratch_tools::ScratchExecutor::new(script_run)),
            econ: None,
            mail: None,
        }
    }

    /// 注入经济层工具上下文（agent 侧 `econ_probe` / `econ_claim` 才有数据可看）
    pub fn with_econ(mut self, tools: crate::econ_tools::EconTools) -> Self {
        self.econ = Some(tools);
        self
    }

    /// 注入邮件服务（三端共用同一份 MailService；不注入则 mail_* 如实报未接线）
    pub fn with_mail(mut self, svc: Arc<crate::mail::MailService>) -> Self {
        self.mail = Some(Arc::new(crate::mail_tools::MailExecutor::new(svc)));
        self
    }
}

#[async_trait]
impl ToolExecutor for BuiltinExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        match call.name.as_str() {
            "read_file" => self.read_file.execute(call).await,
            "write_file" | "edit_file" | "list_directory" | "mkdir" | "move_file" | "delete_file" => {
                self.file.execute(call).await
            }
            "grep_files" | "glob_files" => self.search.execute(call).await,
            "git_status" | "git_diff" | "git_log" | "git_show" | "git_branch" | "git_add"
            | "git_commit" | "git_push" => self.git.execute(call).await,
            "web_fetch" | "web_search" => self.net.execute(call).await,
            "sql_query" => crate::sql_tools::SqlExecutor.execute(call).await,
            "world_card_publish" => crate::world_card_tools::execute(&call),
            "read_skill" | "list_skills" | "todo_add" | "todo_list" | "todo_done" | "remember"
            | "recall" | "task_list" => self.domain.execute(call).await,
            // 信念层: agent 自己的信念/长短期目标 (写的是它自己的判断, 不是用户文件)
            "belief_set" | "belief_list" | "belief_retire" | "goal_set" | "goal_list"
            | "goal_update" | "goal_pick" => {
                crate::belief_tools::BeliefExecutor.execute(call).await
            }
            "check_update" => self.updater.execute(call).await,
            "shell" => self.shell.execute(call).await,
            "run_scratch_script" => self.scratch.execute(call).await,
            "group_invite" | "group_join" | "group_members" | "group_read" | "immune_report"
            | "immune_status" => {
                crate::invite_tools::execute_sync(&call)
            }
            "ipfs_add" | "ipfs_cat" | "ipfs_ls" | "ipns_publish" | "ipns_resolve" => {
                let args = call.arguments.clone();
                let name = call.name.clone();
                let started = std::time::Instant::now();
                match tokio::task::spawn_blocking(move || {
                    crate::ipfs_tools::IpfsExecutor.run(&name, &args)
                })
                .await
                {
                    Ok(Ok(out)) => ToolResult {
                        ok: true,
                        output: out,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        verified: Some(true),
                        evidence: None,
                    },
                    Ok(Err(e)) => ToolResult {
                        ok: false,
                        output: e,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        verified: Some(false),
                        evidence: Some(serde_json::json!({ "ipfs": "failed" })),
                    },
                    Err(e) => ToolResult {
                        ok: false,
                        output: format!("ipfs 工具线程失败: {e}"),
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        verified: Some(false),
                        evidence: None,
                    },
                }
            }
            "econ_probe" | "econ_claim" => match self.econ.as_ref() {
                Some(t) => crate::econ_tools::try_execute(t, &call).unwrap_or_else(|| ToolResult {
                    ok: false,
                    output: "econ 工具分派失败".into(),
                    elapsed_ms: 0,
                    verified: Some(false),
                    evidence: None,
                }),
                None => ToolResult {
                    ok: false,
                    output: "经济层未启用：这次会话没有注入 econ 上下文，所以查不到额度/池子（不是 0，是没接线）".into(),
                    elapsed_ms: 0,
                    verified: Some(false),
                    evidence: Some(serde_json::json!({ "econ": "not_wired" })),
                },
            },
            "mail_accounts" | "mail_search" | "mail_read" | "mail_sync" | "mail_send" => {
                match self.mail.as_ref() {
                    Some(m) => m.execute(call).await,
                    None => crate::mail_tools::not_wired_result(&call.name),
                }
            }
            // 已注册但没接执行器 ⇒ **如实说没接线**, 绝不返回空成功
            other => ToolResult {
                ok: false,
                output: format!("工具 {other} 已注册但没有接线执行器（未迁移完成，不许冒充成功）"),
                elapsed_ms: 0,
                verified: Some(false),
                evidence: Some(serde_json::json!({ "unwired": other })),
            },
        }
    }
}

/// 内置工具注册进注册表（**生产唯一注册点**；此前生产零注册）
pub async fn register_builtin_tools(registry: &ToolRegistry) {
    for d in builtin_tool_defs() {
        registry.register(d).await;
    }
}

/// `ToolDef → ToolSchema` 桥接（**此前完全缺失**：注册表与模型之间无桥，
/// 因此 `params.tools` 恒空、function calling 从未启用）
pub fn tool_defs_to_schemas(defs: &[ToolDef]) -> Vec<ToolSchema> {
    defs.iter()
        .map(|d| ToolSchema {
            tool_type: "function".into(),
            function: FunctionSchema {
                name: d.name.clone(),
                description: d.description.clone(),
                parameters: d.parameters.clone(),
            },
        })
        .collect()
}

/// 默认（非完全访问）**显式授予**的高风险工具: 可逆写入 + 本地 git 写 + scratch。
///
/// 不可逆的 `delete_file` / 对外的 `git_push` **不在**此列（决策 2: 分级授权）。
/// 与 CLI 默认授予同一份清单 —— 单一真源, 不许 web/CLI 各写一套
/// （2026-10-31 实证: web/App 曾经一套都不授予 ⇒ shell/write_file 全被 permission 门拒）。
pub const DEFAULT_GRANTED_TOOLS: &[&str] = &[
    "shell",
    "write_file",
    "edit_file",
    "mkdir",
    "move_file",
    "git_add",
    "git_commit",
    "run_scratch_script",
    // IPFS 原语: 只碰本地节点, 可逆 (内容寻址, 不改本机文件)
    "ipfs_add",
    "ipfs_cat",
    "ipfs_ls",
    "ipns_publish",
    "ipns_resolve",
    // 邮件: 读默认放行; 同步与外发也需要默认授予(用户 2026-11-13 定为「默认支持」)。
    // 注意: 授予只过 permission 门, **外发仍受 service 层硬拒**(单收件人 / 凭据内容)。
    "mail_sync",
    "mail_send",
];

/// 按权限模式把已注册工具授进 Harness 的 permission 门。
///
/// - `bypass = true`（完全访问）⇒ 注册表里**全部**工具
/// - `bypass = false`（默认）  ⇒ 只有 `DEFAULT_GRANTED_TOOLS`
///
/// **只影响 permission 门**: 高危命令 denylist / 受保护路径 / 预算 / 超时 / 审计照旧
/// （敏感路径即便完全访问也读不到 —— 那是执行器侧的硬边界, 不在这里放）。
pub async fn apply_mode_grants(h: &Harness, reg: &ToolRegistry, bypass: bool) {
    if bypass {
        for d in reg.list().await {
            h.grant(&d.name).await;
        }
    } else {
        for name in DEFAULT_GRANTED_TOOLS {
            if reg.get(name).await.is_some() {
                h.grant(name).await;
            }
        }
    }
}

/// 生产即用: 注册全部内置工具 + 产出模型 schema + 建好 Harness (带九步门控)
///
/// `calls` = 工具调用预算上限; `budget_ms` = 工具执行总预算(毫秒);
/// `cancel` = 会话级取消标志; `bypass` = 完全访问(所有权限开放; 超时/取消/预算/审计不撤)。
/// 调用方据此把 `KernelLoop` 真正接进对话 —— 此前生产零接线, 工具从未发给模型。
pub async fn builtin_harness(
    calls: u32,
    budget_ms: u64,
    cancel: Arc<AtomicBool>,
    bypass: bool,
) -> (Arc<Harness>, Vec<ToolSchema>) {
    builtin_harness_with_mail(calls, budget_ms, cancel, bypass, None).await
}

/// 同上, 额外把邮件服务注入工具执行器。
///
/// 不注入 ⇒ `mail_*` 如实报「未接线」, 绝不返回空成功;
/// 注入后仍受 `mail::service::check_send_guard` 的硬拒约束。
pub async fn builtin_harness_with_mail(
    calls: u32,
    budget_ms: u64,
    cancel: Arc<AtomicBool>,
    bypass: bool,
    mail: Option<Arc<crate::mail::MailService>>,
) -> (Arc<Harness>, Vec<ToolSchema>) {
    let budget = Budget::new(calls, budget_ms);
    let reg = Arc::new(ToolRegistry::new());
    register_builtin_tools(&reg).await;
    let mut exec = BuiltinExecutor::new(
        cancel,
        bypass,
        crate::scratch::ScriptRunPort::noop(),
    );
    if let Some(m) = mail {
        exec = exec.with_mail(m);
    }
    let exec = Arc::new(exec);
    let h = Arc::new(Harness::new(reg.clone(), exec, budget));
    // 授权必须在这里落一次: Harness 只放行 `default_allowed` 或**显式授予**的工具,
    // 不授予 ⇒ shell/write_file 一律 `DENIED (policy=permission)`。
    apply_mode_grants(&h, &reg, bypass).await;
    let schemas = tool_defs_to_schemas(&builtin_tool_defs());
    (h, schemas)
}

/// 好友只读指挥可用的工具名 (**唯一事实源**; 加任何一项都要先想清楚会不会被拿来写/执行/花钱)
pub const READONLY_TOOL_NAMES: &[&str] = &[
    "read_file",
    "list_directory",
    "grep_files",
    "glob_files",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "web_fetch",
    "read_skill",
    "list_skills",
    "todo_list",
    "recall",
    "task_list",
    "group_read",
    "group_members",
];

/// **只读工具子集** (2026-11-04: 好友"只读指挥"专用)
///
/// 纪律: ① 只把 `EffectKind::Read` 的工具**发给模型**(schema 里根本看不到写/执行类);
/// ② 只授予同样这批 (permission 门对其它一律 DENIED); ③ 预算与超时由调用方给死,
/// ④ 网络类(web_fetch)也**不**给 —— 防被当成数据外带通道。
pub async fn readonly_harness(
    calls: u32,
    budget_ms: u64,
    cancel: Arc<AtomicBool>,
) -> (Arc<Harness>, Vec<ToolSchema>) {
    let budget = Budget::new(calls, budget_ms);
    let reg = Arc::new(ToolRegistry::new());
    register_builtin_tools(&reg).await;
    let exec = Arc::new(BuiltinExecutor::new(
        cancel,
        false, // 只读子集永不 bypass
        crate::scratch::ScriptRunPort::noop(),
    ));
    let h = Arc::new(Harness::new(reg.clone(), exec, budget));
    // 只读子集 = **显式姓名白名单** (2026-11-04 修正口径)
    //
    // 为什么不再"按 effect==Read 一把抓": Read 类里混着 `econ_claim`(能领额度/记账),
    // 那对好友不是"读"。这里只放行真正的查询工具 + 用户点名的 `web_fetch`。
    let defs: Vec<bolloon_harness::ToolDef> = builtin_tool_defs()
        .into_iter()
        .filter(|d| READONLY_TOOL_NAMES.contains(&d.name.as_str()))
        .collect();
    for d in &defs {
        h.grant(&d.name).await;
    }
    let schemas = tool_defs_to_schemas(&defs);
    (h, schemas)
}

/// 好友"信任"档可用的**写**类工具 (2026-11-04 leo 分级)
///
/// 刻意**不含** `delete_file` (不可逆) 与 `shell` (等于把本机交给对方)。
pub const TRUSTED_WRITE_TOOLS: &[&str] = &["write_file", "edit_file", "mkdir", "move_file"];

/// 好友指挥的工具可见面 (权限分级)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolScope {
    /// 普通: 只读 + web_fetch
    ReadOnly,
    /// 信任: 只读 + 写 (无 shell, 无 delete)
    ReadWrite,
    /// 极度信任: 全量工具 (含 shell) —— 审计/预算/取消**不撤**
    Root,
}

impl ToolScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::ReadWrite => "read_write",
            Self::Root => "root",
        }
    }
}

/// 按分级建 harness (好友指挥用; 三档共用同一套门/审计, 只是"发给模型 + 授予"的范围不同)
pub async fn harness_for_scope(
    scope: ToolScope,
    calls: u32,
    budget_ms: u64,
    cancel: Arc<AtomicBool>,
) -> (Arc<Harness>, Vec<ToolSchema>) {
    match scope {
        ToolScope::ReadOnly => readonly_harness(calls, budget_ms, cancel).await,
        ToolScope::ReadWrite => {
            let budget = Budget::new(calls, budget_ms);
            let reg = Arc::new(ToolRegistry::new());
            register_builtin_tools(&reg).await;
            let exec = Arc::new(BuiltinExecutor::new(
                cancel,
                false,
                crate::scratch::ScriptRunPort::noop(),
            ));
            let h = Arc::new(Harness::new(reg.clone(), exec, budget));
            let defs: Vec<bolloon_harness::ToolDef> = builtin_tool_defs()
                .into_iter()
                .filter(|d| {
                    READONLY_TOOL_NAMES.contains(&d.name.as_str())
                        || TRUSTED_WRITE_TOOLS.contains(&d.name.as_str())
                })
                .collect();
            for d in &defs {
                h.grant(&d.name).await;
            }
            let schemas = tool_defs_to_schemas(&defs);
            (h, schemas)
        }
        ToolScope::Root => {
            // 全量: 等价于本机"完全访问", 但预算/取消/审计照旧 (Harness 门不拆)
            let budget = Budget::new(calls, budget_ms);
            let reg = Arc::new(ToolRegistry::new());
            register_builtin_tools(&reg).await;
            let exec = Arc::new(BuiltinExecutor::new(
                cancel,
                true,
                crate::scratch::ScriptRunPort::noop(),
            ));
            let h = Arc::new(Harness::new(reg.clone(), exec, budget));
            for d in reg.list().await {
                h.grant(&d.name).await;
            }
            let schemas = tool_defs_to_schemas(&builtin_tool_defs());
            (h, schemas)
        }
    }
}

/// **工具白名单 harness** (2026-11-06 特化包): 只注册/只发给模型/只授予白名单里的工具。
///
/// 双保险: schema 里看不到白名单外的工具, permission 门也没授予它们 —— 模型即使硬调也会被 DENY。
/// 注意 `bypass` 仍按本机"完全访问"开关传入 (白名单是**缩小**, 不是提权)。
pub async fn allowlist_harness(
    names: &[String],
    calls: u32,
    budget_ms: u64,
    cancel: Arc<AtomicBool>,
    bypass: bool,
) -> (Arc<Harness>, Vec<ToolSchema>) {
    let budget = Budget::new(calls, budget_ms);
    let reg = Arc::new(ToolRegistry::new());
    register_builtin_tools(&reg).await;
    let exec = Arc::new(BuiltinExecutor::new(
        cancel,
        bypass,
        crate::scratch::ScriptRunPort::noop(),
    ));
    let h = Arc::new(Harness::new(reg.clone(), exec, budget));
    let defs: Vec<bolloon_harness::ToolDef> = builtin_tool_defs()
        .into_iter()
        .filter(|d| names.iter().any(|n| n == &d.name))
        .collect();
    for d in &defs {
        h.grant(&d.name).await;
    }
    (h, tool_defs_to_schemas(&defs))
}

/// 同 `builtin_harness`，但把经济层工具接上（principal 决定算谁的额度）。
pub async fn builtin_harness_with_econ(
    calls: u32,
    budget_ms: u64,
    cancel: Arc<AtomicBool>,
    bypass: bool,
    econ: Arc<bolloon_econ::ShadowEconomy>,
    principal: String,
    group: Option<String>,
) -> (Arc<Harness>, Vec<ToolSchema>) {
    let budget = Budget::new(calls, budget_ms);
    let reg = Arc::new(ToolRegistry::new());
    register_builtin_tools(&reg).await;
    let exec = Arc::new(
        BuiltinExecutor::new(cancel, bypass, crate::scratch::ScriptRunPort::noop()).with_econ(
            crate::econ_tools::EconTools {
                econ,
                principal,
                group,
            },
        ),
    );
    let h = Arc::new(Harness::new(reg.clone(), exec, budget));
    apply_mode_grants(&h, &reg, bypass).await;
    let schemas = tool_defs_to_schemas(&builtin_tool_defs());
    (h, schemas)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(name: &str, content: &str) -> std::path::PathBuf {
        let p =
            std::env::temp_dir().join(format!("bolloon_read_file_{}_{}", std::process::id(), name));
        std::fs::write(&p, content).expect("写临时文件");
        p
    }

    fn call(args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: "call-1".into(),
            name: "read_file".into(),
            arguments: args,
        }
    }

    /// 决策 2: 参数必填校验必须在**入口**发生（对齐 TS `pi-sdk-tools-validation`）
    #[tokio::test]
    async fn path_required_is_rejected_at_entry() {
        let r = ReadFileExecutor.execute(call(serde_json::json!({}))).await;
        assert!(!r.ok);
        assert!(r.output.contains("path 必填"), "{}", r.output);
        assert_eq!(r.verified, Some(false), "没读到内容不得报已验证成功");
    }

    /// **有意安全升级**（决策 1）: 凭据类文件即便是只读也不许进模型上下文
    #[tokio::test]
    async fn sensitive_credentials_are_refused() {
        for p in [
            ".env",
            "a/b.pem",
            ".bolloon/keypair.json",
            "x.key",
            "dir/.env.local",
        ] {
            let r = ReadFileExecutor
                .execute(call(serde_json::json!({ "path": p })))
                .await;
            assert!(!r.ok, "{p} 必须被拒");
            assert!(
                r.output.contains("敏感凭据") || r.output.contains("拒绝读取"),
                "{p} → {}",
                r.output
            );
        }
    }

    #[tokio::test]
    async fn reads_content_and_reports_verified() {
        let p = tmp_file("ok.txt", "line1\nline2\nline3");
        let r = ReadFileExecutor
            .execute(call(serde_json::json!({ "path": p.display().to_string() })))
            .await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("line1") && r.output.contains("line3"));
        assert_eq!(r.verified, Some(true));
        let _ = std::fs::remove_file(&p);
    }

    #[tokio::test]
    async fn limit_caps_lines() {
        let p = tmp_file("limit.txt", "l1\nl2\nl3\nl4");
        let r = ReadFileExecutor
            .execute(call(
                serde_json::json!({ "path": p.display().to_string(), "limit": 2 }),
            ))
            .await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("l1") && r.output.contains("l2"));
        assert!(!r.output.contains("l3"), "limit 必须截断: {}", r.output);
        let _ = std::fs::remove_file(&p);
    }

    #[tokio::test]
    async fn missing_file_fails_honestly() {
        let r = ReadFileExecutor
            .execute(call(serde_json::json!({ "path": "/nonexistent/nope.txt" })))
            .await;
        assert!(!r.ok);
        assert!(r.output.contains("读取失败"), "{}", r.output);
        assert_eq!(r.verified, Some(false));
    }

    /// 决策 2: schema 必须**真实声明**必填（不是 stub）
    #[tokio::test]
    async fn schema_declares_required_path() {
        let d = read_file_def();
        assert_eq!(d.name, "read_file");
        assert_eq!(d.effect, EffectKind::Read);
        assert!(d.default_allowed, "只读默认允许");
        let req = d
            .parameters
            .get("required")
            .and_then(|v| v.as_array())
            .expect("required 必须存在");
        assert!(req.iter().any(|v| v == "path"), "path 必须必填");
        assert!(d.parameters.get("properties").is_some());
    }

    /// 桥接: 注册表里的定义能变成模型看得懂的 schema（此前完全缺失的一环）
    #[tokio::test]
    async fn bridge_maps_def_to_model_schema() {
        let s = tool_defs_to_schemas(&[read_file_def()]);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].tool_type, "function");
        assert_eq!(s[0].function.name, "read_file");
        assert!(!s[0].function.description.is_empty());
        assert!(s[0].function.parameters.get("properties").is_some());
    }

    #[tokio::test]
    async fn registration_puts_tool_in_registry() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg).await;
        assert!(
            reg.len().await >= 29,
            "read_file + shell + 文件 + 搜索 + Git + 网络 + 领域 + 更新: {}",
            reg.len().await
        );
        assert!(reg.get("read_file").await.is_some());
        assert!(reg.get("shell").await.is_some());
        assert!(reg.get("write_file").await.is_some());
    }

    /// **最小闭环集成**: 注册 → 桥接成模型 schema → Harness 门执行 → 结果可读。
    /// 证明「模型发出 read_file 调用」在 Rust 侧**真的能被执行**（此前只是类型存在）。
    #[tokio::test]
    async fn closed_loop_register_bridge_and_execute() {
        let reg = ToolRegistry::new();
        register_builtin_tools(&reg).await;
        let schemas = tool_defs_to_schemas(&reg.list().await);
        // 工具族会持续迁移增长 ⇒ 只断言下限与关键成员（不断言精确数量）
        assert!(
            schemas.len() >= 29,
            "read_file+shell+文件+搜索+Git+网络+领域+更新: {}",
            schemas.len()
        );
        let names: Vec<&str> = schemas.iter().map(|s| s.function.name.as_str()).collect();
        assert!(
            names.contains(&"read_file") && names.contains(&"shell"),
            "{names:?}"
        );
        assert!(names.contains(&"write_file"), "{names:?}");

        let harness = bolloon_harness::Harness::new(
            std::sync::Arc::new(reg),
            std::sync::Arc::new(ReadFileExecutor),
            bolloon_harness::Budget::new(5, 10_000),
        );
        let p = tmp_file("closed_loop.txt", "hello closed loop");
        let out = harness
            .gate(ToolCall {
                id: "c1".into(),
                name: "read_file".into(),
                arguments: serde_json::json!({ "path": p.display().to_string() }),
            })
            .await;
        assert!(
            out.denied.is_none(),
            "已注册只读工具不该被拒: {:?}",
            out.denied
        );
        let r = out.result.expect("非 denied 必有 result");
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("hello closed loop"));
        assert_eq!(r.verified, Some(true));
        let _ = std::fs::remove_file(&p);

        // 未注册工具 → discover 门 **fail-closed**（决策 2: 不许放行、不许静默）
        let out2 = harness
            .gate(ToolCall {
                id: "c2".into(),
                name: "write_file".into(),
                arguments: serde_json::json!({}),
            })
            .await;
        assert!(out2.denied.is_some(), "未注册工具必须被拒 (fail-closed)");
        assert!(out2.result.is_none(), "被拒 = 零执行");
    }

    /// **权限分级**（决策 2）: 未授予的写类被拒且零执行；授予后可写；
    /// 但不可逆的 `delete_file` **不随**可逆写一起被授予。
    #[tokio::test]
    async fn write_requires_grant_and_delete_stays_harder() {
        let reg = Arc::new(ToolRegistry::new());
        register_builtin_tools(&reg).await;
        let exec = || {
            Arc::new(BuiltinExecutor::new(
                Arc::new(AtomicBool::new(false)),
                false,
                crate::scratch::ScriptRunPort::noop(),
            )) as Arc<dyn ToolExecutor>
        };

        // ① 未授予 ⇒ permission 门拒，零执行
        let h = bolloon_harness::Harness::new(
            reg.clone(),
            exec(),
            bolloon_harness::Budget::new(5, 10_000),
        );
        let out = h
            .gate(ToolCall {
                id: "c1".into(),
                name: "write_file".into(),
                arguments: serde_json::json!({ "path": "/tmp/x", "content": "x" }),
            })
            .await;
        let d = out.denied.expect("未授予的写类必须被拒");
        assert_eq!(d.policy, "permission");
        assert!(out.result.is_none(), "被拒 = 零执行");

        // ② 授予后可写
        let h2 = bolloon_harness::Harness::new(
            reg.clone(),
            exec(),
            bolloon_harness::Budget::new(5, 10_000),
        )
        .with_granted(&["write_file"]);
        let p = std::env::temp_dir().join(format!("bolloon_grant_{}.txt", std::process::id()));
        let out2 = h2
            .gate(ToolCall {
                id: "c2".into(),
                name: "write_file".into(),
                arguments: serde_json::json!({ "path": p.display().to_string(), "content": "ok" }),
            })
            .await;
        assert!(out2.denied.is_none(), "已授予不该被拒: {:?}", out2.denied);
        assert!(out2.result.expect("有结果").ok);
        assert!(p.exists());

        // ③ 不可逆 delete 仍被拒（分级：不与可逆写同级）
        let out3 = h2
            .gate(ToolCall {
                id: "c3".into(),
                name: "delete_file".into(),
                arguments: serde_json::json!({ "path": p.display().to_string() }),
            })
            .await;
        assert!(
            out3.denied.is_some(),
            "不可逆 delete 不该随 write 一起被授予"
        );
        let _ = std::fs::remove_file(&p);
    }

    /// **模式授予（2026-10-31 回归门）**: 默认模式必须让日常 shell/写文件可用,
    /// 不可逆工具仍拒; 完全访问 ⇒ 全部放行。
    ///
    /// 真实 bug: web/App 用 `builtin_harness(.., false)` 却**一套都不授予** ⇒
    /// 界面上「完全访问」开了也没用, `shell`/`write_file` 一律 `DENIED (policy=permission)`。
    /// 所以这里断言的是 \*\*接线\*\*, 不只是 Harness 单门逻辑。
    #[tokio::test]
    async fn mode_grants_keep_daily_tools_usable() {
        let cancel = Arc::new(AtomicBool::new(false));

        // ① 默认模式: 日常可逆工具确实进了授予集合
        let (h, _s) = builtin_harness(20, 30_000, cancel.clone(), false).await;
        for name in ["shell", "write_file", "edit_file", "mkdir", "move_file"] {
            assert!(h.is_granted(name).await, "默认模式 {name} 必须被授予");
        }
        // 不可逆 / 对外副作用仍不授予 (决策 2 分级不能被\"顺手放宽\"抹掉)
        for name in ["delete_file", "git_push"] {
            assert!(!h.is_granted(name).await, "默认模式 {name} 不该被授予");
        }

        // ② 真执行: 默认模式 write_file 走完 discover→permission→…→execute
        let p = std::env::temp_dir().join(format!("bolloon_mode_{}.txt", std::process::id()));
        let out = h
            .gate(ToolCall {
                id: "w1".into(),
                name: "write_file".into(),
                arguments: serde_json::json!({ "path": p.display().to_string(), "content": "daily" }),
            })
            .await;
        assert!(
            out.denied.is_none(),
            "默认模式 write_file 被拒: {:?}",
            out.denied
        );
        assert!(out.result.expect("有结果").ok, "写文件应成功");
        assert!(p.exists());

        // ③ 默认模式: 不可逆 delete 被 permission 门拒 (零执行)
        let out2 = h
            .gate(ToolCall {
                id: "d1".into(),
                name: "delete_file".into(),
                arguments: serde_json::json!({ "path": p.display().to_string() }),
            })
            .await;
        let d = out2.denied.expect("默认模式 delete_file 必须被拒");
        assert_eq!(d.policy, "permission");
        assert!(out2.result.is_none());
        assert!(p.exists(), "被拒 = 零执行, 文件不该被动过");

        // ④ 完全访问: 同一台 harness 的构造函数, 换 bypass ⇒ 不可逆也放行
        let (h2, _s2) = builtin_harness(20, 30_000, cancel, true).await;
        assert!(
            h2.is_granted("delete_file").await,
            "完全访问必须授予 delete_file"
        );
        let out3 = h2
            .gate(ToolCall {
                id: "d2".into(),
                name: "delete_file".into(),
                arguments: serde_json::json!({ "path": p.display().to_string() }),
            })
            .await;
        assert!(
            out3.denied.is_none(),
            "完全访问下 delete_file 应放行: {:?}",
            out3.denied
        );
        assert!(out3.result.expect("有结果").ok);
        assert!(!p.exists());
    }

    /// read_file 失败同样带结构化错误码（与 shell 同一套契约）
    #[tokio::test]
    async fn read_file_failures_carry_structured_error_codes() {
        let c = |args: serde_json::Value| ToolCall {
            id: "c".into(),
            name: "read_file".into(),
            arguments: args,
        };
        let r = ReadFileExecutor.execute(c(serde_json::json!({}))).await;
        assert_eq!(
            r.evidence.as_ref().unwrap()["error"]["code"],
            "invalid_argument"
        );

        let r = ReadFileExecutor
            .execute(c(serde_json::json!({ "path": ".env" })))
            .await;
        assert_eq!(r.evidence.as_ref().unwrap()["error"]["code"], "denied");

        let r = ReadFileExecutor
            .execute(c(serde_json::json!({ "path": "/nonexistent/x.txt" })))
            .await;
        assert_eq!(r.evidence.as_ref().unwrap()["error"]["code"], "not_found");
    }

    /// 只读子集硬门 (2026-11-04): 发给模型的 schema 里**不许**出现写/执行类工具;
    /// 允许的只有 Read 类 + 显式点名的 web_fetch。
    #[tokio::test]
    async fn readonly_harness_exposes_only_read_and_web_fetch() {
        let cancel = Arc::new(AtomicBool::new(false));
        let (_h, schemas) = super::readonly_harness(5, 5_000, cancel).await;
        let names: Vec<String> = schemas.into_iter().map(|s| s.function.name).collect();
        for must in ["read_file", "list_directory", "grep_files", "web_fetch"] {
            assert!(names.iter().any(|n| n == must), "缺 {must}: {names:?}");
        }
        for forbidden in [
            "shell",
            "execute_command",
            "write_file",
            "write_to_file",
            "replace_in_file",
            "web_search",
            "econ_claim", // 能领额度/记账 —— 不是"读"
            "econ_probe",
        ] {
            assert!(
                !names.iter().any(|n| n == forbidden),
                "只读子集里混进了 {forbidden}: {names:?}"
            );
        }
    }

    /// 特化包白名单: 只发白名单工具, 且不许出现白名单外的名字
    #[tokio::test]
    async fn allowlist_harness_only_exposes_allowed_tools() {
        let cancel = Arc::new(AtomicBool::new(false));
        let allow = vec!["read_file".to_string(), "grep_files".to_string()];
        let (_h, schemas) = super::allowlist_harness(&allow, 5, 5_000, cancel, false).await;
        let names: Vec<String> = schemas.into_iter().map(|s| s.function.name).collect();
        assert_eq!(names.len(), 2, "只应有 2 个工具: {names:?}");
        assert!(names.iter().any(|n| n == "read_file"));
        assert!(names.iter().any(|n| n == "grep_files"));
        assert!(!names.iter().any(|n| n == "shell" || n == "web_fetch"));
    }
}
