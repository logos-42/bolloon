import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../src/skills/skill-registry.js';

describe('SkillRegistry', () => {
  it('registers and retrieves skills', async () => {
    const registry = new SkillRegistry();
    
    registry.register({
      name: 'testSkill',
      description: 'A test skill',
      execute: async (params) => `executed with ${params.input}`
    });
    
    expect(registry.has('testSkill')).toBe(true);
    const result = await registry.execute('testSkill', { input: 'hello' });
    expect(result).toBe('executed with hello');
  });

  it('throws on unknown skill', async () => {
    const registry = new SkillRegistry();
    await expect(registry.execute('unknown', {})).rejects.toThrow('Skill not found');
  });
});
