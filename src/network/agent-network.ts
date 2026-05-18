import * as fs from 'fs/promises';
import * as path from 'path';
import { multiaddr as createMultiaddr } from '@multiformats/multiaddr';
import { KeyManager } from '@diap/sdk';
import { p2pNetwork, type PersistentPeerInfo } from './p2p.js';

const AGENT_REGISTRY_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'agent-registry.json');
const KEY_PAIR_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'keypair.json');

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  did: string;
}

export interface AgentEndpoint {
  did: string;
  name: string;
  peerId: string;
  multiaddrs: string[];
  lastSeen?: number;
  publicKey?: string;
  signature?: string;
}

export interface AgentRegistryEntry {
  did: string;
  name: string;
  peerId: string;
  multiaddrs: string[];
  registeredAt: number;
  lastSeen: number;
  lastBroadcast: number;
  publicKey: string;
  relayAddr?: string;
  canRelay?: boolean;
}

export interface SignedMessage {
  type: string;
  from: string;
  name: string;
  payload: string;
  timestamp: number;
  signature: string;
}

export interface AddressBroadcast {
  type: 'address_broadcast';
  from: string;
  name: string;
  peerId: string;
  multiaddrs: string[];
  relayAddr?: string;
  canRelay?: boolean;
  timestamp: number;
  signature: string;
}

export interface DiscoveryMessage {
  type: 'discovery';
  from: string;
  name: string;
  capability: string[];
  timestamp: number;
  signature: string;
}

const ADDRESS_BROADCAST_INTERVAL = 5 * 60 * 1000;
const RELAY_RETRY_INTERVAL = 30000;
const MAX_RELAY_HOPS = 3;
const MESSAGE_TIMESTAMP_TOLERANCE = 24 * 60 * 60 * 1000;
const SIGNED_MESSAGE_TYPES = ['task', 'response', 'discovery', 'address_broadcast'] as const;

export class AgentRegistry {
  private agents: Map<string, AgentRegistryEntry> = new Map();
  private registryPath: string;
  private ownEndpoint: AgentEndpoint | null = null;
  private keyPair: KeyPair | null = null;
  private keyPairPath: string;
  private relayMode: boolean = false;
  private pendingRelayMessages: Map<string, { data: Uint8Array; hops: number }[]> = new Map();

  constructor() {
    this.registryPath = AGENT_REGISTRY_PATH;
    this.keyPairPath = KEY_PAIR_PATH;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    await this.loadRegistry();
    await this.loadOrCreateKeyPair();
  }

  private async loadOrCreateKeyPair(): Promise<void> {
    try {
      const data = await fs.readFile(this.keyPairPath, 'utf-8');
      const keyFile = JSON.parse(data);
      this.keyPair = {
        privateKey: Buffer.from(keyFile.privateKey, 'hex'),
        publicKey: Buffer.from(keyFile.publicKey, 'hex'),
        did: keyFile.did
      };
      console.log(`[Registry] Loaded keypair: ${this.keyPair.did.substring(0, 20)}...`);
    } catch {
      console.log(`[Registry] Generating new keypair...`);
      const kp = KeyManager.generate();
      this.keyPair = {
        privateKey: kp.privateKey,
        publicKey: kp.publicKey,
        did: kp.did
      };
      await this.saveKeyPair();
      console.log(`[Registry] New keypair created: ${this.keyPair.did.substring(0, 20)}...`);
    }
  }

  private async saveKeyPair(): Promise<void> {
    if (!this.keyPair) return;
    const keyFile = {
      privateKey: Buffer.from(this.keyPair.privateKey).toString('hex'),
      publicKey: Buffer.from(this.keyPair.publicKey).toString('hex'),
      did: this.keyPair.did,
      createdAt: new Date().toISOString()
    };
    await fs.writeFile(this.keyPairPath, JSON.stringify(keyFile, null, 2));
  }

  getKeyPair(): KeyPair | null {
    return this.keyPair;
  }

  async loadRegistry(): Promise<void> {
    try {
      const data = await fs.readFile(this.registryPath, 'utf-8');
      const entries: AgentRegistryEntry[] = JSON.parse(data);
      for (const entry of entries) {
        this.agents.set(entry.did, entry);
      }
      console.log(`[Registry] Loaded ${entries.length} known agents`);
    } catch {
      console.log(`[Registry] No existing registry found`);
    }
  }

