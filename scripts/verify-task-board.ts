/**
 * verify-task-board.ts — C1/C2 验收: 任务对外发布 + 接单 (公告板), 真跑
 *
 * 对着"最小可用的对外通道"逐条真跑 (不是读代码):
 *   [1] publish: 稳定 announcementId + 真落盘 + **真写注册表** + 真脉冲事件 task_announced (匿名)
 *   [2] board:   本地公告 + **注册表发现的远端公告**, 按 id 去重; 板上没有任务正文
 *   [3] claim:   真签名认领 → 记录 认领者 DID / 时间 / 声明价格; 状态 open → claimed
 *   [4] 负控制:  重复认领被拒 / 认领不存在 id 被拒 / 已取消被拒 / 未签名被拒 / 正文被改被拒 /
 *                已过期被拒 / 非法 id 被拒 —— 每条都要**证明事实没被改** (claims 数不变、状态不变)
 *   [5] 裁决:    **未交付不得释放** / **未结算不得标 verified** (local-dev 永远不是链上结算) +
 *                未认领 / 争议中 / 已释放 各自的拒绝路径; 所有路径 fundsMoved=false (本层不动钱)
 *   [6] send:    注册表没有 provider 但板上有匹配公告 → 给**可操作**提示 (board/claim);
 *                板上没有匹配公告 → 不伪造提示 (负控制)
 *   [7] 显式 skipped: 需要真跨机/真链上交易的部分一条条列出来 (不冒充验过)
 *
 * 用法: npx tsx scripts/verify-task-board.ts       退出码 0=全绿, 1=有红, 2=前置事实拿不到
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REAL_HOME = os.homedir();          // 必须在覆盖 HOME 之前取
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-board-'));
const HOME = path.join(ROOT, 'home');
const HOME2 = path.join(ROOT, 'home-other');   // 模拟"另一台机器"的公告落盘地
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
fs.mkdirSync(path.join(HOME2, '.bolloon'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_SETUP = '1';

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
makeSetupReady(path.join(HOME, '.bolloon'), { realHome: REAL_HOME, name: 'C1/C2 公告板验收' });

// ── 夹具: 本机身份 (买方) + 另外两方身份 (远端公告方 / 接单方) ────────────────
const { KeyManager } = await import('@diap/sdk') as any;
const kpOf = (kp: any) => ({ did: String(kp.did || ''), publicKeyHex: Buffer.from(kp.publicKey as Uint8Array).toString('hex') });
{
  const kp = (KeyManager as any).generate();
  await (KeyManager as any).saveToFile(kp, path.join(HOME, '.bolloon', 'identity.json'));
}
// 另外两方身份 —— **keypair 与声明的公钥必须是同一个**, 否则签名天然验不过 (这正是签名闸该抓的事)
const kpBuyer = (KeyManager as any).generate();
const buyer = kpOf(kpBuyer);              // 远端公告的买方 (另一台机器)
const kpProvider = (KeyManager as any).generate();
const provider = kpOf(kpProvider);        // 接单的 provider
// 语义化命名: 本机 identity.json 里的那个人 = 本机买方 (下面用 loadLocalSigner 取真事实)

const TB: any = await import('../src/agents/task-board.js');
const NP: any = await import('../src/agents/network-pulse.js');
const AR: any = await import('../src/agents/agent-registry.js');
const PE: any = await import('../src/cli/protocol-envelope.js');
const TC: any = await import('../src/agents/task-contract.js');
const TASKS: any = await import('../src/cli/commands/tasks.js');
const LS: any = await import('../src/agents/local-signer.js');

let passed = 0, failed = 0;
const skipped: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 320)}` : ''}`);
  }
};
const skip = (name: string, why: string) => { skipped.push(name); console.log(`  ⏭ ${name} — ${why}`); };
const section = (t: string) => console.log(`\n${t}`);

const now = Date.now();
const CAP = 'market-research-jp';
/** 正文故意长过 60 字预览: 尾部标记只应该出现在**本地文件**里 (板上/注册表里不许有) */
const TAIL_A = 'TAIL-ONLY-BODY-A';
const INSTRUCTION = `调研某类厨房用品的日本市场: 渠道结构/价格带/合规门槛/竞品定价/进入节奏, 输出要点与不确定性. 正文尾部标记 ${TAIL_A} (中性夹具, 只应存在于本地公告文件)`;
const REMOTE_CAP = 'kitchenware-market-scan';
const TAIL_B = 'TAIL-ONLY-BODY-B';
const REMOTE_INSTRUCTION = `某类厨房用品在日本市场的渠道扫描: 主力渠道/价格带/合规与认证门槛/竞品定价结构/进入节奏建议. 正文尾部标记 ${TAIL_B} (中性夹具, 来自另一台机器)`;

