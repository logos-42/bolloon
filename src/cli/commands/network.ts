/**
 * network.ts — P3 `bolloon network init|join|status|leave|peers`
 *
 * 全部是**现有服务的薄包装** (不重实现、不编造):
 *   init    → `gateway-join.ensureGatewayNode()` (本机 libp2p 节点初始化, 幂等)
 *   join    → `gateway-network.joinNetwork(link)` (orbitdb:// / ipns:// / https:// 链接)
 *             或 `gateway-join.joinGlobalGateway()` (文档驱动全球入网)
 *   status  → `p2p-info.getLocalP2pInfo()` + `gateway-network.listJoinedNetworks()`
 *             + `gateway-join.getGatewayJoinState()` + `agent-registry` (只读, 不主动 warm)
 *   peers   → `network/p2p` 的 `getPeers()` (需要本进程里有在跑的节点)
 *   leave   → **没有实现** (仓库里不存在 leaveNetwork) → 如实报 `C_NOT_IMPLEMENTED`
 *
 * 硬要求 (leo 2026-09-21): `network join` 不许只说"加入成功" —— 必须报
 *   DID · 网络名 · manifest 是否注册 · P2P 是否在线 · registry 是否同步 · 是否离线降级 · 下一步。
 */

import {
  type CliFlags, type CommandResult, type Envelope, type NextAction,
  okEnvelope, failEnvelope, notImplemented, line, title, hint, plain, opt, has,
} from '../protocol-envelope.js';

export const NETWORK_USAGE = `
${title('bolloon network')}
  bolloon network status [--json]              本机入网态 (DID / 网络 / P2P / registry)
  bolloon network init [--json]                初始化本机 P2P 节点 (幂等)
  bolloon network join [--json]                文档驱动全球入网 (幂等; 已在网则报 already)
  bolloon network join <link> [--json]         按链接加入共享网络 (orbitdb:// / ipns:// / https://)
  bolloon network peers [--json]               本机节点的已连接 peer
  bolloon network leave                        未实现 (仓库没有 leaveNetwork) → 如实报 C_NOT_IMPLEMENTED

选项: --url <doc> · --name <名> · --capabilities a,b · --force · --request-id <id> · --timeout <ms> · --quiet
`;

interface NetworkFacts {
  did: string;
  name: string;
  p2p: { online: boolean; source: string; peerId: string; multiaddrs: string[]; relayAddrs: string[]; isRelay: boolean; note?: string };
  joined: Array<{ link: string; kind?: string; name?: string; joinedAt: string; serviceCount: number; lastSyncAt?: string; networkId?: string }>;
  gatewayJoin: { url: string; did: string; name?: string; peerId?: string; networkLink?: string; networkId?: string; joinedAt: string; capabilities?: string[] } | null;
  manifest: { registered: boolean; agentIds: string[]; capabilities: string[]; note: string };
  registry: { ready: boolean; storeName: string; services: number; source: 'orbitdb' | 'local' };
}