  private async saveRegistry(): Promise<void> {
    try {
      const entries = Array.from(this.agents.values());
      await fs.writeFile(this.registryPath, JSON.stringify(entries, null, 2));
    } catch (e) {
      console.warn(`[Registry] Failed to save:`, e);
    }
  }

  setOwnEndpoint(endpoint: AgentEndpoint): void {
    this.ownEndpoint = endpoint;
    if (this.keyPair) {
      endpoint.did = this.keyPair.did;
      endpoint.publicKey = Buffer.from(this.keyPair.publicKey).toString('hex');
    }
    this.registerAgent(endpoint);
  }

  getOwnEndpoint(): AgentEndpoint | null {
    return this.ownEndpoint;
  }

  async signMessage(data: string): Promise<Uint8Array | null> {
    if (!this.keyPair) {
      console.warn(`[Registry] No keypair available for signing`);
      return null;
    }
    try {
      const signature = await KeyManager.sign(this.keyPair, new TextEncoder().encode(data));
      return signature;
    } catch (e) {
      console.warn(`[Registry] Signing failed:`, e);
      return null;
    }
  }

  async verifySignature(did: string, data: string, signature: Uint8Array): Promise<boolean> {
    try {
      const agent = this.agents.get(did);
      if (!agent || !agent.publicKey) {
        console.warn(`[Registry] Unknown agent or missing public key: ${did.substring(0, 20)}`);
        return false;
      }

      const publicKey = Buffer.from(agent.publicKey, 'hex');
      const keyPair = { privateKey: new Uint8Array(32), publicKey, did };
      const isValid = await KeyManager.verify(keyPair, new TextEncoder().encode(data), signature);

      if (!isValid) {
        console.warn(`[Registry] Invalid signature from ${did.substring(0, 20)}`);
      }

      return isValid;
    } catch (e) {
      console.warn(`[Registry] Verification failed:`, e);
      return false;
    }
  }

  registerAgent(endpoint: AgentEndpoint): void {
    const entry: AgentRegistryEntry = {
      did: endpoint.did,
      name: endpoint.name,
      peerId: endpoint.peerId,
      multiaddrs: endpoint.multiaddrs,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
      lastBroadcast: 0,
      publicKey: endpoint.publicKey || ''
    };

    const existing = this.agents.get(endpoint.did);
    if (existing) {
      entry.registeredAt = existing.registeredAt;
      entry.lastBroadcast = existing.lastBroadcast;
      if (endpoint.publicKey && !existing.publicKey) {
        entry.publicKey = endpoint.publicKey;
      }
    }

    this.agents.set(endpoint.did, entry);
    this.saveRegistry();
    console.log(`[Registry] Registered agent: ${endpoint.name} (${endpoint.did.substring(0, 20)}...)`);
  }

  getAgent(did: string): AgentRegistryEntry | undefined {
    return this.agents.get(did);
  }

  getAgentByPeerId(peerId: string): AgentRegistryEntry | undefined {
    for (const agent of this.agents.values()) {
      if (agent.peerId === peerId) {
        return agent;
      }
    }
    return undefined;
  }

  getAllAgents(): AgentRegistryEntry[] {
    return Array.from(this.agents.values());
  }

  getOnlineAgents(timeoutMs: number = 10 * 60 * 1000): AgentRegistryEntry[] {
    const now = Date.now();
    return Array.from(this.agents.values()).filter(
      a => now - a.lastSeen < timeoutMs
    );
  }

  updateLastSeen(did: string): void {
    const agent = this.agents.get(did);
    if (agent) {
      agent.lastSeen = Date.now();
      this.saveRegistry();
    }
  }

  removeAgent(did: string): void {
    this.agents.delete(did);
    this.saveRegistry();
  }

