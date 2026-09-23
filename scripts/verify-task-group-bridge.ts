/**
 * verify-task-group-bridge.ts — C7 群聊通道验收 (真跑, 不是读代码)
 *
 * 对着「任务的发布/接单/交付/初筛/终审在群聊里留痕, 且不把私有内容塞进群」逐条真跑:
 *   [0] 前置事实: 隔离 HOME + 真身份 + **真 OrbitDB 群** (createGroup 真起 store) + 板上真公告
 *   [1] 缺 --group → announce/trail/post 三条**都拒绝执行** (不静默降级为本地落盘)
 *   [2] 群链接非法 / 群不存在 → 拒绝执行并给原因 (也不发生任何本地写入)
 *   [3] 公告真发进群 → groupMessages 真读回 → 正则断言**不含**钱包地址/DID/peerId/multiaddr/IP;
 *       且只有极短事实 (期号/capability/预算/公告 id), 任务正文与预览**没有**进群
 *   [4] trail 时间线: 跨消息聚合 (公告/接单/交付/初筛/终审 5 条), 按时间升序, 每条带时间 + 发送者标记;
 *       --announcement-id 过滤正确; 别人的无关消息只计入 ignoredMessages
 *   [5] **未交付不得出现"已交付"条目**: 只发公告 + 终审 accept 的那条 → delivered=false +
 *       显式矛盾 `final-accept-without-delivery` (不靠"没发过"侥幸, 而是显式判)
 *   [6] 负控制 (读路径): 别人绕过本模块往群里发带钱包地址/DID 的消息 → trail 遮蔽 + 记账, stdout 里不出现标识符
 *   [7] 负控制 (发送闸): 逐条隐私规则真拦 (钱包/DID/peerId/multiaddr/IP/私钥/PEM/URL/邮箱); 中性事实放行
 *   [8] 负控制 (字段闸): 交付哈希只收内容哈希形状 (钱包地址 / 0x 私钥 / CIDv0 一律拒)
 *   [9] claim --group: 群非法 → 认领**根本没发生** (盘上 claims 仍 0); 群正常 → 认领发生 + 群里出现接单声明
 *   [10] 群 store 不可达 → 明确失败 (TRANSPORT_FAILED) 且**没有**落任何本地副本
 *   [11] 显式 skipped (需要外部条件, 本脚本没验过)
 *
 * 用法: npx tsx scripts/verify-task-group-bridge.ts    退出码 0=全绿, 1=有红, 2=前置事实拿不到
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REAL_HOME = os.homedir();          // 必须在覆盖 HOME 之前取
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-grp-bridge-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_SETUP = '1';

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
makeSetupReady(path.join(HOME, '.bolloon'), { realHome: REAL_HOME, name: 'C7 群聊通道验收' });

const { KeyManager } = await import('@diap/sdk') as any;
{
  const kp = (KeyManager as any).generate();
  await (KeyManager as any).saveToFile(kp, path.join(HOME, '.bolloon', 'identity.json'));
}

const GG: any = await import('../src/agents/gateway-group.js');
const TG: any = await import('../src/agents/task-group.js');
const TB: any = await import('../src/agents/task-board.js');
const PE: any = await import('../src/cli/protocol-envelope.js');
const TASKS: any = await import('../src/cli/commands/tasks.js');
const LS: any = await import('../src/agents/local-signer.js');

let passed = 0, failed = 0;
const skipped: string[] = [];
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    const d = detail !== undefined ? ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}` : '';
    failures.push(`${name}${d}`);
    console.log(`  ❌ ${name}${d}`);
  }
};
const skip = (name: string, why: string) => { skipped.push(name); console.log(`  ⏭ ${name} — ${why}`); };
const section = (t: string) => console.log(`\n${t}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cli = (args: string[]) => TASKS.taskCommand(PE.parseFlags(args));

// 夹具 (全部中性; 无真实客户/研究内容)
const CAP = 'market-research-jp';
const BODY_TAIL = 'BODY-TAIL-ONLY-LOCAL';   // 只应存在于本地公告文件, 群里不许有
const INSTRUCTION = `调研某类厨房用品的日本市场: 渠道结构 / 价格带 / 合规门槛 / 竞品定价 / 进入节奏建议 (中性夹具; 尾部标记 ${BODY_TAIL})`;
const WALLET = `0x${'11'.repeat(20)}`;        // 形状合法但明显是夹具的钱包地址
const FAKE_DID = 'did:diap:fixture000000000000000000000000000000';
const FAKE_KEY = `0x${'ab'.repeat(32)}`;      // 私钥形状夹具
const NOW = Date.now();

// ── [0] 前置事实 (拿不到就拒跑, 不静默通过) ──────────────────────────────────
section('[0] 前置事实: 隔离 HOME · 真身份 · 真群 · 板上真公告');
const signer = await LS.loadLocalSigner(HOME);
if (!signer?.did) {
  console.error('  ✗ 隔离 HOME 里没有可签名身份 (identity.json) —— 拒绝继续跑 (不用假身份冒充)');
  process.exit(2);
}
const createdGroup = await GG.createGroup('C7-验收群', { from: '验收夹具', hello: '群已建 (中性夹具)' });
if (!createdGroup.ok || !createdGroup.group) {
  console.error(`  ✗ 真 OrbitDB 群建不起来: ${createdGroup.error || '未知'} —— 拒绝继续跑 (不用假 store 冒充真群)`);
  process.exit(2);
}
const GROUP = createdGroup.group;
const LINK = GROUP.link;
check('真群已建 (OrbitDB, 链接含 type=group)', /type=group/.test(LINK), LINK.slice(0, 40));
check('群已在本地群列表里 (listGroups 查得到)', (await GG.listGroups()).some((g: any) => g.id === GROUP.id));
check('身份可加载 (did 非空)', !!signer.did);

const pub = await TB.publishAnnouncement({
  capability: CAP, instruction: INSTRUCTION,
  buyerDid: signer.did, buyerPublicKeyHex: signer.publicKeyHex,
  budget: { maxAmount: '50000', currency: 'USDC', network: 'base-sepolia' },
  deadline: NOW + 24 * 3600_000, paymentMode: 'policy', signerKeypair: signer.keypair,
}, { home: HOME, offline: true });
const AID = pub.announcement?.announcementId || '';
check('板上真公告已就位 (真签名 + 真落盘)', pub.ok === true && /^ann-/.test(AID) && !!pub.signed, { AID, err: pub.error });

// ── [1] 缺 --group: 三条命令都拒跑 ───────────────────────────────────────────
section('[1] 缺 --group → 拒绝执行 (不许静默降级为本地落盘)');
{
  const a = await cli(['announce', '--announcement-id', AID]);
  check('① announce 缺 --group → ok=false + INVALID_ARGUMENT', a.envelope.ok === false && a.envelope.code === 'INVALID_ARGUMENT', a.envelope.code);
  check('① 拒绝时明说"不降级为本地落盘"', String((a.envelope.data as any).why || '').includes('只写本地') && (a.envelope.data as any).localFallback === false, (a.envelope.data as any).why);
  const t = await cli(['trail']);
  check('① trail 缺 --group → ok=false + INVALID_ARGUMENT', t.envelope.ok === false && t.envelope.code === 'INVALID_ARGUMENT', t.envelope.code);
  const p = await cli(['post', '--kind', 'deliver', '--announcement-id', AID, '--hash', `sha256:${'cd'.repeat(32)}`]);
  check('① post 缺 --group → ok=false + INVALID_ARGUMENT', p.envelope.ok === false && p.envelope.code === 'INVALID_ARGUMENT', p.envelope.code);
  const msgs = await GG.groupMessages(GROUP.id, 50);
  check('① 三条被拒的命令**一条群消息都没发出去**', msgs.filter((m: any) => String(m.text).includes(TG.TRAIL_TAG)).length === 0, msgs.length);
}

// ── [2] 群链接非法 / 群不存在 ───────────────────────────────────────────────
section('[2] 群链接非法 / 群不存在 → 拒绝执行并给原因');
{
  const bad1 = await cli(['announce', '--announcement-id', AID, '--group', 'http://127.0.0.1:9999/nope']);
  check('② 非群链接 (http) → INVALID_ARGUMENT', bad1.envelope.ok === false && bad1.envelope.code === 'INVALID_ARGUMENT', bad1.envelope.code);
  const bad2 = await cli(['announce', '--announcement-id', AID, '--group', 'orbitdb:///orbitdb/zdpuFixtureNoType']);
  check('② orbitdb 链接但缺 type=group → INVALID_ARGUMENT', bad2.envelope.ok === false && bad2.envelope.code === 'INVALID_ARGUMENT', bad2.envelope.message);
  const bad3 = await cli(['announce', '--announcement-id', AID, '--group', 'orbitdb:///orbitdb/zdpuSomeoneElse?type=group&name=nope']);
  check('② 本机没加入的群 → NETWORK_NOT_JOINED (不替人静默入群)', bad3.envelope.ok === false && bad3.envelope.code === 'NETWORK_NOT_JOINED', bad3.envelope.code);
  check('② 拒绝时列出本机已加入的群 (可操作)', Array.isArray((bad3.envelope.data as any).joined) && (bad3.envelope.data as any).joined.length >= 1, (bad3.envelope.data as any).joined);
  const bad4 = await cli(['trail', '--group', 'ann-00000000000000ff']);
  check('② 不认识的 groupId → NOT_FOUND', bad4.envelope.ok === false && bad4.envelope.code === 'NOT_FOUND', bad4.envelope.code);
  const msgs = await GG.groupMessages(GROUP.id, 50);
  check('② 所有被拒路径都没发消息', msgs.filter((m: any) => String(m.text).includes(TG.TRAIL_TAG)).length === 0);
}

// ── [3] 公告真进群 + 真读回 + 隐私正则断言 ──────────────────────────────────
section('[3] announce: 公告真发进群 → groupMessages 真读回 → 不含地址/DID/peerId/multiaddr/IP');
const announceRun = await cli(['announce', '--group', LINK, '--announcement-id', AID, '--round', '1', '--criteria', '渠道结构/价格带/合规门槛三条判据可判决', '--json']);
check('③ announce 成功 (真发进群, sent=true)', announceRun.envelope.ok === true && (announceRun.envelope.data as any).sent !== false, { code: announceRun.envelope.code, msg: announceRun.envelope.message });
const sentText = String((announceRun.envelope.data as any).message || '');
{
  const groupMsgs = await GG.groupMessages(GROUP.id, 50);
  const mine = groupMsgs.filter((m: any) => String(m.text).includes(TG.TRAIL_TAG));
  check('③ 群消息真读得回 (groupMessages 里有这条公告)', mine.length === 1, { total: groupMsgs.length, mine: mine.length });
  const raw = JSON.stringify(groupMsgs);
  check('③ 群消息里**没有钱包地址** (0x[0-9a-f]{40})', !/0x[0-9a-fA-F]{40}/.test(raw));
  check('③ 群消息里**没有 DID** (did: 前缀)', !/\bdid:[a-z0-9]+:/i.test(raw));
  check('③ 群消息里**没有 peerId** (12D3Koo…/Qm…)', !/12D3Koo|Qm[1-9A-HJ-NP-Za-km-z]{30,}/.test(raw));
  check('③ 群消息里**没有 multiaddr** (/ip4 /tcp /p2p /orbitdb 地址形态)', !/(^|[\s"'=,[])\/(ip4|ip6|tcp|udp|ws|p2p|p2p-circuit|ipfs|orbitdb)\b/im.test(raw.replace(TG.TRAIL_TAG, '')));
  check('③ 群消息里**没有 IPv4/IPv6**', !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(raw));
  check('③ 群消息里**没有私钥/PEM 形态**', !/0x[0-9a-fA-F]{64}|-----BEGIN/.test(raw));
  check('③ 群消息里**没有群链接原文** (orbitdb://)', !/orbitdb:\/\//i.test(raw));
  check('③ 发送者标记是短假名 (不是 DID)', mine.every((m: any) => /^agent-[0-9a-f]{8}$/.test(String(m.from))), mine.map((m: any) => m.from));
}
{
  const d = announceRun.envelope.data as any;
  check('③ 极短事实齐: 期号 / capability / 预算 / 判据摘要 / 公告 id',
    sentText.includes('round=1') && sentText.includes(`cap=${CAP}`) && sentText.includes('budget=50000USDC@base-sepolia')
    && sentText.includes('judge=') && sentText.includes(`id=${AID}`), sentText);
  check('③ 任务正文 (含尾部标记) **没有**进群', !sentText.includes(BODY_TAIL) && !JSON.stringify(d).includes(BODY_TAIL), sentText.slice(0, 120));
  check('③ 信封里也没有正文预览', !JSON.stringify(announceRun.envelope).includes(BODY_TAIL));
  check('③ 公告入群不动钱/不执行 (executed=false, paid=false)', d.executed === false && d.paid === false && d.fundsMoved === false);
  check('③ 发送者来源如实标注 (identity/flag, DID 未打印)', d.sender?.didPrinted === false && ['flag', 'identity'].includes(d.sender?.source), d.sender);
}

// ── [4] trail: 跨消息聚合 + 排序 + 过滤 ─────────────────────────────────────
section('[4] trail: 过程留痕跨消息聚合 (公告/接单/交付/初筛/终审) 按时间线');
const HASH = `sha256:${'cd'.repeat(32)}`;
{
  const claim = await cli(['claim', AID, '--price', '0.02', '--group', LINK]);
  check('④ 接单痕迹必须对应一笔真认领账 (task claim --group, 不是 post --kind claim)', claim.envelope.ok === true, claim.envelope.code);
  check('④ post --kind claim 被拒 + 指路 task claim (群里不出现没认领者的接单声明)', (await cli(['post', '--kind', 'claim', '--group', LINK, '--announcement-id', AID])).envelope.code === 'INVALID_ARGUMENT');
  await sleep(6);
  const deliver = await cli(['post', '--kind', 'deliver', '--group', LINK, '--announcement-id', AID, '--hash', HASH, '--bytes', '5120']);
  await sleep(6);
  const screen = await cli(['post', '--kind', 'screen', '--group', LINK, '--announcement-id', AID, '--checks', '渠道结构=pass,价格带=pass,合规门槛=fail']);
  await sleep(6);
  const final = await cli(['post', '--kind', 'final', '--group', LINK, '--announcement-id', AID, '--verdict', 'reject']);
  check('④ 四条过程痕迹都真发进群', [claim, deliver, screen, final].every((r: any) => r.envelope.ok === true), [claim, deliver, screen, final].map((r: any) => r.envelope.code));
  check('④ 交付痕迹只贴哈希 (信封里没别的交付内容)', String((deliver.envelope.data as any).message).includes(HASH) && (deliver.envelope.data as any).paid === false && (deliver.envelope.data as any).executed === false, (deliver.envelope.data as any).message);
  check('④ 初筛逐条结果在消息里 (3 条: 2 pass 1 fail)', /screened=3/.test(String((screen.envelope.data as any).message)) && /pass=2/.test(String((screen.envelope.data as any).message)) && /fail=1/.test(String((screen.envelope.data as any).message)), (screen.envelope.data as any).message);
  check('④ 初筛逐条明细随信封返回 (不是只给总数)', Array.isArray((screen.envelope.data as any).checks) && (screen.envelope.data as any).checks.length === 3, (screen.envelope.data as any).checks);
  check('④ 初筛不冒充验收 (verified 恒 false)', (screen.envelope.data as any).verified === false);
}
{
  const t = await cli(['trail', '--group', LINK, '--json']);
  const d = t.envelope.data as any;
  check('④ trail 成功且条目数 = 5 (公告/接单/交付/初筛/终审)', t.envelope.ok === true && d.count === 5, { count: d.count, byKind: d.byKind });
  check('④ byKind 逐类计数正确', d.byKind.announce === 1 && d.byKind.claim === 1 && d.byKind.deliver === 1 && d.byKind.screen === 1 && d.byKind.final === 1, d.byKind);
  const tl = d.timeline as any[];
  check('④ 时间线按时间升序 (跨消息聚合, 不是各自为政)', tl.every((e, i) => i === 0 || e.at >= tl[i - 1].at), tl.map((e) => e.at));
  check('④ 每条都带时间 + 发送者标记', tl.every((e) => typeof e.at === 'number' && e.at > 0 && /^agent-[0-9a-f]{8}$/.test(String(e.sender))), tl.map((e) => [e.at, e.sender]));
  check('④ 时间线里 5 种 kind 齐 (公告→接单→交付→初筛→终审 都在)', ['announce', 'claim', 'deliver', 'screen', 'final'].every((k) => tl.some((e) => e.kind === k)), tl.map((e) => e.kind));
  check('④ 终审结论如实 (reject)', d.flags.rejected === true && d.flags.accepted === false, d.flags);
  check('④ 交付后没有事实矛盾', Array.isArray(d.inconsistencies) && d.inconsistencies.length === 0, d.inconsistencies);
  check('④ 群链接/地址/DID 都不出现在 trail 输出里', !/0x[0-9a-fA-F]{40}/.test(JSON.stringify(t.envelope)) && !/orbitdb:\/\//i.test(JSON.stringify(t.envelope)) && !/\bdid:[a-z0-9]+:/i.test(JSON.stringify(t.envelope)));
  const filtered = await cli(['trail', '--group', LINK, '--announcement-id', AID, '--json']);
  check('④ --announcement-id 过滤生效 (只留本期)', (filtered.envelope.data as any).count === 5 && (filtered.envelope.data as any).announcements.length === 1, (filtered.envelope.data as any).count);
  const other = await cli(['trail', '--group', LINK, '--announcement-id', 'ann-00000000000000ff', '--json']);
  check('④ 过滤到不存在的公告 → 0 条 (不伪造)', (other.envelope.data as any).count === 0);
  const badLimit = await cli(['trail', '--group', LINK, '--limit', '0']);
  check('④ --limit 非法 → INVALID_ARGUMENT', badLimit.envelope.ok === false && badLimit.envelope.code === 'INVALID_ARGUMENT', badLimit.envelope.code);
}

// ── [5] 未交付不得出现"已交付" ───────────────────────────────────────────────
section('[5] 未交付不得出现"已交付"条目 (终审 accept 也不能把它变出来)');
const pub2 = await TB.publishAnnouncement({
  capability: 'kitchenware-market-scan', instruction: `另一个中性夹具公告 (未交付) 尾部标记 ${BODY_TAIL}`,
  buyerDid: signer.did, buyerPublicKeyHex: signer.publicKeyHex,
  budget: { maxAmount: '30000', currency: 'USDC', network: 'base-sepolia' },
  deadline: NOW + 3600_000, paymentMode: 'policy', signerKeypair: signer.keypair,
}, { home: HOME, offline: true });
const AID2 = pub2.announcement?.announcementId || '';
{
  await cli(['announce', '--group', LINK, '--announcement-id', AID2, '--round', '2']);
  await sleep(6);
  const fin = await cli(['post', '--kind', 'final', '--group', LINK, '--announcement-id', AID2, '--verdict', 'accept']);
  check('⑤ 该公告只发了 公告 + 终审 accept (没有交付痕迹)', fin.envelope.ok === true);
  const t = await cli(['trail', '--group', LINK, '--announcement-id', AID2, '--json']);
  const d = t.envelope.data as any;
  check('⑤ 时间线里**没有** deliver 条目 (没交付就不会凭空出现)', d.timeline.every((e: any) => e.kind !== 'deliver'), d.timeline.map((e: any) => e.kind));
  check('⑤ flags.delivered === false (没交付就是没交付)', d.flags.delivered === false && d.flags.finalized === true, d.flags);
  check('⑤ 显式标出矛盾 final-accept-without-delivery', Array.isArray(d.inconsistencies) && d.inconsistencies.includes('final-accept-without-delivery'), d.inconsistencies);
  check('⑤ 人类输出里也标了矛盾 (不是只藏在 JSON)', String((await cli(['trail', '--group', LINK, '--announcement-id', AID2])).human).includes('final-accept-without-delivery'));
  check('⑤ byKind.deliver === 0 (计数也不撒谎)', d.byKind.deliver === 0, d.byKind);
}

// ── [6] 负控制 (读路径): 别人绕过闸发的消息不许被回显 ────────────────────────
section('[6] 负控制: 别人绕过本模块发的带标识符消息 → trail 遮蔽, 不回显');
{
  const wild = `${TG.TRAIL_TAG} v=1 kind=deliver id=did:diap:naive00000000000000000000000000000000 hash=${WALLET}`;
  const s = await GG.groupSend(GROUP.id, wild, FAKE_DID);
  check('⑥ 夹具已就位 (绕过闸直接 groupSend 成功)', s.ok === true, s.error);
  const t = await cli(['trail', '--group', LINK, '--json']);
  const d = t.envelope.data as any;
  const out = JSON.stringify(t.envelope);
  check('⑥ trail 里**没有**钱包地址原文', !out.includes(WALLET));
  check('⑥ trail 里**没有** DID 原文', !out.includes(FAKE_DID) && !/\bdid:[a-z0-9]+:/i.test(out.replace(/"didPrinted":false/g, '')));
  check('⑥ 发送者被遮蔽成 #<8位> (不是 DID)', d.timeline.some((e: any) => /^#[0-9a-f]{8}$/.test(String(e.sender))), d.timeline.map((e: any) => e.sender));
  check('⑥ 命中的字段被标为已遮蔽', JSON.stringify(d.timeline).includes('[已遮蔽:'), d.redacted);
  check('⑥ 遮蔽被如实记账 (redacted + 矛盾标记)', Array.isArray(d.redacted) && d.redacted.length >= 1 && d.inconsistencies.includes('group-message-hit-privacy-rule'), { redacted: d.redacted, inc: d.inconsistencies });
  check('⑥ 遮蔽条目不产生假公告引用 (id 被遮蔽 → 不列进 announcements)', !d.announcements.includes('did:diap:naive00000000000000000000000000000000'), d.announcements);
}

// ── [7] 负控制 (发送闸): 逐条隐私规则真拦 ───────────────────────────────────
section('[7] 负控制: 发送闸逐条真拦 (含中性事实放行)');
{
  const cases: Array<[string, string]> = [
    ['wallet-address', `${TG.TRAIL_TAG} v=1 kind=deliver id=${AID} hash=${WALLET}`],
    ['did', `${TG.TRAIL_TAG} v=1 kind=claim id=${AID} who=${FAKE_DID}`],
    ['peer-id', `${TG.TRAIL_TAG} v=1 kind=claim id=${AID} peer=12D3KooWFixturePeerId000000000000000000000000`],
    ['multiaddr', `${TG.TRAIL_TAG} v=1 kind=claim id=${AID} addr=/ip4/127.0.0.1/tcp/4001`],
    ['ipv4', `${TG.TRAIL_TAG} v=1 kind=claim id=${AID} at=192.168.1.10`],
    ['private-key-hex', `${TG.TRAIL_TAG} v=1 kind=claim id=${AID} k=${FAKE_KEY}`],
    ['pem', `${TG.TRAIL_TAG} v=1 kind=claim id=${AID} x=-----BEGIN PRIVATE KEY-----`],
    ['url', `${TG.TRAIL_TAG} v=1 kind=claim id=${AID} ref=https://example.invalid/spec`],
    ['email', `${TG.TRAIL_TAG} v=1 kind=claim id=${AID} contact=buyer@example.invalid`],
    ['orbitdb-link', `${TG.TRAIL_TAG} v=1 kind=claim id=${AID} g=${LINK}`],
  ];
  const before = (await GG.groupMessages(GROUP.id, 200)).length;
  for (const [rule, text] of cases) {
    const r = await TG.sendTrailMessage(GROUP.id, text, 'agent-fixture');
    check(`⑦ ${rule} → 拒发 (sent=false, 命中的规则如实报出)`,
      r.ok === false && r.sent === false && (r.violations || []).some((v: any) => v.rule === rule), { err: r.error, rules: (r.violations || []).map((v: any) => v.rule) });
  }
  check('⑦ 中性事实放行 (极短事实无标识符 → 可以发)', (await TG.sendTrailMessage(GROUP.id, `${TG.TRAIL_TAG} v=1 kind=claim id=${AID} price=20000USDC`, 'agent-fixture')).ok === true);
  check('⑦ 被拒的 10 条**一条都没进群** (只有放行那条进了)', (await GG.groupMessages(GROUP.id, 200)).length === before + 1);
  {
    // 回归锁: 标识符"粘在 `_`/汉字后面"时也必须命中 (2026-09-23 真实漏过的形态: `\b` 在 `_` 旁边判不出来)
    const glued: Array<[string, string]> = [
      ['wallet-address', `judge=判据见_${WALLET}`],
      ['wallet-address', `judge=判据见${WALLET}`],
      ['did', `who_did:diap:fixture000000000000000000000000000000`],
      ['peer-id', `peer_12D3KooWFixturePeerId000000000000000000000000`],
      ['multiaddr', `addr_/ip4/127.0.0.1/tcp/4001`],
      ['ipv4', `at_192.168.1.10`],
      ['ipv6', `net_2001:db8:0:0:0:0:0:1`],
      ['ipv6', `net_fe80::1`],
      ['private-key-hex', `k_${FAKE_KEY}`],
    ];
    for (const [rule, text] of glued) {
      const v = TG.scanPublicText(text);
      check(`⑦(回归) 粘在 _/汉字后的 ${rule} 也被判出`, v.some((x: any) => x.rule === rule), { text: text.slice(0, 24), hit: v.map((x: any) => x.rule) });
      const s = await TG.sendTrailMessage(GROUP.id, `${TG.TRAIL_TAG} v=1 kind=announce id=${AID} ${text}`, 'agent-fixture');
      check(`⑦(回归) 粘在 _/汉字后的 ${rule} 被拒发`, s.ok === false && s.sent === false, s.error);
    }
    // 误拦控制: 我们自己真发过的公告消息 (带 ISO 时间戳 + sha256 摘要) 必须**过闸**
    check('⑦ 误拦控制: 本模块真发的公告消息不被隐私闸误杀', TG.scanPublicText(sentText).length === 0 && TG.scanPublicText(`${TG.TRAIL_TAG} v=1 kind=announce id=${AID} deadline=2026-09-24T09:50:12.345Z judge=unstated;sha256=abcdef0123456789`).length === 0,
      TG.scanPublicText(sentText).map((x: any) => x.rule));
    check('⑦ 误拦控制: 中文判据摘要 (含 `/`) 不被误杀', TG.scanPublicText(`${TG.TRAIL_TAG} v=1 kind=announce id=${AID} judge=渠道结构/价格带/合规门槛`).length === 0);
  }
  {
    const p = await cli(['announce', '--group', LINK, '--announcement-id', AID, '--criteria', `判据见 0x${'11'.repeat(20)}`]);
    check('⑦ CLI 侧: 判据摘要里塞钱包地址 → POLICY_DENIED (不发出去)', p.envelope.ok === false && p.envelope.code === 'POLICY_DENIED', { code: p.envelope.code, msg: p.envelope.message });
    const b = await cli(['announce', '--group', LINK, '--announcement-id', AID, '--from', FAKE_DID]);
    check('⑦ CLI 侧: --from 塞 DID → POLICY_DENIED (发送者标记不许是标识符)', b.envelope.ok === false && b.envelope.code === 'POLICY_DENIED', { code: b.envelope.code, msg: b.envelope.message });
    const j = await cli(['post', '--kind', 'screen', '--group', LINK, '--announcement-id', AID, '--checks', `渠道结构=pass,联系人=${FAKE_DID}`]);
    check('⑦ CLI 侧: 初筛逐条里塞 DID → 拒 (字段闸或隐私闸拦下, 两种都算拒)', j.envelope.ok === false && ['INVALID_ARGUMENT', 'POLICY_DENIED'].includes(j.envelope.code), { code: j.envelope.code, msg: j.envelope.message });
    const all = await GG.groupMessages(GROUP.id, 300);
    // 只查这三条尝试的**消息文本**: §6 故意塞进去的"野生消息"夹具 (含地址/DID, 发送者就是 FAKE_DID) 仍留在群里,
    // 那是读路径的负控制对象; 这里只看"我们被拒的尝试有没有漏进群"
    check('⑦ CLI 侧三条被拒的尝试: 群里**一条都没有** (判据/发送者标记/初筛夹带都没落地)',
      !all.some((m: any) => String(m.text).includes(FAKE_DID) || String(m.text).includes('判据见')),
      { offenders: all.filter((m: any) => String(m.text).includes(FAKE_DID) || String(m.text).includes('判据见')).map((m: any) => String(m.text).slice(0, 110)) });
  }
}

// ── [8] 负控制 (字段闸): 哈希只收内容哈希形状 ────────────────────────────────
section('[8] 负控制: 交付哈希闸 (地址/私钥/CIDv0 一律拒, 内容哈希放行)');
{
  const cases: Array<[string, string, boolean]> = [
    ['钱包地址', WALLET, false],
    ['0x 私钥', FAKE_KEY, false],
    ['CIDv0 (与 peerId 同形)', 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', false],
    ['随便一段文本', '交付报告', false],
    ['sha256 内容哈希', HASH, true],
    ['裸 hex 内容哈希', 'ef'.repeat(32), true],
    ['CIDv1', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', true],
  ];
  for (const [name, value, shouldPass] of cases) {
    const r = await cli(['post', '--kind', 'deliver', '--group', LINK, '--announcement-id', AID, '--hash', value]);
    const ok = r.envelope.ok === shouldPass;
    check(`⑧ ${name} → ${shouldPass ? '放行' : '拒'}`, ok, { code: r.envelope.code, msg: r.envelope.message });
  }
  const noChecks = await cli(['post', '--kind', 'screen', '--group', LINK, '--announcement-id', AID]);
  check('⑧ 初筛缺 --checks → INVALID_ARGUMENT (不假装有逐条结果)', noChecks.envelope.ok === false && noChecks.envelope.code === 'INVALID_ARGUMENT');
  const noBytes = await cli(['post', '--kind', 'deliver', '--group', LINK, '--announcement-id', AID, '--hash', HASH, '--json']);
  const noBytesText = String((noBytes.envelope.data as any).message || '');
  check('⑧ 交付没给 --bytes → 消息写 `bytes=-` (缺失不许变成 0 = 谎报零字节)', noBytes.envelope.ok === true && noBytesText.includes('bytes=-') && !noBytesText.includes('bytes=0'), noBytesText);
  const badVerdict = await cli(['post', '--kind', 'final', '--group', LINK, '--announcement-id', AID, '--verdict', 'looks-good']);
  check('⑧ 终审结论不在词表 → INVALID_ARGUMENT (不替你翻译成 accept)', badVerdict.envelope.ok === false && badVerdict.envelope.code === 'INVALID_ARGUMENT');
  const badKind = await cli(['post', '--kind', 'release', '--group', LINK, '--announcement-id', AID]);
  check('⑧ 群里没有"释放钱"这种痕迹 (--kind release → 拒)', badKind.envelope.ok === false && badKind.envelope.code === 'INVALID_ARGUMENT', badKind.envelope.message);
}

// ── [9] claim --group 桥接 ─────────────────────────────────────────────────
section('[9] claim --group: 群非法 → 认领不发生; 群正常 → 认领 + 群里留痕');
const pub3 = await TB.publishAnnouncement({
  capability: 'kitchenware-market-scan', instruction: `认单夹具公告 (会被接单) 尾部标记 ${BODY_TAIL}`,
  buyerDid: signer.did, buyerPublicKeyHex: signer.publicKeyHex,
  budget: { maxAmount: '30000', currency: 'USDC', network: 'base-sepolia' },
  deadline: NOW + 3600_000, paymentMode: 'policy', signerKeypair: signer.keypair,
}, { home: HOME, offline: true });
const AID3 = pub3.announcement?.announcementId || '';
{
  const bad = await cli(['claim', AID3, '--group', 'orbitdb:///orbitdb/zdpuNoTypeHere']);
  const onDisk = TB.readAnnouncement(AID3, HOME);
  check('⑨ 群非法 → 整条命令拒绝 (不"认领落本地 + 悄悄不发群")', bad.envelope.ok === false && bad.envelope.code === 'INVALID_ARGUMENT', bad.envelope.code);
  check('⑨ 认领**根本没发生** (盘上 status 仍 open, claims 0 条)', onDisk.status === 'open' && onDisk.claims.length === 0, { status: onDisk.status, claims: onDisk.claims.length });
  const msgBefore = (await GG.groupMessages(GROUP.id, 200)).filter((m: any) => String(m.text).includes(`kind=claim id=${AID3}`)).length;
  const good = await cli(['claim', AID3, '--price', '0.02', '--group', LINK]);
  const after = TB.readAnnouncement(AID3, HOME);
  check('⑨ 群正常 → 认领成功 (原语义不变)', good.envelope.ok === true && after.status === 'claimed' && after.claims.length === 1, { code: good.envelope.code, status: after.status });
  check('⑨ 群里真出现了这条接单声明', (await GG.groupMessages(GROUP.id, 200)).filter((m: any) => String(m.text).includes(`kind=claim id=${AID3}`)).length === msgBefore + 1);
  check('⑨ claim 信封里如实标了群消息状态 (posted=true)', (good.envelope.data as any).group?.posted === true && (good.envelope.data as any).group?.localFallback === false, (good.envelope.data as any).group);
  check('⑨ 接单声明里没有 DID (只有短假名 + 公告 id + 价)', !(await GG.groupMessages(GROUP.id, 200)).some((m: any) => String(m.text).includes(`kind=claim id=${AID3}`) && /\bdid:/i.test(String(m.text))));
  check('⑨ 接单仍然不执行/不付款 (原语义不变)', (good.envelope.data as any).executed === false && (good.envelope.data as any).paid === false && (good.envelope.data as any).verified === false);
  const dup = await cli(['claim', AID3, '--group', LINK]);
  check('⑨ 重复认领被拒 (幂等, 原语义不变)', dup.envelope.ok === false && dup.envelope.code === 'DUPLICATE_REQUEST', dup.envelope.code);
}

// ── [10] 群 store 不可达 → 明确失败, 不落本地副本 ────────────────────────────
section('[10] 群不可达 → TRANSPORT_FAILED, 且不落任何本地副本');
{
  const tasksDirBefore = fs.existsSync(path.join(HOME, '.bolloon', 'tasks'))
    ? fs.readdirSync(path.join(HOME, '.bolloon', 'tasks')).sort().join(',') : '';
  const before = (await GG.groupMessages(GROUP.id, 200)).length;
  GG.resetGroupState();
  GG.setGroupTestDb({
    save: async () => null, load: async () => null, update: async () => null, version: async () => [],
    list: async () => [], share: async () => '', openStore: async () => null,
    openStoreByAddress: async () => null, close: async () => {},
  });
  const r = await cli(['announce', '--group', LINK, '--announcement-id', AID]);
  check('⑩ 群 store 不可达 → ok=false + TRANSPORT_FAILED', r.envelope.ok === false && r.envelope.code === 'TRANSPORT_FAILED', { code: r.envelope.code, msg: r.envelope.message });
  check('⑩ 明说没有降级到本地 (localFallback=false, sent=false)', (r.envelope.data as any).localFallback === false && (r.envelope.data as any).sent === false);
  const tasksDirAfter = fs.existsSync(path.join(HOME, '.bolloon', 'tasks'))
    ? fs.readdirSync(path.join(HOME, '.bolloon', 'tasks')).sort().join(',') : '';
  check('⑩ 本机 tasks/ 目录没有多出任何"影子痕迹"目录', tasksDirBefore === tasksDirAfter, { before: tasksDirBefore, after: tasksDirAfter });
  GG.setGroupTestDb(null);
  GG.resetGroupState();
  check('⑩ 恢复真群后: 那条失败的消息**确实没进群** (不是"发出去了却说失败")', (await GG.groupMessages(GROUP.id, 200)).length === before);
  const back = await cli(['trail', '--group', LINK, '--json']);
  check('⑩ 恢复后 trail 仍能读回 (失败没有污染群状态)', back.envelope.ok === true && (back.envelope.data as any).count >= 5, (back.envelope.data as any).count);
}

// ── [11] 显式 skipped ───────────────────────────────────────────────────────
section('[11] 显式 skipped: 需要外部条件, 本脚本**没有**验过');
skip('两台机器经 OrbitDB 复制看到彼此的群消息', '需要第二个真实节点 + 真 P2P 复制; 本脚本是单机真群 store');
skip('群里多方 (多个 agent) 同时接单/交付的并发语义', '需要多个真实参与方; 群消息本身没有互斥语义 (一条公告只被认领一次的约束在公告板上)');
skip('终审结论触发链上 release (releaseV2)', '本层只发过程痕迹: 真发交易属 chain 命令组 (另一条并行线), 群里的话不替代链上结算');
skip('任务书/交付正文经群聊分发 (端到端加密私聊)', '本设计**刻意**不在群里放正文 (群是公开可读的 store); 正文交接仍走 task send/accept 的直连通道');

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n=== 结果: ${passed} passed, ${failed} failed, ${skipped.length} skipped ===`);
console.log('命令: bolloon task announce --group <链接> [--round …] [--criteria …] · bolloon task trail --group <链接> ·');
console.log('      bolloon task post --kind deliver|screen|final --group <链接> --announcement-id … · bolloon task claim <id> --group <链接>');
console.log('隐私红线: 群里只有短引用 (公告 id / 内容哈希 / capability / 预算 / 时间) + 发送者假名 agent-<8位>;');
console.log('          钱包地址/DID/peerId/multiaddr/IP/私钥形态/URL/邮箱 · 命中即拒发 (发送侧) 或遮蔽 (读回侧)');
console.log('纪律: 缺群/群非法/没加入 → 拒跑 (不降级为本地落盘) · 未交付不会出现"已交付"条目 · 结算仍只在链上');
if (failures.length) console.log(`\n失败明细:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
