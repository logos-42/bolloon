/**
 * Intent Classifier — 最小化用户请求分类 (M2.2, 2026-06-17)
 *
 * 目的: 让 agent 知道用户是问个问题, 还是让改代码, 还是让跑长任务.
 *       不同 intent 注入不同 system prompt 片段, 行为更可预测.
 *
 * 设计: 不调 LLM (避免 5-10s 延迟) — 用 keyword + 长度 + 问号正则匹配.
 *       简单但比之前完全没分类好.
 *
 * 未来升级: 用 LLM 分类 4-5 个 label, 但需要缓存 (相同 input 30min 内复用)
 */

export type Intent = 'question' | 'code_edit' | 'multi_step' | 'chitchat' | 'document';

/**
 * 优先级: code_edit > multi_step > document > question > chitchat
 * 检测顺序重要 (强信号优先)
 */
export function classifyIntent(input: string): Intent {
  const text = (input || '').trim();
  if (text.length === 0) return 'chitchat';

  const lower = text.toLowerCase();

  // 1. code_edit: 强信号 — 包含"改/修/加/删/编辑/refactor/实现/fix/bug"
  //    + 暗示一个具体目标 (函数名 / 文件名 / 报错)
  const codeEditSignals = [
    /\b(改|修|加|删|编辑|重写|重构|实现|写|写一个|添加|移除|fix|bug|patch|refactor|implement|add|remove|rewrite|edit)\b/i,
  ];
  const hasCodeTarget = /\b([\w-]+\.(ts|js|tsx|jsx|py|go|rs|md|json|yaml|yml))\b/.test(lower)
    || /`[\w.]+\(/.test(text)  // 提到函数调用
    || /报错|错误信息|stack\s*trace|exception/i.test(text);
  if (codeEditSignals.some(rx => rx.test(text)) && hasCodeTarget) {
    return 'code_edit';
  }

  // 2. multi_step: "帮我做 X" + 多步暗示 ("然后/接着/之后/再/最后/first/then/next")
  //    或长度 > 300 字
  const multiStepSignals = /(然后|接着|之后|再|最后|首先.*然后|first.+then|step\s*\d|phase\s*\d|1\)|2\)|3\))/i;
  if (text.length > 300 || multiStepSignals.test(text)) {
    return 'multi_step';
  }

  // 3. document: 提到具体文件路径 + 读取/分析/总结
  if (/(读|看|分析|总结|摘要|review|read|analyze|summarize)/i.test(text)
    && /\.[a-z]{1,5}\b/i.test(text)) {
    return 'document';
  }

  // 4. question: 问号 / 怎么/为什么/什么/是啥/how|why|what
  if (/[?？]/.test(text)
    || /^(怎么|为什么|什么|哪些|是啥|如何|哪|how|why|what|which|where|when)\b/i.test(lower)) {
    return 'question';
  }

  return 'chitchat';
}

/**
 * 根据 intent 给出 system prompt 补充片段
 * (注入到 system prompt 末尾, 不替换主提示)
 */
export function intentHint(intent: Intent): string {
  switch (intent) {
    case 'code_edit':
      return `\n\n## 任务类型: code_edit
当前请求是改代码任务. 你应该:
1. 先 \`list_files\` 或 \`read_document\` 看目标文件当前内容
2. 用 \`edit_file\` 精确定位改 (old_text 全文匹配) 或 \`write_file\` 整体覆写
3. 改完跑 \`npx tsc --noEmit\` 和 \`npx vitest run --reporter=dot --bail=1\` 验证
4. 用 \`git_commit\` 提交到当前分支 (分支名 agent/<task-id>)
不要调用 \`<final gen>\` 标记除非任务真正完成 (commit + 测试通过).`;
    case 'multi_step':
      return `\n\n## 任务类型: multi_step
当前请求是多步任务. 你应该:
1. 在响应开头写一个 [PLAN] 段, 列 3-7 步计划
2. 每完成一步更新状态 ([STEP N/7] ... ✓)
3. 中间失败要明确说明, 不要假装完成
4. 用 \`git_commit\` 在每步结束或整个任务结束时提交`;
    case 'document':
      return `\n\n## 任务类型: document
当前请求是文档/代码阅读分析. 优先用 \`read_document\` 读完整内容, 然后给出结构化分析.`;
    case 'question':
      return `\n\n## 任务类型: question
当前请求是问问题. 直接给答案, 不要调用工具 (除非用户明确要查).`;
    case 'chitchat':
    default:
      return '';  // chitchat 不加提示
  }
}