  async createSignedBroadcast(): Promise<AddressBroadcast | null> {
    if (!this.ownEndpoint || !this.keyPair) return null;

    const now = Date.now();
    const entry = this.agents.get(this.ownEndpoint.did);
    if (entry && now - entry.lastBroadcast < ADDRESS_BROADCAST_INTERVAL) {
      return null;
    }

    const relayAddr = (p2pNetwork as any).getRelayAddress?.() || null;

    const broadcastData = JSON.stringify({
      type: 'address_broadcast',
      from: this.keyPair.did,
      name: this.ownEndpoint.name,
      peerId: this.ownEndpoint.peerId,
      multiaddrs: this.ownEndpoint.multiaddrs,
      relayAddr: relayAddr || undefined,
      canRelay: relayAddr ? true : false,
      timestamp: now
    });

    const signature = await this.signMessage(broadcastData);
    if (!signature) return null;

    const broadcast: AddressBroadcast = {
      type: 'address_broadcast',
      from: this.keyPair.did,
      name: this.ownEndpoint.name,
      peerId: this.ownEndpoint.peerId,
      multiaddrs: this.ownEndpoint.multiaddrs,
      relayAddr: relayAddr || undefined,
      canRelay: relayAddr ? true : false,
      timestamp: now,
      signature: Buffer.from(signature).toString('hex')
    };

    if (entry) {
      entry.lastBroadcast = now;
    }

    return broadcast;
  }

  async handleAddressBroadcast(broadcast: AddressBroadcast): Promise<boolean> {
    if (!this.keyPair || broadcast.from === this.keyPair.did) {
      return false;
    }

    if (Math.abs(broadcast.timestamp - Date.now()) > MESSAGE_TIMESTAMP_TOLERANCE) {
      console.log(`[Registry] Stale broadcast from ${broadcast.from.substring(0, 20)}`);
      return false;
    }

    const broadcastData = JSON.stringify({
      type: 'address_broadcast',
      from: broadcast.from,
      name: broadcast.name,
      peerId: broadcast.peerId,
      multiaddrs: broadcast.multiaddrs,
      relayAddr: broadcast.relayAddr,
      canRelay: broadcast.canRelay,
      timestamp: broadcast.timestamp
    });

    const signature = Buffer.from(broadcast.signature, 'hex');
    const isValid = await this.verifySignature(broadcast.from, broadcastData, signature);
    if (!isValid) {
      console.warn(`[Registry] Invalid broadcast signature from ${broadcast.from.substring(0, 20)}`);
      return false;
    }

    const entry: AgentRegistryEntry = {
      did: broadcast.from,
      name: broadcast.name,
      peerId: broadcast.peerId,
      multiaddrs: broadcast.multiaddrs,
      registeredAt: Date.now(),
      lastSeen: broadcast.timestamp,
      lastBroadcast: 0,
      publicKey: Buffer.from(this.keyPair.publicKey).toString('hex'),
      relayAddr: broadcast.relayAddr,
      canRelay: broadcast.canRelay
    };

    const existing = this.agents.get(broadcast.from);
    if (existing) {
      entry.registeredAt = existing.registeredAt;
      entry.lastBroadcast = existing.lastBroadcast;
      if (!existing.publicKey) {
        existing.publicKey = entry.publicKey;
      }
    }

    this.agents.set(broadcast.from, entry);
    this.saveRegistry();

    console.log(`[Registry] Verified broadcast from: ${broadcast.name} (${broadcast.from.substring(0, 20)}...) ${broadcast.canRelay ? '[Relay Capable]' : ''}`);
    return true;
  }

  async createSignedMessage(type: string, payload: string): Promise<SignedMessage | null> {
    if (!this.keyPair || !this.ownEndpoint) return null;

    const messageData = JSON.stringify({
      type,
      from: this.keyPair.did,
      name: this.ownEndpoint.name,
      payload,
      timestamp: Date.now()
    });

    const signature = await this.signMessage(messageData);
    if (!signature) return null;

    return {
      type,
      from: this.keyPair.did,
      name: this.ownEndpoint.name,
      payload,
      timestamp: Date.now(),
      signature: Buffer.from(signature).toString('hex')
    };
  }

  async verifySignedMessage(msg: SignedMessage): Promise<boolean> {
    if (!this.keyPair || msg.from === this.keyPair.did) {
      return false;
    }

    if (Math.abs(msg.timestamp - Date.now()) > MESSAGE_TIMESTAMP_TOLERANCE) {
      console.log(`[Registry] Stale message from ${msg.from.substring(0, 20)}`);
      return false;
    }

    const messageData = JSON.stringify({
      type: msg.type,
      from: msg.from,
      name: msg.name,
      payload: msg.payload,
      timestamp: msg.timestamp
    });

    const signature = Buffer.from(msg.signature, 'hex');
    return this.verifySignature(msg.from, messageData, signature);
  }

