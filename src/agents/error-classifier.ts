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
  { pattern: /ENOENT|not found|no such file|does not exist|invalid path|bad argument|ERR_INVALID/i, cls: 'bad_input', label: '参数错误' },
  { pattern: /401|403|quota|rate limit|API key|unauthorized|authentication/i, cls: 'api_error', label: 'API 认证错误' },
];

export interface ErrorClassification {
  cls: ErrorClass;
  label: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  recoverable: boolean;
}

export function classifyError(errorMsg: string): ErrorClassification {
  if (!errorMsg) return { cls: 'unknown', label: '未知错误', severity: 'medium', recoverable: true };
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
  return { cls: 'unknown', label: '未知错误', severity: 'medium', recoverable: true };
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
    obs.summary = `✅ ${tool} 成功 (${output.length}B)`;
  } else {
    const errMsg = result.error || '未知失败';
    const cls = classifyError(errMsg);
    obs.errorClass = cls.cls;
    obs.errorLabel = cls.label;
    obs.summary = `❌ ${tool} 失败: ${cls.label} — ${errMsg.slice(0, 120)}`;
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
