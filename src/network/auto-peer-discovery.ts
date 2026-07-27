/**
 * auto-peer-discovery.ts — 基于 Hyperswarm topic 的 P2P 自动发现
 *
 * 当 P2PDirect 通过 topic 发现新 peer 时，自动将其加入 known_peers 好友列表，
 * 无需用户手动添加好友。
 *
 * 工作流程：
 *   1. P2PDirect 加入 topic（如 'bolloon-agent-harness'）
 *   2. Hyperswarm DHT 自动发现同 topic 的其他节点
 *   3. P2PDirect 触发 connection 事件
 *   4. 本模块检查该 publicKey 是否已在 known_peers
 *   5. 不在 → 自动添加（后续 AgentHeartbeat 的 getPeers 就会看到它）
 *   6. 如果在 → 更新 lastConnectedAt（已经在 known-peers 做的）
 *
 * 不依赖 Web UI、不依赖用户交互、纯后台自动完成。
 */
// 不使用 logger 模块，用 console.log 保持与 bolloon 项目风格一致
const PREFIX = '[auto-discover]';

// 发现 peers 的缓存 key → 本机 publicKey 映射（用于去重）
const TOPIC = 'bolloon-agent-harness';

/**
 * 尝试将一个通过 topic 发现的 peer 自动加入好友列表
 *
 * 核心逻辑：
 *   - 跳过自己（P2PDirect 可能把自己也当 peer push 过来）
 *   - 跳过已存在的好友（仅标记连接时间）
 *   - 新 peer → 自动生成名字并添加
 *
 * @param remotePublicKey 远端 64 字符 hex publicKey
 * @param knownPeers   { addOrUpdatePeer, listPeers, findNameByPublicKey } 接口
 * @param localPublicKey  本机 publicKey（用于跳过自己）
 * @returns 是否是新添加的 peer
 */
export async function tryAutoDiscoverPeer(
  remotePublicKey: string,
  localPublicKey: string,
): Promise<'self' | 'known' | 'discovered'> {
  // 1. 跳过自己
  if (remotePublicKey === localPublicKey) {
    return 'self';
  }

  // 2. 动态 import known-peers（避免循环依赖）
  const { findNameByPublicKey, addOrUpdatePeer } = await import('../network/known-peers.js');

  // 3. 检查是否已存在
  const existingName = await findNameByPublicKey(remotePublicKey);
  if (existingName) {
    // 已经在好友列表里了，只是更新连接状态
    console.log(`[auto-discover] 已知好友 ${existingName} (${remotePublicKey.substring(0, 12)}...) 重新上线`);
    return 'known';
  }

  // 4. 新 peer！自动添加
  const shortId = remotePublicKey.substring(0, 8);
  const autoName = `discovered-${shortId}`;

  await addOrUpdatePeer(autoName, remotePublicKey, `通过 topic "${TOPIC}" 自动发现`);

  console.log(`✅ [auto-discover] 自动发现新 peer: ${autoName} (${remotePublicKey.substring(0, 12)}...)`);
  console.log(`   已添加到 known_peers, AgentHeartbeat 将自动开始社交`);

  return 'discovered';
}

/**
 * 从 peer 的 manifest 中提取名字，更新自动发现的 peer 名称
 *
 * 如果 peer 是 auto-discovered（名字为 discovered-xxxx），
 * 且 manifest 中有 ownerName，就把名字更新为更友好的格式。
 *
 * @param remotePublicKey 远端 publicKey
 * @param ownerName manifest 中的 ownerName
 */
export async function updateDiscoveredPeerName(
  remotePublicKey: string,
  ownerName?: string,
): Promise<void> {
  if (!ownerName) return;

  const { findNameByPublicKey, addOrUpdatePeer, removePeer } = await import('../network/known-peers.js');

  const existingName = await findNameByPublicKey(remotePublicKey);
  // 只有 auto-discovered 的 peer 才重命名
  if (!existingName || !existingName.startsWith('discovered-')) return;

  // 删除旧名字的条目，用新名字重新添加
  await removePeer(existingName);
  await addOrUpdatePeer(ownerName, remotePublicKey, `自动发现后通过 manifest 获取名称`);

  console.log(`[auto-discover] 更新 peer 名称: ${existingName} → ${ownerName}`);
}