// ── [0] 前置事实必须真拿到 (拿不到就拒跑, 不静默通过) ────────────────────────
section('[0] 前置事实 (拿不到就拒跑, 不静默通过)');
const signer = await LS.loadLocalSigner(HOME);
if (!signer) {
  console.error('  ✗ 隔离 HOME 里没有可签名身份 (identity.json) —— 拒绝继续跑 (不静默通过)');
  process.exit(2);
}
let registry: any = null;
let registryReadable = false;
try { registry = AR.getAgentRegistry(); await registry.list(); registryReadable = true; } catch { registryReadable = false; }
{
  const bad = [];
  if (!signer?.did) bad.push('identity 里没有 did');
  if (!registryReadable) bad.push('注册表读不了 (~/.bolloon/agent-registry.json)');
  if (!fs.existsSync(path.join(HOME, '.bolloon'))) bad.push('隔离 HOME 不存在');
  if (bad.length) { console.error(`  ✗ 前置事实缺失: ${bad.join('; ')} —— 拒绝继续跑`); process.exit(2); }
  check('本机身份可加载 (did 非空, 公钥 64 hex)', !!signer.did && /^[0-9a-f]{64}$/i.test(signer.publicKeyHex), { did: signer.did });
  check('注册表可读 (真 agent-registry 实例)', registryReadable && !!registry);
  check('板目录是 ~/.bolloon/tasks/board', TB.boardDir(HOME) === path.join(HOME, '.bolloon', 'tasks', 'board'), TB.boardDir(HOME));
  check('脉冲事件白名单含 task_announced (C1 新增)', NP.NETWORK_EVENT_TYPES.includes('task_announced'));
}

// ── [1] publish ─────────────────────────────────────────────────────────────
section('[1] publish: 稳定 id + 真落盘 + 真注册表公告 + 真脉冲事件');
const BUDGET = { maxAmount: '50000', currency: 'USDC', network: 'base-sepolia' };
const pub1 = await TB.publishAnnouncement({
  capability: CAP, instruction: INSTRUCTION,
  buyerDid: signer.did, buyerPublicKeyHex: signer.publicKeyHex,
  budget: BUDGET, deadline: now + 24 * 3600_000, paymentMode: 'policy', signerKeypair: signer.keypair,
});
const A = pub1.announcement?.announcementId || '';
check('publish 成功且 announcementId 形如 ann-xxxxxxxxxxxxxxxx', pub1.ok === true && /^ann-[0-9a-f]{16}$/.test(A), { ok: pub1.ok, A, err: pub1.error });
check('公告真的落盘 (~/.bolloon/tasks/board/<id>.json)', !!A && fs.existsSync(path.join(TB.boardDir(HOME), `${A}.json`)));
check('公告已签名 (signed=true)', pub1.signed === true);
check('签名验签通过 (真 ed25519 验, 不是硬编)', (await TB.verifyAnnouncementSignature(TB.readAnnouncement(A, HOME))) === true);
check('向注册表公告成功 (真写 agent-registry)', pub1.registry.attempted === true && pub1.registry.announced === true, pub1.registry);
check('注册表条目是 task.announce 服务', (await registry.list()).some((s: any) => s.agentId === signer.did && s.service?.name === TB.ANNOUNCE_SERVICE_NAME));
check('脉冲事件 task_announced 真记上了', pub1.pulse.attempted === true && pub1.pulse.ok === true, pub1.pulse);
{
  const evRaw = fs.existsSync(path.join(NP.pulseDir(HOME), 'events.json')) ? fs.readFileSync(path.join(NP.pulseDir(HOME), 'events.json'), 'utf8') : '';
  check('脉冲 events.json 里有 task_announced (匿名事件)', evRaw.includes('task_announced'));
  check('脉冲事件里**没有**任务正文 / 公告 id 原文 / DID 原文', !evRaw.includes('厨房') && !evRaw.includes(TAIL_A) && !evRaw.includes(A) && !evRaw.includes(signer.did), evRaw.slice(0, 160));
}
{
  const pubAgain = await TB.publishAnnouncement({
    capability: CAP, instruction: INSTRUCTION,
    buyerDid: signer.did, buyerPublicKeyHex: signer.publicKeyHex,
    budget: BUDGET, deadline: now + 3600_000, paymentMode: 'policy', signerKeypair: signer.keypair,
  });
  const fileJson = JSON.parse(fs.readFileSync(path.join(TB.boardDir(HOME), `${A}.json`), 'utf8'));
  check('同一 (能力+正文+买方+预算) 重发 → 同一个 announcementId (稳定)', pubAgain.announcement?.announcementId === A, pubAgain.announcement?.announcementId);
  check('重发是幂等的 (dup=true) 且**没覆盖**既有公告 (createdAt/deadline 原样)', pubAgain.dup === true && fileJson.createdAt === pub1.announcement!.createdAt && fileJson.deadline === pub1.announcement!.deadline, { dup: pubAgain.dup, deadline: fileJson.deadline });
  const other = await TB.publishAnnouncement({
    capability: CAP, instruction: INSTRUCTION,
    buyerDid: signer.did, buyerPublicKeyHex: signer.publicKeyHex,
    budget: { ...BUDGET, maxAmount: '60000' }, deadline: now + 24 * 3600_000, paymentMode: 'policy', signerKeypair: signer.keypair,
  });
  check('换预算 → 换 id (预算参与身份, 不是同一条公告)', other.announcement?.announcementId !== A, other.announcement?.announcementId);
  check('公告里没有私钥字段', !/privateKey|mnemonic|seed/i.test(fs.readFileSync(path.join(TB.boardDir(HOME), `${A}.json`), 'utf8')));
}

