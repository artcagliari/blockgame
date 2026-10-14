import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameEngine, StalePlanError } from './game-engine.js';

const real = { origin: 'real', kind: 'gift' } as const;

describe('GameEngine', () => {
  afterEach(() => vi.useRealTimers());

  it('inicia com a configuração padrão (meta 2000, 300 s, intervalo 10 s, reinício automático) e SEM gerador automático', () => {
    const state = new GameEngine().getState();
    expect(state.phase).toBe('playing');
    expect(state.startedAt).toBeNull();
    expect(state.config).toMatchObject({ target: 2000, durationSeconds: 300, resultSeconds: 10, autoRestart: true, autoEnabled: false });
    expect(state.teams.lula.score).toBe(0);
    expect(state.teams.bolsonaro.score).toBe(0);
  });

  it('encerra a rodada uma única vez e soma a vitória ao atingir a meta', () => {
    const game = new GameEngine({ target: 20 });
    const ended = vi.fn();
    game.on('roundEnded', ended);
    game.increment('lula', 20, { origin: 'test', kind: 'manual' });
    // Eventos que chegam na tela de resultado não alteram nem encerram de novo.
    expect(game.increment('lula', 50, real)).toBeNull();
    expect(game.increment('bolsonaro', 50, real)).toBeNull();
    const state = game.getState();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe('result');
    expect(state.winner).toBe('lula');
    expect(state.teams.lula.wins).toBe(1);
    expect(state.teams.bolsonaro.score).toBe(0);
  });

  it('não ultrapassa a meta: o excedente de um presente grande é descartado', () => {
    const game = new GameEngine({ target: 100 });
    const event = game.increment('bolsonaro', 1000, real);
    expect(event?.amount).toBe(100);
    expect(game.getState().teams.bolsonaro.score).toBe(100);
  });

  it('preserva o tempo restante enquanto está pausado', () => {
    let now = Date.parse('2026-10-13T12:00:00Z');
    const game = new GameEngine({ durationSeconds: 60 }, { now: () => now });
    now += 10_000;
    expect(game.pause()).toBe(true);
    now += 20_000;
    expect(game.resume()).toBe(true);
    expect(game.getState().pauseAccumulatedMs).toBe(20_000);
    expect(game.increment('lula', 1, real)).not.toBeNull();
  });

  it('rejeita pontuação enquanto pausado', () => {
    const game = new GameEngine();
    game.pause();
    const plan = game.plan('lula', 5, real);
    expect(plan).toEqual({ rejected: 'paused' });
  });

  it('com autoplay desligado só eventos explícitos alteram o placar', () => {
    const game = new GameEngine({ autoEnabled: true }, { autoplay: false });
    for (let index = 0; index < 100; index += 1) game.tick();
    expect(game.getState().teams.lula.score).toBe(0);
    expect(game.getState().teams.bolsonaro.score).toBe(0);
    game.increment('lula', 7, { origin: 'test', kind: 'manual' });
    expect(game.getState().teams.lula.score).toBe(7);
  });

  it('gerador automático respeita equipes habilitadas e é marcado como automático', () => {
    const game = new GameEngine({ autoEnabled: true, autoTeams: { lula: true, bolsonaro: false }, autoSpeed: 5 });
    const events: Array<{ origin: string; team: string }> = [];
    game.on('increment', (event) => events.push(event));
    for (let index = 0; index < 400; index += 1) game.tick();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.origin === 'auto' && event.team === 'lula')).toBe(true);
    expect(game.getState().teams.bolsonaro.score).toBe(0);

    const off = new GameEngine({ autoEnabled: false });
    for (let index = 0; index < 200; index += 1) off.tick();
    expect(off.getState().teams.lula.score + off.getState().teams.bolsonaro.score).toBe(0);
  });

  it('gerador automático é equilibrado entre as equipes', () => {
    const game = new GameEngine({ autoEnabled: true, target: 100_000, durationSeconds: 3_600 });
    for (let index = 0; index < 20_000; index += 1) game.tick();
    const { lula, bolsonaro } = game.getState().teams;
    const ratio = lula.score / bolsonaro.score;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it('reinicia automaticamente após o intervalo e não reinicia quando desabilitado', () => {
    let now = 1_000_000;
    const game = new GameEngine({ target: 10, resultSeconds: 10 }, { now: () => now, autoplay: false });
    game.increment('lula', 10, real);
    expect(game.getState().phase).toBe('result');
    now += 9_000;
    game.tick();
    expect(game.getState().phase).toBe('result');
    now += 1_500;
    game.tick();
    const next = game.getState();
    expect(next.phase).toBe('playing');
    expect(next.round).toBe(2);
    expect(next.teams.lula).toMatchObject({ score: 0, wins: 1 });

    const manual = new GameEngine({ target: 10, resultSeconds: 3, autoRestart: false }, { now: () => now, autoplay: false });
    manual.increment('lula', 10, real);
    now += 60_000;
    manual.tick();
    expect(manual.getState().phase).toBe('result');
  });

  it('empate no fim do tempo não concede vitória', () => {
    let now = 0;
    const game = new GameEngine({ durationSeconds: 10 }, { now: () => now, autoplay: false });
    game.increment('lula', 5, real);
    game.increment('bolsonaro', 5, real);
    now += 11_000;
    game.tick();
    const state = game.getState();
    expect(state.phase).toBe('result');
    expect(state.winner).toBe('draw');
    expect(state.teams.lula.wins + state.teams.bolsonaro.wins).toBe(0);
  });

  it('limita configurações administrativas a faixas seguras', () => {
    const game = new GameEngine();
    game.updateConfig({ target: -1, durationSeconds: 99_999, autoSpeed: 20 });
    const config = game.getState().config;
    expect(config.target).toBe(10);
    expect(config.durationSeconds).toBe(3600);
    expect(config.autoSpeed).toBe(5);
  });

  it('reiniciar rodada zera placares, mantém vitórias e troca o roundId', () => {
    const game = new GameEngine({ target: 10 });
    game.increment('bolsonaro', 10, real);
    const before = game.getState();
    game.resetRound();
    const state = game.getState();
    expect(state.phase).toBe('playing');
    expect(state.teams.lula.score).toBe(0);
    expect(state.teams.bolsonaro.wins).toBe(1);
    expect(state.round).toBe(before.round);
    expect(state.roundId).toBe(before.roundId + 1);
  });

  it('eventos carregam roundId, seq crescente, placar adversário, origem e tipo', () => {
    const game = new GameEngine({}, { autoplay: false });
    const events: Array<Record<string, unknown>> = [];
    game.on('increment', (event) => events.push(event));
    game.increment('lula', 30, { origin: 'real', kind: 'gift', effect: 'gift', giftId: 'turbo', giftName: 'Donut', viewerName: 'Ana', count: 1 });
    game.increment('bolsonaro', 5, { origin: 'test', kind: 'follow', effect: 'follow' });
    expect(events[0]).toMatchObject({
      team: 'lula', amount: 30, total: 30, opponentTotal: 0, source: 'gift', origin: 'real', kind: 'gift',
      giftId: 'turbo', giftName: 'Donut', viewerName: 'Ana', roundId: 1,
    });
    expect(events[1]).toMatchObject({ team: 'bolsonaro', total: 5, opponentTotal: 30, origin: 'test' });
    expect(Number(events[1].seq)).toBeGreaterThan(Number(events[0].seq));
    expect(events[0].id).not.toBe(events[1].id);
    expect(typeof events[0].at).toBe('number');
  });

  it('plano calculado com estado desatualizado é recusado', () => {
    const game = new GameEngine({}, { autoplay: false });
    const plan = game.plan('lula', 5, real);
    if ('rejected' in plan) throw new Error('esperava um plano');
    game.increment('bolsonaro', 1, real);
    expect(() => game.commit(plan)).toThrow(StalePlanError);
  });

  it('restaurar após reinício preserva placar e tempo decorrido, sem contar o tempo parado', () => {
    let now = 1_000_000;
    const game = new GameEngine({ durationSeconds: 300 }, { now: () => now, autoplay: false });
    game.increment('lula', 100, real); // o relógio começa no primeiro evento
    now += 40_000;
    game.increment('lula', 20, real);
    const saved = game.snapshot();
    now += 3_600_000; // servidor ficou uma hora fora

    const revived = new GameEngine({}, { now: () => now, autoplay: false });
    revived.restore(saved);
    const state = revived.getState();
    expect(state.teams.lula.score).toBe(120);
    const elapsed = now - (state.startedAt ?? 0) - state.pauseAccumulatedMs;
    expect(elapsed).toBe(40_000);
    expect(state.seq).toBeGreaterThan(saved.state.seq);
  });

  it('sem eventos a rodada fica aguardando: o relógio não corre nem encerra em empate', () => {
    let now = 0;
    const game = new GameEngine({ durationSeconds: 10 }, { now: () => now, autoplay: true });
    now += 3_600_000; // uma hora sem nenhuma LIVE
    for (let index = 0; index < 50; index += 1) game.tick();
    const state = game.getState();
    expect(state).toMatchObject({ phase: 'playing', round: 1, startedAt: null });
    expect(state.teams.lula.score + state.teams.bolsonaro.score).toBe(0);
  });

  it('o relógio começa no primeiro evento real e a nova rodada volta a aguardar', () => {
    let now = 1_000;
    const game = new GameEngine({ target: 10, resultSeconds: 3 }, { now: () => now, autoplay: false });
    now += 50_000;
    game.increment('lula', 1, real);
    expect(game.getState().startedAt).toBe(51_000);
    game.increment('lula', 9, real);
    expect(game.getState().phase).toBe('result');
    now += 3_100;
    game.tick();
    expect(game.getState()).toMatchObject({ phase: 'playing', round: 2, startedAt: null });
  });
});
