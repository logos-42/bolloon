/**
 * error-classifier.ts — 工具错误分类 + 反射引擎
 *
 * 分层:
 *   1. classifyError: 原始 error string → ErrorClass
 *   2. buildObservation: 工具结果 → 结构化 Observation
 *   3. buildReflection: 错误历史 → 替代策略建议
 *   4. suggestEscalation: 阶梯升档: 重试→换参数→换工具→简化→放弃
 */

// ==================== 错误分类 ====================

export type ErrorClass =
  | 'tool_not_found'       // ToolCall.name 不在已注册工具集
  | 'permission_denied'    // PreToolUse / Harness gate 拒绝
  | 'network_error'        // 网络不通, RPC 超时, DNS 失败
  | 'timeout'              // 工具执行超时
  | 'bad_input'            // 参数格式错误, 文件不存在, 路径非法
  | 'api_error'            // LLM API 401/403/quota/rate-limit
  | 'internal_error'       // 工具内部异常 (非预期 crash)
  | 'unknown';             // 兜底

const ERROR_SIGNATURES: Array<{ pattern: RegExp; cls: ErrorClass; label: string }> = [
  { pattern: /unknown tool|未知工具|tool.*not found|is not a function/i, cls: 'tool_not_found', label: '工具不存在' },
  { pattern: /PreToolUse 拒绝|Harness.*拒绝|permission|not allowed|denied/i, cls: 'permission_denied', label: '权限拒绝' },
  { pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|connect.*fail|fetch.*fail/i, cls: 'network_error', label: '网络错误' },
  { pattern: /timeout|timed out/i, cls: 'timeout', label: '执行超时' },
  // 2026-10-01: ENOENT 单独一条 —— 原先和 bad argument 挤在一起 ⇒ 路径不存在被报成"参数错误" ✗
  //   (用户实测: list_files '~/.bolloon' ⇒ ENOENT, 却被标成"参数错误", 真原因被标签盖住)
  { pattern: /ENOENT|no such file|does not exist|not exist/i, cls: 'bad_input', label: '路径/文件不存在' },
  { pattern: /invalid path|bad argument|ERR_INVALID|参数/i, cls: 'bad_input', label: '参数错误' },
  { pattern: /401|403|quota|rate limit|API key|unauthorized|authentication/i, cls: 'api_error', label: 'API 认证错误' },
];

export interface ErrorClassification {
  cls: ErrorClass;
  label: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  recoverable: boolean;
}

export function classifyError(errorMsg: string): ErrorClassification {
  if (!errorMsg) return { cls: 'unknown', label: '', severity: 'medium', recoverable: true };
  for (const sig of ERROR_SIGNATURES) {
    if (sig.pattern.test(errorMsg)) {
      const severity = sig.cls === 'api_error' ? 'high'
        : sig.cls === 'internal_error' ? 'high'
        : sig.cls === 'permission_denied' ? 'high'
        : sig.cls === 'tool_not_found' ? 'low'
        : sig.cls === 'bad_input' ? 'low'
        : 'medium';
      const recoverable = sig.cls !== 'api_error' && sig.cls !== 'permission_denied';
      return { cls: sig.cls, label: sig.label, severity, recoverable };
    }
  }
  return { cls: 'unknown', label: '', severity: 'medium', recoverable: true };
}

// ==================== Observation ====================

export interface Observation {
  tool: string;
  args: Record<string, string>;
  success: boolean;
  output?: string;
  errorClass?: ErrorClass;
  errorLabel?: string;
  /** 60 字以内的语义摘要 */
  summary: string;
}

