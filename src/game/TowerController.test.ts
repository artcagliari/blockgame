import { describe, expect, it } from 'vitest';
import { TowerController } from './TowerController';
import { BASE_Y, layoutOffsets } from './tower-layout';
import { MAX_QUEUED_PIECES } from './tower-queue';
import type { IncrementEvent, Team } from './types';

const RED = { main: 0xff304a, light: 0xd91435, dark: 0x8d1025, edge: 0xff7588 };
const GREEN = { main: 0x1ed779, light: 0x13a95d, dark: 0x08753b, edge: 0x78ffc0 };
const X = { lula: 395, bolsonaro: 685 } as const;
const DT = 1 / 60;

function makeTower(team: Team) {
  return new TowerController({ team, x: X[team], palette: team === 'lula' ? RED : GREEN });
}

function event(team: Team, amount: number, total: number, id: string): IncrementEvent {
  return {
    team, amount, total, id, source: 'admin', roundId: 1, seq: 1, opponentTotal: 0, origin: 'test', kind: 'manual', at: 0,
  };
}

function advance(tower: TowerController, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += DT) tower.update(DT);
}

/** Avança até esvaziar fila e peça ativa; devolve os segundos usados. */
function drain(tower: TowerController, limit = 60): number {
  let elapsed = 0;
  while (elapsed < limit) {
    const snapshot = tower.getSnapshot();
    if (!snapshot.hasActivePiece && snapshot.queued === 0) break;
    tower.update(DT);
    elapsed += DT;
  }
  advance(tower, .3);
  return elapsed;
}

function buildGradually(team: Team, points: number) {
  const tower = makeTower(team);
  const heights: number[] = [];
  const spawnedAbove: boolean[] = [];
  for (let point = 1; point <= points; point += 1) {
    tower.enqueue(event(team, 1, point, `${team}-${point}`));
    const falling = tower.getSnapshot();
    expect(falling.fallingNodes).toBe(1);
    expect(falling.activePiece?.state).toBe('falling');
    spawnedAbove.push((falling.activePiece?.y ?? 0) < (falling.activePiece?.targetY ?? 0));
    drain(tower);
    heights.push(tower.getSnapshot().stackHeight);
  }
  return { tower, heights, spawnedAbove };
}

describe('TESTE A — torre do Lula', () => {
  it('10 pontos graduais: surgem placas vermelhas, caem uma por vez, ficam assentadas e a altura cresce', () => {
    const { tower, heights, spawnedAbove } = buildGradually('lula', 10);
    expect(spawnedAbove.every(Boolean)).toBe(true);
    const snapshot = tower.getSnapshot();
    expect(snapshot).toMatchObject({
      team: 'lula',
      landedScore: 10,
      logicalScore: 10,
      settledLayers: 10,
      fallingNodes: 0,
      queued: 0,
      hasActivePiece: false,
    });
    for (let index = 1; index < heights.length; index += 1) expect(heights[index]).toBeGreaterThan(heights[index - 1]);
    expect(snapshot.settledTopY).toBe(BASE_Y - heights.at(-1)!);
  });

  it('a queda é visível: a placa nasce acima do topo e desce em direção a ele', () => {
    const tower = makeTower('lula');
    tower.enqueue(event('lula', 1, 1, 'l1'));
    const first = tower.getSnapshot().activePiece!;
    expect(first.x).toBeGreaterThanOrEqual(X.lula - 13);
    expect(first.x).toBeLessThanOrEqual(X.lula + 14);
    expect(first.targetY).toBe(BASE_Y);
    expect(first.y).toBeLessThan(first.targetY - 100);
    let previousY = first.y;
    for (let frame = 0; frame < 12; frame += 1) {
      tower.update(DT);
      const y = tower.getSnapshot().activePiece?.y ?? previousY;
      expect(y).toBeGreaterThanOrEqual(previousY);
      previousY = y;
    }
    expect(previousY).toBeGreaterThan(first.y);
  });

  it('a placa seguinte para sobre a anterior, nunca a atravessa', () => {
    const tower = makeTower('lula');
    let previousTop = BASE_Y + 1;
    for (let point = 1; point <= 8; point += 1) {
      tower.enqueue(event('lula', 1, point, `p${point}`));
      const landing = tower.getSnapshot().activePiece!.targetY;
      expect(landing).toBeLessThan(previousTop);
      drain(tower);
      expect(tower.getSnapshot().settledTopY).toBe(landing);
      previousTop = landing;
    }
  });
});

