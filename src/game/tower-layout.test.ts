import { describe, expect, it } from 'vitest';
import { AVAILABLE_HEIGHT, BASE_Y, MIN_SLAB_GAP, TOP_LIMIT, layoutOffsets, towerHeight } from './tower-layout';

describe('layout determinístico da torre', () => {
  it('começa vazia e a primeira placa fica sobre a base', () => {
    expect(layoutOffsets(0, 2000)).toEqual([]);
    expect(layoutOffsets(1, 2000)).toEqual([0]);
  });

  it('cada ponto inicial cria uma placa visivelmente mais alta que a anterior', () => {
    const offsets = layoutOffsets(10, 2000);
    expect(offsets).toHaveLength(10);
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index] - offsets[index - 1]).toBeGreaterThanOrEqual(MIN_SLAB_GAP);
    }
  });

  it('altura cresce monotonicamente até a meta e nunca ultrapassa o limite superior', () => {
    let previous = -1;
    for (let score = 0; score <= 2000; score += 25) {
      const height = towerHeight(score, 2000);
      expect(height).toBeGreaterThanOrEqual(previous);
      expect(height).toBeLessThanOrEqual(AVAILABLE_HEIGHT);
      previous = height;
    }
    const topY = BASE_Y - towerHeight(2000, 2000);
    expect(topY).toBeGreaterThanOrEqual(TOP_LIMIT);
    expect(topY).toBeLessThan(TOP_LIMIT + 40);
  });

  it('continua visivelmente subindo na reta final da rodada', () => {
    expect(towerHeight(1800, 2000) - towerHeight(1000, 2000)).toBeGreaterThan(80);
    expect(towerHeight(2000, 2000)).toBeGreaterThan(towerHeight(1990, 2000));
  });

  it('limita a quantidade de placas independentemente da pontuação', () => {
    const count = layoutOffsets(2000, 2000).length;
    expect(count).toBeGreaterThan(60);
    expect(count).toBeLessThan(160);
  });

  it('é puro: mesma pontuação, mesmo layout', () => {
    expect(layoutOffsets(731, 2000)).toEqual(layoutOffsets(731, 2000));
  });

  it('o layout da pontuação N é prefixo do layout da pontuação N+k (exceto o topo)', () => {
    const early = layoutOffsets(300, 2000);
    const later = layoutOffsets(420, 2000);
    expect(later.length).toBeGreaterThanOrEqual(early.length);
    for (let index = 0; index < early.length - 1; index += 1) expect(later[index]).toBe(early[index]);
  });
});
