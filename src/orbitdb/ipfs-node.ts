/**
 * ipfs-node.ts — Bolloon 的 OrbitDB 底层 IPFS 节点工厂 (2026-08-06; 落盘 2026-09-24)
 *
 * 基于 helia 7:
 *   - createHelia() 内部已 withLibp2p 但**不传 opts** → 无法自定义 services
 *     (HeliaInit 没有 libp2p 字段, 传了也被丢弃, 实测服务列表仍是默认 13 个)
 *   - 正确姿势: createHeliaLight() (无 libp2p) + 手动 withLibp2p(helia, { services })
 *   - OrbitDB 的 P2P 同步依赖 ipfs.libp2p.services.pubsub (sync.js:113) → 必须加 gossipsub
 *   - libp2p 的 createLibp2p 是 { ...defaults, ...options } 浅合并: services 整个覆盖,
 *     必须显式列出要保留的默认服务 (dht/identify/keychain/...)
 *   - withLibp2p().start() 之后 libp2p getter 才可用 (之前抛 NotStartedError)
 *
 * 2026-09-24 **区块/datastore 落盘修复** (跨进程可重开的根因):
 *   原来 createHeliaLight 只传 codecs/hashers → helia 用默认 MemoryBlockstore / MemoryDatastore,
 *   而 OrbitDB 的 manifest 与 oplog 条目都走 IPFSBlockStorage(ipfs.blockstore) 存
 *   (@orbitdb/core/src/storage/ipfs-block.js)。于是 `~/.bolloon/orbitdb/` 下只有 stores/
 *   (keystore + log/_heads 的 LevelDB), 没有 ipfs/ 块存储 —— store 只活在创建它的那个进程里。
 *   新进程用地址重开必挂在 manifestStore.get():
 *     "No block brokers capable of retrieving blocks are configured, the CID bafyrei… cannot be fetched"
 *   现在: FsBlockstore(dataDir/blocks) + FsDatastore(dataDir/datastore) 真落盘。
 *   · datastore 顺带持久化 pin (helia pins) 与 libp2p 私钥
 *     (@helia/libp2p: loadOrCreateSelfKey(helia.datastore) + opts.datastore ??= helia.datastore)
 *     → 同一 dataDir 的 peerId 跨进程稳定。
 *   · 这两个包是 Node 专用 (node:fs / node:path); 本文件只被 Node 侧 import,
 *     浏览器入口 (client.ts / mobile-core.ts / a2ui-client.tsx) 到不了这里 —— 不伤 Web 包。
 *
 * 跑法: npx tsx scripts/smoke-orbitdb.ts
 */

import { createHeliaLight, type Helia } from 'helia';
import { withLibp2p } from '@helia/libp2p';
import { FsBlockstore } from 'blockstore-fs';
import { FsDatastore } from 'datastore-fs';
import * as dagCbor from '@ipld/dag-cbor';
import * as dagJson from '@ipld/dag-json';
import * as json from 'multiformats/codecs/json';
import { sha512 } from 'multiformats/hashes/sha2';
import { gossipsub } from '@libp2p/gossipsub';
import { identify, identifyPush } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
import { keychain } from '@libp2p/keychain';
import { autoNAT } from '@libp2p/autonat';
import { uPnPNAT } from '@libp2p/upnp-nat';
import { ping } from '@libp2p/ping';
import { mdns } from '@libp2p/mdns';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { http } from '@libp2p/http';
import { delegatedRoutingV1HttpApiClientContentRouting, delegatedRoutingV1HttpApiClientPeerRouting } from '@helia/delegated-routing-v1-http-api-client';
import { delegatedHTTPRoutingDefaults } from '@helia/delegated-routing-client';
import { autoTLS } from '@ipshipyard/libp2p-auto-tls';
import * as path from 'path';
import * as os from 'os';

export interface BolloonIpfsPaths {
  /** 节点数据根目录 (由调用方传入, 默认 ~/.bolloon/orbitdb-ipfs) */
  dataDir: string;
  /** 区块落盘目录 (FsBlockstore) — 必须存在且可写 */
  blocksDir: string;
  /** datastore 落盘目录 (FsDatastore: pin / keystore / libp2p 私钥) */
  datastoreDir: string;
}

export interface BolloonIpfs {
  helia: Helia;
  peerId: string;
  /** 落盘位置 (诊断/验收用) */
  paths: BolloonIpfsPaths;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * 创建 Bolloon 用的 helia 节点 (libp2p 完整默认服务 + gossipsub pubsub)。
 * dataDir 持久化节点身份/数据 (默认 ~/.bolloon/orbitdb-ipfs)。
 *
 * 2026-09-24: dataDir 下真落两个目录 —— `blocks/` (区块) 与 `datastore/` (pin + peerkey)。
 * 目录不可写时**直接抛** (不退回内存: 静默退回正好是"新进程读不到群"的根因)。
 */
export async function createBolloonIpfs(dataDir?: string): Promise<BolloonIpfs> {
  const dir = path.resolve(dataDir ?? path.join(process.env.HOME || os.homedir() || '/tmp', '.bolloon', 'orbitdb-ipfs'));
  const blocksDir = path.join(dir, 'blocks');
  const datastoreDir = path.join(dir, 'datastore');

  // 落盘存储: 不传这两个, helia 默认 MemoryBlockstore/MemoryDatastore → 进程退出即丢区块
  const blockstore = new FsBlockstore(blocksDir);
  const datastore = new FsDatastore(datastoreDir);
  await blockstore.open(); // 建目录 + F_OK|W_OK 探测, 失败抛 OpenFailedError (不静默)
  await datastore.open();

  // createHeliaLight 无 libp2p → withLibp2p 手动装配 (可传 services)
  // codecs/hashers 照抄 createHelia 默认: OrbitDB 的 log entry 用 dag-cbor (codec 113),
  // 不注册会报 "Could not load codec for 113"
  const helia = withLibp2p(createHeliaLight({
    blockstore,
    datastore,
    codecs: [dagCbor, dagJson, json],
    hashers: [sha512],
  }), {
    // 显式列出服务: createLibp2p 浅合并会覆盖默认 services
    services: {
      pubsub: gossipsub({ emitSelf: true }), // OrbitDB 同步必需; emitSelf 让单机也能 publish (否则 NoPeersSubscribedToTopic)
      autoNAT: autoNAT(),
      autoTLS: autoTLS(),
      dcutr: dcutr(),
      delegatedPeerRouting: delegatedRoutingV1HttpApiClientPeerRouting(delegatedHTTPRoutingDefaults()),
      delegatedContentRouting: delegatedRoutingV1HttpApiClientContentRouting(delegatedHTTPRoutingDefaults()),
      dht: kadDHT(),
      identify: identify(),
      identifyPush: identifyPush(),
      keychain: keychain({ pass: 'bolloon-orbitdb-keychain-pass-2026' }),
      ping: ping(),
      relay: circuitRelayServer(),
      upnp: uPnPNAT(),
      mdns: mdns(),
      http: http(),
    },
  } as any);

  await helia.start();
  const peerId = (helia as any).libp2p.peerId.toString();

  return {
    helia,
    peerId,
    paths: { dataDir: dir, blocksDir, datastoreDir },
    start: async () => { await helia.start(); },
    stop: async () => { await helia.stop(); },
  };
}

/** 从地址字符串解析 OrbitDB 数据库地址的 database name */
export function dbNameFromAddress(address: string): string {
  const parts = address.split('/');
  return parts[parts.length - 1] || address;
}
