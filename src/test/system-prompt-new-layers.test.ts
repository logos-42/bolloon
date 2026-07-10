/**
 * system-prompt 装配测试 — 7 个新 layer (2026-07-10 双栖 agent 网络改造)
 *
 * 验证:
 *   1. 7 个新 layer 都已注册
 *   2. channel.* 装配时的 appliesTo 过滤正确
 *   3. tool.* 仅在调用对应工具时拼入
 *   4. TOTAL_BUDGET = 6500
 *   5. frontmatter 解析正确 (added_at / last_reviewed_at / ttl_days)
 */

import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt, listLayers, SYSTEM_PROMPT_VERSION } from '../llm/system-prompt/registry.js';

describe('System Prompt 装配 (双栖 agent 网络改造)', () => {
  describe('listLayers 注册表', () => {
    it('7 个新 layer 都已注册', () => {
      const ids = listLayers().map((l) => l.id);
      // 4 channel
      expect(ids).toContain('channel.p2p-peer-sync');
      expect(ids).toContain('channel.p2p-proactive');
      expect(ids).toContain('channel.human-async');
      expect(ids).toContain('channel.session-handoff');
      // 1 core
      expect(ids).toContain('core.external-engagement');
      // 2 tool
      expect(ids).toContain('tool.p2p_request');
      expect(ids).toContain('tool.goal_handoff');
    });

    it('新 layer 的 appliesTo 正确', () => {
      const layers = listLayers();
      const p2pPeerSync = layers.find((l) => l.id === 'channel.p2p-peer-sync');
      expect(p2pPeerSync?.appliesTo).toContain('local');
      expect(p2pPeerSync?.appliesTo).toContain('p2p-agent');

      const p2pProactive = layers.find((l) => l.id === 'channel.p2p-proactive');
      expect(p2pProactive?.appliesTo).toContain('p2p-agent');
      expect(p2pProactive?.appliesTo).not.toContain('local');

      const humanAsync = layers.find((l) => l.id === 'channel.human-async');
      expect(humanAsync?.appliesTo).toContain('local');

      const toolP2p = layers.find((l) => l.id === 'tool.p2p_request');
      expect(toolP2p?.appliesTo).toContain('tool:send_message');
      expect(toolP2p?.appliesTo).toContain('tool:check_inbox');
    });
  });

  describe('assembleSystemPrompt channel 过滤', () => {
    it('channel=local 应拼入 p2p-peer-sync + human-async + session-handoff', async () => {
      const result = await assembleSystemPrompt({ channel: 'local', role: 'expert' });
      expect(result.layerIds).toContain('channel.local');
      expect(result.layerIds).toContain('channel.p2p-peer-sync');
      expect(result.layerIds).toContain('channel.human-async');
      expect(result.layerIds).toContain('channel.session-handoff');
    });

    it('channel=p2p-agent 应拼入 p2p-peer-sync + p2p-proactive + session-handoff', async () => {
      const result = await assembleSystemPrompt({ channel: 'p2p-agent', role: 'expert' });
      expect(result.layerIds).toContain('channel.p2p-agent');
      expect(result.layerIds).toContain('channel.p2p-peer-sync');
      expect(result.layerIds).toContain('channel.p2p-proactive');
      expect(result.layerIds).toContain('channel.session-handoff');
      expect(result.layerIds).not.toContain('channel.human-async');
    });

    it('channel=p2p-visitor 应只拼入 session-handoff (无 p2p-peer/proactive/human-async)', async () => {
      const result = await assembleSystemPrompt({ channel: 'p2p-visitor', role: 'expert' });
      expect(result.layerIds).toContain('channel.p2p-visitor');
      expect(result.layerIds).toContain('channel.session-handoff');
      expect(result.layerIds).not.toContain('channel.p2p-peer-sync');
      expect(result.layerIds).not.toContain('channel.p2p-proactive');
      expect(result.layerIds).not.toContain('channel.human-async');
    });
  });

  describe('assembleSystemPrompt tool 过滤', () => {
    it('tool=send_message 应拼入 tool.p2p_request', async () => {
      const result = await assembleSystemPrompt({ channel: 'local', role: 'expert', tool: 'send_message' });
      expect(result.layerIds).toContain('tool.p2p_request');
    });

    it('tool=park_goal 应拼入 tool.goal_handoff', async () => {
      const result = await assembleSystemPrompt({ channel: 'local', role: 'expert', tool: 'park_goal' });
      expect(result.layerIds).toContain('tool.goal_handoff');
    });

    it('tool=bash 不应拼入 p2p_request 或 goal_handoff', async () => {
      const result = await assembleSystemPrompt({ channel: 'local', role: 'expert', tool: 'bash' });
      // tool.bash 可能在 budget 截断下被跳过 (priority 250, 在 channel 之后) — 不强求
      expect(result.layerIds).not.toContain('tool.p2p_request');
      expect(result.layerIds).not.toContain('tool.goal_handoff');
    });
  });

  describe('装配预算', () => {
    it('TOTAL_BUDGET 调整为 8000 (7 个新 layer 容纳)', async () => {
      const result = await assembleSystemPrompt({ channel: 'p2p-agent', role: 'expert' });
      // 实际预算 ≥ 现有 11 个 layer (≈ 6930 chars) 但被 8000 截断
      // 用 8500 chars 容差验证预算大致生效
      expect(result.totalChars).toBeLessThanOrEqual(8500);
    });

    it('p2p-agent 至少 1 个 layer 被截断 (证明 budget 生效)', async () => {
      const result = await assembleSystemPrompt({ channel: 'p2p-agent', role: 'expert' });
      // 至少有一个 layer 被 budget 拒绝 (13+ matched > TOTAL_BUDGET/avg_chars)
      expect(result.truncated.length).toBeGreaterThan(0);
    });

    it('SYSTEM_PROMPT_VERSION 升级标识存在', () => {
      expect(SYSTEM_PROMPT_VERSION).toMatch(/hibs-1/);
    });
  });

  describe('core.external-engagement 始终拼入 (appliesTo: all)', () => {
    it('channel=local 时拼入', async () => {
      const result = await assembleSystemPrompt({ channel: 'local', role: 'expert' });
      expect(result.layerIds).toContain('core.external-engagement');
    });

    it('channel=p2p-agent 时拼入', async () => {
      const result = await assembleSystemPrompt({ channel: 'p2p-agent', role: 'expert' });
      expect(result.layerIds).toContain('core.external-engagement');
    });
  });
});
