/**
 * parseToolCall — 从 LLM 输出 (minimax / Hermes / Qwen / GLM / Anthropic 等)
 * 中提取 tool_call { name, args }.
 *
 * 2026-06-30 抽出: 原先作为 PiAgentSession 的 private 方法藏在 4522 行类里,
 * 测试只能复刻逻辑不能 import 真源 = 测试通过 ≠ 实际工作. 现在抽出为纯函数,
 * 接受 ctx.tools (可用工具名集合) + 可选 ctx.resolveAlias (别名 → 真实工具名).
 *
 * 用法:
 *   import { parseToolCall } from './parse-tool-call';
 *   const r = parseToolCall(content, { tools: new Set(['shell_exec', 'read_file']) });
 *   if (r) tool.execute(r.args);
 */

export interface ParseContext {
  /** 当前会话可用的工具名集合. 用于 resolveToolName. */
  tools: Set<string>;
  /** 可选: 别名 → 标准工具名. 不提供时, 只用 tools.has() 精确匹配. */
  resolveAlias?: (name: string) => string | null;
}

export interface ToolCall {
  name: string;
  args: Record<string, string>;
}

const SHELL_KEYWORDS = ['git', 'npx', 'npm', 'tsx', 'tsc', 'vitest', 'node', 'mkdir', 'touch', 'ls', 'echo', 'cat', 'head', 'tail', 'wc', 'pwd', 'date'];

/**
 * 默认的 alias resolver — Claude Code 风格 → bolloon 工具名
 * 当 ctx.resolveAlias 缺失时使用.
 */
function defaultResolveAlias(name: string, tools: Set<string>): string | null {
  if (tools.has(name)) return name;
  const lower = name.toLowerCase();
  const aliasMap: Record<string, string> = {
    read: 'read_file',
    edit: 'edit_file',
    write: 'write_file',
    rm: 'delete_file',
    mv: 'move_file',
    bash: 'shell_exec',
    shell: 'shell_exec',
    sh: 'shell_exec',
    cat: 'read_file',
    test: 'vitest_run',
    vitest: 'vitest_run',
    typecheck: 'tsc_check',
    tsc: 'tsc_check',
    log: 'git_log',
    show: 'git_show',
    diff: 'git_diff',
    commit: 'git_commit',
    push: 'git_push',
    branch: 'git_branch',
    checkout: 'git_branch',
    stash: 'git_stash',
    todo_write: 'create_task',
    todowrite: 'create_task',
    task: 'create_task',
  };
  const aliased = aliasMap[lower];
  if (aliased && tools.has(aliased)) return aliased;
  if (tools.has(lower)) return lower;
  return null;
}

/** 拆分 args.command: "git status" → { command: "git", args: "status" } */
function autoSplitCommand(args: Record<string, string>): void {
  if (typeof args.command === 'string' && args.command.includes(' ') && !args.args) {
    const parts = args.command.split(/\s+/);
    args.command = parts[0];
    args.args = parts.slice(1).join(' ');
  }
}

/** 用 resolver 解析工具名 — 接受任意 resolver (默认或自定义). */
function resolve(ctx: ParseContext, name: string): string | null {
  if (ctx.resolveAlias) return ctx.resolveAlias(name);
  return defaultResolveAlias(name, ctx.tools);
}

