//! slash.rs — `bolloon chat` 里所有 `/命令` 的注册表 (**唯一事实源**)
//!
//! 三条纪律:
//!   1. **一条不漏** —— 用户给定命令面的每一条都在 `SPECS` 里, 测试逐个核对
//!      (`every_required_command_is_registered`), 少一条就红;
//!   2. **状态如实** —— `Ready` = 本轮真实现; `Planned` = 有底座但没接 (写清还差什么);
//!      `Na` = 本仓库没有这个概念 (写清为什么)。**不拿"没实现"冒充"已实现"**;
//!   3. **别名不重复实现** —— 别名条目用 `alias_of` 指回本体, 真正逻辑只有一份
//!      (`alias_points_at_real_impl`)。
//!
//! 文案 (summary/usage) 与「能不能用」由这里统一给出, `chat_command.rs` 只写行为。

/// 命令的实现状态
#[derive(Clone, Copy)]
pub enum Status {
    /// 真实现 (本轮接好)
    Ready,
    /// 有底座/能做, 但还没接 —— 写清差什么
    Planned(&'static str),
    /// 本仓库没有这个概念 —— 写清为什么
    Na(&'static str),
}

impl Status {
    /// 帮助页里的后缀标记 (Ready 不加标记, 保持清爽)
    pub fn mark(&self) -> &'static str {
        match self {
            Status::Ready => "",
            Status::Planned(_) => " [待接]",
            Status::Na(_) => " [不适用]",
        }
    }
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            Status::Ready => None,
            Status::Planned(r) | Status::Na(r) => Some(r),
        }
    }
    #[allow(dead_code)] // bin 侧只在测试里用 (gate: 每个 Ready 都必须有实现)
    pub fn is_ready(&self) -> bool {
        matches!(self, Status::Ready)
    }
}

pub const C_SESSION: &str = "会话";
pub const C_CONTEXT: &str = "上下文";
pub const C_AUTO: &str = "后台与自动化";
pub const C_CONFIG: &str = "配置";
pub const C_INFO: &str = "信息";
pub const C_TOOLS: &str = "工具与技能";
pub const C_EXIT: &str = "退出";

/// 分类显示顺序 (与用户给的命令面一致)
pub const CATEGORIES: &[&str] = &[C_SESSION, C_CONTEXT, C_AUTO, C_CONFIG, C_INFO, C_TOOLS, C_EXIT];

pub struct Spec {
    pub name: &'static str,
    /// "" = 本体; 否则是本体命令名 (别名条目)
    pub alias_of: &'static str,
    pub category: &'static str,
    pub usage: &'static str,
    pub summary: &'static str,
    pub status: Status,
}

const fn s(
    name: &'static str,
    category: &'static str,
    usage: &'static str,
    summary: &'static str,
    status: Status,
) -> Spec {
    Spec { name, alias_of: "", category, usage, summary, status }
}

/// 别名条目: `status` 只是占位 —— `specs()` 会从本体**继承**可用性 (别名不许单独声明能用)
const fn a(name: &'static str, of: &'static str, category: &'static str, summary: &'static str) -> Spec {
    Spec { name, alias_of: of, category, usage: "", summary, status: Status::Ready }
}

use Status::{Na, Planned, Ready};

// ── 待接 / 不适用的原因 (集中一处, 改口径只改这里) ─────────────
const R_AGENT_LOOP: &str = "chat 目前直连 LLM, 没有 agent 循环 ⇒ 没有「下一轮注入 / 后台跑」的挂点";
const R_MSG_PLATFORM: &str = "bolloon 没有 Telegram/Discord/Slack 网关, 会话不能交接出去";
const R_NOUS: &str = "这是 Hermes/Nous 的账号与计费体系, bolloon 里不存在";
const R_UI_SETTING: &str = "bolloon 只有一套品牌主题, 没有可切换皮肤/状态栏/宠物";
const R_SNAPSHOT: &str = "状态快照要先把 config/state 收成一个可回滚单元, 本轮没做";
const R_SKILLS: &str = "chat 还没挂工具/技能循环; skills 运行时装在 agent 侧";
const R_MCP: &str = "chat 没接 MCP 客户端 (agent 侧才有 mcp.rs)";
const R_VOICE: &str = "没有语音/唤醒词管线";

