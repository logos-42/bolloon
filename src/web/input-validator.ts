/**
 * input-validator — web 接口输入验证 (v0.2.5)
 *
 * 2026-07-01: 抽到独立模块, claude code / 前端都能 import 验证.
 *   - 后端用: POST /api/validate-input 调 validate()
 *   - 前端用: 实时 UI 反馈 (发送前预校验, 不阻塞)
 *
 * 验证规则 (bolloon web 当前业务):
 *   - text 非空 (trim 后)
 *   - text 长度 <= MAX_TEXT_LENGTH
 *   - text 不包含 NUL / 不可打印控制字符
 *   - channelId 非空
 *   - channelName (新建频道) 长度 <= MAX_NAME_LENGTH
 *   - 不含 SQL/XSS payload 触发 (sanitize-only: 不是阻止, 是 warn)
 *
 * 设计: 纯函数 + 返回结构化 ValidationResult.
 *   { ok: true, reason?, severity? }
 *   严重等级: 'info' | 'warn' | 'block'
 */

export interface ValidationResult {
  ok: boolean;
  /** 人类可读说明 (前端 UI 展示) */
  reason?: string;
  /** 严重等级 — 'block' 表示拒收, 'warn' 表示通过但提示 */
  severity?: 'info' | 'warn' | 'block';
  /** 校验后的清理文本 (trim + 长度截断) */
  cleaned?: string;
}

export const MAX_TEXT_LENGTH = 16_000;  // 大约 4K tokens, 单条 user 消息够用
export const MAX_NAME_LENGTH = 200;     // channel name 上限
export const MAX_AGENT_ID_LENGTH = 200;

/** 校验单条 /message 请求 (text + channelId) */
export function validateMessageInput(input: {
  text?: unknown;
  channelId?: unknown;
}): ValidationResult {
  // 1. channelId
  if (typeof input.channelId !== 'string' || input.channelId.trim() === '') {
    return { ok: false, severity: 'block', reason: 'channelId 必填' };
  }
  if (input.channelId.length > 256) {
    return { ok: false, severity: 'block', reason: `channelId 长度超过 256 字符 (${input.channelId.length})` };
  }

  // 2. text
  if (typeof input.text !== 'string') {
    return { ok: false, severity: 'block', reason: 'text 必填且必须是字符串' };
  }
  const trimmed = input.text.trim();
  if (trimmed === '') {
    return { ok: false, severity: 'block', reason: 'text 不能为空 (trim 后)' };
  }
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      severity: 'block',
      reason: `text 长度 ${trimmed.length} 超过最大 ${MAX_TEXT_LENGTH} 字符`,
    };
  }

  // 3. 控制字符检测 — 拒绝 NUL + 不可打印 char (< 0x20 除了 \n \r \t)
  // eslint-disable-next-line no-control-regex
  const controlCharRe = /[\x00-\x08\x0B-\x0C\x0E-\x1F]/g;
  const controlMatches = trimmed.match(controlCharRe);
  if (controlMatches && controlMatches.length > 0) {
    return {
      ok: false,
      severity: 'block',
      reason: `text 含 ${controlMatches.length} 个不可打印控制字符`,
    };
  }

  // 4. 通用安全 check — 大段 HTML/JS 注入 (sanitize 是另一层, 这里只 warn)
  const htmlRe = /<\/?[a-z][\s\S]*>/i;
  if (htmlRe.test(trimmed) && trimmed.length > 500) {
    return {
      ok: true,
      severity: 'warn',
      reason: 'text 包含 HTML 标签 (>500 字符), 确认发送前预览',
      cleaned: trimmed,
    };
  }

  return { ok: true, severity: 'info', cleaned: trimmed };
}

/** 校验 channel 创建输入 */
export function validateChannelInput(input: {
  name?: unknown;
  agentId?: unknown;
}): ValidationResult {
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    return { ok: false, severity: 'block', reason: 'name 必填' };
  }
  const trimmedName = input.name.trim();
  if (trimmedName.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      severity: 'block',
      reason: `name 长度 ${trimmedName.length} 超过最大 ${MAX_NAME_LENGTH}`,
    };
  }
  if (typeof input.agentId === 'string' && input.agentId.length > MAX_AGENT_ID_LENGTH) {
    return {
      ok: false,
      severity: 'block',
      reason: `agentId 长度 ${input.agentId.length} 超过最大 ${MAX_AGENT_ID_LENGTH}`,
    };
  }
  return { ok: true, severity: 'info', cleaned: trimmedName };
}

/** 健康检查 — 简单 liveness endpoint 用的契约 */
export interface HealthCheck {
  ok: boolean;
  version: string;
  uptime_sec: number;
  validators_loaded: string[];
}

const BOOT_TIME = Date.now();
export function healthCheck(version: string): HealthCheck {
  return {
    ok: true,
    version,
    uptime_sec: Math.floor((Date.now() - BOOT_TIME) / 1000),
    validators_loaded: [
      'validateMessageInput',
      'validateChannelInput',
    ],
  };
}