export function parseToolCall(content: string, ctx: ParseContext): ToolCall | null {
  if (!content) return null;

  // === 0. 剥离 思考块 — 必须先做, 否则旧 regex `<(\w+)>...</\1>` 会先匹配 想想标签 ===
  const strippedContent = content.replace(/<think[\s\S]*?<\/think/g, '');

  // [diag-2026-07-12] 临时诊断日志:WebUI 出现 7 个 “必填/参数 undefined” 错误,
  //   怀疑 parseToolCall 没拿到正确的 name/args. 这里只打日志不改任何逻辑.
  //   日志形态: [parseToolCall diag] ok=true/false name=... argKeys=... rawHead=...
  //   用 console.warn 一行 JSON, 方便 grep + 排时间线.
  try {
    const result = (function _diagProbe() {
      // 用与正文完全相同的解析路径,但提前跑一次,记录是否命中
      // 走完下面所有分支再覆盖回原值即可
      return null as ToolCall | null;
    })();
    void result;
    const probe = (function _doParse(): ToolCall | null {
      // 内联一份最便宜的 "能不能解出 name" 探测 — 不重复跑全部分支
      const m1 = strippedContent.match(/<invoke\s+name=["']([\w]+)["']/);
      if (m1) {
        return { name: m1[1], args: { __probe_invoketag: '1' } };
      }
      const m2 = strippedContent.match(/<function_calls>[\s\S]*?<invoke\s+name=["']([\w]+)["']/);
      if (m2) {
        return { name: m2[1], args: { __probe_function_calls: '1' } };
      }
      const m3 = strippedContent.match(/\{[\s\S]*?"name"\s*:\s*["']([\w]+)["']/);
      if (m3) {
        return { name: m3[1], args: { __probe_json_name: '1' } };
      }
      return null;
    })();
    console.warn(
      '[parseToolCall diag] rawLen=' + content.length +
      ' strippedLen=' + strippedContent.length +
      ' probeName=' + (probe?.name ?? 'null') +
      ' rawHead=' + JSON.stringify(content.slice(0, 500))
    );
  } catch (diagErr) {
    // 诊断日志绝不能影响主路径 — 吞掉任何 diag 自身抛错
    console.warn('[parseToolCall diag] diag-self-failed:', String(diagErr));
  }

  // === 1. JSON function-call (OpenAI / Anthropic / Minimax-style) ===
  const jsonPatterns = [
    // markdown json code block + OpenAI  块, 同时匹配 arguments/input 字段
    /(?:```(?:json|json5)?\s*\n?)?\{[\s\S]*?"name"\s*:\s*["'](\w+)["']\s*,\s*["']?(?:arguments|input)["']?\s*:\s*(\{[\s\S]*?\})\s*\}/,
  ];
  for (const p of jsonPatterns) {
    const m = content.match(p);
    if (m) {
      const name = m[1];
      let args: Record<string, string> = {};
      try {
        const parsed = JSON.parse(m[2]);
        if (parsed && typeof parsed === 'object') {
          args = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
        }
      } catch {
        /* 解析失败保持 args={} */
      }
      autoSplitCommand(args);
      const resolved = resolve(ctx, name);
      if (resolved) {
        return { name: resolved, args };
      }
    }
  }

  // === 2. <tools:call name="X">...</tools:call> 嵌套格式 ===
  const toolsCallMatch = content.match(/<tools:call\s+name=["'](\w+)["']>([\s\S]*?)<\/tools:call>/);
  if (toolsCallMatch) {
    const name = toolsCallMatch[1];
    const inner = toolsCallMatch[2];
    const args: Record<string, string> = {};
    const argTags = inner.matchAll(/<tools:call\s+name=["'](\w+)["']>([\s\S]*?)<\/tools:call>/g);
    for (const m of argTags) {
      args[m[1]] = m[2].trim();
    }
    const resolved = resolve(ctx, name);
    if (resolved) {
      return { name: resolved, args };
    }
    // 兜底: 外层 tool name 不在 tools, 但内层有 command, 推断 shell_exec
    if (args.command) {
      const cmdFirst = args.command.split(/\s+/)[0];
      if (SHELL_KEYWORDS.includes(cmdFirst)) {
        return { name: 'shell_exec', args };
      }
    }
  }

  // === 3. XML 格式 (陆续检测多个 pattern) ===
  const patterns = [
    // minimax/Hermes 自闭合 XML 格式 <invoke name="X">...</invoke>
    new RegExp('<invoke\\s+name=["\']([\\w]+)["\']>([\\s\\S]*?)</invoke>'),
    // <function_calls> 包裹
    new RegExp('<function_calls>[\\s\\S]*?<invoke\\s+name=["\']([\\w]+)["\']>([\\s\\S]*?)</invoke>[\\s\\S]*?</function_calls>'),
    // <function_calls><tool name="X"><param name="Y">value</param></tool></function_calls>
    new RegExp('<function_calls>[\\s\\S]*?<tool\\s+name=["\']([\\w]+)["\']>([\\s\\S]*?)</tool>[\\s\\S]*?</function_calls>'),
    /调用工具[：:]\s*(\w+)\s*\(([^)]*)\)/,
    /使用工具[：:]\s*(\w+)\s*\(([^)]*)\)/,
    /tool[_\w]*[：:]\s*(\w+)\s*\(([^)]*)\)/i,
    /(\w+)\s*\(\s*([^)]*)\s*\)/,
    // 对象字面量格式 {tool => "get_identity", args => {...}}
    /\{\s*tool\s*=>\s*["'](\w+)["']\s*(?:,\s*args\s*=>\s*(\{[\s\S]*?\}))?\s*\}/,
    // tool => "get_identity" (无 args 包裹)
    /\btool\s*=>\s*["'](\w+)["']/,
    // [TOOL_CALL] 块内 JSON 形式 {"name": "x", "args": {...}}
    /\[TOOL_CALL\][\s\S]*?\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})/i,
    // "tool_name {json_args}" 形式 (单行, 无 name 字段)
    /(?:^|\n)(\w+)\s+(\{[\s\S]*?\})(?=\n|$)/,
    // XML 格式 <tool_name>...<arg>value</arg>...</tool_name>
    /<(\w+)>([\s\S]*?)<\/\1>/,
  ];

  for (const pattern of patterns) {
    const match = strippedContent.match(pattern);
    if (!match) continue;
    const name = match[1];
    let args: Record<string, string> = {};
    const rawArgs = match[2] || '';

    if (rawArgs && rawArgs.trim().startsWith('{')) {
      // JSON 形式, 尝试解析
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === 'object') {
          args = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
        }
      } catch {
        // 解析失败就当字符串处理
        const argPairs = rawArgs.split(',').map(s => s.trim()).filter(Boolean);
        for (const pair of argPairs) {
          const [key, ...valueParts] = pair.split(':').map(s => s.trim().replace(/['"]/g, ''));
          if (key) args[key] = valueParts.join(':') || '';
        }
      }
    } else if (rawArgs && /<[\w]/.test(rawArgs) && /<\/\w+>/.test(rawArgs)) {
      // 2026-06-30 修: 检测 XML 子标签 (含带属性的 <parameter name="X"> 形式)
      //   原文用 /<\w+>[\s\S]*<\/\w+>/ 检测, 但是 <parameter name="command"> 形式
      //   首标签是 <parameter, 不是简单的 <command 所以原检测会 false,
      //   路由错误走 key:value 路径. 这里放宽到任何 <...>...content...</...>
      const paramRe = /<parameter\s+name=["'](\w+)["']>([\s\S]*?)<\/parameter>/g;
      const paramReShort = /<param\s+name=["'](\w+)["']>([\s\S]*?)<\/param>/g;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = paramRe.exec(rawArgs)) !== null) {
        const argName = pMatch[1];
        const argValue = pMatch[2].trim();
        if (argName && argValue) {
          args[argName] = argValue;
        }
      }
      if (Object.keys(args).length === 0) {
        let sMatch: RegExpExecArray | null;
        paramReShort.lastIndex = 0;
        while ((sMatch = paramReShort.exec(rawArgs)) !== null) {
          const argName = sMatch[1];
          const argValue = sMatch[2].trim().replace(/^["']|["']$/g, '');
          if (argName && argValue) {
            args[argName] = argValue;
          }
        }
      }
      if (Object.keys(args).length === 0) {
        const xmlArgPattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
        let xmlMatch: RegExpExecArray | null;
        while ((xmlMatch = xmlArgPattern.exec(rawArgs)) !== null) {
          const argName = xmlMatch[1];
          const argValue = xmlMatch[2].trim();
          if (argName && argValue) {
            args[argName] = argValue;
          }
        }
      }
    } else if (rawArgs) {
      // 形参串 key: value
      const argPairs = rawArgs.split(',').map(s => s.trim()).filter(Boolean);
      for (const pair of argPairs) {
        const [key, ...valueParts] = pair.split(':').map(s => s.trim().replace(/['"]/g, ''));
        if (key) args[key] = valueParts.join(':') || '';
      }
    }

    // 名字 resolve: 优先 this.tools.has, 然后 alias resolver
    const resolved = ctx.tools.has(name) ? name : resolve(ctx, name);
    if (resolved) {
      autoSplitCommand(args);
      return { name: resolved, args };
    }
    // 名字未识别但 rawArgs 含 <command> 子标签 → 跳出, 走 fallback 按 command 推断 shell_exec
    if (rawArgs && /<\w+>[\s\S]*<\/\w+>/.test(strippedContent)) {
      break;
    }
  }

  // === 4. Fallback: 任意 <tag><command>...</command></tag> 按 cmdFirst 推断 shell_exec ===
  const xmlTagMatch = strippedContent.match(/<(\w+)>([\s\S]*?)<\/\1>/);
  if (xmlTagMatch) {
    const outerTag = xmlTagMatch[1];
    const inner = xmlTagMatch[2];
    if (!resolve(ctx, outerTag)) {
      const cmdMatch = inner.match(/<command>([\s\S]*?)<\/command>/);
      if (cmdMatch) {
        const cmd = cmdMatch[1].trim();
        const cmdFirst = cmd.split(/\s+/)[0];
        if (SHELL_KEYWORDS.includes(cmdFirst)) {
          const args: Record<string, string> = {};
          const remaining = cmd.slice(cmdFirst.length).trim();
          if (remaining) {
            args.command = cmdFirst;
            args.args = remaining;
          } else {
            args.command = cmd;
          }
          const argsM = inner.match(/<args>([\s\S]*?)<\/args>/);
          if (argsM && argsM[1].trim()) {
            args.args = argsM[1].trim();
          }
          return { name: 'shell_exec', args };
        }
      }
    }
  }
  return null;
}

/**
 * isFinalResponse — 临时判断 LLM 是否已完结 (含 <final gen>)
 * 2026-06-19/06-30 修: 先剥离 think, 避免思考块中提及 <final gen> 误杀
 *                       含可解析 tool_call 则优先执行工具, 不算 final
 */
export function isFinalResponse(content: string, ctx?: ParseContext): boolean {
  const stripped = content.replace(/<think[\s\S]*?<\/think/g, '');
  if (!stripped.includes('<final gen>')) return false;
  // 用默认 ctx (无需 tool 名解析, 只看能否 parse 出来) - 但 isFinalResponse 不需要 tools 列表上下文.
  // 如果没有传 ctx, 使用 empty set (只解析不 resolve).
  if (ctx && parseToolCall(stripped, ctx)) return false;
  if (!ctx) {
    // 试探性 parse (不 resolve name) — 如果至少能提取 name+args 模式, 就不是 final.
    // 这里粗略检测: stripped 中含 json "name": 或 <invoke name= 或 <function_calls> 任一
    if (/\{[\s\S]*?"name"\s*:/.test(stripped)) return false;
    if (/<invoke\s+name=/.test(stripped)) return false;
    if (/<function_calls>/.test(stripped)) return false;
  }
  return true;
}

/** extractFinalAnswer: 去除 <final gen> 标记 + tool call 噪声. */
export function extractFinalAnswer(content: string): string {
  const marker = '<final gen>';
  const markerIndex = content.indexOf(marker);
  if (markerIndex !== -1) {
    const after = content.substring(markerIndex + marker.length).trim();
    if (after) {
      content = after;
    } else {
      content = content.substring(0, markerIndex).trim();
    }
  }
  let cleaned = content
    .replace(/调用工具[：:]\s*\w+\s*\([^)]*\)/g, '')
    .replace(/使用工具[：:]\s*\w+\s*\([^)]*\)/g, '')
    .replace(/tool[_\w]*[：:]\s*\w+\s*\([^)]*\)/gi, '')
    .trim();
  return cleaned;
}
