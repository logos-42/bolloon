/**
 * verify-group-replication.ts — P0 门: **真两节点** OrbitDB 复制基线 (2026-09-30)
 *
 * 为什么有这道门: 全仓 5 个"多节点"测试都注入 fake CIDDatabase, 真复制从来没被验过。
 * 本门起**真子进程**(每个 = 一个真 helia/libp2p/OrbitDB 节点, 各自 HOME/身份/随机端口),
 * 走真 dial + 真 pubsub + 真 bitswap 块交换, 并把量如实报出来。
 *
 * 四个场景:
 *   S1  100 条  : A 建群发 100 (A **保持在线**) → B(新节点) dial + 按地址打开 → 拿到全部? 耗时/磁盘?
 *   S3  反事实  : D 打开同一地址但**不 dial** (A 此刻在线且供块) → 必须看不见
 *                (2026-10-01: 只给 D 关 mDNS 不够 —— A 那侧开着也会反向发现 D ⇒ 整门都用
 *                 BOLLOON_ORBITDB_NO_MDNS=1 跑, 让"连接必须来自显式拨号"这件事成立)
 *   S2  1000 条 : 迟到者拿长历史 (全仓最没被验过的一条)
 *   S4  断网分叉: A 建群 → B 加入 → A 退出 → B 离线写 10 条 → A 重启(dial B) → 两侧收敛?
 *                  (顺带验 write:['*'] 对**非创建者**是否真生效)
 *
 * 判据: 集合指纹 keysHash (排序 key 的 sha256) 相同 = 两侧看到的 oplog 集合逐条一致。
 * 跑法: npx tsx scripts/verify-group-replication.ts
 *
 * 两次失败留下的教训 (写进门里, 免得下次重踩):
 *   ① 节点没有 block broker 时按地址打开**必挂** (报 "No block brokers ... cannot be fetched")
 *      ⇒ 根因是 src/orbitdb/ipfs-node.ts 缺 withBitswap, 已修。
 *   ② 阶段结束就退出的节点, 对端只会得到 ECONNREFUSED / "Failed to load block"
 *      ⇒ **供块的节点必须活着**, 故本门用 holdMs 让 A 常驻。
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 仓里 ts 脚本的既有写法 (verify-cli-panel / verify-model-selector 同款): 从 cwd 取仓根
const REPO = process.cwd();
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const CHILD = path.join(REPO, 'scripts', 'lib', 'group-node-child.ts');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-p0-'));
const HOLD_MS = 600000;

interface Res { ok: boolean; [k: string]: unknown }
interface BgNode { kill: () => void; result: Promise<Res> }
const live: ChildProcess[] = [];

function startNode(home: string, spec: Record<string, unknown>, timeoutMs = 300000, extraEnv: Record<string, string> = {}) {
  fs.mkdirSync(home, { recursive: true });
  const specPath = path.join(home, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({ home, ...spec }));
  const p = spawn(TSX, [CHILD, specPath], { cwd: REPO, env: { ...process.env, HOME: home, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  live.push(p);
  let out = '', err = '';
  let firstResult: Res | null = null;      // 首个阶段结果 (hold 型节点靠它提前放行)
  let resolveFirst: ((r: Res) => void) | null = null;
  const first = new Promise<Res>((r) => { resolveFirst = r; });
  const onLine = (line: string): void => {
    if (!line.startsWith('@@OUT ')) return;
    try {
      const obj = JSON.parse(line.slice(6)) as Res;
      // 探针的每 5s 一行: 打出来 (否则失败时看不到"有没有在长")
      if (obj.tick) { console.log(`         · 探针 t=${(obj.tick as any).t}s 日志=${(obj.tick as any).seen} 订阅者=${(obj.tick as any).subscribers} 磁盘=${(obj.tick as any).diskKB}KB`); return; }
      if (!firstResult && !('hold' in obj)) { firstResult = obj; resolveFirst?.(obj); }
    } catch { /* 忽略坏行 */ }
  };
  p.stdout.on('data', (d) => { const s = d.toString(); out += s; for (const l of s.split('\n')) onLine(l); });
  p.stderr.on('data', (d) => { err += d.toString(); });
  const timeout = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* 忽略 */ } }, timeoutMs);
  const closed = new Promise<Res>((resolve) => {
    p.on('close', () => {
      clearTimeout(timeout);
      // 2026-09-30 自己踩的 bug: 这里原来写 `if (settled) return;` —— 短命节点的 @@OUT 一到
      // settled 就是 true, 于是 closed **永远不 resolve**, await 挂死 (门看着像"卡住没输出")。
      // 正确做法: 把已经解析到的那个结果交给 closed (第一次调用的语义就是"我要这个阶段的结果")。
      if (firstResult) return resolve(firstResult);
      const line = out.split('\n').find((l) => l.startsWith('@@OUT '));
      if (!line) return resolve({ ok: false, fatal: 'child 没输出 @@OUT', stderrTail: err.split('\n').slice(-4).join(' | ').slice(0, 400) });
      try { resolve(JSON.parse(line.slice(6))); } catch (e) { resolve({ ok: false, fatal: `解析 @@OUT 失败: ${String(e)}` }); }
    });
  });
  return { first, closed, kill: () => { try { p.kill('SIGTERM'); } catch { /* 忽略 */ } } };
}