  async connectToAgent(did: string): Promise<boolean> {
    const agent = this.agents.get(did);
    if (!agent) {
      console.log(`[Registry] Unknown agent: ${did}`);
      return false;
    }

    if (!agent.multiaddrs || agent.multiaddrs.length === 0) {
      console.log(`[Registry] No addresses for agent: ${agent.name}`);
      if (!agent.relayAddr) {
        return false;
      }
      console.log(`[Registry] Agent has relay address, will try relay connection`);
    }

    let connected = false;

    if (agent.multiaddrs && agent.multiaddrs.length > 0) {
      for (const addr of agent.multiaddrs) {
        try {
          const ma = createMultiaddr(addr);
          const node = (p2pNetwork as any).node;
          if (node) {
            await node.dial(ma);
            connected = true;
            console.log(`[Registry] Direct connection to ${agent.name} at ${addr}`);
            break;
          }
        } catch (e) {
          console.warn(`[Registry] Failed to connect directly to ${addr}:`, e);
        }
      }
    }

    if (!connected && agent.relayAddr) {
      console.log(`[Registry] Trying relay connection to ${agent.name} via ${agent.relayAddr}`);
      try {
        const node = (p2pNetwork as any).node;
        if (node) {
          const ma = createMultiaddr(`${agent.relayAddr}/p2p/${agent.peerId}`);
          await node.dial(ma);
          connected = true;
          console.log(`[Registry] Relay connection to ${agent.name} established`);
        }
      } catch (e) {
        console.warn(`[Registry] Failed to connect via relay:`, e);
      }
    }

    if (!connected && agent.canRelay) {
      const relayPeers = this.findRelayPeers();
      for (const relay of relayPeers) {
        if (relay.peerId === agent.peerId) continue;
        try {
          console.log(`[Registry] Trying to relay via ${relay.name} (${relay.peerId.substring(0, 12)}...)`);
          const relayAddr = relay.relayAddr || relay.multiaddrs?.[0];
          if (relayAddr) {
            const node = (p2pNetwork as any).node;
            if (node) {
              const ma = createMultiaddr(`${relayAddr}/p2p/${agent.peerId}`);
              await node.dial(ma);
              connected = true;
              console.log(`[Registry] Connection to ${agent.name} via relay ${relay.name}`);
              break;
            }
          }
        } catch (e) {
          console.warn(`[Registry] Failed to relay via ${relay.name}:`, e);
        }
      }
    }

    if (connected) {
      this.updateLastSeen(did);
      p2pNetwork.addPersistentPeer({
        peerId: agent.peerId,
        multiaddrs: agent.multiaddrs,
        did: agent.did,
        name: agent.name,
        relayAddr: agent.relayAddr,
        canRelay: agent.canRelay
      });
    }

    return connected;
  }

  private findRelayPeers(): AgentRegistryEntry[] {
    const now = Date.now();
    return Array.from(this.agents.values()).filter(
      a => a.canRelay && a.relayAddr && now - a.lastSeen < 30 * 60 * 1000
    );
  }

  async relayMessage(toDid: string, data: Uint8Array, fromDid: string, hops = 0): Promise<boolean> {
    if (hops >= MAX_RELAY_HOPS) {
      console.log(`[Registry] Max relay hops reached for ${toDid}`);
      return false;
    }

    const targetAgent = this.agents.get(toDid);
    if (!targetAgent) {
      console.log(`[Registry] Unknown relay target: ${toDid}`);
      return false;
    }

    try {
      const peerId = targetAgent.peerId;
      const relayMsg = new TextEncoder().encode(
        `RELAY:${fromDid}|${hops + 1}|${new TextDecoder().decode(data)}`
      );
      await p2pNetwork.sendMessage(peerId, 'relay', new TextDecoder().decode(relayMsg));
      return true;
    } catch (e) {
      console.warn(`[Registry] Relay failed to ${toDid}:`, e);
      return false;
    }
  }

  getConnectionInfo(): { did: string; name: string; peerId: string; multiaddrs: string[] } | null {
    if (!this.ownEndpoint) return null;
    return {
      did: this.ownEndpoint.did,
      name: this.ownEndpoint.name,
      peerId: this.ownEndpoint.peerId,
      multiaddrs: this.ownEndpoint.multiaddrs
    };
  }
}

export const agentRegistry = new AgentRegistry();

