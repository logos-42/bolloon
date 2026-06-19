/**
 * local-inbox-bus.ts — 进程内 Agent 通信总线 (2026-06-19)
 *
 * 解决 bolloon "和另一个智能体发消息" 的本地场景:
 *   - 同进程内多个 PiAgentSession 实例 (例如 nodeA / nodeB 测试) 互发消息
 *   - 走 in-process EventEmitter, 不依赖 P2P 网络/Hyperswarm
 *   - 远端通信仍走 p2pNetwork.sendMessage + onMessage
 *
 * 用法:
 *   const bus = LocalInboxBus.getInstance();
 *   bus.subscribe('nodeA', (msg) => console.log('nodeA got:', msg));
 *   bus.deliver('nodeB', { from: 'nodeA', type: 'agent-message', payload: 'hi' });
 *
 * 角色标识: 默认从 process.env.BOLLOON_ROLE 读, 也可显式传
 */

import { EventEmitter } from 'events';

export interface InboxMessage {
  from: string;
  fromDid?: string;
  type: string;
  payload: string;
  timestamp: number;
  /** 可选 metadata, 比如 replyTo, channelId */
  meta?: Record<string, any>;
}

class LocalInboxBus {
  private static _instance: LocalInboxBus | null = null;
  private emitter: EventEmitter;
  /** 记录已注册的角色, deliver 时找不到会返回 false (避免 silent drop) */
  private registeredRoles: Set<string> = new Set();

  private constructor() {
    this.emitter = new EventEmitter();
    // 防止 listener 太多导致 memory leak
    this.emitter.setMaxListeners(1000);
  }

  static getInstance(): LocalInboxBus {
    if (!LocalInboxBus._instance) {
      LocalInboxBus._instance = new LocalInboxBus();
    }
    return LocalInboxBus._instance;
  }

  /**
   * 订阅角色 inbox — 投递到该角色的消息会回调 fn
   * 返回 unsubscribe 函数
   */
  subscribe(role: string, fn: (msg: InboxMessage) => void): () => void {
    this.registeredRoles.add(role);
    this.emitter.on(`role:${role}`, fn);
    return () => {
      this.emitter.off(`role:${role}`, fn);
      // 如果没人订阅, 移除 role (避免泄漏)
      if (this.emitter.listenerCount(`role:${role}`) === 0) {
        this.registeredRoles.delete(role);
      }
    };
  }

  /**
   * 投递消息到指定角色
   * 返回 true=已投递, false=角色未注册
   */
  deliver(role: string, msg: InboxMessage): boolean {
    if (!this.registeredRoles.has(role)) {
      return false;
    }
    this.emitter.emit(`role:${role}`, msg);
    return true;
  }

  /**
   * 列出当前进程所有已注册的角色
   */
  listRoles(): string[] {
    return Array.from(this.registeredRoles);
  }

  /**
   * 检查某角色是否已订阅
   */
  hasRole(role: string): boolean {
    return this.registeredRoles.has(role);
  }
}

export { LocalInboxBus };
export default LocalInboxBus;
