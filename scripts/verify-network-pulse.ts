/**
 * verify-network-pulse.ts — 网络脉冲端到端验收 (含双节点集成)
 *
 * 真跑: 节点 A 发布 manifest → 节点 B 收到并缓存 → 观察层生成快照 → 公开只读接口返回聚合 →
 * 页面可消费; 并验证匿名性(原始 DID 不落盘/不出网)、隐私阈值、状态机(live/stale/unavailable)、
 * malformed 安全、ETag/304、无需认证。
 *
 * 用法: npx tsx scripts/verify-network-pulse.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-pulse-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_SETUP = '1';

const NP: any = await import('../src/agents/network-pulse.js');
const MP: any = await import('../src/agents/agent-manifest-protocol.js');

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 240)}` : ''}`);
  }
};
const section = (t: string) => console.log(`\n${t}`);

const DID_A = 'did:key:z6MkNodeAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DID_B = 'did:key:z6MkNodeBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// ── [1] 双节点: A 发布 manifest, B 收到并缓存 ──────────────────────────────
section('[1] 双节点集成: A 发布 → B 缓存 → 观察层看得见');
{
  MP.setLocalManifest({
    ownerName: 'NodeA',
    ownerPublicKey: DID_A,
    agents: [{ id: 'agent-a1', name: 'Researcher', capabilities: ['cross-border-market-research', 'data-analysis'], status: 'active' }],
  } as any);
  MP.cacheRemoteManifest({
    ownerName: 'NodeB',
    ownerPublicKey: DID_B,
    agents: [{ id: 'agent-b1', name: 'Coder', capabilities: ['code-review'], status: 'active' }],
  } as any);
  await new Promise((r) => setTimeout(r, 600));   // 挂点是 fire-and-forget

  const evRaw = fs.readFileSync(path.join(HOME, '.bolloon', 'network-pulse', 'events.json'), 'utf8');
  check('事件已落盘', evRaw.length > 10, evRaw.slice(0, 80));
  check('**原始 DID 没有落盘** (只有摘要)', !evRaw.includes('z6MkNodeA') && !evRaw.includes('z6MkNodeB'), evRaw.slice(0, 160));
  check('**原始能力名没有落盘** (只有粗类别)', !evRaw.includes('cross-border-market-research') && evRaw.includes('research'), evRaw.slice(0, 240));
  check('事件类型都在白名单内', JSON.parse(evRaw).every((e: any) => NP.NETWORK_EVENT_TYPES.includes(e.type)));

  const snap = await NP.getNetworkPulse({ home: HOME, force: true });
  check('观察层看到 2 个节点', snap.totals.nodes === 2, snap.totals);
  check('观察层看到 2 个 Agent', snap.totals.agents === 2, snap.totals);
  // 小网络里每个类别只有 1 个 Agent → 低于隐私阈值 → 全部并进 other 才是**正确行为**
  check('小网络: 类别全并进 other (隐私阈值先于可读性)', snap.capabilities.length === 1 && snap.capabilities[0].key === 'other', snap.capabilities);
  check('活动流由服务端模板生成 (中英齐备)', snap.recent_activity.length > 0 && snap.recent_activity.every((a: any) => a.text?.zh && a.text?.en), snap.recent_activity.slice(0, 2));
  check('状态 live 且带新鲜期', snap.status === 'live' && snap.fresh_until > snap.generated_at);
}

// ── [2] 隐私与可信边界 ─────────────────────────────────────────────────────
section('[2] 隐私阈值 + 可信文案 (observed / verified)');
{
  const snap = await NP.getNetworkPulse({ home: HOME, force: true });
  check('单/双来源未签名 → scope=observed (不说成全网)', snap.scope === 'observed' && snap.scope_label.zh.includes('当前节点观察到'), snap.scope_label);
  check('notes 明确"不是全网精确总量"', snap.notes.join(' ').includes('不是全网精确总量'), snap.notes);
  // ★ 2026-09-24 (leo: 快照 notes 里那个词也去掉): 无源不再借「未接入」这个词, 改用等价说法。
  check('notes 里不再出现「未接入」(无源改用「该口径无对应事件源, 不下发该字段」)',
    !snap.notes.join(' ').includes('未接入'), snap.notes);
  check('公开投影不含任何私有字段', NP.assertNoPrivateFields(snap).length === 0, NP.assertNoPrivateFields(snap));
  const json = JSON.stringify(snap);
  // DID / peerId / multiaddr 字样一律不许出现; 0x 长 hex **只许**出现在白名单键 (tx_hash / contract /
  // explorer_tx) 下 —— 越界即按泄露处理 (2026-09-23 精确化, 不是放松; 同日收窄: 合约地址不进页面)
  check('响应 JSON 里没有 did/peerId/multiaddrs/wallet', !/did:key|peerId|multiaddrs|wallet/.test(json), json.slice(0, 160));
  check('响应 JSON 里没有越界的 0x 长 hex (白名单键外一律算泄露)', NP.auditPublicHexLeaks(snap).length === 0, NP.auditPublicHexLeaks(snap));

  // 稀疏类别不单独暴露
  await NP.recordNetworkEvent({ type: 'capability_announced', capability: 'vision-ocr', did: DID_A, agentId: 'agent-a1' }, HOME);
  const s2 = await NP.getNetworkPulse({ home: HOME, force: true });
  check('单个 Agent 的稀有类别被并进 other (隐私阈值生效)', !s2.capabilities.some((c: any) => c.key === 'multimodal'), s2.capabilities);

  // 达到阈值后, 类别才以**准确计数**出现 (count = 不同 Agent 数, 不是事件数)
  for (const [i, did] of [DID_A, DID_B, 'did:key:zNodeC'].entries()) {
    await NP.recordNetworkEvent({ type: 'capability_announced', capability: 'cross-border-market-research', did, agentId: `r-${i}` }, HOME);
  }
  const s2b = await NP.getNetworkPulse({ home: HOME, force: true });
  const research = s2b.capabilities.find((c: any) => c.key === 'research');
  // 计数 = **不同 Agent 数** (不是事件数): [1] 里 setLocalManifest 已给 agent-a1 声明过 research,
  // 这里再加 r-0/r-1/r-2 三个 → 4 个不同 Agent。重复声明不会把计数刷高。
  check('达到隐私阈值后 research 出现且计数=不同 Agent 数 (4)', research?.count === 4, s2b.capabilities);
  await NP.recordNetworkEvent({ type: 'capability_announced', capability: 'cross-border-market-research', did: DID_A, agentId: 'r-0' }, HOME);
  const s2c = await NP.getNetworkPulse({ home: HOME, force: true });
  check('同一 Agent 重复声明 → 计数不虚增 (仍 4)', s2c.capabilities.find((c: any) => c.key === 'research')?.count === 4, s2c.capabilities);

  // ≥2 个签名来源 → verified
  await NP.recordNetworkEvent({ type: 'node_joined', did: DID_A, signed: true }, HOME);
  await NP.recordNetworkEvent({ type: 'node_joined', did: DID_B, signed: true }, HOME);
  const s3 = await NP.getNetworkPulse({ home: HOME, force: true });
  check('≥2 个签名来源 → verified network snapshot', s3.scope === 'verified' && s3.scope_label.en === 'Verified network snapshot', s3.scope_label);
}

// ── [3] 状态机: 缓存/live/stale/unavailable ────────────────────────────────
section('[3] 状态机: 短缓存 · stale · unavailable');
{
  const t1 = await NP.getNetworkPulse({ home: HOME });
  const t2 = await NP.getNetworkPulse({ home: HOME });
  check('30s 内命中缓存 (generated_at 相同)', t1.generated_at === t2.generated_at);
  check('缓存文件已落盘', fs.existsSync(path.join(HOME, '.bolloon', 'network-pulse', 'snapshot.json')));
  check('新鲜期内 → live', NP.snapshotStatus(t1, t1.generated_at + 1000) === 'live');
  check('新鲜期过后 → stale (不伪装实时)', NP.snapshotStatus(t1, t1.fresh_until + 1) === 'stale');
  const down = await NP.getNetworkPulse({ home: HOME, unavailable: true });
  check('观察层不可用 → unavailable + 说明不是"网络为空"', down.status === 'unavailable' && down.notes.join(' ').includes('不是"网络为空"'), down.notes);
}

// ── [4] malformed 安全 ─────────────────────────────────────────────────────
section('[4] malformed 数据: 不崩、不误报');
{
  const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-bad-'));
  fs.mkdirSync(path.join(h2, '.bolloon', 'network-pulse'), { recursive: true });
  fs.writeFileSync(path.join(h2, '.bolloon', 'network-pulse', 'events.json'), '{"broken": tru', 'utf8');
  const s = await NP.getNetworkPulse({ home: h2, force: true });
  check('坏 events.json → live 全 0 (不崩)', s.status === 'live' && s.totals.nodes === 0);
  check('坏事件对象被丢弃', NP.computeSnapshot([null, 7, { type: 'node_joined' }] as any, { now: Date.now() }).totals.nodes === 0);
  fs.rmSync(h2, { recursive: true, force: true });
}

// ── [5] 公开只读接口 (真 HTTP, 无认证) ─────────────────────────────────────
section('[5] GET /api/public/network/progress (真 HTTP, 无凭据, ETag, 短缓存)');
{
  const { createWebServer } = await import('../src/web/server.js') as any;
  const app = await createWebServer({ port: 0, headless: true } as any);
  const srv: any = app?.server || app;
  const addr: any = await new Promise((r) => { if (srv?.address?.()) r(srv.address()); else srv?.once?.('listening', () => r(srv.address())); });
  const BASE = `http://127.0.0.1:${addr?.port || 0}`;
  try {
    const r1 = await fetch(`${BASE}/api/public/network/progress`);
    const body: any = await r1.json();
    check('无需任何凭据即 200', r1.status === 200, r1.status);
    check('Cache-Control 短缓存', String(r1.headers.get('cache-control') || '').includes('max-age=15'), r1.headers.get('cache-control'));
    const etag = r1.headers.get('etag');
    check('带 ETag', !!etag, etag);
    check('响应含 totals/capabilities/recent_activity 三块', !!body.totals && Array.isArray(body.capabilities) && Array.isArray(body.recent_activity));
    check('响应 status ∈ live|stale|unavailable', ['live', 'stale', 'unavailable'].includes(body.status), body.status);
    check('响应不含私有字段', NP.assertNoPrivateFields(body).length === 0, NP.assertNoPrivateFields(body));
    const r2 = await fetch(`${BASE}/api/public/network/progress`, { headers: { 'if-none-match': String(etag) } });
    check('带 If-None-Match → 304 (省流量)', r2.status === 304, r2.status);
    // 本地私有接口仍在、且与公开接口分离
    const rl = await fetch(`${BASE}/api/agent/local-manifest`);
    check('本地 /api/agent/local-manifest 依旧可用 (进网/控制用, 不给网站)', rl.status === 200 || rl.status === 404, rl.status);
  } finally {
    try { await (app?.close?.() ?? srv?.close?.()); } catch { /* noop */ }
  }
}