// 签名缺失的公告 (负控制用: 没签名 → 不许被接单)
const NO_SIG_INSTRUCTION = '某类厨房用品的日本市场调研 (未签名夹具)';
const pubNoSig = await TB.publishAnnouncement({
  capability: CAP, instruction: NO_SIG_INSTRUCTION,
  buyerDid: signer.did, buyerPublicKeyHex: signer.publicKeyHex,
  budget: BUDGET, deadline: now + 24 * 3600_000, paymentMode: 'policy',
});
const NS = pubNoSig.announcement?.announcementId || '';
check('没有身份就不签名 (signed=false, 不假装签过)', pubNoSig.signed === false && !!NS);

// 被篡改正文的公告 (负控制用)
const TAMPER_INSTRUCTION = '某类厨房用品的日本市场调研 (会被改坏的夹具)';
const pubT = await TB.publishAnnouncement({
  capability: CAP, instruction: TAMPER_INSTRUCTION,
  buyerDid: signer.did, buyerPublicKeyHex: signer.publicKeyHex,
  budget: BUDGET, deadline: now + 24 * 3600_000, paymentMode: 'policy', signerKeypair: signer.keypair,
});
const TP = pubT.announcement?.announcementId || '';
{
  const f = path.join(TB.boardDir(HOME), `${TP}.json`);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.instruction = `${j.instruction} —— 被人改过一行`;
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
  check('篡改夹具已就位 (正文与签名时的摘要不再一致)', !!TP);
}

// 已过期的公告 (负控制用)
const EXP_INSTRUCTION = '某类厨房用品的日本市场调研 (过期夹具)';
const pubE = await TB.publishAnnouncement({
  capability: CAP, instruction: EXP_INSTRUCTION,
  buyerDid: signer.did, buyerPublicKeyHex: signer.publicKeyHex,
  budget: BUDGET, deadline: now - 1000, paymentMode: 'policy', signerKeypair: signer.keypair,
});
const EX = pubE.announcement?.announcementId || '';
check('过期公告能落盘 (deadline 已过), 但接单时会被拒', !!EX && pubE.ok === true);

// 会被取消的公告 (负控制用)
const CANCEL_INSTRUCTION = '某类厨房用品的日本市场调研 (会被撤下的夹具)';
const pubC = await TB.publishAnnouncement({
  capability: CAP, instruction: CANCEL_INSTRUCTION,
  buyerDid: signer.did, buyerPublicKeyHex: signer.publicKeyHex,
  budget: BUDGET, deadline: now + 24 * 3600_000, paymentMode: 'policy', signerKeypair: signer.keypair,
});
const CX = pubC.announcement?.announcementId || '';
{
  const c = await TB.cancelAnnouncement(CX, '夹具: 买方撤下这条公告 (供负控制用)', { home: HOME, registry });
  check('买方撤销公告走真代码 (cancelAnnouncement, 并回写注册表)', c.ok === true && c.announcement?.status === 'cancelled', c.error);
  const svc = (await registry.list()).find((s: any) => s.agentId === signer.did);
  const payloads = JSON.parse(String(svc?.service?.description || '').replace(TB.ANNOUNCE_DESC_PREFIX, ''));
  check('取消后注册表条目里不再把这条列成 open (远端不会看到已撤销的公告)',
    !payloads.some((p: any) => p.announcementId === CX), payloads.map((p: any) => [p.announcementId.slice(0, 10), p.status]).slice(0, 8));
}

