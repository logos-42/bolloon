/**
 * trace 执行描述 (2026-10-01, 用户: 「反思还是有错误，这里的思考能不能变成 trace 的执行描述」)。
 *
 * 用户实测的痛点: 原来显示的是模型的**思维流**(💭) —— 英文、常重复四遍、还夹着**错的推断** ✗
 *   (例: 同一句 "The user wants to push to GitHub." 出现四次; 中途还有一句 `Reflection: ❌ …` 把
 *    lefthook 的正常输出当成失败 ✗)。人要的是"它**在做什么**" ✓, 不是"它**在想什么**" ✗。
 * 做法: 把思维流默认关掉, 改在**工具行**上写一句中文动作短语(trace ✓) —— 一行说清这一步干了什么 ✓。
 * 纯函数 ⇒ 可测。
 */

/** 工具名 → 中文动作短语 (按"人看到这一步在干嘛"来写, 不照搬工具名) */
const ACTIONS: Array<[RegExp, string]> = [
  [/^git_status$/, '查看 git 状态'],
  [/^git_diff$/, '看改动差异'],
  [/^git_log$/, '看提交历史'],
  [/^git_commit$/, '提交改动'],
  [/^git_push$/, '推送'],
  [/^grep_files$/, '搜内容'],
  [/^glob_files$/, '找文件'],
  [/^list_files$/, '列目录'],
  [/^read_file$/, '读文件'],
  [/^read_document$/, '读文档'],
  [/^write_file$/, '写文件'],
  [/^(edit_file|patch)$/, '改文件'],
  [/^(mkdir|move_file|delete_file|copy_file)$/, '改文件系统'],
  [/^terminal$/, '跑命令'],
  [/^execute_code$/, '跑代码'],
  [/^tsc_check$/, '查类型'],
  [/^list_tools$/, '看有哪些工具'],
  [/^list_skills$/, '找技能'],
  [/^read_skill$/, '读技能'],
  [/^process$/, '管后台进程/服务'],
  [/^task|^plan|^todo/i, '理计划/待办'],
  [/^send_|^broadcast|^check_inbox|^list_peers/, '发消息/看连接'],
  [/^group|^create_group|^join_group/, '群聊操作'],
  [/^wallet|^get_balance|^tx|^token/, '链上/钱包操作'],
  [/^fetch_url|^web_search/, '联网取信息'],
  [/^get_identity|^set_persona|^bolloon_config/, '看/改身份与配置'],
  [/^delegate_task|^agent_call/, '派子智能体'],
];

/** 一句话说清这一步在做什么; 认不出的工具 ⇒ 返回空(调用方退回显示工具名) ✓ */
export function describeToolCall(name: string): string {
  const n = String(name ?? '').trim();
  if (!n) return '';
  for (const [re, label] of ACTIONS) if (re.test(n)) return label;
  return '';
}

/** 渲染成工具行文字 (认不出就用工具名本身, 绝不显示空白 ✓) */
export function traceLabel(name: string): string {
  const d = describeToolCall(name);
  return d ? `${d} · ${name}` : name;
}