/// **全部命令** (顺序 = 用户给定的命令面顺序, 帮助页按分类重排)
const RAW: &[Spec] = &[
    // ==== 会话 ====
    s("/new", C_SESSION, "/new [name]", "开新会话 (新 session ID + 消息清空)", Ready),
    a("/reset", "/new", C_SESSION, "开新会话"),
    s("/clear", C_SESSION, "/clear", "清屏并从新会话开始 (新 ID + 新历史)", Ready),
    s("/redraw", C_SESSION, "/redraw", "强制整屏重画 (终端画面错位时用)", Ready),
    s("/history", C_SESSION, "/history", "列出本会话的对话历史", Ready),
    s("/save", C_SESSION, "/save <json|md|html> [filename] [redact]", "导出当前会话 (裸 /save 只给用法)", Ready),
    s("/retry", C_SESSION, "/retry", "重发最后一条消息 (丢掉上一条回复再发一次)", Ready),
    s("/prompt", C_SESSION, "/prompt [initial text]", "在 $EDITOR 里写 markdown 提示词, 存盘后直接发送", Ready),
    a("/compose", "/prompt", C_SESSION, "在 $EDITOR 里写提示词再发送"),
    s("/undo", C_SESSION, "/undo [N]", "回退 N 轮用户消息并把它放回输入框 (默认 1)", Ready),
    s("/title", C_SESSION, "/title [name]", "给当前会话起标题", Ready),
    s("/handoff", C_SESSION, "/handoff <platform>", "把会话交接给消息平台", Na(R_MSG_PLATFORM)),
    s("/branch", C_SESSION, "/branch [--here] [name]", "从当前会话分叉出新线程", Na(R_MSG_PLATFORM)),
    a("/fork", "/branch", C_SESSION, "分叉出新线程"),
    s("/worktree", C_SESSION, "/worktree [new [name]|list|prune [--dry-run]]", "查看/新建/清理 git worktree", Ready),
    s("/rollback", C_SESSION, "/rollback [number] [--all]", "列出/恢复文件系统检查点", Planned(R_SNAPSHOT)),
    s("/snapshot", C_SESSION, "/snapshot [create|restore <id>|prune]", "创建/恢复 config 与 state 快照", Planned(R_SNAPSHOT)),
    a("/snap", "/snapshot", C_SESSION, "创建/恢复状态快照"),
    s("/stop", C_SESSION, "/stop", "杀掉所有后台进程", Planned("chat 不起后台进程; /bg 接好后才有意义")),
    s("/review", C_SESSION, "/review [instructions]", "派一个独立子智能体复查刚讨论的工作", Planned("subagents 有底座, 但 chat 没有 dispatch 入口")),
    s("/plan", C_SESSION, "/plan [task]", "把实施计划写成 markdown 落到 ~/.bolloon/rust/plans/ (不执行)", Ready),
    s("/egress", C_SESSION, "/egress [status]", "Docker 出口代理状态", Na("没有 Docker 出口代理这层")),
    s("/resume", C_SESSION, "/resume [name]", "恢复一个已命名的会话", Ready),
    s("/sessions", C_SESSION, "/sessions", "列出本机所有会话并给出恢复方式", Ready),

    // ==== 上下文 ====
    s("/compress", C_CONTEXT, "/compress [here [N] | focus topic | --preview]", "压缩上下文 (here N 保留最近 N 轮)", Ready),
    a("/compact", "/compress", C_CONTEXT, "压缩上下文"),
    s("/status", C_CONTEXT, "/status", "会话/模型/token 估算/上下文占用", Ready),
    s("/context", C_CONTEXT, "/context [all]", "上下文窗口明细 (占用条 + 分类 + 压缩统计)", Ready),
    a("/ctx", "/context", C_CONTEXT, "上下文窗口明细"),

    // ==== 后台与自动化 ====
    s("/bg", C_AUTO, "/bg <prompt>", "在独立后台会话里跑一条提示", Planned(R_AGENT_LOOP)),
    s("/btw", C_AUTO, "/btw <question>", "不打断当前对话, 顺带问一个旁支问题", Planned(R_AGENT_LOOP)),
    s("/agents", C_AUTO, "/agents", "看活跃的子智能体与在跑的任务", Planned("subagents 有执行板, chat 没接")),
    a("/tasks", "/agents", C_AUTO, "看活跃智能体与任务"),
    s("/journey", C_AUTO, "/journey [list|delete <id>|edit <id>]", "学习旅程时间线", Na("bolloon 没有学习旅程这层")),
    a("/learning", "/journey", C_AUTO, "学习旅程时间线"),
    a("/memory-graph", "/journey", C_AUTO, "学习旅程时间线"),
    s("/queue", C_AUTO, "/queue [<prompt>|list|edit N <prompt>|rm N|move A B|clear]", "排队下一轮的提示 (可增删改排)", Planned(R_AGENT_LOOP)),
    a("/q", "/queue", C_AUTO, "排队提示词"),
    s("/steer", C_AUTO, "/steer <prompt>", "在下次工具调用后注入一条消息", Planned(R_AGENT_LOOP)),
    a("/s", "/steer", C_AUTO, "注入消息"),
    s("/goal", C_AUTO, "/goal [text | show | pause | resume | clear | status]", "设定跨轮持续目标", Planned("goal.rs 是判定器, chat 没有跨轮驱动器")),
    s("/heartbeat", C_AUTO, "/heartbeat [every <interval> <prompt> | status | pause|resume|clear]", "空闲时定时回到本会话", Planned("heartbeat.rs 是注册表, chat 没有调度器")),
    a("/hb", "/heartbeat", C_AUTO, "空闲定时回到会话"),
    s("/refine", C_AUTO, "/refine [focus]", "复盘本对话, 把经验写进 memory/skills", Planned(R_AGENT_LOOP)),
    s("/loop", C_AUTO, "/loop [interval] <prompt> [--times N] [--until <条件>]", "在本会话里按间隔重复跑一条提示", Planned(R_AGENT_LOOP)),
    a("/proactive", "/loop", C_AUTO, "重复跑提示"),
    s("/moa", C_AUTO, "/moa <prompt>", "用 Mixture of Agents 跑一条提示再切回原模型", Planned("没有多模型编排层")),
    s("/subgoal", C_AUTO, "/subgoal [text | remove N | clear]", "给当前目标加/删子条件", Planned("goal.rs 只有判定器, 没有目标存储")),

    // ==== 配置 ====
    s("/export", C_CONFIG, "/export [profile] [-o out.tar.gz]", "导出一个 profile (config/skills/theme)", Planned("bolloon 没有 profile 概念 (只有一套 home)")),
    s("/import", C_CONFIG, "/import <archive.tar.gz> [--name N]", "导入别人的 profile 归档", Planned("bolloon 没有 profile 概念 (只有一套 home)")),
    s("/config", C_CONFIG, "/config", "显示当前配置 (provider/model/base_url/key 有无)", Ready),
    s("/model", C_CONFIG, "/model [model] [--provider name]", "切换本会话的模型", Ready),
    s("/codex-runtime", C_CONFIG, "/codex-runtime [auto|codex_app_server]", "切换 OpenAI/Codex 的 app-server 运行时", Na("没有 codex app-server 运行时")),
    a("/codex_runtime", "/codex-runtime", C_CONFIG, "切换 codex 运行时"),
    s("/personality", C_CONFIG, "/personality [name]", "设置预设人格", Na(R_UI_SETTING)),
    s("/statusbar", C_CONFIG, "/statusbar", "开关上下文/模型状态栏", Planned("状态栏已有 (Screen 固定行), 但没有开关")),
    a("/sb", "/statusbar", C_CONFIG, "开关状态栏"),
    s("/battery", C_CONFIG, "/battery [on|off|status]", "状态栏里加电量指示", Na(R_UI_SETTING)),
    s("/timestamps", C_CONFIG, "/timestamps [on|off|status]", "给消息与 /history 加 [HH:MM] 时间", Planned("消息框还不出时间戳")),
    a("/ts", "/timestamps", C_CONFIG, "时间戳开关"),
    s("/verbose", C_CONFIG, "/verbose", "循环工具进度显示: off → new → all → verbose", Planned("chat 只画工具调用摘要行")),
    s("/focus", C_CONFIG, "/focus [on|off|status]", "专注视图: 只留提问与最终回复", Planned("需要一个「只画首尾」的渲染开关")),
    s("/footer", C_CONFIG, "/footer [on|off|status]", "回复末尾加运行元数据脚注", Planned("还没有运行元数据汇总口")),
    s("/yolo", C_CONFIG, "/yolo", "跳过所有危险命令审批", Planned("审批门在 Harness, chat 直连 LLM 不经过它")),
    s("/approvals", C_CONFIG, "/approvals [manual|smart|off]", "设置危险命令审批模式", Planned("审批门在 Harness, chat 直连 LLM 不经过它")),
    s("/reasoning", C_CONFIG, "/reasoning [level|show|hide|full|clamp]", "推理强度与展示", Planned("provider 参数还没暴露到 chat")),
    s("/skin", C_CONFIG, "/skin [name]", "换皮肤/主题", Na(R_UI_SETTING)),
    s("/indicator", C_CONFIG, "/indicator [ascii|emoji|kaomoji|unicode]", "忙时指示器样式", Planned("加载动画已是固定 6 帧")),
    s("/voice", C_CONFIG, "/voice [on|off|tts|status]", "语音模式", Na(R_VOICE)),
    s("/wake", C_CONFIG, "/wake [on|off|status]", "唤醒词监听", Na(R_VOICE)),
    s("/busy", C_CONFIG, "/busy [queue|steer|interrupt|status]", "忙碌时消息怎么处理", Planned(R_AGENT_LOOP)),
    s("/autoprune", C_CONFIG, "/autoprune [on|off|later|status]", "自动清理旧会话", Planned("会话库刚落地, 清理策略还没定")),

    // ==== 信息 ====
    s("/whoami", C_INFO, "/whoami", "显示你的命令权限 (admin/user)", Na("bolloon 没有账号/权限体系")),
    s("/profile", C_INFO, "/profile", "显示当前 home 目录与配置位置", Ready),
    s("/diff", C_INFO, "/diff [staged|all|session] [--stat] [path...]", "看工作区的 git 改动", Ready),
    s("/help", C_INFO, "/help [skills|<filter>]", "命令帮助 (/help 过滤, /help <命令> 看细节)", Ready),
    s("/palette", C_INFO, "/palette", "打开模糊命令面板 (Ctrl+P)", Planned("需要全屏面板 + 模糊匹配; 目前 /help 过滤够用")),
    s("/usage", C_INFO, "/usage [reset]", "token 用量与速率限制", Planned("没有账号侧限额, 本地只能给估算 (见 /status)")),
    s("/subscription", C_INFO, "/subscription", "查看/变更订阅", Na(R_NOUS)),
    a("/upgrade", "/subscription", C_INFO, "查看/变更订阅"),
    s("/login", C_INFO, "/login", "用 Nous 账号登录", Na(R_NOUS)),
    s("/topup", C_INFO, "/topup", "查看余额/充值", Na(R_NOUS)),
    s("/insights", C_INFO, "/insights [days]", "用量洞察", Planned("没有本地用量账本")),
    s("/platforms", C_INFO, "/platforms", "网关/消息平台状态", Na(R_MSG_PLATFORM)),
    a("/gateway", "/platforms", C_INFO, "网关状态"),
    s("/copy", C_INFO, "/copy [number]", "把第 N 条回复复制到系统剪贴板", Ready),
    s("/paste", C_INFO, "/paste", "贴剪贴板里的图片, 作为下一条消息的附件", Ready),
    s("/image", C_INFO, "/image <path>", "把本地图片挂到下一条消息", Ready),
    s("/update", C_INFO, "/update [install]", "检查/安装 bolloon 自身更新", Ready),
    s("/version", C_INFO, "/version", "显示 bolloon 版本", Ready),
    a("/v", "/version", C_INFO, "显示版本"),
    s("/debug", C_INFO, "/debug [nous|local]", "上传调试报告换分享链接", Na("没有上报服务; 本地日志在 logs/")),

    // ==== 工具与技能 ====
    s("/tools", C_TOOLS, "/tools [list|disable|enable] [name...]", "管理工具", Planned(R_SKILLS)),
    s("/toolsets", C_TOOLS, "/toolsets", "列出可用工具集", Planned(R_SKILLS)),
    s("/skills", C_TOOLS, "/skills", "列出已装技能", Planned(R_SKILLS)),
    s("/memory", C_TOOLS, "/memory [pending|approve|reject|approval]", "记忆审批闸", Planned("bolloon 记忆走 memory_db (remember/recall), 没有审批闸")),
    s("/bundles", C_TOOLS, "/bundles", "技能包", Planned(R_SKILLS)),
    s("/pet", C_TOOLS, "/pet [toggle|list|scale <n>|<slug>]", "桌面宠物", Na(R_UI_SETTING)),
    s("/hatch", C_TOOLS, "/hatch [description]", "生成新宠物", Na(R_UI_SETTING)),
    a("/generate-pet", "/hatch", C_TOOLS, "生成新宠物"),
    s("/learn", C_TOOLS, "/learn <what to learn from>", "从目录/URL/对话里学一条可复用技能", Planned("skills_runtime 有 register, 但「从材料学」这一步没接")),
    s("/init", C_TOOLS, "/init [notes]", "扫仓库生成/更新 AGENTS.md", Planned("AGENTS.md 由人维护, 自动生成未做")),
    s("/cron", C_TOOLS, "/cron [subcommand]", "管理定时任务", Planned("kernel 有 cron, chat 没接线")),
    s("/suggestions", C_TOOLS, "/suggestions [accept|dismiss N|catalog]", "待审的自动化建议", Planned("没有建议生成器")),
    a("/suggest", "/suggestions", C_TOOLS, "自动化建议"),
    s("/blueprint", C_TOOLS, "/blueprint [name] [slot=value ...]", "用模板搭一条自动化", Planned("没有自动化模板库")),
    a("/bp", "/blueprint", C_TOOLS, "自动化模板"),
    s("/curator", C_TOOLS, "/curator [subcommand]", "后台技能维护", Planned(R_SKILLS)),
    s("/kanban", C_TOOLS, "/kanban [subcommand]", "多 profile 协作看板", Planned("task_board 是任务公告板, 不是看板 UI")),
    s("/reload", C_TOOLS, "/reload", "重新加载 .env 到当前会话", Planned("配置在每个 provider 里, 重载入口没接")),
    s("/reload-mcp", C_TOOLS, "/reload-mcp", "重载 MCP 服务器", Planned(R_MCP)),
    a("/reload_mcp", "/reload-mcp", C_TOOLS, "重载 MCP"),
    s("/reload-skills", C_TOOLS, "/reload-skills", "重新扫描技能目录", Planned(R_SKILLS)),
    a("/reload_skills", "/reload-skills", C_TOOLS, "重扫技能"),
    s("/browser", C_TOOLS, "/browser [connect|disconnect|status|use]", "把浏览器工具接到本机 Chromium", Planned("没有 CDP 客户端")),
    s("/plugins", C_TOOLS, "/plugins", "列出已装插件", Planned("bolloon 没有插件机制")),

    // ==== 退出 ====
    s("/quit", C_EXIT, "/quit [--delete]", "退出 CLI (--delete 连会话一起删)", Ready),
    a("/exit", "/quit", C_EXIT, "退出 CLI"),
];