describe('TESTE B — torre do Bolsonaro', () => {
  it('10 pontos graduais com placas verdes, no próprio eixo X', () => {
    const { tower, heights } = buildGradually('bolsonaro', 10);
    const snapshot = tower.getSnapshot();
    expect(snapshot).toMatchObject({ team: 'bolsonaro', x: X.bolsonaro, landedScore: 10, settledLayers: 10, fallingNodes: 0 });
    for (let index = 1; index < heights.length; index += 1) expect(heights[index]).toBeGreaterThan(heights[index - 1]);
  });

  it('+5 gera cinco quedas sequenciais, nunca simultâneas', () => {
    const tower = makeTower('bolsonaro');
    tower.enqueue(event('bolsonaro', 5, 5, 'b5'));
    expect(tower.getSnapshot()).toMatchObject({ queued: 4, hasActivePiece: true });
    let landed = 0;
    let previousLayers = 0;
    for (let frame = 0; frame < 60 * 6; frame += 1) {
      tower.update(DT);
      const snapshot = tower.getSnapshot();
      expect(snapshot.fallingNodes).toBeLessThanOrEqual(1);
      expect(snapshot.settledLayers - previousLayers).toBeLessThanOrEqual(1);
      if (snapshot.settledLayers > previousLayers) landed += 1;
      previousLayers = snapshot.settledLayers;
    }
    expect(landed).toBe(5);
  });
});

describe('TESTE C — construção simultânea e independente', () => {
  it('duas torres crescem ao mesmo tempo sem se influenciar', () => {
    const lula = makeTower('lula');
    const bolsonaro = makeTower('bolsonaro');
    lula.enqueue(event('lula', 5, 5, 'l'));
    bolsonaro.enqueue(event('bolsonaro', 1, 1, 'b'));
    expect(lula.getSnapshot().fallingNodes).toBe(1);
    expect(bolsonaro.getSnapshot().fallingNodes).toBe(1);

    let bothFalling = 0;
    for (let frame = 0; frame < 60 * 4; frame += 1) {
      lula.update(DT);
      bolsonaro.update(DT);
      const a = lula.getSnapshot();
      const b = bolsonaro.getSnapshot();
      expect(a.fallingNodes).toBeLessThanOrEqual(1);
      expect(b.fallingNodes).toBeLessThanOrEqual(1);
      if (a.hasActivePiece && b.hasActivePiece) bothFalling += 1;
    }
    expect(bothFalling).toBeGreaterThan(0);
    expect(lula.getSnapshot()).toMatchObject({ settledLayers: 5, landedScore: 5 });
    expect(bolsonaro.getSnapshot()).toMatchObject({ settledLayers: 1, landedScore: 1 });
    expect(lula.getSnapshot().x).not.toBe(bolsonaro.getSnapshot().x);
  });

  it('uma torre ignora eventos da outra equipe', () => {
    const lula = makeTower('lula');
    lula.enqueue(event('bolsonaro', 10, 10, 'foreign'));
    expect(lula.getSnapshot()).toMatchObject({ queued: 0, hasActivePiece: false, logicalScore: 0 });
  });

  it('60 segundos simulados com cadências diferentes mantêm as duas filas independentes', () => {
    const lula = makeTower('lula');
    const bolsonaro = makeTower('bolsonaro');
    let lulaTotal = 0;
    let bolsonaroTotal = 0;
    let nextLula = 0;
    let nextBolsonaro = 0;
    for (let elapsed = 0; elapsed < 60; elapsed += DT) {
      if (elapsed >= nextLula) {
        lulaTotal += 1;
        lula.enqueue(event('lula', 1, lulaTotal, `l-${lulaTotal}`));
        nextLula += .7;
      }
      if (elapsed >= nextBolsonaro) {
        bolsonaroTotal += 3;
        bolsonaro.enqueue(event('bolsonaro', 3, bolsonaroTotal, `b-${bolsonaroTotal}`));
        nextBolsonaro += .9;
      }
      lula.update(DT);
      bolsonaro.update(DT);
    }
    drain(lula);
    drain(bolsonaro);
    expect(lula.getSnapshot()).toMatchObject({ landedScore: lulaTotal, logicalScore: lulaTotal });
    expect(bolsonaro.getSnapshot()).toMatchObject({ landedScore: bolsonaroTotal, logicalScore: bolsonaroTotal });
    expect(bolsonaro.getSnapshot().stackHeight).toBeGreaterThan(lula.getSnapshot().stackHeight);
  });
});