// 另一台机器的公告 (远端公告夹具): 落盘在 HOME2 (= 对方的机器), 只有注册表条目进本机
const pubRemote = await TB.publishAnnouncement({
  capability: REMOTE_CAP, instruction: REMOTE_INSTRUCTION,
  buyerDid: buyer.did, buyerPublicKeyHex: buyer.publicKeyHex,
  budget: { maxAmount: '70000', currency: 'USDC', network: 'base-sepolia' },
  deadline: now + 24 * 3600_000, paymentMode: 'policy', signerKeypair: kpBuyer,
}, { home: HOME2, registry, offline: false, recordEvent: async () => ({ ok: true }) });
const RID = pubRemote.announcement?.announcementId || '';
check('远端公告已注册进本机注册表 (真 register, 真签名)',
  pubRemote.registry.announced === true && pubRemote.signed === true && /^ann-[0-9a-f]{16}$/.test(RID), { registry: pubRemote.registry, signed: pubRemote.signed });
check('远端公告的正文**没**落到本机板目录 (本机只有注册表里的摘要)',
  fs.existsSync(path.join(TB.boardDir(HOME2), `${RID}.json`)) === true && fs.existsSync(path.join(TB.boardDir(HOME), `${RID}.json`)) === false);

// ── [2] board ───────────────────────────────────────────────────────────────
section('[2] board: 本地 + 注册表远端, 按 id 去重, 板上没有正文');
const view = await TB.listBoard({ home: HOME, registry, now: Date.now() });
const byId = new Map(view.entries.map((e: any) => [e.announcementId, e]));
check('板上含本地公告 (A 在)', byId.has(A) && (byId.get(A) as any).source === 'local');
{
  const remoteEntries = view.entries.filter((e: any) => e.remote === true);
  check('板上含注册表发现的远端公告 (本机没有它的公告文件)', remoteEntries.length >= 1, { remoteCount: view.remoteCount });
  const r = remoteEntries[0];
  check('远端条目 source=registry 且带能力/预算/摘要', r && r.source === 'registry' && r.capability === REMOTE_CAP && !!r.instructionDigest && !!r.budget, r);
  check('远端条目**没有**任务正文 (只有摘要 + 预览)', r && !('instruction' in r) && !JSON.stringify(r).includes(TAIL_B), r?.instructionPreview);
  check('远端条目认领数如实标 0 (看不到就写 0, 不编)', r && r.claimCount === 0 && r.claimedBy === null);
}
{
  const ids = view.entries.map((e: any) => e.announcementId);
  const dupCount = ids.filter((x: string) => x === A).length;
  check('本地与注册表都有的 id → 去重后只出现一次', dupCount === 1, { dupCount, duplicates: view.duplicates });
  check('去重的 id 被显式列出来 (duplicates)', view.duplicates.includes(A), view.duplicates);
  check('本地/远端计数与板行数自洽', view.localCount === TB.listAnnouncements(HOME).length && view.entries.length === view.localCount + view.remoteCount, { local: view.localCount, remote: view.remoteCount, rows: view.entries.length });
}
{
  const cli = await TASKS.taskCommand(PE.parseFlags(['board', '--json', '--open']));
  const d = cli.envelope.data as any;
  check('CLI `task board --open` 只列可接单的且信封 ok', cli.envelope.ok === true && d.entries.every((e: any) => e.claimable === true), { count: d.count });
  check('CLI 看板输出里没有任何任务正文 (只有 60 字预览)', !JSON.stringify(cli.envelope).includes(TAIL_A) && !JSON.stringify(cli.envelope).includes(TAIL_B), JSON.stringify(cli.envelope).slice(0, 200));
  const cliCap = await TASKS.taskCommand(PE.parseFlags(['board', '--json', '--capability', REMOTE_CAP]));
  const dc = cliCap.envelope.data as any;
  check('`task board --capability X` 过滤生效', dc.entries.length >= 1 && dc.entries.every((e: any) => e.capability === REMOTE_CAP), { count: dc.count });
}