export class AgentMessaging {
  private registry: AgentRegistry;
  private messageHandlers: Map<string, (msg: Uint8Array, from: string, did?: string) => void> = new Map();

  constructor(registry: AgentRegistry) {
    this.registry = registry;
  }

  registerHandler(type: string, handler: (msg: Uint8Array, from: string, did?: string) => void): void {
    this.messageHandlers.set(type, handler);
  }

  async sendSignedToAgent(did: string, type: string, payload: string): Promise<boolean> {
    const agent = this.registry.getAgent(did);
    if (!agent) {
      console.log(`[Messaging] Unknown agent: ${did}`);
      return false;
    }

    const signedMsg = await this.registry.createSignedMessage(type, payload);
    if (!signedMsg) {
      console.warn(`[Messaging] Failed to create signed message`);
      return false;
    }

    try {
      const messageStr = JSON.stringify(signedMsg);
      await p2pNetwork.sendMessage(agent.peerId, 'signed', messageStr);
      return true;
    } catch (e) {
      console.warn(`[Messaging] Failed to send to ${did}:`, e);
      return false;
    }
  }

  async sendToAgent(did: string, type: string, payload: string): Promise<boolean> {
    const agent = this.registry.getAgent(did);
    if (!agent) {
      console.log(`[Messaging] Unknown agent: ${did}`);
      return false;
    }

    const message = `${type}:${payload}`;

    try {
      await p2pNetwork.sendMessage(agent.peerId, type, payload);
      return true;
    } catch (e) {
      console.warn(`[Messaging] Failed to send to ${did}:`, e);
      return false;
    }
  }

  async broadcastToAll(type: string, payload: string): Promise<void> {
    const agents = this.registry.getOnlineAgents();
    const ownEndpoint = this.registry.getOwnEndpoint();

    for (const agent of agents) {
      if (agent.did === ownEndpoint?.did) continue;

      try {
        await p2pNetwork.sendMessage(agent.peerId, type, payload);
      } catch (e) {
        console.warn(`[Messaging] Broadcast failed to ${agent.name}:`, e);
      }
    }
  }

  parseMessage(data: Uint8Array): { type: string; payload: string; did?: string; isRelay?: boolean; relayHops?: number } | null {
    const messageStr = new TextDecoder().decode(data);

    if (messageStr.startsWith('RELAY:')) {
      const parts = messageStr.substring(6).split('|');
      if (parts.length >= 3) {
        const fromDid = parts[0];
        const hops = parseInt(parts[1], 10);
        const innerMessage = parts.slice(2).join('|');
        return this.parseInnerMessage(innerMessage, fromDid, true, hops);
      }
    }

    return this.parseInnerMessage(messageStr, undefined, false);
  }

  private parseInnerMessage(messageStr: string, relayFrom?: string, isRelay = false, relayHops = 0): { type: string; payload: string; did?: string; isRelay?: boolean; relayHops?: number } | null {
    if (messageStr.startsWith('DID:')) {
      const didEndIdx = messageStr.indexOf('|');
      if (didEndIdx > 0) {
        const did = messageStr.substring(4, didEndIdx);
        const afterDid = messageStr.substring(didEndIdx + 1);
        const colonIdx = afterDid.indexOf(':');
        if (colonIdx > 0) {
          return {
            type: afterDid.substring(0, colonIdx),
            payload: afterDid.substring(colonIdx + 1),
            did: relayFrom || did,
            isRelay,
            relayHops
          };
        }
        return { type: afterDid, payload: '', did: relayFrom || did, isRelay, relayHops };
      }
    }

    const colonIdx = messageStr.indexOf(':');
    if (colonIdx > 0) {
      return {
        type: messageStr.substring(0, colonIdx),
        payload: messageStr.substring(colonIdx + 1),
        did: relayFrom,
        isRelay,
        relayHops
      };
    }
    return { type: messageStr, payload: '', did: relayFrom, isRelay, relayHops };
  }

  async dispatchSignedMessage(data: Uint8Array, fromPeerId: string): Promise<boolean> {
    try {
      const messageStr = new TextDecoder().decode(data);
      const signedMsg: SignedMessage = JSON.parse(messageStr);

      if (!signedMsg.type || !signedMsg.from || !signedMsg.signature) {
        console.warn(`[Messaging] Invalid signed message format`);
        return false;
      }

      const isValid = await this.registry.verifySignedMessage(signedMsg);
      if (!isValid) {
        console.warn(`[Messaging] Signature verification failed for ${signedMsg.from.substring(0, 20)}`);
        return false;
      }

      const handler = this.messageHandlers.get(signedMsg.type);
      if (handler) {
        handler(data, fromPeerId, signedMsg.from);
      }

      return true;
    } catch (e) {
      console.warn(`[Messaging] Failed to dispatch signed message:`, e);
      return false;
    }
  }

