/**
 * verify-orbitdb-stack.ts — OrbitDB 数据层全栈验证 (2026-08-06)
 * Context Store (快照/恢复/版本) + UI CID (保存/加载/React 动态构造/版本) + agent 工具
 * 跑法: npx tsx scripts/verify-orbitdb-stack.ts
 */
import { OrbitDBAdapter } from '../src/orbitdb/cid-database.js';
import { ContextStore } from '../src/orbitdb/context-store.js';
import { UICidStoreImpl } from '../src/orbitdb/ui-cid.js';
import { registerOrbitdbTools } from '../src/orbitdb/agent-tools.js';
import * as os from 'os';
import * as path from 'path';

async function main() {
  const dir = path.join(os.tmpdir(), `bolloon-orbitdb-stack-${Date.now()}`);
  const db = new OrbitDBAdapter(dir);
  let pass = 0, fail = 0;
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name} ${extra}`); }
  };

  console.log('[1] Context Store: 快照 → 恢复 → 版本');
  const cs = new ContextStore(db);
  const snap = await cs.captureCurrentContext('agent-A', { focus: '优化 OrbitDB 集成', memorySummary: '已完成数据层' });
  const snapRec = await cs.saveSnapshot(snap);
  check('快照保存返回 CID', /^bafy/.test(snapRec.id));
  const restored = await cs.restoreContext('agent-A');
  check('恢复快照 (focus 一致)', !!restored && restored.focus === '优化 OrbitDB 集成');
  const versions = await cs.contextVersions('agent-A');
  check('快照版本列表 = 1', versions.length === 1);

  console.log('[2] 共享记忆 (multi-agent)');
  await cs.saveMemory('agent-A', { note: 'A 的经验' });
  await cs.saveMemory('agent-B', { note: 'B 的经验' });
  const shared = await cs.sharedMemory();
  check('sharedMemory 全量 = 2', shared.length === 2);
  const sharedA = await cs.sharedMemory('agent-A');
  check('sharedMemory(agent-A) = 1', sharedA.length === 1 && sharedA[0].content.note === 'A 的经验');

  console.log('[3] UI CID: 保存 → 加载 → React 动态构造 → 版本');
  const ui = new UICidStoreImpl(db);
  const compRec = await ui.saveComponent('agent-A', {
    name: 'TradeButton',
    framework: 'react',
    code: 'function TradeButton(props){ return React.createElement("button", { style: { background: props.theme?.color || "#c4d640" } }, props.label); }',
    theme: { color: '#c4d640' },
    description: '交易按钮',
  });
  check('组件保存返回 CID', /^bafy/.test(compRec.id));
  const def = await ui.loadComponent(compRec.id);
  check('组件加载 (name 一致)', !!def && def.name === 'TradeButton');
  const { component } = await ui.loadReactComponent(compRec.id);
  const el = component({ label: '执行交易' });
  check('React 组件动态构造 (element 生成)', !!el && typeof el === 'object' && el.props.children === '执行交易');
  const v2 = await ui.versionComponent(compRec.id, 'function TradeButton(props){ return React.createElement("button", null, props.label); }', { theme: { color: '#000' } });
  check('组件版本 v2', !!v2 && v2.version === 2);
  const uiChain = await db.version(v2!.id);
  check('组件版本链 = [v1, v2]', uiChain.length === 2);
  const uiList = await ui.listComponents('agent-A');
  check('listComponents = 2 (v1+v2)', uiList.length === 2);

  console.log('[4] agent 工具注册 + 执行');
  const ctx: any = { tools: new Map() };
  registerOrbitdbTools(ctx);
  const toolNames = [...ctx.tools.keys()];
  for (const n of ['cid_save', 'cid_load', 'cid_update', 'cid_version', 'cid_list', 'cid_share', 'context_save_snapshot', 'context_restore', 'ui_save_component', 'ui_load_component']) {
    check(`工具已注册: ${n}`, toolNames.includes(n));
  }
  const saveRes = await ctx.tools.get('cid_save').execute({ agentId: 'agent-C', type: 'knowledge', content: { insight: 'OrbitDB 全栈可用' } });
  check('cid_save 工具执行', saveRes.success && /CID: bafy/.test(saveRes.output || ''));
  const cid = (saveRes.output.match(/CID: (bafy\w+)/) || [])[1];
  const loadRes = await ctx.tools.get('cid_load').execute({ cid });
  check('cid_load 工具执行', loadRes.success && loadRes.output.includes('OrbitDB 全栈可用'));
  const listRes = await ctx.tools.get('cid_list').execute({ agentId: 'agent-C' });
  check('cid_list 工具执行', listRes.success && listRes.output.includes('knowledge'));
  const shareRes = await ctx.tools.get('cid_share').execute({ cid });
  check('cid_share 工具执行', shareRes.success && shareRes.output.includes('bolloon-cid://'));
  const snapRes = await ctx.tools.get('context_save_snapshot').execute({ agentId: 'agent-C', focus: '测试' });
  check('context_save_snapshot 工具执行', snapRes.success);
  const uiSaveRes = await ctx.tools.get('ui_save_component').execute({ agentId: 'agent-C', name: 'TestUI', code: 'function TestUI(props){ return null; }' });
  check('ui_save_component 工具执行', uiSaveRes.success);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('FAIL:', e?.message || e); console.error(e?.stack?.split('\n').slice(0, 5).join('\n')); process.exit(1); });