describe('TESTE D — eventos grandes', () => {
  it('+500 no Lula e +1000 no Bolsonaro terminam sem travar e batem com o placar', () => {
    const lula = makeTower('lula');
    const bolsonaro = makeTower('bolsonaro');
    lula.enqueue(event('lula', 500, 500, 'l500'));
    bolsonaro.enqueue(event('bolsonaro', 1000, 1000, 'b1000'));
    expect(lula.getSnapshot().queued).toBeLessThanOrEqual(MAX_QUEUED_PIECES);
    expect(bolsonaro.getSnapshot().queued).toBeLessThanOrEqual(MAX_QUEUED_PIECES);

    let maxFalling = 0;
    for (let frame = 0; frame < 60 * 20; frame += 1) {
      lula.update(DT);
      bolsonaro.update(DT);
      maxFalling = Math.max(maxFalling, lula.getSnapshot().fallingNodes, bolsonaro.getSnapshot().fallingNodes);
    }
    expect(maxFalling).toBeLessThanOrEqual(1);
    for (const [tower, total] of [[lula, 500], [bolsonaro, 1000]] as const) {
      const snapshot = tower.getSnapshot();
      expect(snapshot).toMatchObject({ landedScore: total, queued: 0, hasActivePiece: false });
      const expected = layoutOffsets(total, 2000);
      expect(snapshot.settledLayers).toBe(expected.length);
      expect(snapshot.settledLayers).toBeLessThan(160);
      expect(snapshot.settledTopY).toBe(BASE_Y - expected.at(-1)!);
    }
    expect(bolsonaro.getSnapshot().stackHeight).toBeGreaterThan(lula.getSnapshot().stackHeight);
  });

  it('+1000 termina em poucos segundos e o jogo continua aceitando eventos durante a animação', () => {
    const tower = makeTower('bolsonaro');
    tower.enqueue(event('bolsonaro', 1000, 1000, 'ultra'));
    advance(tower, .5);
    tower.enqueue(event('bolsonaro', 1, 1001, 'extra'));
    const seconds = drain(tower);
    expect(seconds).toBeLessThan(10);
    expect(tower.getSnapshot()).toMatchObject({ landedScore: 1001, logicalScore: 1001 });
  });

  it('a pilha continua subindo até o fim da meta, sem congelar ao chegar perto do topo', () => {
    const tower = makeTower('lula');
    let total = 0;
    const tops: number[] = [];
    while (total < 2000) {
      const amount = Math.min(50, 2000 - total);
      total += amount;
      tower.enqueue(event('lula', amount, total, `l-${total}`));
      drain(tower);
      tops.push(tower.getSnapshot().settledTopY!);
    }
    for (let index = 1; index < tops.length; index += 1) expect(tops[index]).toBeLessThanOrEqual(tops[index - 1]);
    expect(tops[tops.length - 2]).toBeGreaterThan(tops.at(-1)!);
    expect(tops.at(-1)).toBeGreaterThanOrEqual(800);
    expect(tops.at(-1)).toBeLessThan(840);
  });

  it('a fila acompanha cadência alta (≈6 pts/s por torre) sem acumular atraso', () => {
    const tower = makeTower('lula');
    let total = 0;
    let maxLag = 0;
    let maxQueued = 0;
    for (let elapsed = 0; elapsed < 90; elapsed += DT) {
      if (Math.round(elapsed * 60) % 30 === 0) {
        total += 3;
        tower.enqueue(event('lula', 3, total, `l-${total}`));
      }
      tower.update(DT);
      const snapshot = tower.getSnapshot();
      maxQueued = Math.max(maxQueued, snapshot.queued);
      if (elapsed > 5) maxLag = Math.max(maxLag, snapshot.logicalScore - snapshot.landedScore);
    }
    expect(maxQueued).toBeLessThanOrEqual(MAX_QUEUED_PIECES);
    expect(maxLag).toBeLessThan(40);
    drain(tower);
    expect(tower.getSnapshot().landedScore).toBe(total);
  });
});