static RESOLVED: std::sync::LazyLock<Vec<Spec>> = std::sync::LazyLock::new(|| {
    let mut v: Vec<Spec> = Vec::with_capacity(RAW.len());
    for sp in RAW {
        let mut c = Spec {
            name: sp.name,
            alias_of: sp.alias_of,
            category: sp.category,
            usage: sp.usage,
            summary: sp.summary,
            status: sp.status,
        };
        if !c.alias_of.is_empty() {
            if let Some(t) = RAW.iter().find(|x| x.name == c.alias_of) {
                // 别名**继承**本体: 本体不能用, 别名也不能; 用法也照抄
                c.status = t.status;
                if c.usage.is_empty() {
                    c.usage = t.usage;
                }
            }
        }
        v.push(c);
    }
    v
});

/// 解析后的命令表 (别名已继承本体状态) —— **所有读取都走这里**
pub fn specs() -> &'static [Spec] {
    &RESOLVED
}

/** 按名字或别名查 (大小写不敏感) */
pub fn find(name: &str) -> Option<&'static Spec> {
    let want = name.trim().to_ascii_lowercase();
    let want = if want.starts_with('/') { want } else { format!("/{want}") };
    specs().iter().find(|s| s.name == want)
}

/** 别名 → 本体命令名; 本体原样返回 */
pub fn canonical(spec: &Spec) -> &'static str {
    if spec.alias_of.is_empty() { spec.name } else { spec.alias_of }
}

