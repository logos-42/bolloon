import { describe, it, expect } from 'vitest';
import { clamp } from '../utils/clamp.js';
describe('clamp', () => {
  it('n within range', () => expect(clamp(5, 0, 10)).toBe(5));
  it('n < min', () => expect(clamp(-3, 0, 10)).toBe(0));
  it('n > max', () => expect(clamp(15, 0, 10)).toBe(10));
});
