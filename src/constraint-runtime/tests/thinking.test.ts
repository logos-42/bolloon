import { describe, it, expect } from 'vitest';
import { DeepThinkingEngine } from '../src/thinking/engine.js';

describe('DeepThinkingEngine', () => {
  it('performs thinking steps', async () => {
    const engine = new DeepThinkingEngine(2);
    const result = await engine.think('test prompt');
    
    expect(result.originalPrompt).toBe('test prompt');
    expect(result.steps.length).toBe(2);
    expect(result.depth).toBe(2);
  });

  it('respects max depth', async () => {
    const engine = new DeepThinkingEngine(5);
    const result = await engine.think('deep thought');
    
    expect(result.steps.length).toBe(5);
  });

  it('allows depth adjustment', async () => {
    const engine = new DeepThinkingEngine(1);
    engine.setDepth(3);
    const result = await engine.think('adjustable');
    
    expect(result.steps.length).toBe(3);
  });
});