/** 只读地收集本机入网事实 (不 warm OrbitDB, 不启动节点, 不改任何文件) */
async function collectFacts(): Promise<NetworkFacts> {
  const { getLocalP2pInfo } = await import('../../agents/p2p-info.js');
  const { listJoinedNetworks } = await import('../../agents/gateway-network.js');
  const { getGatewayJoinState } = await import('../../agents/gateway-join.js');
  const { getAgentRegistry } = await import('../../agents/agent-registry.js');
  const { getLocalManifest } = await import('../../agents/agent-manifest-protocol.js');
  const { getUserOwnerDid } = await import('../../agents/agent-identity.js');

  const p2p = await getLocalP2pInfo();
  const joinedRaw = await listJoinedNetworks();
  const gate = await getGatewayJoinState().catch(() => null);
  const did = String(gate?.did || p2p.did || getUserOwnerDid() || '');
  const name = String(gate?.name || p2p.name || '');

  // manifest 是**进程内**结构 (agent-manifest-protocol 不落盘) —— 一次性 CLI 里读到空是正常的, 如实说
  const m = getLocalManifest();
  const agentIds = (m.agents || []).map((a) => String(a.id));
  const capabilities = (m.agents || []).flatMap((a) => (a.capabilities || []).map(String));

  const reg = getAgentRegistry(did || 'local');
  let services: number | null = null;
  try { services = (await reg.loadLocal()).length; } catch { services = null; }

  return {
    did,
    name,
    p2p: {
      online: !!p2p.peerId && p2p.source === 'live',
      source: p2p.source,
      peerId: p2p.peerId || '',
      multiaddrs: p2p.multiaddrs || [],
      relayAddrs: p2p.relayAddrs || [],
      isRelay: !!p2p.isRelay,
      note: p2p.note,
    },
    joined: joinedRaw.map((n) => ({
      link: n.link, kind: n.kind, name: n.name, joinedAt: n.joinedAt,
      serviceCount: n.serviceCount, lastSyncAt: n.lastSyncAt, networkId: n.networkId,
    })),
    gatewayJoin: gate ? {
      url: gate.url, did: gate.did, name: gate.name, peerId: gate.peerId,
      networkLink: gate.networkLink, networkId: gate.networkId, joinedAt: gate.joinedAt, capabilities: gate.capabilities,
    } : null,
    manifest: {
      registered: agentIds.length > 0,
      agentIds,
      capabilities: Array.from(new Set(capabilities)),
      note: agentIds.length > 0
        ? '本进程内 manifest 已注册 (刚入网时登记的那份)'
        : 'manifest 只在运行中的 Runtime 进程内 (agent-manifest-protocol 不落盘) —— 一次性 CLI 命令读不到它不等于没注册过',
    },
    registry: {
      ready: reg.ready,
      storeName: reg.storeName,
      services: services ?? 0,
      source: reg.ready ? 'orbitdb' : 'local',
    },
  };
}

/** registry 预热 (有界): CLI 一次性命令里不许无限等 OrbitDB/IPFS */
function factsHuman(f: NetworkFacts, head: string): string {
  const out: string[] = [title(head)];
  out.push(line('DID', f.did));
  out.push(line('名称', f.name));
  out.push(line('已加入网络', `${f.joined.length} 个`));
  for (const n of f.joined) out.push(`      · ${n.name || n.networkId || n.link.slice(0, 60)} (${n.joinedAt.slice(0, 19)}, 服务 ${n.serviceCount})`);
  if (f.gatewayJoin) out.push(line('全球入网', `${f.gatewayJoin.networkId || f.gatewayJoin.networkLink || f.gatewayJoin.url} @ ${f.gatewayJoin.joinedAt.slice(0, 19)}`));
  out.push(line('P2P', f.p2p.online ? `在线 peerId=${f.p2p.peerId.slice(0, 16)}…` : '不在线 (当前进程没有节点在跑)'));
  if (f.p2p.multiaddrs.length) out.push(line('可拨入地址', `${f.p2p.multiaddrs.length} 条, 例: ${f.p2p.multiaddrs[0].slice(0, 72)}`));
  if (f.p2p.note) out.push(line('说明', f.p2p.note));
  out.push(line('manifest', f.manifest.registered ? `已注册 (${f.manifest.agentIds.join(', ')})` : `本 CLI 进程未读到 (${f.manifest.note})`));
  out.push(line('registry', `${f.registry.ready ? 'OrbitDB 就绪' : '未就绪 (离线/未 warm)'} · ${f.registry.source} · 本地服务 ${f.registry.services} 条`));
  out.push(line('离线降级', f.joined.length > 0 && !f.p2p.online ? '是 (入网记录在, 但当前没有节点在跑)' : '否'));
  return out.join('\n');
}

function nextActionForFacts(f: NetworkFacts): NextAction {
  if (!f.did) return 'rejoin_network';
  if (f.joined.length === 0 && !f.gatewayJoin) return 'rejoin_network';
  if (!f.p2p.online) return 'rejoin_network';
  return null;
}

