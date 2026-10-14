import { describe, expect, it } from 'vitest';
import { getVisualBlockCount } from './block-visuals';

describe('quantidade visual de blocos', () => {
  it.each([
    [1, 1],
    [5, 5],
    [10, 10],
    [30, 15],
    [100, 18],
    [500, 22],
    [1000, 26],
  ])('converte +%i em %i blocos animados', (amount, expected) => {
    expect(getVisualBlockCount(amount)).toBe(expected);
  });

  it('limita rajadas enormes sem criar milhares de sprites', () => {
    expect(getVisualBlockCount(5000)).toBe(26);
  });
});