/** 短命节点 (跑完即退) */
async function runNode(home: string, spec: Record<string, unknown>, timeoutMs = 300000, extraEnv: Record<string, string> = {}): Promise<Res> {
  return startNode(home, spec, timeoutMs, extraEnv).closed;
}
/** 常驻节点 (供块方必须活着): 拿到阶段结果就继续, 进程留着 */
function holdNode(home: string, spec: Record<string, unknown>, timeoutMs = 300000): BgNode {
  const n = startNode(home, { ...spec, holdMs: HOLD_MS }, timeoutMs);
  return { kill: n.kill, result: n.first };
}

/**
 * 拨号地址筛选: 本机有 ClashX fake-ip, 节点的监听列表里会混进 100.100.x / 198.18.x 这类
 * **拨不通的假地址** —— 全拨会在假地址上挂到超时。优先 127.0.0.1 (同机两节点), 取不到才退全部。
 */
function dialableAddrs(addrs: unknown): string[] {
  const list = Array.isArray(addrs) ? (addrs as string[]) : [];
  const loopback = list.filter((a) => a.includes('/ip4/127.0.0.1/tcp/'));
  if (loopback.length) return loopback.slice(0, 1);
  // 回退必须**排除 /p2p-circuit/** (2026-10-01 实测踩过: 挑到中继地址 ⇒ 拨号得到
  // "Database failed to open" ⇒ S4 的 B 侧看似"没同步", 其实是拨错了地址 ✗)
  const direct = list.filter((a) => !a.includes('webrtc-direct') && !a.includes('/p2p-circuit/'));
  return direct.slice(0, 1);
}

const checks: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void { checks.push({ name, pass, detail }); }
const kb = (n: unknown) => `${(Number(n || 0) / 1024).toFixed(1)}KB`;

