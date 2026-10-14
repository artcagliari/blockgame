import { EventEmitter } from 'node:events';
import type { EventKind, EventOrigin, GameConfig, GameState, IncrementEvent, Team } from '../src/game/types.js';
import { GameEngine, type ScoreMeta } from './game-engine.js';
import type { Logger } from './logger.js';
import type { ComboRow, FollowerClaim, RoundRow, Store } from './store/types.js';

export interface ScoreInput {
  /** Chave de idempotência do evento (mensagem do TikTok, seguidor da sessão, simulação...). */
  dedupeKey: string;
  origin: Exclude<EventOrigin, 'auto'>;
  kind: EventKind;
  team: Team;
  amount: number;
  effect?: IncrementEvent['effect'];
  /** Identificador visual do presente (catálogo do jogo). */
  giftId?: string;
  giftName?: string;
  viewerName?: string;
  count?: number;
  sessionKey?: string;
  userHash?: string;
  /** giftId real do TikTok (apenas para auditoria). */
  rawGiftId?: string;
  slotId?: string;
  follower?: FollowerClaim;
  combo?: ComboRow;
}

export type ScoreOutcome =
  | { status: 'applied'; event: IncrementEvent }
  | { status: 'duplicate'; reason: string }
  | { status: 'ignored'; reason: string }
  | { status: 'error'; reason: string };

const RECENT_LIMIT = 5_000;
const TICK_MS = 450;
const HEARTBEAT_MS = 1_000;
const SAVE_DEBOUNCE_MS = 1_000;
const PURGE_EVERY_MS = 6 * 60 * 60 * 1_000;

/**
 * Dono do estado oficial em produção. Serializa TODA mudança (eventos reais, simulados,
 * relógio, gerador automático e comandos administrativos) em uma única fila, e grava o
 * placar junto com o evento na mesma transação antes de aplicá-lo e de notificar o overlay.
 */
export class GameService extends EventEmitter {
  private chain: Promise<unknown> = Promise.resolve();
  private recent = new Set<string>();
  private tickTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private lastSavedSeq = -1;
  private started = false;

  constructor(
    readonly engine: GameEngine,
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly options: { retentionDays?: number; clock?: () => number } = {},
  ) {
    super();
    engine.on('state', (state: GameState) => this.emit('state', state));
    engine.on('increment', (event: IncrementEvent) => this.emit('increment', event));
    engine.on('roundStarted', (state: GameState) => this.emit('roundStarted', state));
    engine.on('roundEnded', (state: GameState) => this.emit('roundEnded', state));
    engine.on('roundStarted', () => this.saveSoon(true));
    engine.on('roundEnded', () => this.saveSoon(true));
  }

  /** Restaura o último estado persistido. Não reaplica eventos já processados. */
  async init(): Promise<void> {
    const saved = await this.store.loadGame();
    if (saved) {
      this.engine.restore(saved);
      this.logger.info('estado restaurado', { round: saved.state.round, seq: this.engine.seq });
    } else {
      this.logger.info('nenhum estado anterior; iniciando partida nova');
    }
    await this.persistNow();
  }

  /** Inicia relógio e gerador automático. Idempotente: nunca há dois motores. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.tickTimer = setInterval(() => {
      void this.exclusive(async () => {
        this.engine.tick();
        this.saveSoon();
      });
    }, TICK_MS);
    this.heartbeatTimer = setInterval(() => this.engine.broadcast(), HEARTBEAT_MS);
    const retentionMs = (this.options.retentionDays ?? 30) * 24 * 60 * 60 * 1_000;
    const purge = () => this.store.purge(retentionMs)
      .then((result) => this.logger.info('retenção aplicada', result))
      .catch((error) => this.logger.warn('falha na retenção', { error }));
    this.purgeTimer = setInterval(purge, PURGE_EVERY_MS);
    void purge();
    this.tickTimer.unref?.();
    this.heartbeatTimer.unref?.();
    this.purgeTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const timer of [this.tickTimer, this.heartbeatTimer, this.purgeTimer, this.saveTimer]) if (timer) clearInterval(timer);
    this.tickTimer = this.heartbeatTimer = this.purgeTimer = this.saveTimer = null;
    await this.exclusive(() => this.persistNow());
  }

  getState(): GameState {
    return this.engine.getState();
  }

  /** Aplica um evento de pontuação (TikTok ou simulação) com idempotência e transação. */
  score(input: ScoreInput): Promise<ScoreOutcome> {
    return this.exclusive(() => this.scoreLocked(input));
  }

