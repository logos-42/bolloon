/**
 * deny-pipeline.ts — Unified Deny-First Pipeline (2026-07-29)
 *
 * 将分散在 system 各处的拒绝逻辑统一到一条管道:
 *   1. deny-list  (Tool pre-filter — pi-sdk.ts _deniedToolNames)
 *   2. hooks      (HooksEngine.checkToolUse — shell/LLM)
 *   3. permission (permission-mode.ts — static mode)
 *   4. judgment   (injectNegativeGuard — 负向判断力)
 *
 * 设计: deny-first
 *   - 任何一层拒绝, 整个工具被阻塞
 *   - 第一层拒绝后不再检查后续 (fail-fast)
 *
 * Claude Code 论文 7 层防御的简化实现:
 *   第 1 层 = deny-list  (硬拒绝, 最便宜)
 *   第 2 层 = permission (静态规则)
 *   第 3 层 = hooks      (可编程策略, 中等成本)
 *   第 4 层 = judgment   (LLM 评估, 最贵)
 */

import type { PermissionMode } from './permission-mode.js';

export interface DenyContext {
  /** 当前工具名 */
  toolName: string;
  /** 当前工具参数 */
  toolArgs: Record<string, unknown>;
  /** 当前 permission mode */
  permissionMode: PermissionMode;
  /** 当前 channel id */
  channelId?: string;
  /** 当前 agent id */
  agentId?: string;
}

export interface DenyResult {
  /** 是否拒绝 */
  denied: boolean;
  /** 拒绝原因 */
  reason: string;
  /** 拒绝来源: 'deny-list' | 'permission' | 'hooks' | 'judgment' */
  source: string;
  /** 注入到 system prompt 的文本 (来自 hook) */
  systemAddition?: string;
}

/** 对工具检查签名 */
export type DenyChecker = (ctx: DenyContext) => Promise<DenyResult> | DenyResult;

/**
 * Unified Deny Pipeline.
 *
 * 按顺序注册 checker, 每个 checker 返回 {denied} 表示是否拒绝该工具.
 * 任何 checker 返回 denied=true 即中断, 不再执行后续.
 */
export class DenyPipeline {
  private checkers: DenyChecker[] = [];

  constructor() {
    // 默认注册: 从 null 开始, 调用方按需 addChecker
  }

  /** 添加一个检查器 (按添加顺序执行) */
  addChecker(checker: DenyChecker): void {
    this.checkers.push(checker);
  }

  /** 清空所有检查器 (调试/测试用) */
  clear(): void {
    this.checkers = [];
  }

  /**
   * 对工具执行完整 deny 检查.
   * 返回第一个拒绝结果, 或 {denied: false} (全部通过).
   */
  async check(ctx: DenyContext): Promise<DenyResult> {
    for (const checker of this.checkers) {
      try {
        const result = await checker(ctx);
        if (result.denied) {
          return result;
        }
        // 如果 check 返回了 systemAddition, 累积
        if (result.systemAddition) {
          // 当前 check 通过, 但携带了注入文本
        }
      } catch (e) {
        // checker 异常: 按 deny-first 原则, 异常视为拒绝 (安全侧)
        return {
          denied: true,
          reason: `Deny check 异常: ${String(e)}`,
          source: `checker:${this.checkers.indexOf(checker)}`,
        };
      }
    }
    return { denied: false, reason: '', source: '' };
  }

  // ============== 工厂方法 ==============

  /**
   * 构建 deny-list checker.
   * 检查工具名是否在 deny set 中.
   */
  static denyListChecker(deniedNames: Set<string>): DenyChecker {
    return (ctx: DenyContext) => ({
      denied: deniedNames.has(ctx.toolName),
      reason: deniedNames.has(ctx.toolName)
        ? `工具 ${ctx.toolName} 在拒绝列表中, 不允许调用`
        : '',
      source: 'deny-list',
    });
  }

  /**
   * 构建 permission-mode checker.
   * default 模式: 禁用 shell_exec / git_commit / git_push 等危险工具
   * bypassPermissions: 放行所有
   *
   * 2026-08-10: write_file/edit_file/delete_file 移出 default 禁列表 — 它们已有
   *   checkWritePath 写入白名单兜底 (self-improve-policy.json), 正常任务 (如写 HTML 发布
   *   IPFS 网站) 不该被 permission 层拦截; 实测日志: "write_file 被权限拦了" → LLM 只能
   *   绕道, 任务无法推进.
   */
  static permissionChecker(): DenyChecker {
    const DEFAULT_DENY_TOOLS = new Set<string>([
      'shell_exec', 'git_commit', 'git_push', 'git_branch',
    ]);
    return (ctx: DenyContext) => {
      if (ctx.permissionMode === 'bypassPermissions') {
        return { denied: false, reason: '', source: 'permission' };
      }
      if (ctx.permissionMode === 'acceptEdits') {
        // acceptEdits: 允许写文件, 但禁止 shell 和 git 操作
        if (ctx.toolName === 'shell_exec' || ctx.toolName === 'git_commit' || ctx.toolName === 'git_push') {
          return {
            denied: true,
            reason: `当前 permission mode 为 acceptEdits, 工具 ${ctx.toolName} 受限. 如需调用请切换到 bypassPermissions.`,
            source: 'permission',
          };
        }
        return { denied: false, reason: '', source: 'permission' };
      }
      // default: 危险工具全禁
      if (DEFAULT_DENY_TOOLS.has(ctx.toolName)) {
        return {
          denied: true,
          reason: `当前 permission mode 为 default, 工具 ${ctx.toolName} 不允许调用. 如需调用请切换到 acceptEdits 或 bypassPermissions.`,
          source: 'permission',
        };
      }
      return { denied: false, reason: '', source: 'permission' };
    };
  }
}