// ── [3] claim ───────────────────────────────────────────────────────────────
section('[3] claim: 真签名认领 → 记 DID / 时间 / 声明价格');
const claim1 = await TB.claimAnnouncement(A, {
  providerDid: provider.did, providerPublicKeyHex: provider.publicKeyHex,
  priceAmountAtomic: '20000', currency: 'USDC', network: 'base-sepolia',
  signerKeypair: kpProvider,
});
check('认领成功 (ok=true, reason=claimed)', claim1.ok === true && claim1.reason === 'claimed', claim1.message);
check('认领记录带 认领者 DID', claim1.claim?.providerDid === provider.did);
check('认领记录带 认领时间 (≈现在)', Math.abs(Number(claim1.claim?.claimedAt) - Date.now()) < 60_000, claim1.claim?.claimedAt);
check('认领记录带 声明价格 (原子单位串)', claim1.claim?.priceAmountAtomic === '20000');
check('认领签名真加上了', !!claim1.claim?.signature);
check('声明价格的人话版如实 (声明了就说多少)', String(claim1.priceNote || '').includes('20000'), claim1.priceNote);
{
  const { verifyTaskEnvelope } = TC;
  const vf = (await import('../src/agents/local-signer.js')).verifierFor(provider.publicKeyHex);
  const okSig = vf ? await verifyTaskEnvelope({ ...(claim1.claim as any) }, vf) : false;
  check('认领签名用 provider 的公钥真验得过 (不是随手编的签名)', okSig === true);
}
check('认领不执行 / 不付款 / 不标 verified / 不动钱',
  claim1.paid === false && claim1.fundsMoved === false && claim1.verified === false, { paid: claim1.paid, moved: claim1.fundsMoved, verified: claim1.verified });
{
  const onDisk = TB.readAnnouncement(A, HOME);
  check('盘上状态 open → claimed', onDisk.status === 'claimed');
  check('盘上 claims 恰好 1 条', Array.isArray(onDisk.claims) && onDisk.claims.length === 1, onDisk.claims?.length);
  const v2 = await TB.listBoard({ home: HOME, registry, now: Date.now() });
  const row = v2.entries.find((e: any) => e.announcementId === A);
  check('板上这条不再可接单 (claimable=false) 且显示认领者', row?.claimable === false && row?.claimedBy === provider.did, row);
}
{
  const cliClaim = await TASKS.taskCommand(PE.parseFlags(['claim', pubRemote.announcement!.announcementId]));
  const d = cliClaim.envelope.data as any;
  check('CLI `task claim <远端公告 id>` 成功且诚实标注未投递', cliClaim.envelope.ok === true && d.remote === true && d.deliveredToBuyer === false, { code: cliClaim.envelope.code, d });
  check('CLI 认领的 JSON 里不出现私钥材料', !/privateKey|BEGIN .*PRIVATE/i.test(JSON.stringify(cliClaim.envelope)));
  check('CLI 没给 --price → 如实说"未声明价格" (不编价)', d.claim?.priceAmountAtomic === null && String(d.priceNote || '').includes('未声明'), d.priceNote);
}
{
  // 声明价格的路子 (CLI 真跑): 人类可读金额 → 原子单位串
  const F = await TB.publishAnnouncement({
    capability: 'kitchenware-market-scan', instruction: `报价夹具: ${INSTRUCTION}`,
    buyerDid: signer.did, buyerPublicKeyHex: signer.publicKeyHex,
    budget: { maxAmount: '30000', currency: 'USDC', network: 'base-sepolia' },
    deadline: now + 3600_000, paymentMode: 'policy', signerKeypair: signer.keypair,
  } as any, { home: HOME, offline: true });
  const fid = F.announcement?.announcementId || '';
  const cliPriced = await TASKS.taskCommand(PE.parseFlags(['claim', fid, '--price', '0.031']));
  const dp = cliPriced.envelope.data as any;
  check('CLI `--price 0.031` → 认领里记 31000 原子 (真换算)',
    cliPriced.envelope.ok === true && dp.claim?.priceAmountAtomic === '31000', dp.claim);
  check('价格声明人话版如实', String(dp.priceNote || '').includes('31000'), dp.priceNote);
}