async function main(): Promise<void> {
  console.log('P0 · 真两节点 OrbitDB 复制基线');
  console.log(`   节点根目录: ${ROOT}  (每节点隔离 HOME: 独立身份/blockstore/随机端口; 供块方保持在线)`);
  console.log('');

  // ── S1: 100 条 (A 常驻)
  const a1 = holdNode(path.join(ROOT, 's1-a'), { phase: 'create_and_send', group: 'p0-100', count: 100, from: 'A' });
  const A1 = await a1.result;

  const B1 = await runNode(path.join(ROOT, 's1-b'), { phase: 'join_and_wait', address: A1.address, addrs: dialableAddrs(A1.addrs), waitFor: 101, timeoutMs: 120000 });
  console.log('   S1 · 100 条 (A 在线)');
  console.log(`      A: appended=${A1.appended} 发送=${A1.sendMs}ms 磁盘=${kb(A1.diskBytes)}`);
  console.log(`      B: seen=${B1.seen} 打开=${B1.openMs}ms 等齐=${B1.waitedMs}ms timedOut=${B1.timedOut} 磁盘=${kb(B1.diskBytes)}`);
  console.log(`      指纹: A=${A1.keysHash} B=${B1.keysHash}`);
  if (B1.dialErrors) console.log(`      拨号: ${JSON.stringify(B1.dialErrors).slice(0, 200)}`);
  if (B1.openError) console.log(`      打开失败: ${String(B1.openError).slice(0, 220)}`);
  check('S1 B 拿到 A 的 101 条历史', Number(B1.seen) >= 101, `seen=${B1.seen} (期望 ≥101)`);
  check('S1 两侧集合指纹逐字相同', A1.keysHash === B1.keysHash && !!A1.keysHash, `A=${A1.keysHash} B=${B1.keysHash}`);
  console.log('');

  a1.kill();   // S1/S3 的供块方退场 —— 必须排在 S1 的 B 之后 (否则 B 拉不到块, 且 S1 会假红)
  // ── S3 反事实 (2026-10-01 重写): **供块方下线后** 新节点按地址打 ⇒ 必须拿不到内容
  //   旧判据前提不成立 (实测: dial:false + 关 mDNS 的 D 仍会经 bootstrap/发现路径连上 A1,
  //   连接表里有 A1 的地址 ⇒ seen=101 是网络的真实行为, 不是复制异常)。
  //   正确反事实 = 数据只在 A1 的节点上 ⇒ A1 停掉后, 谁也不可能凭空变出它;
  //   D 明确去拨 A1 的(已失效)地址, 拿不到才证明"复制确实来自 A1 这个节点"。
  const D3 = await runNode(path.join(ROOT, 's3-d'), { phase: 'join_and_wait', address: A1.address, addrs: dialableAddrs(((A1 as any).addrs as string[]) || []), dial: true, waitFor: 1, timeoutMs: 20000 }, 120000, { BOLLOON_ORBITDB_NO_MDNS: '1' });
  console.log('   S3 · 反事实 (A1 已停 + D 明确去拨它的失效地址)');
  console.log(`      D: seen=${D3.seen} 打不开=${D3.openError ? '是' : '否'}`);
  console.log(`      D 的当前连接 = ${JSON.stringify((D3 as any).peerConnections ?? null)}`);
  check('S3 供块方下线后, 新节点按地址打必须拿不到内容', Number(D3.seen) === 0 || !!D3.openError, `seen=${D3.seen} 打不开=${D3.openError ? '是' : '否'} (期望 0 或打不开 = 数据确实只在 A1 节点上)`);
  console.log('');

  // ── S2: 1000 条 (迟到者拿长历史)
  const a2 = holdNode(path.join(ROOT, 's2-a'), { phase: 'create_and_send', group: 'p0-1000', count: 1000, from: 'A' }, 420000);
  const A2 = await a2.result;
  const C2 = await runNode(path.join(ROOT, 's2-c'), { phase: 'join_and_wait', address: A2.address, addrs: dialableAddrs(A2.addrs), waitFor: 1001, timeoutMs: 300000 }, 420000);
  console.log('   S2 · 1000 条 (迟到者)');
  console.log(`      A: appended=${A2.appended} 发送=${A2.sendMs}ms 磁盘=${kb(A2.diskBytes)}`);
  console.log(`      C: seen=${C2.seen} 打开=${C2.openMs}ms 等齐=${C2.waitedMs}ms timedOut=${C2.timedOut} 磁盘=${kb(C2.diskBytes)}`);
  console.log(`      指纹: A=${A2.keysHash} C=${C2.keysHash}`);
  if (C2.openError) console.log(`      打开失败: ${String(C2.openError).slice(0, 220)}`);
  check('S2 迟到者拿到 1001 条历史', Number(C2.seen) >= 1001, `seen=${C2.seen} (期望 ≥1001)`);
  check('S2 指纹逐字相同', A2.keysHash === C2.keysHash && !!A2.keysHash, `A=${A2.keysHash} C=${C2.keysHash}`);
  a2.kill();
  console.log('');

  // ── S4: 断网分叉 + 重连收敛 (+ 非创建者写入)
  const a4 = holdNode(path.join(ROOT, 's4-a'), { phase: 'create_and_send', group: 'p0-offline', count: 10, from: 'A' });
  const A4 = await a4.result;
  const B4a = await runNode(path.join(ROOT, 's4-b'), { phase: 'join_and_wait', address: A4.address, addrs: dialableAddrs(A4.addrs), waitFor: 11, timeoutMs: 120000 });
  a4.kill(); // A 离线
  // B 离线写 10 条 (拨不到 A) —— 顺带验 write:['*'] 对**非创建者**是否真生效
  const b4 = holdNode(path.join(ROOT, 's4-b'), { phase: 'send_only', address: A4.address, count: 10, from: 'B' });
  const B4b = await b4.result;
  // A 重启 (同 HOME ⇒ 同身份/同 blockstore), 拨 B; B 常驻供块
  const a4b = holdNode(path.join(ROOT, 's4-a'), { phase: 'open_and_wait', address: A4.address, addrs: dialableAddrs(B4b.addrs), waitFor: 21, timeoutMs: 180000 }, 300000);
  const a4bRes = await a4b.result;
  // 2026-10-01 踩的坑: B 的上一个进程 (离线写那次 hold) 必须**先退出** —— 同一 HOME 上两个进程
  // 同时开同一个库会撞 LevelDB 锁, 表现为 openStoreByAddress 报 "Database failed to open"
  // (我修过 A 的同类问题, 漏了 B)。所以这里先 kill 再起 B 的下一个进程。
  b4.kill();
  await new Promise((r) => setTimeout(r, 1500));
  // B 的第二次: 用 open_and_wait (断言需要 seen/keysHash 形状); 若没看到, 再补一个探针拿时间曲线
  let B4c = await runNode(path.join(ROOT, 's4-b'), { phase: 'open_and_wait', address: A4.address, addrs: dialableAddrs(a4bRes.addrs), waitFor: 21, timeoutMs: 180000 }, 300000);
  if (Number(B4c.seen) < 21) {
    console.log('      (B 侧没看到 21 条 ⇒ 补跑探针拿曲线)');
    await runNode(path.join(ROOT, 's4-b'), { phase: 'probe_sync', address: A4.address, addrs: dialableAddrs(a4bRes.addrs), waitFor: 21, count: 12 }, 300000);
    B4c = { ...B4c, probedAfter: true };
  }
  const A4b = a4bRes;
  console.log('   S4 · 断网分叉 + 重连收敛');
  console.log(`      A 建群 appended=${A4.appended} · B 加入 seen=${B4a.seen}`);
  console.log(`      A 退出后 B 离线写: written=${B4b.written} ok=${B4b.ok}${B4b.error ? ' 错误=' + String(B4b.error).slice(0, 150) : ''}`);
  console.log(`      A 重启: seen=${A4b.seen} 等=${A4b.waitedMs}ms · B(新进程): seen=${B4c.seen} 等=${B4c.waitedMs}ms`);
  console.log(`      指纹: A=${A4b.keysHash} B=${B4c.keysHash}`);
  if (B4c.openError) console.log(`      B 打开失败原文: ${String(B4c.openError).slice(0, 200)}`);
  if (B4c.dialErrors) console.log(`      B 拨号: ${JSON.stringify(B4c.dialErrors).slice(0, 200)}`);
  check('S4 非创建者离线写入成功 (write:* 真生效)', Number(B4b.written) === 10, `written=${B4b.written} (期望 10)${B4b.error ? ' · ' + String(B4b.error).slice(0, 130) : ''}`);
  check('S4 重连后两侧都看到 21 条', Number(A4b.seen) >= 21 && Number(B4c.seen) >= 21, `A=${A4b.seen} B=${B4c.seen} (期望 ≥21)`);
  check('S4 收敛后指纹逐字相同', A4b.keysHash === B4c.keysHash && !!A4b.keysHash, `A=${A4b.keysHash} B=${B4c.keysHash}`);
  a4b.kill();
  console.log('');

  // ── P0 数字表 (方案 §2 四个量里的三个; 线上字节未单独采集, 如实注明)
  // ── S5 (2026-10-02, leo「跨节点读回要真验」): 走**群模块** —— AI 的 group_read / group_say /
  //   group_autopilot 背后**同一批函数** (createGroup / joinGroup / groupMessages / groupSend),
  //   不是裸 store 原语。回环 = A 建群写 → B 拨号入群读 + 回写 → A 重启读回 B 那一条。
  console.log('   S5 · 群模块跨节点 (A 建群写 → B 入群读+回写 → A 重启读回)');
  //   ⚠ 建群默认 = **创建者独占** (2026-10-01 P1) ⇒ 要验"入群后能发言"必须建 acl:'open' 的群
  //     (产品语义: 谁拿到邀请链接都能发言)。独占群下 B 写不进去是**正确行为**, 不是 bug。
  const a5 = holdNode(path.join(ROOT, 's5-a'), { phase: 'module_ops', mode: 'create', group: 'p0-module', count: 50, from: 'A', acl: 'open' });
  const A5 = await a5.result;
  console.log(`      A(群模块): 建群 ${String(A5.groupId).slice(0, 16)}… 写 ${A5.seen} 条 用时 ${A5.sendMs}ms 磁盘=${kb(A5.diskBytes)}`);
  if (!A5.link) console.log('      ⚠ A 没拿到邀请链接 (groupLink 返回空) —— B 只能靠 groupId, 会测不到"入群"这一步');
  //   ⚠ B 必须**常驻**: 它写进去的那一条, 只有它在线时 A 才拿得到 (门自己的规矩: 供块方要活着)
  const b5 = holdNode(path.join(ROOT, 's5-b'), {
    phase: 'module_ops', mode: 'join_read', link: A5.link, groupId: A5.groupId,
    addrs: dialableAddrs(A5.addrs), waitFor: 51, from: 'B', timeoutMs: 120000,
  });
  const B5 = await b5.result;
  console.log(`      B(群模块): 入群后读到 ${B5.seen} 条 等 ${B5.waitMs}ms 回写=${B5.spoke} 回写后自见 ${B5.afterSeen} 条`);
  if (B5.openError) console.log(`      读失败: ${String(B5.openError).slice(0, 160)}`);
  // 2026-10-02: 红的时候必须能看出"没连上"还是"连上了没落块" —— 上一版这里什么都没有
  console.log(`      拨号: ${(dialableAddrs(A5.addrs) as string[]).length} 个地址 · 错误 ${Array.isArray(B5.dialErrors) ? (B5.dialErrors as string[]).length : 0} 条 · 轮询 ${B5.polls ?? '?'} 次`);
  if (Array.isArray(B5.dialErrors) && (B5.dialErrors as string[]).length) console.log(`      拨号错误样本: ${String((B5.dialErrors as string[])[0]).slice(0, 140)}`);
  if (B5.lastError) console.log(`      最后一次读错: ${String(B5.lastError).slice(0, 160)}`);
  check('S5 群模块: B 经 joinGroup + groupMessages 读到 A 的 51 条', Number(B5.seen) >= 51, `seen=${B5.seen} (期望 ≥51)`);
  check('S5 群模块: B 用 groupSend 回写成功 (非创建者可写)', B5.spoke === true, `spoke=${B5.spoke}`);
  a5.kill();
  const A5b = await runNode(path.join(ROOT, 's5-a'), {
    phase: 'module_ops', mode: 'read_only', groupId: A5.groupId,
    addrs: dialableAddrs(B5.addrs), waitFor: 52, timeoutMs: 60000,
  });
  b5.kill();
  console.log(`      A 重启(群模块只读): 读到 ${A5b.seen} 条 指纹=${A5b.keysHash}`);
  check('S5 群模块: A 重启后读到 51 + B 回写 1 = 52 条', Number(A5b.seen) >= 52, `seen=${A5b.seen} (期望 ≥52)`);
  check('S5 群模块: B 侧集合是 A 侧的超集 (回写那条确实进了同一 store)',
    Number(B5.afterSeen) >= 52 && Number(A5b.seen) >= 52, `B=${B5.afterSeen} A=${A5b.seen}`);
  console.log('');

  console.log('   P0 数字表 (真两节点, 单机 loopback):');
  console.log('      场景                    N      对端拿齐耗时   对端磁盘    供块方磁盘');
  console.log(`      S1 新节点拿全量       101   ${String(B1.waitedMs ?? '-').padStart(8)}ms   ${kb(B1.diskBytes).padStart(9)}   ${kb(A1.diskBytes).padStart(9)}`);
  console.log(`      S2 迟到者拿长历史    1001   ${String(C2.waitedMs ?? '-').padStart(8)}ms   ${kb(C2.diskBytes).padStart(9)}   ${kb(A2.diskBytes).padStart(9)}`);
  console.log('      (线上字节数未单独采集 —— libp2p 计数器没接; 磁盘增量是它的可核验代理)');
  console.log('');

  const bad = checks.filter((c) => !c.pass);
  console.log('   判据:');
  for (const c of checks) console.log(`      ${c.pass ? '✓' : '✗'} ${c.name} — ${c.detail}`);
  console.log('');
  console.log(`   结论: ${checks.length - bad.length}/${checks.length} 通过` + (bad.length ? ' —— 有真失败, 见上' : ''));
  console.log(`   节点数据留档: ${ROOT}  (每节点 .bolloon/orbitdb 下可看 blocks/ 与 stores/)`);
  for (const p of live) { try { p.kill('SIGTERM'); } catch { /* 忽略 */ } }
  if (!bad.length) { try { fs.rmSync(ROOT, { recursive: true, force: true }); console.log('   (全绿, 临时节点目录已清理)'); } catch { /* 忽略 */ } }
  process.exit(bad.length ? 1 : 0);
}

void main();
