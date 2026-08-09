/**
 * verify-agent-persona.ts — 验证 agentId 透传 → persona/ME 文档按 agent 加载 (2026-08-09)
 * 隔离 HOME: agent-alpha / agent-beta 各建独立 persona 目录, 确认加载内容不同.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-persona-verify-'));
process.env.HOME = TMP;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function main() {
  // 预置两个 agent 的 persona 目录 (identity 文档不同 — Context OS 01-Me 对应 persona identity)
  const mk = (agentId: string, me: string) => {
    const dir = path.join(TMP, '.bolloon', 'persona', agentId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'identity.md'), me);
    fs.writeFileSync(path.join(dir, 'soul.md'), `# ${agentId} soul`);
  };
  mk('agent-alpha', '# Alpha identity\n我是 Alpha, 研究助手');
  mk('agent-beta', '# Beta identity\n我是 Beta, 交易助手');

  // [1] loadPersonaDocs 按 agentId 加载不同内容
  console.log('[1] loadPersonaDocs 按 agentId 区分');
  const { loadPersonaDocs, formatPersonaForSystemPrompt } = await import('../src/bootstrap/persona-loader.js');
  const docsA = await loadPersonaDocs('agent-alpha');
  const docsB = await loadPersonaDocs('agent-beta');
  check('agent-alpha 加载到 identity', docsA.identity.includes('Alpha'), `got=${docsA.identity.slice(0, 40)}`);
  check('agent-beta 加载到 identity', docsB.identity.includes('Beta'), `got=${docsB.identity.slice(0, 40)}`);
  check('内容不同 (身份区分)', JSON.stringify(docsA) !== JSON.stringify(docsB));

  // [2] formatPersonaForSystemPrompt 产物含对应 agent 内容
  console.log('[2] systemPrompt 注入含 agent 专属内容');
  const spA = formatPersonaForSystemPrompt(docsA);
  const spB = formatPersonaForSystemPrompt(docsB);
  check('Alpha prompt 含 Alpha', spA.includes('Alpha'));
  check('Beta prompt 含 Beta', spB.includes('Beta'));
  check('prompt 内容互斥', spA !== spB);

  // [3] sanitizeAgentId 防路径穿越 (agentId 含 ../ 被清洗)
  console.log('[3] sanitizeAgentId 安全');
  const { sanitizeAgentId } = await import('../src/bootstrap/persona-loader.js');
  const safe = sanitizeAgentId('../../etc/passwd');
  check('路径穿越被清洗', !safe.includes('/') && !safe.includes('..'), `safe=${safe}`);

  // [4] Context OS 按 agentId 分区 — 每个 agent 独立 01-Me (2026-08-09 核心修复)
  console.log('[4] Context OS 按 agentId 分区 (01-Me 独立)');
  const { writeContextAsset, readContextAssets } = await import('../src/bootstrap/context-os.js');
  const rA = await writeContextAsset({ layer: '01-Me', title: '我是 Alpha 身份', content: 'Alpha 的 ME 文档: 我是研究助手' }, undefined, 'agent-alpha');
  const rB = await writeContextAsset({ layer: '01-Me', title: '我是 Beta 身份', content: 'Beta 的 ME 文档: 我是交易助手' }, undefined, 'agent-beta');
  check('Alpha 写入自己的 01-Me', !!rA.ok, rA.error || '');
  check('Beta 写入自己的 01-Me', !!rB.ok, rB.error || '');
  // 读分区
  const listA = await readContextAssets('01-Me', undefined, undefined, 'agent-alpha');
  const listB = await readContextAssets('01-Me', undefined, undefined, 'agent-beta');
  const filesA = listA[0]?.files || [];
  const filesB = listB[0]?.files || [];
  check('Alpha 只看到自己的资产', filesA.length === 1 && filesA[0].title.includes('Alpha'), `filesA=${filesA.map(f => f.title)}`);
  check('Beta 只看到自己的资产', filesB.length === 1 && filesB[0].title.includes('Beta'), `filesB=${filesB.map(f => f.title)}`);
  // 物理隔离验证: 不同目录
  const fs2 = await import('fs');
  const pathA = fs2.existsSync(path.join(TMP, '.bolloon', 'context-os', 'agent-alpha', '01-Me'));
  const pathB = fs2.existsSync(path.join(TMP, '.bolloon', 'context-os', 'agent-beta', '01-Me'));
  check('物理目录隔离', pathA && pathB, `A=${pathA} B=${pathB}`);

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