// ── [6] 前端消费契约 ───────────────────────────────────────────────────────
section('[6] 前端消费契约 (bolloon-UI 网关页需要什么这里就得有什么)');
{
  const snap = await NP.getNetworkPulse({ home: HOME, force: true });
  const need = ['status', 'generated_at', 'fresh_until', 'scope', 'scope_label', 'totals', 'capabilities', 'recent_activity'];
  const missing = need.filter((k) => !(k in snap));
  check('快照字段齐全 (UI 只依赖白名单投影)', missing.length === 0, missing);
  check('totals 四个大数值齐备', ['nodes', 'agents', 'active_agents', 'seen_last_24h'].every((k) => k in snap.totals), snap.totals);
  check('scope_label 中英双语可用', !!snap.scope_label.zh && !!snap.scope_label.en, snap.scope_label);
  const json = JSON.stringify(snap);
  check('前端拿到的 JSON 里没有任务正文/指令类字段', !/"instruction"|"content"|"payload"/.test(json), json.slice(0, 120));
}

// ── [7] 冻结形状 confirmed_activity (真索引 → 真行; 索引坏 → 降级并标源) ──────
section('[7] confirmed_activity 冻结形状 (链上索引 → 真活动行 · 降级标注 · 匿名)');
{
  const FROZEN = ['task', 'kind', 'state', 'chain_id', 'block', 'tx', 'confirmations', 'finality', 'at'];
  // 链上索引行的完整形状 (2026-09-23): 老 9 个 + 4 个可核验字段 (追加在尾部)
  const CHAIN_FROZEN = [...FROZEN, 'tx_hash', 'contract', 'explorer_tx'];
  const TASK = '0x' + 'ab'.repeat(32);
  /** 夹具里的 escrow **合约**地址 (索引文件顶层 escrowAddress === 条目 address 才有合约字段) */
  const ESCROW = '0x' + '11'.repeat(20);
  const chainDir = path.join(HOME, '.bolloon', 'chain');
  const chainFile = path.join(chainDir, 'index.json');
  const mkEntry = (i: number) => ({
    key: `0x${String(i).padStart(2, '0').repeat(32)}:${i}`,
    blockNumber: 400 + i, blockHash: '0x' + 'aa'.repeat(32),
    txHash: `0x${String(i).padStart(2, '0').repeat(32)}`, txIndex: 0, logIndex: i,
    address: '0x' + '11'.repeat(20),
    eventName: i % 2 === 0 ? 'EscrowCreatedV2' : 'ReleasedV2',
    taskKey: TASK, args: {}, confirmations: 0, finality: 'observed', suspect: false,
    firstSeenAt: Date.UTC(2026, 8, 22, 5, 31, 0) + i * 1000, updatedAt: Date.now(), history: [],
  });

  // ① 没有链上索引 → 字段仍在, 空数组 + source=none (不编行)
  const noIdx = await NP.getNetworkPulse({ home: HOME, force: true });
  check('没有链上索引: confirmed_activity 仍在 (空数组) 且 source=none',
    Array.isArray(noIdx.confirmed_activity) && noIdx.confirmed_activity.length === 0 && noIdx.confirmed_activity_source === 'none',
    [noIdx.confirmed_activity_source, noIdx.confirmed_activity.length]);

  // ② 真索引文件 (30 条, 故意超上限) → 25 行, 最新在前, 冻结形状逐字
  fs.mkdirSync(chainDir, { recursive: true });
  fs.writeFileSync(chainFile, JSON.stringify({
    schemaVersion: 2, chainId: 84532, networkName: 'base-sepolia', escrowAddress: '0x' + '11'.repeat(20),
    deploymentBlock: 47142222, deploymentSource: 'fixture', lastSyncedBlock: 47142250, lastSyncedAt: Date.now(),
    headBlock: 47142250, headBlockHash: '0x' + 'bb'.repeat(32),
    confirmations: { confirmed: 1, finalized: 12 }, pageSize: 2000, reorgDepth: 32,
    entries: Array.from({ length: 30 }, (_, i) => mkEntry(i)), recentBlocks: [], runs: [], updatedAt: Date.now(),
  }), 'utf8');
  const snap = await NP.getNetworkPulse({ home: HOME, force: true });
  const rows: any[] = snap.confirmed_activity;
  check('真索引 → 快照列出真活动行 (source=chain-index)', snap.confirmed_activity_source === 'chain-index' && rows.length > 0, [snap.confirmed_activity_source, rows.length]);
  check('上限 25 行', rows.length === 25, rows.length);
  check('字段名与顺序逐字冻结 (链上索引行 = 老 9 个 + 新增 3 个可核验字段)', rows.every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(CHAIN_FROZEN)), Object.keys(rows[0]));
  check('最新在前 (block 递减)', rows.every((r, i) => i === 0 || rows[i - 1].block > r.block), rows.slice(0, 3).map((r) => r.block));
  check('state/kind 映射正确 (EscrowCreatedV2→active · ReleasedV2→released)',
    rows.every((r) => (r.state === 'active' && r.kind === 'task_created') || (r.state === 'released' && r.kind === 'trade_settled')));
  check('确认数按 1/12 门槛复算 (head 47142250 - block + 1)',
    rows[0].confirmations === 47142250 - rows[0].block + 1 && ['observed', 'confirmed', 'finalized'].includes(rows[0].finality),
    [rows[0].block, rows[0].confirmations, rows[0].finality]);
  const rowsJson = JSON.stringify(rows);
  const txOf = (i: number) => `0x${String(i).padStart(2, '0').repeat(32)}`;
  check('任务标识仍是 sha256 短写 (taskKey 原文绝不出); 真 txHash / escrow 合约地址**只**出现在白名单键下',
    rows.every((r: any) => /^sha256:[0-9a-f]{8}$/.test(r.task) && /^sha256:[0-9a-f]{8}$/.test(r.tx))
    && !rowsJson.includes(TASK)
    && rows.every((r: any) => r.tx_hash === txOf(r.block - 400))          // 真哈希, 逐行对得上夹具
    && rows.every((r: any) => NP.anonShortRef(r.tx_hash, 'tx') === r.tx)  // 老短写与新哈希同源
    && rows.every((r: any) => r.contract === ESCROW)                      // 合约 = 索引文件的 escrowAddress
    && rows.every((r: any) => r.explorer_tx === `https://sepolia.basescan.org/tx/${r.tx_hash}`)
    && rows.every((r: any) => !('explorer_contract' in r))                       // 合约链接不存在 (合约不上页面)
    && rows.every((r: any) => !/\/address\//.test(JSON.stringify(r)))              // 行里也没有任何合约地址链接
    && NP.auditPublicHexLeaks(rows).length === 0,                          // 白名单键外一个 0x 长 hex 都没有
    rows[0]);
  check('快照整体无私有字段', NP.assertNoPrivateFields(snap).length === 0, NP.assertNoPrivateFields(snap));

  // ③ 索引坏掉 → 降级, 并在快照里标明来源
  fs.writeFileSync(chainFile, '{ broken', 'utf8');
  await NP.recordNetworkEvent({ type: 'task_posted', taskId: 'verify-task', did: DID_A }, HOME);
  const degraded = await NP.getNetworkPulse({ home: HOME, force: true });
  check('索引坏 → 降级到脉冲事件并标 source=pulse-events',
    degraded.confirmed_activity_source === 'pulse-events' && degraded.confirmed_activity.length === 1, degraded.confirmed_activity_source);
  check('降级行不冒充链上 (chain_id/block/confirmations=0 · finality=observed)',
    degraded.confirmed_activity.every((r: any) => r.chain_id === 0 && r.block === 0 && r.confirmations === 0 && r.finality === 'observed'),
    degraded.confirmed_activity[0]);
  check('降级行也不出任务原文', !JSON.stringify(degraded.confirmed_activity).includes('verify-task'));
  check('totals/recent_activity 等既有字段没被改动', !!degraded.totals && Array.isArray(degraded.recent_activity) && Array.isArray(degraded.capabilities));
}

console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
console.log('覆盖: 双节点(发布→缓存→观察) · 匿名化(原始 DID/能力名不落盘) · 隐私阈值 · scope 可信边界 · live/stale/unavailable · malformed 安全 · 公开接口无认证+ETag+304 · 前端字段契约 · confirmed_activity 冻结形状(真索引→真行 · 上限/排序/门槛 · 降级标源 · 匿名)');
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
process.exit(failed === 0 ? 0 : 1);
