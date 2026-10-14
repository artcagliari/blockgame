import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { GameService, ScoreOutcome } from './game-service.js';
import { GIFT_ID_PATTERN, type GiftRegistry } from './gift-registry.js';
import type { Logger } from './logger.js';
import type { Store } from './store/types.js';
import type { DiagnosticLiveEvent, FollowLiveEvent, GiftLiveEvent, LikeLiveEvent, LiveEvent } from './tiktok/events.js';
import type { Team } from '../src/game/types.js';

/** Comentário que é só o número da equipe: "13", "22", "#13", "22!!" etc. */
export function commentVote(text: string | undefined): Team | null {
  const match = /^\s*#?\s*(13|22)\s*[!.?]*\s*$/.exec(text ?? '');
  return match ? (match[1] === '13' ? 'lula' : 'bolsonaro') : null;
}

/** Uma pessoa só conta 1 comentário a cada tantos ms (anti-spam). */
export const COMMENT_COOLDOWN_MS = 3_000;

const MAX_UNITS_PER_EVENT = 9_999;

export interface PipelineSummary {
  at: number;
  origin: 'real' | 'test';
  kind: string;
  status: ScoreOutcome['status'];
  reason?: string;
  team?: string;
  points?: number;
  giftId?: string;
  giftName?: string | null;
  viewer?: string;
}

export interface PipelineOptions {
  hashSecret: string;
  maxLikesPerEvent: number;
}

/**
 * Converte eventos normalizados do TikTok (ou simulados) em pontuação:
 * valida, mapeia pelo giftId, trata combos e seguidores e delega a gravação ao GameService.
 *
 * Regras conservadoras: sem identificação confiável não há pontos; tudo é registrado.
 */