  /** Registra um evento sem pontos (presente desconhecido, sem equipe, etc.). Idempotente. */
  async ignore(row: { dedupeKey: string; origin: ScoreInput['origin']; kind: EventKind; reason: string; sessionKey?: string; userHash?: string; rawGiftId?: string; slotId?: string; team?: Team }): Promise<boolean> {
    if (this.recent.has(row.dedupeKey)) return false;
    const inserted = await this.store.recordIgnoredEvent({
      dedupeKey: row.dedupeKey,
      origin: row.origin,
      kind: row.kind,
      status: 'ignored',
      reason: row.reason,
      team: row.team,
      points: 0,
      roundId: this.engine.getState().roundId,
      sessionKey: row.sessionKey,
      userHash: row.userHash,
      giftId: row.rawGiftId,
      slotId: row.slotId,
    });
    this.remember(row.dedupeKey);
    return inserted;
  }

  pause(): Promise<boolean> { return this.exclusive(async () => { const ok = this.engine.pause(); await this.persistNow(); return ok; }); }
  resume(): Promise<boolean> { return this.exclusive(async () => { const ok = this.engine.resume(); await this.persistNow(); return ok; }); }
  resetRound(): Promise<void> { return this.exclusive(async () => { this.engine.resetRound(); await this.persistNow(); }); }
  updateConfig(patch: Partial<GameConfig>): Promise<GameConfig> {
    return this.exclusive(async () => { const next = this.engine.updateConfig(patch); await this.persistNow(); return next; });
  }

  // --- internos ---

  private async scoreLocked(input: ScoreInput): Promise<ScoreOutcome> {
    if (this.recent.has(input.dedupeKey)) return { status: 'duplicate', reason: 'recent_cache' };
    const meta: ScoreMeta = {
      origin: input.origin,
      kind: input.kind,
      effect: input.effect,
      giftId: input.giftId,
      giftName: input.giftName,
      viewerName: input.viewerName,
      count: input.count,
    };
    const plan = this.engine.plan(input.team, input.amount, meta);
    if ('rejected' in plan) {
      await this.ignore({
        dedupeKey: input.dedupeKey, origin: input.origin, kind: input.kind, reason: plan.rejected,
        sessionKey: input.sessionKey, userHash: input.userHash, rawGiftId: input.rawGiftId, slotId: input.slotId, team: input.team,
      });
      // O combo avança mesmo sem pontuar: a parte recebida fora de jogo nunca é creditada depois.
      if (input.combo) await this.store.upsertCombo(input.combo);
      return { status: 'ignored', reason: plan.rejected };
    }

    const clock = this.options.clock ?? Date.now;
    let result;
    try {
      result = await this.store.commitScoringEvent({
        event: {
          dedupeKey: input.dedupeKey,
          origin: input.origin,
          kind: input.kind,
          status: 'applied',
          team: input.team,
          points: plan.event.amount,
          roundId: plan.event.roundId,
          sessionKey: input.sessionKey,
          userHash: input.userHash,
          giftId: input.rawGiftId,
          slotId: input.slotId,
        },
        snapshot: { state: plan.next, savedAt: clock() },
        round: roundRow(plan.next, clock()),
        combo: input.combo,
        follower: input.follower,
      });
    } catch (error) {
      this.logger.error('falha ao gravar evento; pontuação NÃO aplicada', { error, kind: input.kind });
      void this.store.logError('score', String((error as Error)?.message ?? error)).catch(() => {});
      return { status: 'error', reason: 'persist_failed' };
    }
    if (result !== 'ok') {
      this.remember(input.dedupeKey);
      return { status: 'duplicate', reason: result };
    }
    this.engine.commit(plan);
    this.remember(input.dedupeKey);
    this.lastSavedSeq = plan.next.seq;
    return { status: 'applied', event: plan.event };
  }

  private remember(key: string): void {
    this.recent.add(key);
    if (this.recent.size > RECENT_LIMIT) {
      const oldest = this.recent.values().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
  }

  private saveSoon(immediate = false): void {
    if (this.engine.seq === this.lastSavedSeq) return;
    if (immediate) {
      void this.persistNow().catch(() => {});
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persistNow().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private async persistNow(): Promise<void> {
    const clock = this.options.clock ?? Date.now;
    const snapshot = this.engine.snapshot();
    try {
      await this.store.saveGame(snapshot, roundRow(snapshot.state, clock()));
      this.lastSavedSeq = snapshot.state.seq;
    } catch (error) {
      this.logger.error('falha ao persistir estado; o jogo continua em memória', { error });
      void this.store.logError('persist', String((error as Error)?.message ?? error)).catch(() => {});
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export function roundRow(state: GameState, now: number): RoundRow {
  return {
    roundId: state.roundId,
    round: state.round,
    startedAt: state.startedAt ?? now,
    endedAt: state.phase === 'result' ? state.resultStartedAt ?? now : null,
    target: state.config.target,
    lula: state.teams.lula.score,
    bolsonaro: state.teams.bolsonaro.score,
    winner: state.winner,
  };
}
