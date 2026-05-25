/**
 * DiapDoc Parser - 解析 Diap 去中心化身份协议文档
 *
 * 负责解析 Diap 智能体发布的 IPFS/IPNS 文档，提取：
 * - DID (去中心化身份标识)
 * - 频道信息
 * - 能力列表
 * - 网络地址
 */

export interface DiapDoc {
  // 基本信息
  id: string;              // DID 标识
  name: string;             // 智能体名称
  version: string;          // 协议版本

  // 能力信息
  capabilities: string[];    // 支持的能力列表
  interests: string[];      // 兴趣领域

  // 网络信息
  peerId?: string;          // P2P peer ID
  multiaddrs?: string[];    // 网络地址列表
  relayAddr?: string;       // 中继地址

  // 频道信息
  channels?: DiapChannel[]; // 管理的频道列表

  // 身份信息
  publicKey?: string;       // 公钥
  signature?: string;       // 签名

  // 时间戳
  createdAt?: string;
  updatedAt?: string;
  timestamp?: number;
}

export interface DiapChannel {
  id: string;               // 频道 ID
  name: string;             // 频道名称
  topic?: string;           // 频道主题
  type?: 'interest' | 'capability' | 'region' | 'ad_hoc';
  isPublic?: boolean;       // 是否公开
  memberCount?: number;     // 成员数量
}

export interface ParseResult {
  success: boolean;
  doc?: DiapDoc;
  error?: string;
}

/**
 * DiapDoc Parser 类
 */
export class DiapDocParser {
  /**
   * 解析 Diap 文档 (从 IPFS CID 或 IPNS 获取的内容)
   */
  parse(content: string): ParseResult {
    try {
      const data = JSON.parse(content);

      // 验证必需字段
      if (!data.id && !data.did) {
        return {
          success: false,
          error: 'Missing required field: id or did'
        };
      }

      const doc: DiapDoc = {
        id: data.id || data.did,
        name: data.name || 'Unknown Agent',
        version: data.version || '1.0',

        // 能力信息
        capabilities: this.normalizeArray(data.capabilities || data.capability || []),
        interests: this.normalizeArray(data.interests || data.interest || []),

        // 网络信息
        peerId: data.peerId || data.peer_id || data.peer,
        multiaddrs: this.normalizeArray(data.multiaddrs || data.addresses || []),
        relayAddr: data.relayAddr || data.relay_addr || data.relay,

        // 频道信息
        channels: this.parseChannels(data.channels || data.channel || []),

        // 身份信息
        publicKey: data.publicKey || data.public_key,
        signature: data.signature,

        // 时间戳
        createdAt: data.createdAt || data.created_at,
        updatedAt: data.updatedAt || data.updated_at,
        timestamp: data.timestamp || data.createdAt ? Date.now() : undefined
      };

      return { success: true, doc };
    } catch (e) {
      return {
        success: false,
        error: `Failed to parse DiapDoc: ${e}`
      };
    }
  }

  /**
   * 解析频道数组
   */
  private parseChannels(channels: any[]): DiapChannel[] {
    if (!Array.isArray(channels)) return [];

    return channels.map(ch => {
      if (typeof ch === 'string') {
        return {
          id: ch,
          name: ch
        };
      }

      return {
        id: ch.id || ch.channelId || ch.channel_id || String(Date.now()),
        name: ch.name || ch.channelName || ch.channel_name || 'Unnamed Channel',
        topic: ch.topic,
        type: ch.type,
        isPublic: ch.isPublic ?? ch.is_public ?? true,
        memberCount: ch.memberCount || ch.member_count
      };
    });
  }

  /**
   * 规范化数组
   */
  private normalizeArray(value: any): string[] {
    if (Array.isArray(value)) {
      return value.map(v => String(v));
    }
    if (typeof value === 'string') {
      return [value];
    }
    return [];
  }

  /**
   * 从 CID 解析文档
   */
  async parseFromCID(cid: string, ipfsEndpoint: string = 'http://127.0.0.1:5001'): Promise<ParseResult> {
    try {
      const { IpfsClient } = await import('@diap/sdk');
      const ipfs = new IpfsClient(ipfsEndpoint, null);

      const content = await ipfs.get(cid);
      return this.parse(content);
    } catch (e) {
      return {
        success: false,
        error: `Failed to fetch from IPFS: ${e}`
      };
    }
  }

  /**
   * 从 IPNS 解析文档
   */
  async parseFromIPNS(ipnsName: string, ipfsEndpoint: string = 'http://127.0.0.1:5001'): Promise<ParseResult> {
    try {
      const { IpfsClient } = await import('@diap/sdk');
      const ipfs = new IpfsClient(ipfsEndpoint, null);

      const cid = await ipfs.resolveIpns(ipnsName);
      if (!cid) {
        return {
          success: false,
          error: 'IPNS resolve returned no CID'
        };
      }

      return this.parseFromCID(cid, ipfsEndpoint);
    } catch (e) {
      return {
        success: false,
        error: `Failed to resolve IPNS: ${e}`
      };
    }
  }

  /**
   * 从 URL 解析 (用于解析网关返回的内容)
   */
  parseFromUrl(url: string): Promise<ParseResult> {
    return fetch(url)
      .then(resp => resp.text())
      .then(content => this.parse(content))
      .catch(e => ({
        success: false,
        error: `Failed to fetch URL: ${e}`
      }));
  }

  /**
   * 提取 DID
   */
  extractDID(doc: DiapDoc): string {
    return doc.id;
  }

  /**
   * 提取用于连接的信息
   */
  extractConnectionInfo(doc: DiapDoc): {
    peerId?: string;
    multiaddrs: string[];
    relayAddr?: string;
  } {
    return {
      peerId: doc.peerId,
      multiaddrs: doc.multiaddrs || [],
      relayAddr: doc.relayAddr
    };
  }

  /**
   * 提取频道列表
   */
  extractChannels(doc: DiapDoc): DiapChannel[] {
    return doc.channels || [];
  }

  /**
   * 验证文档签名 (如果实现)
   */
  async verifySignature(doc: DiapDoc): Promise<boolean> {
    if (!doc.publicKey || !doc.signature) {
      return true; // 无签名时默认通过
    }

    // TODO: 实现签名验证
    return true;
  }
}

// 全局解析器实例
let parserInstance: DiapDocParser | null = null;

export function createDiapDocParser(): DiapDocParser {
  return new DiapDocParser();
}

export function getDiapDocParser(): DiapDocParser {
  if (!parserInstance) {
    parserInstance = new DiapDocParser();
  }
  return parserInstance;
}

/**
 * 从 DiapAnnouncement 提取 DiapDoc 信息
 */
export function extractDocFromAnnouncement(announcement: {
  leaderDid: string;
  channelName: string;
  channelId?: string;
  topic?: string;
  capabilities?: string[];
  interests?: string[];
}): DiapDoc {
  return {
    id: announcement.leaderDid,
    name: announcement.channelName,
    version: '1.0',
    capabilities: announcement.capabilities || [],
    interests: announcement.interests || [],
    channels: announcement.channelId ? [{
      id: announcement.channelId,
      name: announcement.channelName,
      topic: announcement.topic
    }] : []
  };
}