describe('TESTE E — recarregamento', () => {
  it('restaura a pilha do estado atual sem enfileirar animações antigas', () => {
    const tower = makeTower('lula');
    tower.syncScore(650, 2000);
    const snapshot = tower.getSnapshot();
    expect(snapshot).toMatchObject({
      queued: 0,
      hasActivePiece: false,
      fallingNodes: 0,
      landedScore: 650,
      settledLayers: layoutOffsets(650, 2000).length,
    });
  });

  it('a torre restaurada é idêntica à construída ao vivo com a mesma pontuação', () => {
    const live = makeTower('bolsonaro');
    let total = 0;
    for (const amount of [1, 5, 10, 30, 100, 3, 1, 250, 7]) {
      total += amount;
      live.enqueue(event('bolsonaro', amount, total, `b-${total}`));
      drain(live);
    }
    const restored = makeTower('bolsonaro');
    restored.syncScore(total, 2000);
    const a = live.getSnapshot();
    const b = restored.getSnapshot();
    expect(a.settledLayers).toBe(b.settledLayers);
    expect(a.settledTopY).toBe(b.settledTopY);
    expect(a.stackHeight).toBe(b.stackHeight);
  });
});

describe('TESTE F — reinício da rodada', () => {
  it('limpa fila, peça em queda e pilha, e reconstrói do zero', () => {
    const tower = makeTower('lula');
    tower.enqueue(event('lula', 100, 100, 'l100'));
    advance(tower, 1);
    expect(tower.getSnapshot().settledLayers).toBeGreaterThan(0);

    tower.syncScore(0, 2000);
    expect(tower.getSnapshot()).toMatchObject({
      logicalScore: 0,
      landedScore: 0,
      queued: 0,
      hasActivePiece: false,
      fallingNodes: 0,
      settledLayers: 0,
      stackHeight: 0,
    });

    tower.enqueue(event('lula', 1, 1, 'new-1'));
    drain(tower);
    expect(tower.getSnapshot()).toMatchObject({ settledLayers: 1, settledTopY: BASE_Y, landedScore: 1 });
  });

  it('um estado antigo atrasado não desfaz a pilha enquanto há animações pendentes', () => {
    const tower = makeTower('lula');
    tower.enqueue(event('lula', 20, 20, 'l20'));
    tower.syncScore(20, 2000);
    advance(tower, .1);
    expect(tower.getSnapshot().hasActivePiece).toBe(true);
    expect(tower.getSnapshot().logicalScore).toBe(20);
  });
});
