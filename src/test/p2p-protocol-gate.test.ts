/**
 * p2p-protocol-gate — P2P 入站协议遥测不进正文 (leo 2026-10-14: 「📩 收到/📥 [undefined] 刷屏 → tips 栏」)
 */
import { describe, it, expect } from 'vitest';
import { isP2PProtocolMessage } from '../index.js';

describe('isP2PProtocolMessage — v3 协议遥测识别', () => {
  it('v3 协议握手 → true (必须静默, 不刷正文)', () => {
    for (const l of [
      '{"v":3,"op":"agent.meta.list.request","payload":{"fromPublicKey":"abc"}}',
      '{"v":3,"op":"agent.heartbeat","payload":{"fromPublicKey":"abc","ts":123}}',
      '{"v":3,"op":"agent.manifest.exchange.reply","payload":{"channels":[]}}',
      '{"op":"agent.meta.list.reply","payload":{}}',
    ]) {
      expect(isP2PProtocolMessage(l), l.slice(0, 50)).toBe(true);
    }
  });

  it('真 RPC 任务 → false (走正文处理)', () => {
    for (const l of [
      '{"type":"summarize","documentPath":"/tmp/a.md","from":"did:key:x","id":"1"}',
      '{"type":"improve","documentPath":"/tmp/a.md","requirements":"x","from":"did:key:x","id":"2"}',
      'DID:key:abc|{"type":"summarize","documentPath":"/x","id":"3"}',
    ]) {
      expect(isP2PProtocolMessage(l), l.slice(0, 50)).toBe(false);
    }
  });

  it('边界: 用户文本含 "op" 字样但不构成协议 → false', () => {
    expect(isP2PProtocolMessage('你好, 帮我操作')).toBe(false);
    expect(isP2PProtocolMessage('')).toBe(false);
  });
});