// ── [4] 负控制 (每条都证明"事实没被改") ─────────────────────────────────────
section('[4] 负控制: 重复认领 / 不存在 / 已取消 / 未签名 / 被改 / 过期 / 非法 id');
{
  const claimsBefore = TB.readAnnouncement(A, HOME).claims.length;
  const again = await TB.claimAnnouncement(A, { providerDid: provider.did, priceAmountAtomic: '20000' });
  check('① 同一 provider 重复认领 → 拒 (already_claimed)', again.ok === false && again.reason === 'already_claimed', { reason: again.reason, msg: again.message });
  check('① 拒绝后盘上 claims 数没变 (没有第二次写入)', TB.readAnnouncement(A, HOME).claims.length === claimsBefore);
  const other = await TB.claimAnnouncement(A, { providerDid: kpOf((KeyManager as any).generate()).did });
  check('① 另一 provider 也认领同一条 → 拒 (一条公告只被认领一次)', other.ok === false && other.reason === 'already_claimed', other.reason);
  check('① 拒绝时带出既有认领事实 (谁先接的)', other.existingClaim?.providerDid === provider.did, other.existingClaim);
  const cliAgain = await TASKS.taskCommand(PE.parseFlags(['claim', A]));
  check('① CLI 重复认领 → 信封 ok=false + code=DUPLICATE_REQUEST', cliAgain.envelope.ok === false && cliAgain.envelope.code === 'DUPLICATE_REQUEST', cliAgain.envelope.code);
  check('① CLI 重复认领没有副作用 (claims 仍 1 条, paid=false)', TB.readAnnouncement(A, HOME).claims.length === 1 && (cliAgain.envelope.data as any).paid === false);
}
{
  const ghost = 'ann-00000000000000ff';
  const r = await TB.claimAnnouncement(ghost, { providerDid: provider.did });
  check('② 认领不存在的 id → 拒 (not_found, 本地+注册表都查过)', r.ok === false && r.reason === 'not_found', r.message);
  const cliR = await TASKS.taskCommand(PE.parseFlags(['claim', ghost]));
  check('② CLI → 信封 ok=false + code=NOT_FOUND', cliR.envelope.ok === false && cliR.envelope.code === 'NOT_FOUND', cliR.envelope.code);
  check('② 不存在的 id 不会凭空建出公告文件', !fs.existsSync(path.join(TB.boardDir(HOME), `${ghost}.json`)));
  const bad = await TB.claimAnnouncement('../../etc/passwd', { providerDid: provider.did });
  check('② 非法 id (路径穿越) → 拒 (invalid_id)', bad.ok === false && bad.reason === 'invalid_id', bad.reason);
}
{
  const r = await TB.claimAnnouncement(CX, { providerDid: provider.did });
  check('③ 已取消的公告 → 拒 (cancelled)', r.ok === false && r.reason === 'cancelled', r.message);
  check('③ 已认领的公告不许被取消 (取消走真代码, 并且被拒)', (await TB.cancelAnnouncement(A, '试试')).ok === false);
  const cliR = await TASKS.taskCommand(PE.parseFlags(['claim', CX]));
  check('③ CLI → code=TASK_CANCELLED', cliR.envelope.ok === false && cliR.envelope.code === 'TASK_CANCELLED', cliR.envelope.code);
}
{
  const r = await TB.claimAnnouncement(NS, { providerDid: provider.did });
  check('④ 未签名的公告 → 拒 (signature_invalid)', r.ok === false && r.reason === 'signature_invalid', r.message);
  check('④ 未签名公告在板上如实标 signatureVerified=false (可接单=false 的诚实标注)', (await TB.listBoard({ home: HOME, registry, now: Date.now() })).entries.find((e: any) => e.announcementId === NS)?.signatureVerified === false);
  const cliR = await TASKS.taskCommand(PE.parseFlags(['claim', NS]));
  check('④ CLI → code=SIGNATURE_INVALID', cliR.envelope.ok === false && cliR.envelope.code === 'SIGNATURE_INVALID', cliR.envelope.code);
}
{
  const r = await TB.claimAnnouncement(TP, { providerDid: provider.did });
  check('⑤ 正文被改过的公告 → 拒 (instruction_digest_mismatch)', r.ok === false && r.reason === 'instruction_digest_mismatch', r.message);
  check('⑤ 被改过的公告没被认领 (状态仍 open, claims 空)', TB.readAnnouncement(TP, HOME).status === 'open' && TB.readAnnouncement(TP, HOME).claims.length === 0);
}
{
  const r = await TB.claimAnnouncement(EX, { providerDid: provider.did });
  check('⑥ 已过期的公告 → 拒 (deadline_expired)', r.ok === false && r.reason === 'deadline_expired', r.message);
  const cliR = await TASKS.taskCommand(PE.parseFlags(['claim', EX]));
  check('⑥ CLI → code=DEADLINE_EXPIRED', cliR.envelope.ok === false && cliR.envelope.code === 'DEADLINE_EXPIRED', cliR.envelope.code);
}
{
  const noArgs = await TASKS.taskCommand(PE.parseFlags(['claim']));
  check('⑦ 缺 announcementId → 参数错 (INVALID_ARGUMENT, 不猜一条来认领)', noArgs.envelope.ok === false && noArgs.envelope.code === 'INVALID_ARGUMENT');
  const before = TB.listAnnouncements(HOME).reduce((n: number, a: any) => n + a.claims.length, 0);
  const cliAgainRemote = await TASKS.taskCommand(PE.parseFlags(['claim', pubRemote.announcement!.announcementId]));
  check('⑦ 远端公告重复认领 → 也被拒 (幂等), 本地认领账本没加第二条', cliAgainRemote.envelope.ok === false && TB.readRemoteClaims(HOME).filter((c: any) => c.announcementId === pubRemote.announcement!.announcementId).length === 1);
  check('⑦ 所有拒绝路径都没有增加任何认领 (本地 claims 总数不变)', TB.listAnnouncements(HOME).reduce((n: number, a: any) => n + a.claims.length, 0) === before, { before });
}

