/**
 * ConstraintLayer Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConstraintLayer, WorkflowContext, AUTONOMOUS_ACTIONS, CONFIRM_REQUIRED_ACTIONS } from '../agents/constraint-layer.js';

describe('ConstraintLayer', () => {
  let layer: ConstraintLayer;

  beforeEach(() => {
    layer = new ConstraintLayer();
  });

  describe('checkGuardrails', () => {
    it('should pass when no guardrails fail', async () => {
      const context: WorkflowContext = {
        peers: ['peer1', 'peer2'],
        logs: []
      };

      const result = await layer.checkGuardrails(context);
      expect(result.passed).toBe(true);
      expect(result.blocked).toBeUndefined();
    });

    it('should block send to unknown peer', async () => {
      const context: WorkflowContext = {
        peers: ['peer1', 'peer2'],
        logs: []
      };

      const step = {
        id: 'send',
        type: 'send' as const,
        config: { peerId: 'unknown-peer' },
        retry: { max: 0, current: 0, backoffMs: 0 },
        onFail: 'block' as const
      };

      const result = await layer.checkGuardrails(context, step as any);
      expect(result.passed).toBe(false);
      expect(result.blocked?.name).toBe('validateSendTarget');
    });

    it('should allow send to known peer', async () => {
      const context: WorkflowContext = {
        peers: ['peer1', 'peer2'],
        logs: []
      };

      const step = {
        id: 'send',
        type: 'send' as const,
        config: { peerId: 'peer1' },
        retry: { max: 0, current: 0, backoffMs: 0 },
        onFail: 'block' as const
      };

      const result = await layer.checkGuardrails(context, step as any);
      expect(result.passed).toBe(true);
    });

    it('should warn for low quality summary', async () => {
      const context: WorkflowContext = {
        peers: [],
        logs: [],
        qualityScore: 0.3
      };

      const result = await layer.checkGuardrails(context);
      expect(result.passed).toBe(false);
      expect(result.blocked?.name).toBe('validateSummaryQuality');
    });

    it('should pass for acceptable quality summary', async () => {
      const context: WorkflowContext = {
        peers: [],
        logs: [],
        qualityScore: 0.7
      };

      const result = await layer.checkGuardrails(context);
      expect(result.passed).toBe(true);
    });
  });

  describe('isAutonomousAction', () => {
    it('should identify autonomous actions', () => {
      expect(layer.isAutonomousAction('summarize')).toBe(true);
      expect(layer.isAutonomousAction('chunk')).toBe(true);
      expect(layer.isAutonomousAction('improve')).toBe(true);
    });

    it('should return false for non-autonomous actions', () => {
      expect(layer.isAutonomousAction('send')).toBe(false);
      expect(layer.isAutonomousAction('delete')).toBe(false);
    });
  });

  describe('requiresConfirmation', () => {
    it('should identify confirmation-required actions', () => {
      expect(layer.requiresConfirmation('send')).toBe(true);
      expect(layer.requiresConfirmation('delete')).toBe(true);
    });

    it('should return false for non-confirmation-required actions', () => {
      expect(layer.requiresConfirmation('summarize')).toBe(false);
      expect(layer.requiresConfirmation('chunk')).toBe(false);
    });
  });

  describe('logging', () => {
    it('should record operations', () => {
      layer.log('test action', { key: 'value' }, 'success');
      const logs = layer.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('test action');
      expect(logs[0].status).toBe('success');
      expect(logs[0].details).toEqual({ key: 'value' });
    });

    it('should record multiple operations', () => {
      layer.log('action1', {}, 'success');
      layer.log('action2', { data: 123 }, 'warn');
      const logs = layer.getLogs();
      expect(logs).toHaveLength(2);
    });

    it('should clear logs', () => {
      layer.log('action1', {}, 'success');
      layer.log('action2', {}, 'failed');
      layer.clearLogs();
      const logs = layer.getLogs();
      expect(logs).toHaveLength(0);
    });

    it('should track timestamp for logs', () => {
      const before = Date.now();
      layer.log('test', {}, 'success');
      const after = Date.now();
      const logs = layer.getLogs();
      expect(logs[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(logs[0].timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('registerRule', () => {
    it('should register new rules', () => {
      const rule = {
        id: 'custom-rule',
        description: 'Custom rule',
        guardrails: [{
          name: 'customGuard',
          check: async () => true
        }]
      };
      layer.registerRule(rule);
      expect(layer.getRuleIds()).toContain('custom-rule');
    });

    it('should unregister rules', () => {
      const rule = {
        id: 'temp-rule',
        description: 'Temporary rule',
        guardrails: [{
          name: 'tempGuard',
          check: async () => true
        }]
      };
      layer.registerRule(rule);
      expect(layer.unregisterRule('temp-rule')).toBe(true);
      expect(layer.getRuleIds()).not.toContain('temp-rule');
    });
  });

  describe('AUTONOMOUS_ACTIONS constant', () => {
    it('should contain expected actions', () => {
      expect(AUTONOMOUS_ACTIONS).toContain('summarize');
      expect(AUTONOMOUS_ACTIONS).toContain('chunk');
      expect(AUTONOMOUS_ACTIONS).toContain('improve');
    });
  });

  describe('CONFIRM_REQUIRED_ACTIONS constant', () => {
    it('should contain expected actions', () => {
      expect(CONFIRM_REQUIRED_ACTIONS).toContain('send');
      expect(CONFIRM_REQUIRED_ACTIONS).toContain('delete');
    });
  });
});