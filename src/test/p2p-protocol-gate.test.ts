/**
 * p2p-protocol-gate — P2P 入站协议遥测不进正文 (leo 2026-10-14: 「📩 收到/📥 [undefined] 刷屏 → tips 栏」)
 */
import { describe, it, expect } from 'vitest';
import { isP2PProtocolMessage, shouldShowStagePreview } from '../index.js';

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

describe('shouldShowStagePreview — 阶段性进展上屏判定 (leo 2026-10-14: 「循环中间模型说的阶段性总结被丢」)', () => {
  it('有实质内容的阶段性文本 → true (该显示)', () => {
    expect(shouldShowStagePreview('已完成前两步, 接下来检查测试结果并汇总报告。', '')).toBe(true);
    expect(shouldShowStagePreview('正在分析项目结构, 已经找到 3 个关键模块。', '上一轮')).toBe(true);
  });
  it('工具调用音/JSON → false (不是阶段性总结)', () => {
    expect(shouldShowStagePreview('```json\n{"name":"read_file","input":{"path":"x"}}\n```', '')).toBe(false);
    expect(shouldShowStagePreview('{"name":"terminal","input":{"command":"ls"}}', '')).toBe(false);
    expect(shouldShowStagePreview('<tool_call>read_file</tool_call>', '')).toBe(false);
  });
  it('太短 (<12 字) → false', () => {
    expect(shouldShowStagePreview('好的', '')).toBe(false);
    expect(shouldShowStagePreview('继续', '')).toBe(false);
  });
  it('相邻重复 → false (去重, 不重复打同一个框)', () => {
    const t = '这是上一条已经显示过的阶段性总结文本。';
    expect(shouldShowStagePreview(t, t)).toBe(false);
  });
});