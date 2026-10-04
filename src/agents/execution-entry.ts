/**
 * K8 唯一执行入口的取用助手 (2026-10-02 从 web/server.ts 抽出, 为了能被**行为门**测到)。
 *
 * 为什么值得单独一个文件: 这段代码的形状有个**隐蔽陷阱** ——
 *   `return agent.runExecution;` 会把方法**脱挂**。调用时 `this === undefined`, 而 `runExecution`
 *   内部第一句就是 `this.applyExecutionRequest(req)` ⇒ 运行时报
 *   `Cannot read properties of undefined (reading 'applyExecutionRequest')`。
 *   这个坑**源码看起来完全正常** (类型也对), 只有真跑才炸 —— 实例里 supervisor / 心跳 / 任务
 *   三条路径都栽在它上面。抽出来 + 行为门 (假 agent 的 `runExecution` 依赖 `this`) 才拦得住。
 */
import type { ExecutionRequest } from '../kernel/channel-actor.js';   // K5 步骤⑦ 的真类型 (与 web/server.ts 同一处)

export interface RunExecutionCapable {
  runExecution?: (req: ExecutionRequest) => Promise<string>;
}

/**
 * 取该 session 的唯一执行入口; 取不到就**响亮失败** (绝不静默回落直呼 `prompt`)。
 * 注意返回的是**绑定过的**函数 —— 见文件头那个坑。
 */
export function requireRunExecution<T extends RunExecutionCapable>(agent: T): (req: ExecutionRequest) => Promise<string> {
  if (typeof agent.runExecution !== 'function') {
    throw new Error('K8: 该 session 未提供 runExecution (唯一执行入口) ⇒ 拒绝直呼 prompt');
  }
  return agent.runExecution.bind(agent);
}
