#!/bin/bash
# auto-evolve-oneshot.sh — 阶段 D 单次修复 (shell 版)
#
# 流程 (全本地, 用 MINIMAX_API_KEY 调 LLM):
#   1. 跑 vitest, 抓 fail
#   2. 让 LLM 修 
#   3. 解析 LLM 输出的 diff, 写到 staging
#   4. 跑 reviewer (护栏 4)
#   5. PASS → git apply + commit (护栏 1 拦)

set -uo pipefail  # 不加 -e: vitest 失败要继续

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

echo "[oneshot] REPO=$REPO"

# 1. 跑 vitest
npx vitest run --reporter=json --no-color 2>/dev/null > /tmp/vt-out.json
TOTAL_FAIL=$(python3 -c "
import json
d = json.load(open('/tmp/vt-out.json'))
print(sum(1 for f in d.get('testResults',[]) for a in f.get('assertionResults',[]) if a.get('status')=='failed'))
")
echo "[oneshot] vitest failed=$TOTAL_FAIL"

if [ "$TOTAL_FAIL" = "0" ]; then
  echo "[oneshot] ✅ 全部通过, 不需要修"
  exit 0
fi

# 2. 抽 fail 信息
FAIL_SUMMARY=$(python3 -c "
import json
d = json.load(open('/tmp/vt-out.json'))
for f in d.get('testResults', []):
    for a in f.get('assertionResults', []):
        if a.get('status') == 'failed':
            print('FILE:', f.get('name'))
            print('TEST:', a.get('fullName') or a.get('title'))
            print('ERROR:')
            for m in a.get('failureMessages', [])[:2]:
                print(m[:600])
            print('---')
" | head -60)
echo "[oneshot] 2. 调 LLM 修..."

# 3. 用 LLM 生成修复
# prompt: 要 LLM 输出 ```diff ... ``` 块
# 3. 写 prompt 到文件 (避免 shell 反引号冲突)
PROMPT_FILE="/tmp/oneshot-prompt.txt"
cat > "$PROMPT_FILE" <<PROMPT_EOF
你是一个谨慎的代码修复助手. 你的工作是修复失败的测试.

约束: 改动最小, 不改测试, 不引入 any/unknown/@ts-ignore.

输出格式: 严格只输出一个 \`\`\`diff ... \`\`\` 块, 第一个字符 \`\`\`diff, 最后一个字符 \`\`\`. 中间是 unified diff (--- a/path +++ b/path 风格). 不要在 diff 块外输出任何文字.

FAIL 信息:
$(cat /tmp/vt-out.json | python3 -c "
import json
d = json.load(open('/tmp/vt-out.json'))
for f in d.get('testResults', []):
    for a in f.get('assertionResults', []):
        if a.get('status') == 'failed':
            print('FILE:', f.get('name'))
            print('TEST:', a.get('fullName') or a.get('title'))
            print('ERROR:')
            for m in a.get('failureMessages', [])[:2]:
                print(m[:600])
            print('---')
" | head -60)

请**只**输出 diff 块:
PROMPT_EOF

LLM_OUTPUT=$(npx tsx -r dotenv/config -e "
import { initMinimax } from './src/llm/pi-ai.js';
import * as fs from 'fs';
const prompt = fs.readFileSync('$PROMPT_FILE', 'utf-8');
const client = initMinimax();
const text = await client.generateText({ messages: [{ role: 'user', content: prompt }], maxTokens: 4096, temperature: 0.2 });
process.stdout.write(text || '');
" 2>/tmp/llm-err.log)

if [ -z "$LLM_OUTPUT" ]; then
  echo "[oneshot] ❌ LLM 没返回"
  exit 2
fi

# 4. 解析 diff
DIFF=$(echo "$LLM_OUTPUT" | python3 -c "
import sys, re
text = sys.stdin.read()
m = re.search(r'\`\`\`diff\s*([\s\S]*?)\`\`\`', text)
if m:
    diff = m.group(1).strip()
    if not diff.endswith('\n'):
        diff += '\n'
    print(diff)
else:
    sys.exit(1)
" 2>/dev/null) || {
  echo "[oneshot] ❌ LLM 输出没 diff 块"
  echo "--- LLM 原始输出 (前 800) ---"
  echo "$LLM_OUTPUT" | head -c 800
  echo ""
  exit 3
}

echo "[oneshot] 拿到 diff: $(echo "$DIFF" | wc -l) lines"

# 5. 写 staging
ID="oneshot-$(date +%s)"
mkdir -p "staging/auto-evolve/$ID"
echo "$DIFF" > "staging/auto-evolve/$ID/$ID.patch"
echo "$ID" > "staging/auto-evolve/$ID/.patch-id"
echo "[oneshot] patch 写到 staging/auto-evolve/$ID/"

# 6. 跑 reviewer
echo "[oneshot] 3. 跑 reviewer..."
npx tsx -r dotenv/config scripts/diff-reviewer.ts "$ID" > /tmp/reviewer.log 2>&1 || true
VERDICT=$(python3 -c "
import json
try:
    print(json.load(open('staging/auto-evolve/$ID/.review-verdict')).get('verdict','UNKNOWN'))
except:
    print('UNKNOWN')
")
echo "[oneshot] reviewer verdict: $VERDICT"

# 7. apply + commit
if [ "$VERDICT" = "PASS" ]; then
  echo "[oneshot] 4. apply + commit"
  if git apply --recount --whitespace=fix "staging/auto-evolve/$ID/$ID.patch" 2>/tmp/apply.err; then
    git add -A
    git commit -m "auto-evolve: $ID (LLM 修复)"
    echo "[oneshot] ✅ 提交成功"
    # 验证
    npx vitest run --reporter=json --no-color 2>/dev/null > /tmp/vt-after.json
    AFTER_FAIL=$(python3 -c "
import json
print(sum(1 for f in json.load(open('/tmp/vt-after.json')).get('testResults',[]) for a in f.get('assertionResults',[]) if a.get('status')=='failed'))
")
    echo "[oneshot] 修复后 fail: $AFTER_FAIL (之前 $TOTAL_FAIL)"
  else
    echo "[oneshot] ❌ git apply 失败:"
    cat /tmp/apply.err
    exit 4
  fi
else
  echo "[oneshot] ❌ reviewer verdict=$VERDICT, 不 apply"
  cat /tmp/reviewer.log | head -10
  exit 5
fi
