import { describe, it, expect } from 'vitest';
import { AgentCoordinator } from '../src/agent/coordinator.js';

describe('AgentCoordinator', () => {
  it('dispatches parallel tasks', async () => {
    const coordinator = new AgentCoordinator(2);
    const results = await coordinator.dispatch('one two three four', 2);
    
    expect(results.length).toBe(2);
    expect(results.every(r => r.success)).toBe(true);
  });

  it('aggregates results in order', async () => {
    const coordinator = new AgentCoordinator(2);
    const results = await coordinator.dispatch('a b c d', 3);
    
    const ids = results.map(r => r.taskId);
    expect(ids).toEqual(ids.sort());
  });
});
