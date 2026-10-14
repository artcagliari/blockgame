import { EventEmitter } from 'node:events';
import {
  DEFAULT_CONFIG,
  type EventKind,
  type EventOrigin,
  type GameConfig,
  type GameState,
  type IncrementEvent,
  type Team,
} from '../src/game/types.js';

const MIN_TARGET = 10;
const MAX_TARGET = 100_000;
const MIN_DURATION = 10;
const MAX_DURATION = 3_600;
export const MAX_EVENT_INCREMENT = 5_000;
const TEAMS: Team[] = ['lula', 'bolsonaro'];

export interface ScoreMeta {
  origin: EventOrigin;
  kind: EventKind;
  effect?: IncrementEvent['effect'];
  giftId?: string;
  giftName?: string;
  viewerName?: string;
  count?: number;
}

export type RejectReason = 'paused' | 'result_phase' | 'invalid_amount' | 'target_reached';

/** Resultado de calcular (sem aplicar) uma mudança de placar. */
export interface ScorePlan {
  baseSeq: number;
  next: GameState;
  /** null quando a mudança não adiciona blocos (ex.: curtidas acumulando). */
  event: IncrementEvent | null;
  roundEnded: boolean;
}

export interface PersistedGame {
  state: GameState;
  savedAt: number;
}

export class StalePlanError extends Error {
  constructor() {
    super('O estado do jogo mudou entre o cálculo e a aplicação do evento.');
  }
}

export interface GameEngineOptions {
  /** Desliga totalmente o gerador automático (útil em testes e para diagnóstico). */
  autoplay?: boolean;
  now?: () => number;
}

/**
 * Estado oficial do jogo. Não conhece sockets, TikTok nem banco.
 *
 * - `plan()` calcula uma mudança sem aplicá-la, para que a camada de persistência a grave
 *   de forma atômica antes do `commit()`.
 * - `tick()` avança relógio, fim de rodada e gerador automático. Quem chama é responsável
 *   por serializar `tick()` com `plan()/commit()` (ver GameService).
 */
export class GameEngine extends EventEmitter {
  private state: GameState;
  private tickTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly autoplay: boolean;
  private readonly now: () => number;

  constructor(config: Partial<GameConfig> = {}, options: GameEngineOptions = {}) {
    super();
    this.autoplay = options.autoplay ?? true;
    this.now = options.now ?? Date.now;
    const merged = normalizeConfig({ ...DEFAULT_CONFIG, ...config });
    const now = this.now();
    this.state = {
      round: 1,
      roundId: 1,
      seq: 1,
      pendingLikes: 0,
      phase: 'playing',
      teams: { lula: { score: 0, wins: 0 }, bolsonaro: { score: 0, wins: 0 } },
      config: merged,
      // O relógio só começa no primeiro evento: sem LIVE, a rodada fica aguardando.
      startedAt: null,
      pausedAt: null,
      pauseAccumulatedMs: 0,
      resultStartedAt: null,
      winner: null,
      serverNow: now,
    };
  }