// ── [5] 释放 / 验真裁决 ─────────────────────────────────────────────────────
section('[5] 裁决: 未交付不得释放 · 未结算不得标 verified (本层一分钱都不动)');
const TX = `0x${'ab'.repeat(32)}`;
const decisions: Array<[string, any]> = [
  ['未认领 (status=open)', TB.decideAnnouncementRelease({ announcementId: A, status: 'open', delivery: { delivered: true }, paymentMode: 'facilitator', chainSettled: true, txHash: TX })],
  ['**未交付** (status=claimed, delivered=false)', TB.decideAnnouncementRelease({ announcementId: A, status: 'claimed', delivery: { delivered: false, contentHash: null }, paymentMode: 'facilitator', chainSettled: true, txHash: TX })],
  ['交付了但**未链上结算** (chainSettled=false)', TB.decideAnnouncementRelease({ announcementId: A, status: 'claimed', delivery: { delivered: true, contentHash: 'h' }, paymentMode: 'facilitator', chainSettled: false, txHash: null })],
  ['交付了但**没有 txHash** (拿不到链上事实)', TB.decideAnnouncementRelease({ announcementId: A, status: 'claimed', delivery: { delivered: true, contentHash: 'h' }, paymentMode: 'facilitator', chainSettled: true, txHash: null })],
  ['local-dev "结算" + 已交付 (红线: 永远不是链上结算)', TB.decideAnnouncementRelease({ announcementId: A, status: 'claimed', delivery: { delivered: true, contentHash: 'h' }, paymentMode: 'local-dev', chainSettled: true, txHash: TX })],
  ['争议中 (delivered=true 也不放)', TB.decideAnnouncementRelease({ announcementId: A, status: 'claimed', delivery: { delivered: true, contentHash: 'h' }, disputeOpen: true, paymentMode: 'facilitator', chainSettled: true, txHash: TX })],
];
check('未交付 → refuse/NOT_DELIVERED 且不许标 verified', decisions[1][1].action === 'refuse' && decisions[1][1].code === 'NOT_DELIVERED' && decisions[1][1].canMarkVerified === false, decisions[1][1]);
check('未链上结算 → refuse/NOT_CHAIN_SETTLED 且不许标 verified', decisions[2][1].action === 'refuse' && decisions[2][1].code === 'NOT_CHAIN_SETTLED' && decisions[2][1].canMarkVerified === false, decisions[2][1]);
check('缺 txHash → 也算未结算 (拿不到事实不许标 verified)', decisions[3][1].code === 'NOT_CHAIN_SETTLED' && decisions[3][1].canMarkVerified === false);
check('local-dev → refuse/LOCAL_DEV_NOT_CHAIN (红线: local-dev 永不算链上)', decisions[4][1].code === 'LOCAL_DEV_NOT_CHAIN' && decisions[4][1].canMarkVerified === false);
check('未认领 → refuse/NOT_CLAIMED', decisions[0][1].code === 'NOT_CLAIMED');
check('争议中 → refuse/DISPUTE_OPEN 且 mustNotRepay=true (不自动重付/不标 verified/不静默关闭)', decisions[5][1].code === 'DISPUTE_OPEN' && decisions[5][1].mustNotRepay === true);
{
  const ok = TB.decideAnnouncementRelease({ announcementId: A, status: 'claimed', delivery: { delivered: true, contentHash: 'h', resultVerified: true }, paymentMode: 'facilitator', chainSettled: true, txHash: TX });
  check('正例: 已认领 + 已交付 + 链上结算齐 → release 且 canMarkVerified=true', ok.action === 'release' && ok.code === 'RELEASE_OK' && ok.canMarkVerified === true, ok);
  check('正例里也没动钱 (本层只出裁决, 真发交易不在这里)', ok.fundsMoved === false);
  const already = TB.decideAnnouncementRelease({ announcementId: A, status: 'claimed', delivery: { delivered: true, contentHash: 'h' }, paymentMode: 'facilitator', chainSettled: true, txHash: TX, alreadyReleased: true });
  check('已释放 → refuse/ALREADY_RELEASED + mustNotRepay (幂等, 不重复付款)', already.action === 'refuse' && already.code === 'ALREADY_RELEASED' && already.mustNotRepay === true);
  check('每条裁决都带证据行 (可回放)', decisions.every(([, d]) => Array.isArray(d.evidence) && d.evidence.length >= 6) && ok.evidence.length >= 6);
  check('所有裁决路径 fundsMoved 都是 false (本模块永不发文/不转账)', [...decisions.map(([, d]) => d), ok, already].every((d) => d.fundsMoved === false));
}
{
  // 与真实认领事实接上: A 已被认领, 但 provider 还没交付 → 不能释放
  const cur = TB.readAnnouncement(A, HOME);
  const d = TB.decideAnnouncementRelease({ announcementId: A, status: cur.status, delivery: { delivered: false }, paymentMode: 'policy', chainSettled: false, txHash: null });
  check('真实事实接进来: A 已认领但未交付 → 不能释放 (钱不动)', d.action === 'refuse' && d.code === 'NOT_DELIVERED', d.code);
}

