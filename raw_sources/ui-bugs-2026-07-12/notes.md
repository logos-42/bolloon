# UI bug 截图 — 工具调用参数 undefined (2026-07-12)

> 来源: 用户从 bolloon 真实 web UI 截屏 (另一个沙箱 /home/bolloon 实例).
> 内容: 16:18-16:19 时段工具调用失败日志, 显示 self_improve / read_document /
>        summarize_document / improve_document / glob_files / shell_exec / read_file
>        全部以"X 必填"失败.

## 原始文本

```
16:18
⚠️ ❌ self_improve 失败: goal 必填

read_document
复制
蒸馏为判断
重新回答
16:18
⚠️ ❌ read_document 失败: TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string or an instance of Buffer or URL. Received undefined

summarize_document
复制
蒸馏为判断
重新回答
16:18
⚠️ ❌ summarize_document 失败: TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string or an instance of Buffer or URL. Received undefined

improve_document
复制
蒸馏为判断
重新回答
16:18
⚠️ ❌ improve_document 失败: TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string or an instance of Buffer or URL. Received undefined

glob_files
复制
蒸馏为判断
重新回答
16:18
⚠️ ❌ glob_files 失败: pattern 必填

shell_exec
复制
蒸馏为判断
重新回答
16:18
⚠️ ❌ shell_exec 失败: command 必填

read_file
复制
蒸馏为判断
重新回答
16:18
⚠️ ❌ read_file 失败: path 必填

复制
蒸馏为判断
重新回答
16:19
[STEP 3/4] 读 skill 源文件 — glob 命中了 .claude/skills/技能写作/SKILL.md. 读它.

复制
蒸馏为判断
重新回答
16:19
```

## 根因分析 (2026-07-12 当日)

### 表层 (LLM 自生成的"X 必填"提示)
- `glob_files 失败: pattern 必填` ← 工具代码确实有校验
- `shell_exec 失败: command 必填` ← 工具代码确实有校验
- `read_file 失败: path 必填` ← 工具代码确实有校验
- `self_improve 失败: goal 必填` ← 工具代码确实有校验

### 深层 (Node fs 抛 ERR_INVALID_ARG_TYPE)
- `read_document / summarize_document / improve_document` 失败原因都是
  `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string... Received undefined`
- 根因: 这 3 个工具 (src/agents/pi-sdk-tools.ts:62/79/103) **没有 `if (!args.path)` 前置校验**,
  直接把 `args.path === undefined` 传给 `documentReader.read()`, 触发 Node fs 类型检查.
- 而其他 30+ 工具都做了 `if (!args.X) return { success: false, error: 'X 必填' }` 前置校验.

### 触发链路
1. LLM 在 prompt 里调用 `read_document` 但没传 `path` (或 path 被解析成空字符串)
2. `parseToolCall` 返回 `{ name: 'read_document', args: {} }` 或 `args: { path: '' }`
3. `tool.execute(args)` 直接走 `documentReader.read(undefined)`, Node fs 抛错
4. 错误一路冒到 UI 显示为 `ERR_INVALID_ARG_TYPE: ... Received undefined`
5. LLM 在下一轮把这个错误"翻译"成 "path 必填" 这种自然语言, 跟代码层的 `path 必填` 混在一起, 用户难以区分.

## 修复 (commit in 2026-07-12 session)

3 处工具 + 1 处底层防御 + 1 个测试文件 (10 测试用例).

详见 docs/wiki/log.md 的当日 entry.