  dispatchMessage(data: Uint8Array, fromPeerId: string): void {
    const parsed = this.parseMessage(data);
    if (!parsed) return;

    const handler = this.messageHandlers.get(parsed.type);
    if (handler) {
      handler(data, fromPeerId, parsed.did);
    }
  }
}

export const agentMessaging = new AgentMessaging(agentRegistry);

export async function initializeAgentNetwork(
  ownDid: string,
  ownName: string,
  peerId: string,
  multiaddrs: string[]
): Promise<void> {
  await agentRegistry.initialize();

  const keyPair = agentRegistry.getKeyPair();
  const publicKeyHex = keyPair ? Buffer.from(keyPair.publicKey).toString('hex') : undefined;

  agentRegistry.setOwnEndpoint({
    did: keyPair?.did || ownDid,
    name: ownName,
    peerId,
    multiaddrs,
    publicKey: publicKeyHex
  });

  p2pNetwork.setOwnDid(keyPair?.did || ownDid);

  p2pNetwork.onMessage('signed', async (data, from, did) => {
    await agentMessaging.dispatchSignedMessage(data, from);
  });

  p2pNetwork.onMessage('address_broadcast', async (data, from, did) => {
    try {
      const messageStr = new TextDecoder().decode(data);
      const broadcast: AddressBroadcast = JSON.parse(messageStr);
      if (broadcast.type === 'address_broadcast') {
        await agentRegistry.handleAddressBroadcast(broadcast);
      }
    } catch (e) {
      console.warn(`[AgentNetwork] Failed to handle address broadcast:`, e);
    }
  });

  p2pNetwork.onMessage('relay', (data, from, did) => {
    try {
      const relayMsg = new TextDecoder().decode(data);
      const relayMatch = relayMsg.match(/^RELAY:(.+?)\|(\d+)\|(.+)$/);
      if (relayMatch) {
        const [, targetDid, hopsStr, innerData] = relayMatch;
        const hops = parseInt(hopsStr, 10);

        if (hops < MAX_RELAY_HOPS) {
          agentRegistry.relayMessage(targetDid, new TextEncoder().encode(innerData), did || from, hops);
        }
      }
    } catch (e) {
      console.warn(`[AgentNetwork] Failed to handle relay:`, e);
    }
  });

  p2pNetwork.onMessage('discovery', async (data, from, did) => {
    try {
      const messageStr = new TextDecoder().decode(data);
      const discovery: DiscoveryMessage = JSON.parse(messageStr);
      if (discovery.type === 'discovery') {
        const isValid = await agentRegistry.verifySignature(
          discovery.from,
          JSON.stringify({ ...discovery, signature: undefined }),
          Buffer.from(discovery.signature, 'hex')
        );
        if (isValid) {
          console.log(`[AgentNetwork] Verified discovery from: ${discovery.name}`);
        }
      }
    } catch (e) {
      console.warn(`[AgentNetwork] Failed to handle discovery:`, e);
    }
  });

  console.log(`[AgentNetwork] Initialized with DID: ${keyPair?.did.substring(0, 20) || ownDid.substring(0, 20)}...`);
}

export async function broadcastOwnAddress(): Promise<void> {
  const broadcast = await agentRegistry.createSignedBroadcast();
  if (broadcast) {
    const data = JSON.stringify(broadcast);
    await p2pNetwork.broadcast('address_broadcast', data);
    console.log(`[AgentNetwork] Broadcast signed address to network`);
  }
}

export async function findAndConnectToAgent(did: string): Promise<boolean> {
  return agentRegistry.connectToAgent(did);
}

export async function sendMessageToAgent(did: string, type: string, payload: string): Promise<boolean> {
  return agentMessaging.sendSignedToAgent(did, type, payload);
}

export async function sendUnverifiedMessageToAgent(did: string, type: string, payload: string): Promise<boolean> {
  return agentMessaging.sendToAgent(did, type, payload);
}