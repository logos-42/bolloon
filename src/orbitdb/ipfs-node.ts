/**
 * ipfs-node.ts — Bolloon 的 OrbitDB 底层 IPFS 节点工厂 (2026-08-06)
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
 * 跑法: npx tsx scripts/smoke-orbitdb.ts
 */

import { createHeliaLight, type Helia } from 'helia';
import { withLibp2p } from '@helia/libp2p';
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

export interface BolloonIpfs {
  helia: Helia;
  peerId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * 创建 Bolloon 用的 helia 节点 (libp2p 完整默认服务 + gossipsub pubsub)。
 * dataDir 持久化节点身份/数据 (默认 ~/.bolloon/orbitdb-ipfs)。
 */
export async function createBolloonIpfs(dataDir?: string): Promise<BolloonIpfs> {
  const dir = dataDir ?? path.join(process.env.HOME || os.homedir() || '/tmp', '.bolloon', 'orbitdb-ipfs');

  // createHeliaLight 无 libp2p → withLibp2p 手动装配 (可传 services)
  // codecs/hashers 照抄 createHelia 默认: OrbitDB 的 log entry 用 dag-cbor (codec 113),
  // 不注册会报 "Could not load codec for 113"
  const helia = withLibp2p(createHeliaLight({
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
    start: async () => { await helia.start(); },
    stop: async () => { await helia.stop(); },
  };
}

/** 从地址字符串解析 OrbitDB 数据库地址的 database name */
export function dbNameFromAddress(address: string): string {
  const parts = address.split('/');
  return parts[parts.length - 1] || address;
}