export async function networkCommand(flags: CliFlags): Promise<CommandResult> {
  const sub = flags.positionals[0];
  switch (sub) {
    case 'status': return networkStatus(flags);
    case 'init': return networkInit(flags);
    case 'join': return networkJoin(flags);
    case 'peers': return networkPeers(flags);
    case 'leave': return networkLeave(flags);
    default:
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', sub ? `未知 network 子命令: ${sub}` : '缺少 network 子命令', { usage: plain(NETWORK_USAGE.trim()) }, [], 'needs_human'),
        human: NETWORK_USAGE,
      };
  }
}

// ── network status ──────────────────────────────────────────────────────────

async function networkStatus(flags: CliFlags): Promise<CommandResult> {
  const f = await collectFacts();
  const next = nextActionForFacts(f);
  if (!f.did && f.joined.length === 0 && !f.gatewayJoin) {
    // 诚实的前置条件失败 (§3 NETWORK_NOT_JOINED: 本机没有任何已加入网络)
    return {
      envelope: failEnvelope('NETWORK_NOT_JOINED', '本机还没有加入任何网络 (也没有 DID 身份)', {
        did: f.did, joinedNetworks: [], registryReady: f.registry.ready, p2p: f.p2p,
      }, [], 'rejoin_network'),
      human: `${factsHuman(f, 'bolloon network status')}\n\n${hint('下一步: bolloon network join  (或先 bolloon setup 建立身份)')}`,
    };
  }
  const data = {
    did: f.did,
    name: f.name,
    joinedNetworks: f.joined,
    gatewayJoin: f.gatewayJoin,
    p2pOnline: f.p2p.online,
    p2p: f.p2p,
    manifest: f.manifest,
    registry: f.registry,
    offlineDegraded: !f.p2p.online,
  };
  const env: Envelope = okEnvelope('OK', `本机入网态: ${f.joined.length} 个网络${f.p2p.online ? ', P2P 在线' : ', P2P 未在线'}`, data, [
    ...(f.did ? [f.did] : []),
    ...(f.p2p.peerId ? [f.p2p.peerId] : []),
  ], next);
  return { envelope: env, human: `${factsHuman(f, 'bolloon network status')}\n\n${hint(next === 'rejoin_network' ? '下一步: 启动一个本机 Runtime (bolloon --web) 或 bolloon network init, 才有节点在跑' : 'P2P 在线, 可直接 bolloon p2p --json 拿到可拨入地址')}` };
}

// ── network init ────────────────────────────────────────────────────────────

async function networkInit(flags: CliFlags): Promise<CommandResult> {
  const { ensureGatewayNode } = await import('../../agents/gateway-join.js');
  const node = await ensureGatewayNode({ nodeTimeoutMs: flags.timeoutMs ?? 25_000 });
  if (!node.ok) {
    return {
      envelope: failEnvelope('NETWORK_NOT_JOINED', `本机 P2P 节点没起来: ${node.error || '未知原因'}`, { error: node.error || null, did: (await collectFacts()).did }, [], 'rejoin_network'),
      human: `本机 P2P 节点没起来\n  原因: ${node.error || '未知原因'}\n\n${hint('下一步: bolloon doctor 看运行时; 或 bolloon network join 走文档驱动入网')}`,
    };
  }
  const f = await collectFacts();
  return {
    envelope: okEnvelope('NETWORK_NODE_READY', `本机 P2P 节点就绪 (peerId=${String(node.peerId).slice(0, 16)}…)`, {
      did: f.did, peerId: node.peerId || '', started: !!node.started, multiaddrs: node.multiaddrs || [],
    }, node.peerId ? [String(node.peerId)] : [], f.did ? null : 'rejoin_network'),
    human: `${title('bolloon network init')}\n${line('DID', f.did)}\n${line('peerId', node.peerId || '(未拿到)')}\n${line('本次启动', node.started ? '是' : '否 (已在跑)')}\n${line('可拨入地址', (node.multiaddrs || []).length + ' 条')}\n\n${hint('注意: 这条命令起的节点随进程结束 (一次性命令) —— 要长期在线用 bolloon --web')}`,
  };
}

// ── network join ────────────────────────────────────────────────────────────