  /** Timers internos (modo autônomo). O GameService usa tick()/broadcast() por conta própria. */
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), 450);
    this.heartbeatTimer = setInterval(() => this.broadcast(), 1_000);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.tickTimer = null;
    this.heartbeatTimer = null;
  }

  get running(): boolean {
    return this.tickTimer !== null;
  }

  getState(): GameState {
    return structuredClone({ ...this.state, serverNow: this.now() });
  }

  get seq(): number {
    return this.state.seq;
  }

  snapshot(): PersistedGame {
    return { state: structuredClone(this.state), savedAt: this.now() };
  }

  /** Restaura após reinício do servidor. O tempo parado do processo não conta como tempo de jogo. */
  restore(saved: PersistedGame): void {
    const state = structuredClone(saved.state);
    const now = this.now();
    state.config = normalizeConfig({ ...DEFAULT_CONFIG, ...state.config });
    state.roundId = state.roundId ?? 1;
    state.pendingLikes = Number.isFinite(state.pendingLikes) ? state.pendingLikes : 0;
    state.seq = (state.seq ?? 0) + 1;
    if (state.startedAt === null) {
      // Rodada ainda aguardando o primeiro evento: nada a ajustar.
      state.pausedAt = state.phase === 'paused' ? now : null;
    } else if (state.phase === 'playing' || state.phase === 'paused') {
      const reference = state.phase === 'paused' && state.pausedAt ? state.pausedAt : saved.savedAt;
      const elapsed = Math.max(0, reference - (state.startedAt ?? reference) - state.pauseAccumulatedMs);
      state.startedAt = now - elapsed;
      state.pauseAccumulatedMs = 0;
      state.pausedAt = state.phase === 'paused' ? now : null;
    } else if (state.resultStartedAt) {
      state.resultStartedAt = now - Math.max(0, saved.savedAt - state.resultStartedAt);
    }
    this.state = state;
    this.broadcast();
  }

  pause(): boolean {
    if (this.state.phase !== 'playing') return false;
    const next = this.mutable();
    next.phase = 'paused';
    next.pausedAt = this.now();
    this.apply(next);
    return true;
  }

  resume(): boolean {
    if (this.state.phase !== 'paused') return false;
    const next = this.mutable();
    const now = this.now();
    if (next.pausedAt) next.pauseAccumulatedMs += now - next.pausedAt;
    next.pausedAt = null;
    next.phase = 'playing';
    this.apply(next);
    return true;
  }

  /** Reinicia a rodada atual (mesmo número, novo roundId, placar zerado). */
  resetRound(): void {
    this.beginRound(false);
  }

  updateConfig(patch: Partial<GameConfig>): GameConfig {
    const next = this.mutable();
    next.config = normalizeConfig({ ...next.config, ...patch, autoTeams: { ...next.config.autoTeams, ...patch.autoTeams } });
    this.apply(next);
    return structuredClone(next.config);
  }

  /** Calcula o efeito de um incremento sem aplicá-lo. */
  plan(team: Team, amount: number, meta: ScoreMeta): ScorePlan | { rejected: RejectReason } {
    if (this.state.phase === 'paused') return { rejected: 'paused' };
    if (this.state.phase !== 'playing') return { rejected: 'result_phase' };
    if (!Number.isFinite(amount) || amount < 1) return { rejected: 'invalid_amount' };
    const target = this.state.config.target;
    const before = this.state.teams[team].score;
    const safe = Math.min(MAX_EVENT_INCREMENT, Math.round(amount));
    const total = Math.min(target, before + safe);
    if (total <= before) return { rejected: 'target_reached' };

    const next = structuredClone(this.state);
    next.teams[team].score = total;
    next.seq += 1;
    next.serverNow = this.now();
    if (next.startedAt === null) next.startedAt = this.now();
    let roundEnded = false;
    if (total >= target) {
      roundEnded = true;
      next.phase = 'result';
      next.winner = team;
      next.resultStartedAt = this.now();
      next.teams[team].wins += 1;
    }
    const opponent: Team = team === 'lula' ? 'bolsonaro' : 'lula';
    const event: IncrementEvent = {
      id: `${next.roundId}-${next.seq}`,
      roundId: next.roundId,
      seq: next.seq,
      team,
      amount: total - before,
      total,
      opponentTotal: next.teams[opponent].score,
      source: meta.kind === 'gift' ? 'gift' : meta.origin === 'auto' ? 'automatic' : 'admin',
      origin: meta.origin,
      kind: meta.kind,
      effect: meta.effect,
      giftId: meta.giftId,
      giftName: meta.giftName,
      count: meta.count,
      viewerName: meta.viewerName,
      at: this.now(),
    };
    return { baseSeq: this.state.seq, next, event, roundEnded };
  }

  /**
   * Curtidas: acumulam até completar `likesPerBlock` e só então viram blocos.
   * O resto fica guardado para a próxima curtida (zera no início de cada rodada).
   */
  planLikes(team: Team, likes: number, meta: ScoreMeta): ScorePlan | { rejected: RejectReason } {
    if (this.state.phase === 'paused') return { rejected: 'paused' };
    if (this.state.phase !== 'playing') return { rejected: 'result_phase' };
    if (!Number.isFinite(likes) || likes < 1) return { rejected: 'invalid_amount' };
    const per = this.state.config.likesPerBlock;
    const total = this.state.pendingLikes + Math.round(likes);
    const blocks = Math.floor(total / per);
    const rest = total % per;
    if (blocks === 0) {
      const next = structuredClone(this.state);
      next.pendingLikes = rest;
      next.seq += 1;
      next.serverNow = this.now();
      return { baseSeq: this.state.seq, next, event: null, roundEnded: false };
    }
    const plan = this.plan(team, blocks, { ...meta, count: Math.round(likes) });
    if ('rejected' in plan) return plan;
    plan.next.pendingLikes = rest;
    return plan;
  }

  /** Aplica um plano previamente calculado e notifica os assinantes. */
  commit(plan: ScorePlan): void {
    if (plan.baseSeq !== this.state.seq) throw new StalePlanError();
    this.state = plan.next;
    if (plan.event) this.emit('increment', plan.event);
    if (plan.roundEnded) this.emit('roundEnded', this.getState());
    this.broadcast();
  }

  /** Atalho síncrono: calcula e aplica. Usado pelo gerador automático. */
  increment(team: Team, amount: number, meta: ScoreMeta): IncrementEvent | null {
    const plan = this.plan(team, amount, meta);
    if ('rejected' in plan) return null;
    this.commit(plan);
    return plan.event;
  }

  /** Atalho síncrono para curtidas (usado em testes). */
  addLikes(team: Team, likes: number, meta: ScoreMeta): IncrementEvent | null {
    const plan = this.planLikes(team, likes, meta);
    if ('rejected' in plan) return null;
    this.commit(plan);
    return plan.event;
  }

  tick(): void {
    const now = this.now();
    const { phase, config } = this.state;
    if (phase === 'result') {
      const started = this.state.resultStartedAt;
      if (config.autoRestart && started && now - started >= config.resultSeconds * 1_000) this.beginRound(true);
      return;
    }
    if (phase !== 'playing') return;

    // Meta reduzida pelo administrador abaixo de um placar já existente encerra a rodada.
    for (const team of TEAMS) {
      if (this.state.teams[team].score >= config.target) {
        this.finishRound(team);
        return;
      }
    }

    const elapsed = this.state.startedAt === null ? 0 : now - this.state.startedAt - this.state.pauseAccumulatedMs;
    if (this.state.startedAt !== null && elapsed >= config.durationSeconds * 1_000) {
      const { lula, bolsonaro } = this.state.teams;
      this.finishRound(lula.score === bolsonaro.score ? 'draw' : lula.score > bolsonaro.score ? 'lula' : 'bolsonaro');
      return;
    }

    if (!this.autoplay || !config.autoEnabled) return;
    // Mesma distribuição para as duas equipes; a ordem é sorteada para não favorecer ninguém.
    const order: Team[] = Math.random() < 0.5 ? ['lula', 'bolsonaro'] : ['bolsonaro', 'lula'];
    for (const team of order) {
      if (!config.autoTeams[team] || this.state.phase !== 'playing') continue;
      if (Math.random() >= 0.72) continue;
      const base = 1 + Math.floor(Math.random() * 5);
      const burst = Math.random() < 0.08 ? 3 + Math.floor(Math.random() * 8) : 0;
      this.increment(team, Math.max(1, Math.round((base + burst) * config.autoSpeed)), { origin: 'auto', kind: 'auto' });
    }
  }

  broadcast(): void {
    this.emit('state', this.getState());
  }

  private finishRound(winner: Team | 'draw'): void {
    if (this.state.phase === 'result') return;
    const next = this.mutable();
    next.phase = 'result';
    next.winner = winner;
    next.resultStartedAt = this.now();
    if (winner !== 'draw') next.teams[winner].wins += 1;
    this.state = next;
    this.emit('roundEnded', this.getState());
    this.broadcast();
  }

  private beginRound(incrementRound: boolean): void {
    const next = this.mutable();
    if (incrementRound) next.round += 1;
    next.roundId += 1;
    next.phase = 'playing';
    next.teams.lula.score = 0;
    next.teams.bolsonaro.score = 0;
    next.pendingLikes = 0;
    next.startedAt = null;
    next.pausedAt = null;
    next.pauseAccumulatedMs = 0;
    next.resultStartedAt = null;
    next.winner = null;
    this.state = next;
    this.emit('roundStarted', this.getState());
    this.broadcast();
  }

  private mutable(): GameState {
    const next = structuredClone(this.state);
    next.seq += 1;
    next.serverNow = this.now();
    return next;
  }

  private apply(next: GameState): void {
    this.state = next;
    this.broadcast();
  }
}

export function normalizeConfig(input: Partial<GameConfig>): GameConfig {
  const base = { ...DEFAULT_CONFIG, ...input };
  return {
    target: clamp(Math.round(base.target), MIN_TARGET, MAX_TARGET),
    durationSeconds: clamp(Math.round(base.durationSeconds), MIN_DURATION, MAX_DURATION),
    resultSeconds: clamp(Math.round(base.resultSeconds), 3, 60),
    autoSpeed: clamp(base.autoSpeed, 0.1, 5),
    soundEnabled: Boolean(base.soundEnabled),
    autoEnabled: Boolean(base.autoEnabled),
    autoTeams: {
      lula: Boolean(base.autoTeams?.lula ?? true),
      bolsonaro: Boolean(base.autoTeams?.bolsonaro ?? true),
    },
    autoRestart: Boolean(base.autoRestart),
    likesPerBlock: clamp(Math.round(base.likesPerBlock ?? 120), 1, 10_000),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