/**
 * 解析一行输入: `/cmd args...` → (spec, 余下参数)。
 *
 * 不是命令 (不以 `/` 开头) 或不在表里 ⇒ None (调用方按普通消息/未知命令处理)。
 */
pub fn parse(line: &str) -> Option<(&'static Spec, String)> {
    let t = line.trim();
    if !t.starts_with('/') {
        return None;
    }
    let mut parts = t.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or("");
    let args = parts.next().unwrap_or("").trim().to_string();
    find(name).map(|s| (s, args))
}

/**
 * 帮助页 (**全部命令**, 按分类, 非 Ready 的带 `[待接]`/`[不适用]` 标记)。
 *
 * `filter` 给了就只留命中项 (名字/别名/说明里包含, 大小写不敏感); 分类标题里的计数
 * 始终写**原始条数**, 免得"过滤后计数变小"误导。
 */
pub fn help_lines(filter: Option<&str>) -> Vec<String> {
    let f = filter.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty());
    let hit = |sp: &Spec| -> bool {
        match &f {
            None => true,
            Some(q) => {
                sp.name.to_ascii_lowercase().contains(q)
                    || sp.summary.to_ascii_lowercase().contains(q)
                    || sp.usage.to_ascii_lowercase().contains(q)
            }
        }
    };

    let mut out: Vec<String> = Vec::new();
    out.push(format!(
        "Bolloon 命令 (共 {} 条 · 别名也算一条){}",
        specs().len(),
        match &f {
            Some(q) => format!(" · 过滤 “{q}”"),
            None => String::new(),
        }
    ));
    for cat in CATEGORIES {
        let rows: Vec<&Spec> = specs()
            .iter()
            .filter(|s| s.category == *cat && hit(s))
            .collect();
        if rows.is_empty() {
            continue;
        }
        out.push(String::new());
        out.push(format!("── {cat} ──"));
        for sp in rows {
            let alias = if sp.alias_of.is_empty() {
                String::new()
            } else {
                format!(" (别名 for {})", sp.alias_of)
            };
            out.push(format!(
                "  {:<16} {}{}{}",
                sp.name,
                sp.summary,
                alias,
                sp.status.mark()
            ));
        }
    }
    out
}