export function buildObservation(
  tool: string,
  args: Record<string, string>,
  result: { success: boolean; output?: string; error?: string },
): Observation {
  const obs: Observation = { tool, args, success: result.success, summary: '' };
  if (result.success) {
    const output = result.output || '(无输出)';
    obs.output = output;
    // 2026-10-01 (用户: 「完整看一下这个反思模式，为啥一直出错？」):
    //   原来只报 **字节数** ✗(`✅ terminal 成功 (1234B)`) ⇒ 模型不知道**发生了什么**, 只能猜 ⇒ 猜错 ✓
    //   现在附一段**内容预览**(压平换行 ✓ 头部 160 字符 ✓) ⇒ 观察里就有事实 ✓。
    const preview = output.replace(/\s+/g, ' ').trim().slice(0, 160);
    obs.summary = `✅ ${tool} 成功 (${output.length}B)${preview ? `: ${preview}` : ''}`;
  } else {
    const errMsg = result.error || '未知失败';
    const cls = classifyError(errMsg);
    obs.errorClass = cls.cls;
    obs.errorLabel = cls.label;
    // ② 2026-10-01: 退出码非零时**先不写"失败"** ✓(钩子/子命令常以非零退出而动作已生效);
    // ③ 并附**输出尾部** —— 原来只截错误文本前 120 字符 ✗, 而 lefthook 那类"到底干了什么"恰在**尾部** ⇒ 必然误判 ✗
    const __exit0 = Number((/exit\s+(\d+)/i.exec(result.error || '') || [])[1]);
    const __tail = String(result.output || '').replace(/\s+/g, ' ').trim().slice(-200);
    const __head = __exit0 && Number.isFinite(__exit0) && __exit0 !== 0 && tool === 'terminal'
      ? `⚠️ ${tool} 退出码 ${__exit0}(结果待核, 不等于失败)`
      : `❌ ${tool} 失败: ${cls.label}`;
    obs.summary = `${__head} — ${errMsg.slice(0, 160)}${__tail ? ` · 输出尾部: ${__tail}` : ''}`;
    // 2026-10-01 (用户: 「反思还是有错误」—— 现场实测: git 提交**已经成功**, 但那一行却写着
    //   `Reflection: ❌ terminal 失败: — exit 1` ✗, 把 lefthook 的钩子退出码当成了任务失败 ✗):
    //   **退出码非零 ≠ 任务失败** ✓ —— 用命令核一次事实再下结论, 别直接写"失败"。
    const __exit = Number((/exit\s+(\d+)/i.exec(errMsg) || [])[1]);
    if (tool === 'terminal' && Number.isFinite(__exit) && __exit !== 0) {
      obs.summary = `${obs.summary} · ⚠️ 退出码 ${__exit} **不等于任务失败**(钩子/子命令常以非零退出而动作已生效)`
        + ` —— 先核事实(git status / git log / read_file 看结果)再下结论, 别写成"失败"`;
    }
    // 2026-10-01 (优化 #6): 顺手给出"下一步该干什么" —— 光有标签模型会原地重试同一条命令
    const __advice = suggestNextAction(`${cls.label} ${errMsg}`);
    if (__advice) obs.summary = `${obs.summary} · ${__advice}`;
  }
  return obs;
}

// ==================== Reflection ====================

export interface StrategySuggestion {
  action: 'retry' | 'change_params' | 'change_tool' | 'simplify_goal' | 'abandon';
  reason: string;
  detail: string;
}

const ERROR_TO_STRATEGIES: Record<ErrorClass, StrategySuggestion[]> = {
  tool_not_found: [
    { action: 'change_tool', reason: '工具名不存在', detail: '用 list_tools 查可用工具, 使用正确的工具名' },
    { action: 'retry', reason: '可能是别名没匹配上', detail: '尝试用标准工具名重新调用, 如 shell_exec 而非 bash' },
  ],
  permission_denied: [
    { action: 'change_tool', reason: '当前工具被权限系统阻止', detail: '尝试用其他方式完成目标, 如 read_file 替代 shell_exec cat' },
    { action: 'simplify_goal', reason: '权限持续拒绝', detail: '缩小操作范围, 选择不需要高权限的操作' },
  ],
  network_error: [
    { action: 'retry', reason: '网络偶发故障', detail: '等待 2-3 秒后重试, LLM 会自动降速' },
    { action: 'change_tool', reason: '网络不可用', detail: '尝试本地操作替代网络请求' },
  ],
  timeout: [
    { action: 'retry', reason: '可能暂时性负载高', detail: '简化参数后重试, 或分多次执行' },
    { action: 'change_tool', reason: '工具执行时间过长', detail: '换一个更轻量的工具' },
  ],
  bad_input: [
    { action: 'change_params', reason: '参数格式不对', detail: '检查参数格式: 路径用绝对路径, 空格用引号包裹' },
    { action: 'retry', reason: '参数调整后重试', detail: '用正确的参数重新调用' },
  ],
  api_error: [
    { action: 'simplify_goal', reason: 'API 认证失败', detail: '检查 API 配置或使用已有的本地能力完成' },
    { action: 'abandon', reason: 'API 不可恢复', detail: 'API key 或配额问题无法自动解决, 告知用户' },
  ],
  internal_error: [
    { action: 'change_tool', reason: '工具内部异常', detail: '换另一种方式处理' },
    { action: 'simplify_goal', reason: '工具无法正常工作', detail: '尝试用更简单的方式完成任务' },
  ],
  unknown: [
    { action: 'retry', reason: '错误类型不确定', detail: '换个方式或参数再试一次' },
    { action: 'change_tool', reason: '原方法不可行', detail: '尝试用其他工具组合达成目标' },
  ],
};