async function networkJoin(flags: CliFlags): Promise<CommandResult> {
  const link = flags.positionals[1] || opt(flags, '--link');
  const wantGlobal = has(flags, '--global') || !link;
  const steps: Array<{ step: string; ok: boolean; note: string }> = [];
  let joined = false;
  let already = false;
  let networkName = '';
  let networkId = '';
  let networkLink = '';
  let error = '';
  let mode = '';

  if (!wantGlobal && link) {
    // 按链接加入 (gateway-network.joinNetwork: 拉远端服务 → 并入本地 registry + 记成员身份)
    const { joinNetwork } = await import('../../agents/gateway-network.js');
    mode = 'link';
    const r = await joinNetwork(link);
    joined = r.ok;
    already = !!r.already;
    networkName = r.networkName || '';
    networkId = r.networkId || '';
    error = r.error || '';
    steps.push({ step: '按链接加入网络', ok: r.ok, note: r.ok ? `${r.already ? '已在网(幂等)' : `拉取远端服务 ${r.total} 条, 新增 ${r.joined} 条`} (kind=${r.linkKind || '?'})` : (r.error || '') });
  } else {
    // 文档驱动全球入网 (gateway-join.joinGlobalGateway)
    const { joinGlobalGateway } = await import('../../agents/gateway-join.js');
    mode = 'global';
    const caps = (opt(flags, '--capabilities') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const r = await joinGlobalGateway({
      url: opt(flags, '--url'),
      name: opt(flags, '--name'),
      capabilities: caps.length ? caps : undefined,
      force: has(flags, '--force'),
    });
    joined = r.ok;
    already = !!r.already;
    networkName = r.networkId || '';
    networkId = r.networkId || '';
    networkLink = r.networkLink || '';
    error = r.error || '';
    steps.push(...r.steps.map((s) => ({ step: s.step, ok: s.ok, note: s.note })));
  }

  // 入网后重新采集事实 (join 会写 gateway-join.json / gateway-networks.json)
  const f = await collectFacts();
  const manifestStep = steps.find((s) => s.step.includes('manifest'));
  const serviceStep = steps.find((s) => s.step.includes('服务登记'));
  const registrySynced = mode === 'link'
    ? joined || f.joined.length > 0
    : (serviceStep ? serviceStep.ok : f.joined.length > 0 || !!f.gatewayJoin);
  const manifestRegistered = mode === 'global' ? (manifestStep ? manifestStep.ok : f.manifest.registered) : f.manifest.registered;
  const offlineDegraded = !f.p2p.online;

  const data = {
    mode,
    did: f.did,
    networkName: networkName || f.name,
    networkId,
    networkLink,
    already,
    manifest: {
      registered: manifestRegistered,
      persisted: false,
      agentIds: f.manifest.agentIds,
      note: f.manifest.note,
    },
    p2p: {
      online: f.p2p.online,
      source: f.p2p.source,
      peerId: f.p2p.peerId,
      multiaddrs: f.p2p.multiaddrs.slice(0, 4),
    },
    registry: { ready: f.registry.ready, synced: registrySynced, services: f.registry.services, source: f.registry.source },
    offlineDegraded,
    steps,
  };
  const evidence = [f.did, f.p2p.peerId, networkLink].filter(Boolean) as string[];

  const human = [
    title('bolloon network join'),
    line('DID', f.did),
    line('网络名', networkName || f.name || '(未拿到)'),
    line('入网方式', mode === 'global' ? '文档驱动 (joinGlobalGateway)' : `链接 (${link})`),
    line('幂等', already ? '已在网 (already=true, 没有重复建网)' : '本次入网'),
    line('manifest', manifestRegistered ? '已注册 (本进程读回确认)' : `未确认 (${f.manifest.note})`),
    line('P2P', f.p2p.online ? `在线 peerId=${f.p2p.peerId.slice(0, 16)}…` : `不在线 (source=${f.p2p.source || 'none'})`),
    line('registry', `${f.registry.ready ? 'OrbitDB 就绪' : '未就绪'} · 同步=${registrySynced ? '是' : '否'} · 本地服务 ${f.registry.services} 条`),
    line('离线降级', offlineDegraded ? '是 —— 入网记录在, 但当前没有节点在跑 (重启后由 restoreJoinedNetworks 恢复)' : '否'),
    steps.length ? `\n  步骤:` : '',
    ...steps.map((s) => `    ${s.ok ? '✓' : '✗'} ${s.step}: ${s.note.slice(0, 120)}`),
  ].filter(Boolean).join('\n');

  const next: NextAction = !joined ? 'rejoin_network' : (offlineDegraded ? 'rejoin_network' : null);
  const env = joined
    ? okEnvelope('NETWORK_JOINED', `已加入网络 ${networkName || f.name || networkLink || ''}${already ? ' (幂等命中, 未重复建网)' : ''}`, data, evidence, next)
    : failEnvelope('NETWORK_NOT_JOINED', `入网没成功: ${error || '未知原因'}`, data, evidence, 'rejoin_network');
  return { envelope: env, human: `${human}\n\n${hint(joined ? (offlineDegraded ? '下一步: 启动常驻 Runtime (bolloon --web) 让节点真的在线; 再 bolloon p2p --json 拿可拨入地址' : '下一步: 无需额外动作') : '下一步: 检查网络/文档地址, 或 bolloon network status 看现状')}` };
}

// ── network peers ───────────────────────────────────────────────────────────

async function networkPeers(flags: CliFlags): Promise<CommandResult> {
  const peerId = await currentProcessPeerId();
  if (!peerId) {
    // §3 NETWORK_NOT_JOINED: 本机没有 peerId (没有在跑的节点) —— 不编造 peer
    return {
      envelope: failEnvelope('NETWORK_NOT_JOINED', '当前进程没有在跑的 P2P 节点, 拿不到 peer 列表', {
        online: false, peers: [],
        note: 'peer 列表来自运行中的节点 (p2pNetwork.getPeers()); 一次性 CLI 命令里节点没起就没有可列的对端',
      }, [], 'rejoin_network'),
      human: `${title('bolloon network peers')}\n  当前进程没有在跑的 P2P 节点 → 没有 peer 可列 (不是"网络上没人")\n\n${hint('下一步: bolloon network init 起一个节点, 或 bolloon --web 让 Runtime 常驻')}`,
    };
  }
  const mod: any = await import('../../network/p2p.js');
  const peers: string[] = (mod.p2pNetwork?.getPeers?.() || []).map((p: any) => String(p));
  return {
    envelope: okEnvelope('OK', `本机节点已连接 ${peers.length} 个 peer`, {
      online: true, peerId, peers, count: peers.length,
    }, [peerId], null),
    human: `${title('bolloon network peers')}\n${line('本机 peerId', peerId)}\n${line('连接数', peers.length)}\n${peers.map((p) => `      · ${p}`).join('\n')}`,
  };
}

/** 只在**本进程**里有节点时给 peerId (与 p2p-info 的探测同一套 API) */
async function currentProcessPeerId(): Promise<string> {
  try {
    const mod: any = await import('../../network/p2p.js');
    const net = mod.p2pNetwork;
    if (!net?.getNode?.()) return '';
    return String(net.getNodePeerId?.() || '');
  } catch {
    return '';
  }
}

// ── network leave ───────────────────────────────────────────────────────────

async function networkLeave(_flags: CliFlags): Promise<CommandResult> {
  const env = notImplemented('network leave 还没实现: 仓库里不存在 leaveNetwork (没有任何"退出网络"的服务可包)', {
    plannedCapability: 'network.leave',
    contractState: '入网记录在 ~/.bolloon/gateway-networks.json + ~/.bolloon/gateway-join.json (没有删除/退出的服务入口)',
    alternative: '今天只能手工处理入网记录文件 (CLI 不做, 免得绕过 restoreJoinedNetworks 的成员身份语义)',
  });
  return { envelope: env, human: failHumanLeave(env.message) };
}

function failHumanLeave(msg: string): string {
  return `${title('bolloon network leave')}\n  ${msg}\n\n${hint('下一步: 没有 → 这条能力在路线图上 (upgrade_client)')}`;
}