/** 单条命令的细节 (`/help <命令>`) */
pub fn detail_lines(spec: &Spec) -> Vec<String> {
    let mut out = vec![
        format!("{} — {}", spec.name, spec.summary),
        format!("分类: {}", spec.category),
    ];
    if !spec.usage.is_empty() {
        out.push(format!("用法: {}", spec.usage));
    }
    if !spec.alias_of.is_empty() {
        out.push(format!("别名属于: {}", spec.alias_of));
    }
    match spec.status.reason() {
        None => out.push("状态: ✓ 可用".to_string()),
        Some(r) => out.push(format!("状态: {} — {r}", spec.status.mark().trim())),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// 用户给定的命令面 **一条都不能漏** (逐条列出, 少一条就红)
    #[test]
    fn every_required_command_is_registered() {
        let required = [
            "/new", "/reset", "/clear", "/redraw", "/history", "/save", "/retry", "/prompt",
            "/compose", "/undo", "/title", "/handoff", "/branch", "/fork", "/worktree",
            "/rollback", "/snapshot", "/snap", "/stop", "/review", "/plan", "/egress", "/resume",
            "/sessions", "/compress", "/compact", "/status", "/context", "/ctx", "/bg", "/btw",
            "/agents", "/tasks", "/journey", "/learning", "/memory-graph", "/queue", "/q",
            "/steer", "/s", "/goal", "/heartbeat", "/hb", "/refine", "/loop", "/proactive",
            "/moa", "/subgoal", "/export", "/import", "/config", "/model", "/codex-runtime",
            "/codex_runtime", "/personality", "/statusbar", "/sb", "/battery", "/timestamps",
            "/ts", "/verbose", "/focus", "/footer", "/yolo", "/approvals", "/reasoning",
            "/skin", "/indicator", "/voice", "/wake", "/busy", "/autoprune", "/whoami",
            "/profile", "/diff", "/help", "/palette", "/usage", "/subscription", "/upgrade",
            "/login", "/topup", "/insights", "/platforms", "/gateway", "/copy", "/paste",
            "/image", "/update", "/version", "/v", "/debug", "/tools", "/toolsets", "/skills",
            "/memory", "/bundles", "/pet", "/hatch", "/generate-pet", "/learn", "/init",
            "/cron", "/suggestions", "/suggest", "/blueprint", "/bp", "/curator", "/kanban",
            "/reload", "/reload-mcp", "/reload_mcp", "/reload-skills", "/reload_skills",
            "/browser", "/plugins", "/quit", "/exit",
        ];
        for name in required {
            assert!(find(name).is_some(), "命令面漏了 {name}");
        }
        assert_eq!(required.len(), specs().len(), "注册表条数与命令面不一致 (多了或少了)");
    }

    /// 名字唯一 (别名也是名字, 不许重复注册)
    #[test]
    fn names_are_unique() {
        let mut seen = HashSet::new();
        for sp in specs() {
            assert!(seen.insert(sp.name), "重复注册: {}", sp.name);
        }
    }

    /// 别名必须指向**真实存在**的本体, 且别名不许自带实现 (逻辑只有一份)
    #[test]
    fn alias_points_at_real_impl() {
        for sp in specs().iter().filter(|s| !s.alias_of.is_empty()) {
            let target = find(sp.alias_of).unwrap_or_else(|| panic!("{} 指向不存在的 {}", sp.name, sp.alias_of));
            assert!(target.alias_of.is_empty(), "{} 指向的 {} 也是别名 (链条不许打结)", sp.name, sp.alias_of);
            assert_eq!(sp.category, target.category, "{} 与本体分类不一致", sp.name);
        }
    }

    /// 每个 Ready 命令都必须有用法 (没用法等于没说清怎么调)
    #[test]
    fn ready_commands_have_usage() {
        for sp in specs().iter().filter(|s| s.status.is_ready()) {
            assert!(!sp.usage.is_empty(), "{} 是 Ready 但没写用法", sp.name);
            assert!(!sp.summary.is_empty(), "{} 没有说明", sp.name);
        }
    }

    /// 非 Ready 必须写清原因 (不许只挂个标记)
    #[test]
    fn not_ready_commands_say_why() {
        for sp in specs().iter().filter(|s| !s.status.is_ready()) {
            let r = sp.status.reason().unwrap_or("");
            assert!(r.len() >= 6, "{} 没写清楚为什么不可用: {r:?}", sp.name);
        }
    }

    /// 解析: 名字大小写不敏感, 参数原样带出
    #[test]
    fn parse_takes_name_and_args() {
        let (sp, args) = parse("/SAVE md out.md redact").unwrap();
        assert_eq!(sp.name, "/save");
        assert_eq!(args, "md out.md redact");
        assert_eq!(parse("/undo").unwrap().1, "");
        assert!(parse("你好").is_none(), "普通消息不是命令");
        assert!(parse("/nope").is_none(), "未注册的命令要 None");
    }

    /// 帮助页: 分类齐全 + 待接/不适用带标记 + 过滤有效
    #[test]
    fn help_lists_every_category_and_marks_status() {
        let all = help_lines(None).join("\n");
        for cat in CATEGORIES {
            assert!(all.contains(&format!("── {cat} ──")), "帮助页缺分类 {cat}");
        }
        assert!(all.contains("[待接]"));
        assert!(all.contains("[不适用]"));
        assert!(all.contains("/new"));
        assert!(all.contains("/exit"));

        let only_save = help_lines(Some("save")).join("\n");
        assert!(only_save.contains("/save"));
        assert!(!only_save.contains("/worktree"), "过滤后不该出现无关命令");
    }

    /// 细节页: Ready 写"可用", 非 Ready 写原因
    #[test]
    fn detail_shows_status_and_reason() {
        let d = detail_lines(find("/new").unwrap()).join("\n");
        assert!(d.contains("✓ 可用"), "{d}");
        let d2 = detail_lines(find("/login").unwrap()).join("\n");
        assert!(d2.contains("不适用") && d2.contains("Nous"), "{d2}");
    }

    /// Ready 数量是口径的一部分 (改少了要有人看见)
    #[test]
    fn ready_count_is_what_we_claim() {
        let ready = specs().iter().filter(|s| s.status.is_ready()).count();
        // 含别名 (别名继承本体状态), 所以这个数 > "真命令数"
        assert_eq!(ready, 33, "Ready 命令数变了: {ready} (改了就在这里同步口径)");
    }
}