export function buildReflection(
  toolName: string,
  errorMsg: string | undefined,
  errorCount: number,
  sameToolFailCount: number,
): StrategySuggestion[] {
  if (!errorMsg) return ERROR_TO_STRATEGIES.unknown.slice(0, 1);
  // ④ 2026-10-01: 退出码非零 ⇒ **先核事实**, 而不是按规则表给重试 ✗
  //   (实测: git 提交已生效却因钩子退出码非零被判失败 ⇒ 模型又去重试/绕道, 越走越偏 ✗)
  const __exitCode = Number((/exit\s+(\d+)/i.exec(errorMsg) || [])[1]);
  if (Number.isFinite(__exitCode) && __exitCode !== 0) {
    return [
      { action: 'change_params', reason: `退出码 ${__exitCode} —— 结果待核(不等于失败)`, detail: '先用 git status / git log / read_file 核事实, 确认到底成没成, 再决定下一步; 别直接当失败重试' },
      { action: 'change_tool', reason: '换法再试', detail: '若确未成功: 换参数/换工具/拆小步再执行' },
    ];
  }
  const cls = classifyError(errorMsg);

  // 阶梯升档: 根据连续失败次数选择更激进的策略
  if (sameToolFailCount >= 3) {
    return [
      { action: 'abandon', reason: `工具 ${toolName} 连续失败 ${sameToolFailCount} 次`, detail: '放弃这个工具, 用其他方法或直接给用户已知信息' },
      { action: 'simplify_goal', reason: '工具不可用', detail: '简化任务, 给出已成功执行的部分结果' },
    ];
  }
  if (errorCount >= 5) {
    return [
      { action: 'simplify_goal', reason: `累计 ${errorCount} 次错误`, detail: '放弃复杂操作, 用已有知识回答用户' },
    ];
  }

  return ERROR_TO_STRATEGIES[cls.cls] || ERROR_TO_STRATEGIES.unknown;
}

// ==================== 格式化为 system prompt 注入 ====================

/**
 * 把 Observation + Reflection 格式化成一条 system 消息,
 * 注入到 messageHistory 中让 LLM 下一轮能看到.
 */
export function formatObservationWithReflection(
  obs: Observation,
  reflection: StrategySuggestion[],
): string {
  const lines: string[] = [];
  lines.push(`[工具结果] ${obs.summary}`);
  if (!obs.success && reflection.length > 0) {
    lines.push(`[Reflection] 推荐策略:`);
    for (const r of reflection.slice(0, 2)) {
      lines.push(`  - ${r.action}: ${r.reason}. ${r.detail}`);
    }
  }
  return lines.join('\n');
}

/**
 * 错误 ⇒ **下一步动作建议** (2026-10-01 优化 #6)。
 * 光有标签(路径不存在/参数错误)还不够 —— 模型得知道**接着该干什么**, 否则就原地重试同一条命令。
 */
export function suggestNextAction(labelOrMsg: string): string | null {
  const s = String(labelOrMsg || '');
  const rules: Array<[RegExp, string]> = [
    [/路径|不存在|ENOENT/i, '用 list_files / glob_files 看**真实**路径再重试(注意 ~ 展开与工作目录)'],
    [/超时|timeout/i, '拆小(分成多次/加 limit)或改用后台执行, 别原样重发'],
    [/权限|EACCES|EPERM/i, '换可写目录(如工作区或 /tmp), 不要动系统目录'],
    [/参数|invalid|missing|必填/i, '对照工具描述里的必填项补齐参数; 不确定就先 list_tools 看schema'],
    [/网络|ECONN|fetch failed|不可达/i, '确认本机服务/代理可达; 自家域走 --resolve + --noproxy'],
    [/缓冲区|maxBuffer|输出过大/i, '加过滤(只取需要的行)或改写到文件再按需读取'],
  ];
  for (const [re, advice] of rules) if (re.test(s)) return `下一步: ${advice}`;
  return null;
}
