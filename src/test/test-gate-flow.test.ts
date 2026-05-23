import { describe, it, expect, beforeEach } from 'vitest';
import { GateStateMachine } from '../bollharness-integration/gate-state-machine.js';
import { initializeGateHooks, listGateHooks, clearGateHooks } from '../bollharness-integration/gate-transition-hooks.js';
import { generateJudgmentInjection, getCoreJudgmentsForSession, getJudgmentsForPath } from '../bollharness-integration/context-router-judgment.js';
import { getCombinedJudgments } from '../pi-ecosystem-judgment/index.js';

describe('Gate State Machine', () => {
  it('should initialize at gate 0', () => {
    const gsm = new GateStateMachine();
    expect(gsm.getCurrentGate()).toBe(0);
  });

  it('should have correct gate pack', () => {
    const gsm = new GateStateMachine();
    const pack = gsm.getGatePack();
    expect(pack.current_gate).toBe(0);
    expect(pack.required_artifact).toBeTruthy();
    expect(pack.required_next_skill).toBe('arch');
  });

  it('should transition to gate 1', async () => {
    const gsm = new GateStateMachine();
    const result = await gsm.transition();
    expect(result.from).toBe(0);
    expect(result.to).toBe(1);
    expect(result.blockers).toHaveLength(0);
    expect(gsm.getCurrentGate()).toBe(1);
  });
});

describe('Gate Transition Hooks', () => {
  beforeEach(() => {
    clearGateHooks();
  });

  it('should initialize without hooks', () => {
    initializeGateHooks();
    const hooks = listGateHooks();
    expect(hooks).toBeDefined();
  });

  it('should load hooks from settings', () => {
    initializeGateHooks();
    const hooks = listGateHooks();
    console.log('Loaded hooks:', hooks.length);
  });
});

describe('Judgment System', () => {
  it('should load judgments from YAML files', async () => {
    const judgments = await getCombinedJudgments();
    console.log('Total judgments loaded:', judgments.length);
    judgments.forEach(j => {
      console.log(`  - ${j.id}: ${j.content ? j.content.substring(0, 30) : 'N/A'}... (${j.type}, conf: ${j.confidence})`);
    });
    expect(Array.isArray(judgments)).toBe(true);
  });

  it('should generate core judgments for gate 0', async () => {
    const injection = await getCoreJudgmentsForSession(0.9);
    console.log('Core judgments length:', injection.length);
    if (injection.length > 0) {
      console.log('Core judgments sample:', injection.substring(0, 300));
    }
    expect(typeof injection).toBe('string');
  });

  it('should generate judgment injection for gate 0', async () => {
    const injection = await generateJudgmentInjection('src/agents/', 0);
    console.log('Gate 0 injection length:', injection.length);
    if (injection.length > 0) {
      console.log('Gate 0 injection:', injection.substring(0, 300));
    }
    expect(typeof injection).toBe('string');
  });

  it('should generate judgment injection for gate 3', async () => {
    const injection = await generateJudgmentInjection('src/agents/', 3);
    console.log('Gate 3 injection length:', injection.length);
    if (injection.length > 0) {
      console.log('Gate 3 injection:', injection.substring(0, 300));
    }
    expect(typeof injection).toBe('string');
  });

  it('should get judgments for path', async () => {
    const result = await getJudgmentsForPath('src/agents/');
    console.log('Path judgments - count:', result.judgments.length, 'confidence:', result.confidence);
    expect(result.fragments).toBeDefined();
    expect(Array.isArray(result.judgments)).toBe(true);
  });
});