export class LivePipeline extends EventEmitter {
  /**
   * Fila FIFO única. O TikTok entrega atualizações de combo em rajada; ler o estado do combo,
   * decidir o incremento e gravar precisa ser atômico em relação ao evento seguinte.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private lastCommentAt = new Map<string, number>();

  constructor(
    private readonly game: GameService,
    private readonly registry: GiftRegistry,
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly options: PipelineOptions,
  ) {
    super();
  }

  hashUser(userId: string): string {
    return createHmac('sha256', this.options.hashSecret).update(userId).digest('hex').slice(0, 32);
  }

  handle(event: LiveEvent, origin: 'real' | 'test', sessionKey: string): Promise<ScoreOutcome> {
    const run = this.chain.then(() => this.process(event, origin, sessionKey));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async process(event: LiveEvent, origin: 'real' | 'test', sessionKey: string): Promise<ScoreOutcome> {
    let outcome: ScoreOutcome;
    try {
      switch (event.type) {
        case 'gift': outcome = await this.gift(event, origin, sessionKey); break;
        case 'like': outcome = await this.like(event, origin, sessionKey); break;
        case 'follow': outcome = await this.follow(event, origin, sessionKey); break;
        case 'comment': outcome = await this.comment(event, origin, sessionKey); break;
        default: outcome = { status: 'ignored', reason: 'diagnostic_only' };
      }
    } catch (error) {
      this.logger.error('falha ao processar evento', { type: event.type, error });
      void this.store.logError('pipeline', String((error as Error)?.message ?? error)).catch(() => {});
      outcome = { status: 'error', reason: 'exception' };
    }
    const countsAsVote = event.type === 'comment' && outcome.status !== 'ignored';
    if (event.type === 'gift' || event.type === 'like' || event.type === 'follow' || countsAsVote) {
      this.emit('processed', {
        at: Date.now(),
        origin,
        kind: event.type,
        status: outcome.status,
        reason: 'reason' in outcome ? outcome.reason : undefined,
        team: outcome.status === 'applied' ? outcome.event.team : undefined,
        points: outcome.status === 'applied' ? outcome.event.amount : undefined,
        giftId: event.type === 'gift' ? event.giftId : undefined,
        giftName: event.type === 'gift' ? event.giftName : undefined,
        viewer: event.userName || undefined,
      } satisfies PipelineSummary);
    }
    return outcome;
  }

  // ---- LIKE: +1 bloco ao Lula por curtida incremental ----
  private async like(event: LikeLiveEvent, origin: 'real' | 'test', sessionKey: string): Promise<ScoreOutcome> {
    const prefix = origin === 'test' ? 'test:' : '';
    const userHash = event.userId ? this.hashUser(event.userId) : undefined;
    const key = event.msgId
      ? `${prefix}like:${sessionKey}:${event.msgId}`
      : `${prefix}like:${sessionKey}:${userHash ?? 'anon'}:${event.total ?? 'x'}:${event.count}:${event.at}`;
    if (!Number.isInteger(event.count) || event.count < 1) {
      await this.game.ignore({ dedupeKey: key, origin, kind: 'like', reason: 'invalid_like_count', sessionKey, userHash });
      return { status: 'ignored', reason: 'invalid_like_count' };
    }
    let amount = event.count;
    if (amount > this.options.maxLikesPerEvent) {
      this.logger.warn('lote de curtidas acima do limite; aplicando o limite', { received: amount, limit: this.options.maxLikesPerEvent });
      amount = this.options.maxLikesPerEvent;
    }
    return this.game.score({
      dedupeKey: key, origin, kind: 'like', effect: 'like', team: 'lula', amount, likes: amount, viewerName: event.userName || undefined,
      sessionKey, userHash,
    });
  }

  // ---- COMENTÁRIO "13"/"22": acumula até `commentsPerBlock` e vira 1 bloco ----
  private async comment(event: DiagnosticLiveEvent, origin: 'real' | 'test', sessionKey: string): Promise<ScoreOutcome> {
    const team = commentVote(event.text);
    // Comentários comuns não são gravados (são só diagnóstico).
    if (!team) return { status: 'ignored', reason: 'not_a_vote' };
    if (!this.game.getState().config.commentVotes) return { status: 'ignored', reason: 'comment_votes_disabled' };
    const prefix = origin === 'test' ? 'test:' : '';
    const userHash = event.userId ? this.hashUser(event.userId) : undefined;
    const now = event.at || Date.now();
    const userKey = `${prefix}${sessionKey}:${userHash ?? 'anon'}`;
    if (now - (this.lastCommentAt.get(userKey) ?? 0) < COMMENT_COOLDOWN_MS) {
      return { status: 'ignored', reason: 'comment_rate_limited' };
    }
    const key = event.msgId
      ? `${prefix}comment:${sessionKey}:${event.msgId}`
      : `${prefix}comment:${sessionKey}:${userHash ?? 'anon'}:${now}`;
    const outcome = await this.game.score({
      dedupeKey: key, origin, kind: 'comment', effect: 'comment', team, amount: 1, comments: 1,
      viewerName: event.userName || undefined, sessionKey, userHash,
    });
    if (outcome.status === 'applied' || outcome.status === 'accumulated') {
      this.lastCommentAt.set(userKey, now);
      if (this.lastCommentAt.size > 20_000) this.lastCommentAt.clear();
    }
    return outcome;
  }

  // ---- FOLLOW: +1 bloco ao Bolsonaro, uma vez por usuário e sessão LIVE ----
  private async follow(event: FollowLiveEvent, origin: 'real' | 'test', sessionKey: string): Promise<ScoreOutcome> {
    const prefix = origin === 'test' ? 'test:' : '';
    if (!event.userId) {
      const key = `${prefix}follow-nouser:${sessionKey}:${event.msgId || event.at}`;
      this.logger.warn('evento de seguir sem identificador do usuário; ignorado (limitação do conector)', { via: event.via });
      await this.game.ignore({ dedupeKey: key, origin, kind: 'follow', reason: 'follow_without_user_id', sessionKey });
      return { status: 'ignored', reason: 'follow_without_user_id' };
    }
    const userHash = this.hashUser(event.userId);
    // Mesma chave para FOLLOW e SOCIAL: a mesma ação nunca vale duas vezes.
    const key = `${prefix}follow:${sessionKey}:${userHash}`;
    const claim = { sessionKey: `${prefix}${sessionKey}`, userHash };
    if (await this.store.hasFollower(claim)) return { status: 'duplicate', reason: 'follower_already_counted' };
    return this.game.score({
      dedupeKey: key, origin, kind: 'follow', effect: 'follow', team: 'bolsonaro', amount: 1,
      viewerName: event.userName || undefined, sessionKey, userHash, follower: claim,
    });
  }

  // ---- GIFT ----
  private async gift(event: GiftLiveEvent, origin: 'real' | 'test', sessionKey: string): Promise<ScoreOutcome> {
    const prefix = origin === 'test' ? 'test:' : '';
    const userHash = event.userId ? this.hashUser(event.userId) : undefined;
    const msgKey = event.msgId
      ? `${prefix}gift:${sessionKey}:${event.msgId}`
      : `${prefix}gift:${sessionKey}:${userHash ?? 'anon'}:${event.giftId}:${event.groupId}:${event.repeatCount}:${event.repeatEnd ? 1 : 0}:${event.at}`;
    const ignore = async (reason: string, extra: { team?: 'lula' | 'bolsonaro'; slotId?: string } = {}): Promise<ScoreOutcome> => {
      const fresh = await this.game.ignore({ dedupeKey: msgKey, origin, kind: 'gift', reason, sessionKey, userHash, rawGiftId: event.giftId || undefined, ...extra });
      return fresh ? { status: 'ignored', reason } : { status: 'duplicate', reason: 'already_recorded' };
    };

    // Teste pode apontar o slot diretamente; eventos reais só entram por giftId numérico.
    let resolved = origin === 'test' && event.slotId ? this.registry.resolveSlot(event.slotId) : null;
    if (!resolved) {
      if (!GIFT_ID_PATTERN.test(event.giftId)) return ignore('invalid_gift_id');
      await this.registry.noteSeen(event.giftId, { name: event.giftName, imageUrl: event.imageUrl, coins: event.coins });
      resolved = this.registry.resolve(event.giftId);
      if (!resolved) {
        this.logger.info('presente desconhecido registrado para mapeamento', { giftId: event.giftId, name: event.giftName });
        this.emit('unknownGift', { giftId: event.giftId, name: event.giftName, imageUrl: event.imageUrl, coins: event.coins });
        return ignore('unmapped_gift');
      }
    }
    const { slot, mapping } = resolved;
    if (!mapping.active) return ignore('inactive_gift', { team: slot.team, slotId: slot.slotId });
    if (origin === 'real' && mapping.boundCoins != null && event.coins != null && mapping.boundCoins !== event.coins) {
      this.logger.warn('metadados divergentes do presente mapeado; pontuação mantida', {
        giftId: event.giftId, expectedCoins: mapping.boundCoins, receivedCoins: event.coins,
      });
      this.emit('metadataMismatch', { giftId: event.giftId, expectedCoins: mapping.boundCoins, receivedCoins: event.coins });
    }

    // Combos: só o incremento ainda não contabilizado vale ponto.
    let units = Math.min(MAX_UNITS_PER_EVENT, Math.max(1, event.repeatCount));
    let combo;
    if (event.streakable) {
      const reliable = Boolean(event.groupId && userHash);
      if (reliable) {
        const comboKey = `${prefix}${sessionKey}:${userHash}:${event.giftId || slot.slotId}:${event.groupId}`;
        const previous = await this.store.getCombo(comboKey);
        const processed = previous?.processedCount ?? 0;
        const delta = units - processed;
        if (delta <= 0) return ignore(event.repeatEnd ? 'combo_end_already_counted' : 'combo_already_counted', { team: slot.team, slotId: slot.slotId });
        units = delta;
        combo = {
          comboKey,
          sessionKey: `${prefix}${sessionKey}`,
          giftId: event.giftId || slot.slotId,
          userHash: userHash!,
          processedCount: event.repeatCount,
          finished: event.repeatEnd,
        };
      } else if (!event.repeatEnd) {
        // Sem groupId/usuário não há como saber quanto já foi contado: só o fechamento vale.
        return ignore('combo_intermediate_unreliable', { team: slot.team, slotId: slot.slotId });
      }
    }

    return this.game.score({
      dedupeKey: msgKey,
      origin,
      kind: 'gift',
      effect: 'gift',
      team: slot.team,
      amount: units * mapping.blocks,
      giftId: slot.visualId,
      giftName: event.giftName ?? slot.label,
      viewerName: event.userName || undefined,
      count: units,
      sessionKey,
      userHash,
      rawGiftId: event.giftId || undefined,
      slotId: slot.slotId,
      combo,
    });
  }
}
