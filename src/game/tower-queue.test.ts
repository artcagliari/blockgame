import { describe, expect, it } from 'vitest';
import { MAX_QUEUED_PIECES, TowerAnimationQueue } from './tower-queue';
import type { IncrementEvent, Team } from './types';

function event(team: Team, amount: number, total: number, id: string): IncrementEvent {
  return {
    team, amount, total, id, source: 'admin', roundId: 1, seq: 1, opponentTotal: 0, origin: 'test', kind: 'manual', at: 0,
  };
}

describe('filas independentes das torres', () => {
  it('mantém Lula e Bolsonaro completamente separados', () => {
    const lulaTower = new TowerAnimationQueue();
    const bolsonaroTower = new TowerAnimationQueue();
    lulaTower.enqueue(event('lula', 5, 5, 'l1'));
    bolsonaroTower.enqueue(event('bolsonaro', 10, 10, 'b1'));

    expect(lulaTower.length).toBe(5);
    expect(bolsonaroTower.length).toBe(10);
    expect(lulaTower.shift()?.team).toBe('lula');
    expect(lulaTower.length).toBe(4);
    expect(bolsonaroTower.length).toBe(10);
  });

  it('preserva ordem FIFO e alcança a pontuação oficial', () => {
    const queue = new TowerAnimationQueue();
    queue.enqueue(event('lula', 30, 45, 'burst'));
    const pieces = queue.snapshot();
    expect(pieces).toHaveLength(MAX_QUEUED_PIECES);
    expect(pieces.at(-1)?.scoreAtLanding).toBe(45);
    expect(pieces.reduce((sum, piece) => sum + piece.weight, 0)).toBe(30);
    const landings = pieces.map((piece) => piece.scoreAtLanding);
    expect([...landings].sort((a, b) => a - b)).toEqual(landings);
  });

  it('agrupa eventos grandes sem criar centenas de sprites e sem perder pontos', () => {
    const queue = new TowerAnimationQueue();
    queue.enqueue(event('bolsonaro', 1000, 1000, 'ultra'));
    expect(queue.length).toBeLessThanOrEqual(MAX_QUEUED_PIECES);
    expect(queue.pendingWeight).toBe(1000);
    expect(queue.snapshot().at(-1)?.scoreAtLanding).toBe(1000);
  });

  it('+1 e +5 continuam sendo uma queda por ponto', () => {
    const queue = new TowerAnimationQueue();
    queue.enqueue(event('lula', 1, 1, 'a'));
    expect(queue.length).toBe(1);
    queue.enqueue(event('lula', 5, 6, 'b'));
    expect(queue.length).toBe(6);
    expect(queue.pendingWeight).toBe(6);
  });

  it('agrupar nunca reordena nem ultrapassa o limite, mesmo com muitos eventos acumulados', () => {
    const queue = new TowerAnimationQueue();
    let total = 0;
    for (let index = 0; index < 100; index += 1) {
      total += 3;
      queue.enqueue(event('lula', 3, total, `e${index}`));
    }
    expect(queue.length).toBeLessThanOrEqual(MAX_QUEUED_PIECES);
    expect(queue.pendingWeight).toBe(300);
    expect(queue.snapshot().at(-1)?.scoreAtLanding).toBe(300);
  });
});
