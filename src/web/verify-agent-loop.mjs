/**
 * 手机端 Agent 机制实证测试 (Node 直连内置网关)
 * 复制 mobile-agent.ts 的 WEB_AGENT_SYSTEM / 工具集 / LLM 循环逻辑 (浏览器安全边界内)
 * 验证: 手机端"派活 → LLM 自动调工具 → 持续工作流 → 回答"成立
 */
const BASE = 'https://api.bolloon.cn/v1';
const KEY = 'bolloon-free';
const MODEL = 'glm-5.3';

// ---- 手机端工具集 (mobile-agent.ts WEB_AGENT_TOOLS 等价) ----
const TOOLS = {
  get_status: async () => 'DID: 0x3f9a...b1c2 名字: Bolloon 手机节点, 已入网, P2P 正常',
  get_wallet: async () => '钱包: main (0x8f2a...c91d), 余额: 12.5 USDC',
  get_identity: async () => 'DID: did:key:z6Mk...9xQr 名字: Bolloon',
  get_contacts: async () => '联系方式与授权模块可用',
};

const SYSTEM = [
  '你是手机端 Bolloon 智能体 (自治节点), 用中文简洁回复。',
  '你有以下工具, 按需调用 (JSON: {"tool":"名字","args":{...}}), 不需要工具就直接回答:',
  '- get_status: 查本机身份/入网/钱包/P2P 状态 (args: 无)',
  '- get_wallet: 查钱包余额 (args: 无)',
  '- get_identity: 查本机 DID (args: 无)',
  '- get_contacts: 查联系方式授权状态 (args: 无)',
  '每轮只能用一个工具; 拿到结果后继续思考, 直到任务完成给出最终回答。',
].join('\n');

async function llmCall(messages) {
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 1024, temperature: 0.4 }),
  });
  if (!r.ok) throw new Error('LLM HTTP ' + r.status + ': ' + (await r.text()).slice(0, 120));
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 空回复');
  return String(content).trim();
}

// 宽容提取工具调用 JSON (mobile-agent.ts extractToolCall 同款)
function extractToolCall(raw) {
  if (!raw) return null;
  const start = raw.indexOf('{"');
  if (start >= 0) {
    try {
      const obj = JSON.parse(parseBalanced(raw, start));
      if (obj && typeof obj.tool === 'string') return { tool: obj.tool, args: obj.args || {} };
    } catch { /* 继续 */ }
  }
  const fm = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fm) { try { const o = JSON.parse(fm[1]); if (o && typeof o.tool === 'string') return { tool: o.tool, args: o.args || {} }; } catch { } }
  return null;
}
function parseBalanced(raw, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) { if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return raw.slice(start, i + 1); }
  }
  throw new Error('unbalanced');
}

// ---- 手机端 agent 循环 (runWebAgentLoop 同款) ----
async function runAgent(goal, maxSteps = 5) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: goal }];
  const steps = [];
  for (let i = 0; i < maxSteps; i++) {
    const raw = await llmCall(messages);
    const tool = extractToolCall(raw);
    if (tool && TOOLS[tool.tool]) {
      const out = await TOOLS[tool.tool]();
      steps.push(`[${i + 1}] 🔧 ${tool.tool} → ${out.slice(0, 60)}`);
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: `工具结果: ${out}` });
      console.log(`  步 ${i + 1}: 工具调用 ${tool.tool} 成功`);
      continue;
    }
    return { steps, answer: raw };
  }
  return { steps, answer: '(达到步数上限)' };
}

// ---- 测试 1: 派活要求调工具 ----
console.log('════════ 测试 1: 派活 → LLM 自动调工具 → 汇总 ════════');
const r1 = await runAgent('查一下我的钱包余额和身份，汇总成一句话回复我');
console.log(`\n工具调用 ${r1.steps.length} 步:`);
r1.steps.forEach(s => console.log('  ' + s));
console.log(`\n最终回答: ${r1.answer.slice(0, 200)}`);

// ---- 测试 2: 持续工作流 (多步, 链式) ----
console.log('\n════════ 测试 2: 持续工作流 (连续两次派活) ════════');
const r2 = await runAgent('先查状态，再查钱包，最后用两句话说结论');
console.log(`\n工具调用 ${r2.steps.length} 步:`);
r2.steps.forEach(s => console.log('  ' + s));
console.log(`\n最终回答: ${r2.answer.slice(0, 200)}`);

// ---- 测试 3: 直接回答 (无需工具) ----
console.log('\n════════ 测试 3: 无需工具的直接对话 ════════');
const r3 = await runAgent('你好，你是谁？');
console.log(`\n回答: ${r3.answer.slice(0, 200)}`);

console.log('\n✅ 手机端 Agent 机制验证完成');