// ── [6] task send 的可操作提示 ──────────────────────────────────────────────
section('[6] task send: 没有 provider 但有匹配公告 → 提示 board/claim (否则不伪造提示)');
{
  const cli = await TASKS.taskCommand(PE.parseFlags(['send', '--capability', REMOTE_CAP, '--instruction', '调研某类厨房用品的日本市场 (中性夹具)']));
  const d = cli.envelope.data as any;
  check('没有 provider → 仍然是失败信封 (没有假装发出去)', cli.envelope.ok === false, cli.envelope.code);
  check('code 仍然是"没找到目标"类 (CAPABILITY_NOT_FOUND / NETWORK_NOT_JOINED, 语义没被改)',
    cli.envelope.code === 'CAPABILITY_NOT_FOUND' || cli.envelope.code === 'NETWORK_NOT_JOINED', cli.envelope.code);
  check('板上有匹配公告时**给出可操作提示** (指向 board/claim)',
    typeof d.board?.hint === 'string' && d.board.hint.includes('bolloon task board') && d.board.hint.includes('bolloon task claim'), d.board?.hint);
  check('提示里带具体公告 id + 条数', d.board?.count >= 1 && String(d.board.hint).includes(d.board.announcements[0]?.announcementId), d.board?.announcements?.[0]);
  check('人类可读输出里也有这句提示', cli.human.includes('task board') && cli.human.includes('task claim'), cli.human.slice(0, 240));
  check('send 仍然不付款 (paid/fundsMoved 语义没被改)', d.paid === undefined || d.paid === false, d);
}
{
  const cli = await TASKS.taskCommand(PE.parseFlags(['send', '--capability', 'no-such-capability-xyz', '--instruction', '调研某类厨房用品的日本市场 (负控制)']));
  const d = cli.envelope.data as any;
  check('板上**没有**匹配公告 → 不伪造提示 (count=0, hint=null)', cli.envelope.ok === false && d.board?.count === 0 && d.board?.hint === null, d.board);
  check('板上没有匹配公告时不提 claim (不说假话)', !String(cli.envelope.message).includes('task claim'), cli.envelope.message);
}

// ── [7] 显式 skipped (不冒充验过) ───────────────────────────────────────────
section('[7] 显式 skipped: 需要外部条件, 本脚本**没有**验过');
skip('真跨机远端公告同步 (两台机器经 gateway merge 拿到对方公告)', '需要第二个真实节点 + gateway 同步; 本脚本用同一台机器的注册表条目模拟远端公告形状');
skip('真链上释放交易 (AgentEscrow submitProof/release)', '本层只出裁决不出交易; 真发交易属 chain 命令组 (另一条并行线), 本脚本未接');
skip('远端认领投递给买方 (让对方的公告变成 accepted)', '本版**没有**该通道 (claim 的返回值里如实标 deliveredToBuyer=false); 真交接走 task send → 对方 task accept');
skip('公告到期自动清理 / 多轮竞价 (多个 provider 抢一条)', '本版语义是"一条公告只被认领一次"; 竞价与清理未做');

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n=== 结果: ${passed} passed, ${failed} failed, ${skipped.length} skipped ===`);
console.log(`公告板: publish(落盘+注册表+脉冲) → board(本地+远端去重) → claim(DID/时间/价格, 重复/不存在/已取消一律拒)`);
console.log(`裁决纪律: 未交付不得释放 · 未结算不得标 verified · local-dev 永不算链上 · 本模块一分钱都不动`);
console.log(`未覆盖(见 [7]): 真跨机同步 · 真链上释放交易 · 远端认领投递 · 到期清理/竞价`);
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
