import { describe, it, expect } from 'vitest';
import { double } from '../utils/double.js';

describe('double', () => {
  it('should double positive', () => expect(double(5)).toBe(10));
  it('should double zero', () => expect(double(0)).toBe(0));
  it('should double negative', () => expect(double(-3)).toBe(-6));
});
