import type { PersistedGame } from '../game-engine.js';
import type { AudioClipInfo, EventOrigin } from '../../src/game/types.js';
import type {
  CommitInput,
  CommitResult,
  ComboRow,
  EventRow,
  EventStats,
  IgnoredReason,
  FollowerClaim,
  GiftMappingRow,
  GiftRegistryEntry,
  LiveSessionRow,
  RoundRow,
  Store,
} from './types.js';

type StoredEvent = EventRow & { at: number };

/**
 * Armazenamento volátil: desenvolvimento e testes. Mesma semântica do PostgreSQL
 * (idempotência por chave, gravação atômica), mas nada sobrevive a reinício do processo.
 */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private game: PersistedGame | null = null;
  private rounds = new Map<number, RoundRow>();
  private settings = new Map<string, unknown>();
  private events = new Map<string, StoredEvent>();
  private combos = new Map<string, ComboRow & { at: number }>();
  private followers = new Map<string, number>();
  private registry = new Map<string, GiftRegistryEntry>();
  private mappings = new Map<string, GiftMappingRow>();
  private sessions = new Map<string, LiveSessionRow>();
  private audioClips = new Map<string, AudioClipInfo>();
  private audioBlobs = new Map<string, Buffer>();
  private errors: Array<{ at: number; scope: string; message: string }> = [];
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async ping(): Promise<boolean> { return true; }

  async loadGame(): Promise<PersistedGame | null> {
    return this.game ? structuredClone(this.game) : null;
  }

  async saveGame(game: PersistedGame, round: RoundRow): Promise<void> {
    this.game = structuredClone(game);
    this.rounds.set(round.roundId, { ...round });
  }

  async getSetting<T>(key: string): Promise<T | null> {
    return this.settings.has(key) ? structuredClone(this.settings.get(key) as T) : null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, structuredClone(value));
  }

  async commitScoringEvent(input: CommitInput): Promise<CommitResult> {
    if (this.events.has(input.event.dedupeKey)) return 'duplicate';
    if (input.follower) {
      const key = followerKey(input.follower);
      if (this.followers.has(key)) return 'duplicate_follower';
    }
    // Tudo ou nada: validações acima já passaram, agora grava.
    this.events.set(input.event.dedupeKey, { ...input.event, at: this.clock() });
    if (input.follower) this.followers.set(followerKey(input.follower), this.clock());
    if (input.combo) this.combos.set(input.combo.comboKey, { ...input.combo, at: this.clock() });
    this.game = structuredClone(input.snapshot);
    this.rounds.set(input.round.roundId, { ...input.round });
    return 'ok';
  }

  async recordIgnoredEvent(row: EventRow): Promise<boolean> {
    if (this.events.has(row.dedupeKey)) return false;
    this.events.set(row.dedupeKey, { ...row, at: this.clock() });
    return true;
  }

  async hasEvent(dedupeKey: string): Promise<boolean> {
    return this.events.has(dedupeKey);
  }

  async hasFollower(claim: FollowerClaim): Promise<boolean> {
    return this.followers.has(followerKey(claim));
  }

  async getCombo(comboKey: string): Promise<ComboRow | null> {
    const combo = this.combos.get(comboKey);
    if (!combo) return null;
    const { at: _at, ...row } = combo;
    return { ...row };
  }

  async upsertCombo(row: ComboRow): Promise<void> {
    this.combos.set(row.comboKey, { ...row, at: this.clock() });
  }

  async stats(sinceMs = 0): Promise<EventStats[]> {
    const bucket = new Map<string, EventStats>();
    for (const event of this.events.values()) {
      if (event.at < sinceMs) continue;
      const key = `${event.origin}|${event.kind}|${event.status}`;
      const current = bucket.get(key) ?? { origin: event.origin, kind: event.kind, status: event.status, events: 0, points: 0 };
      current.events += 1;
      current.points += event.points;
      bucket.set(key, current);
    }
    return [...bucket.values()];
  }

  async ignoredReasons(sinceMs = 0): Promise<IgnoredReason[]> {
    const bucket = new Map<string, IgnoredReason>();
    for (const event of this.events.values()) {
      if (event.status !== 'ignored' || event.at < sinceMs) continue;
      const reason = event.reason ?? 'desconhecido';
      const key = `${event.origin}|${event.kind}|${reason}`;
      const current = bucket.get(key) ?? { origin: event.origin, kind: event.kind, reason, events: 0 };
      current.events += 1;
      bucket.set(key, current);
    }
    return [...bucket.values()].sort((a, b) => b.events - a.events);
  }

  async recentEvents(origin: EventOrigin | 'all', limit: number) {
    return [...this.events.values()]
      .filter((event) => origin === 'all' || event.origin === origin)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map((event) => ({ ...event }));
  }

  async listGiftRegistry(): Promise<GiftRegistryEntry[]> {
    return [...this.registry.values()].map((entry) => ({ ...entry }));
  }

  async upsertGiftRegistry(entries: Array<Pick<GiftRegistryEntry, 'giftId' | 'name' | 'imageUrl' | 'coins' | 'source'>>): Promise<void> {
    const now = this.clock();
    for (const entry of entries) {
      const current = this.registry.get(entry.giftId);
      this.registry.set(entry.giftId, {
        giftId: entry.giftId,
        name: entry.name ?? current?.name ?? null,
        imageUrl: entry.imageUrl ?? current?.imageUrl ?? null,
        coins: entry.coins ?? current?.coins ?? null,
        source: current?.source === 'manual' ? 'manual' : entry.source,
        firstSeenAt: current?.firstSeenAt ?? now,
        lastSeenAt: now,
        seenCount: current?.seenCount ?? 0,
      });
    }
  }

  async touchGift(giftId: string, patch: { name?: string | null; imageUrl?: string | null; coins?: number | null }): Promise<void> {
    const now = this.clock();
    const current = this.registry.get(giftId);
    this.registry.set(giftId, {
      giftId,
      name: patch.name ?? current?.name ?? null,
      imageUrl: patch.imageUrl ?? current?.imageUrl ?? null,
      coins: patch.coins ?? current?.coins ?? null,
      source: current?.source ?? 'event',
      firstSeenAt: current?.firstSeenAt ?? now,
      lastSeenAt: now,
      seenCount: (current?.seenCount ?? 0) + 1,
    });
  }

  async listGiftMappings(): Promise<GiftMappingRow[]> {
    return [...this.mappings.values()].map((row) => ({ ...row }));
  }

  async saveGiftMapping(row: GiftMappingRow): Promise<void> {
    if (row.giftId) {
      for (const [slot, other] of this.mappings) {
        if (slot !== row.slotId && other.giftId === row.giftId) {
          throw new Error(`O presente ${row.giftId} já está associado a ${slot}.`);
        }
      }
    }
    this.mappings.set(row.slotId, { ...row, updatedAt: this.clock() });
  }

  async openSession(session: { sessionKey: string; username: string }): Promise<LiveSessionRow> {
    const current = this.sessions.get(session.sessionKey);
    const row: LiveSessionRow = current
      ? { ...current, username: session.username, endedAt: null, connectCount: current.connectCount + 1 }
      : { sessionKey: session.sessionKey, username: session.username, startedAt: this.clock(), endedAt: null, connectCount: 1 };
    this.sessions.set(session.sessionKey, row);
    return { ...row };
  }

  async closeSession(sessionKey: string): Promise<void> {
    const current = this.sessions.get(sessionKey);
    if (current) this.sessions.set(sessionKey, { ...current, endedAt: this.clock() });
  }

  async logError(scope: string, message: string): Promise<void> {
    this.errors.push({ at: this.clock(), scope, message: message.slice(0, 500) });
    if (this.errors.length > 200) this.errors.shift();
  }

  async purge(olderThanMs: number) {
    const cutoff = this.clock() - olderThanMs;
    let events = 0;
    let combos = 0;
    let followers = 0;
    for (const [key, event] of this.events) if (event.at < cutoff) { this.events.delete(key); events += 1; }
    for (const [key, combo] of this.combos) if (combo.at < cutoff) { this.combos.delete(key); combos += 1; }
    for (const [key, at] of this.followers) if (at < cutoff) { this.followers.delete(key); followers += 1; }
    const before = this.errors.length;
    this.errors = this.errors.filter((entry) => entry.at >= cutoff);
    return { events, combos, followers, errors: before - this.errors.length };
  }

  async listAudioClips(): Promise<AudioClipInfo[]> {
    return [...this.audioClips.values()].map((clip) => ({ ...clip })).sort((a, b) => a.createdAt - b.createdAt);
  }
  async getAudioClip(id: string): Promise<AudioClipInfo | null> {
    const clip = this.audioClips.get(id);
    return clip ? { ...clip } : null;
  }
  async saveAudioClip(clip: AudioClipInfo): Promise<void> { this.audioClips.set(clip.id, { ...clip }); }
  async deleteAudioClip(id: string): Promise<void> {
    this.audioClips.delete(id);
    this.audioBlobs.delete(id);
  }
  async putAudioBlob(id: string, data: Buffer): Promise<void> { this.audioBlobs.set(id, Buffer.from(data)); }
  async getAudioBlob(id: string): Promise<Buffer | null> { return this.audioBlobs.get(id) ?? null; }

  async acquireLeadership(): Promise<boolean> { return true; }
  async releaseLeadership(): Promise<void> {}
}

function followerKey(claim: FollowerClaim): string {
  return `${claim.sessionKey}|${claim.userHash}`;
}
