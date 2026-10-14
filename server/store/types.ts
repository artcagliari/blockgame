import type { AudioClipInfo, EventKind, EventOrigin, Team } from '../../src/game/types.js';
import type { PersistedGame } from '../game-engine.js';

export type EventStatus = 'applied' | 'ignored';

export interface EventRow {
  dedupeKey: string;
  origin: EventOrigin;
  kind: EventKind;
  status: EventStatus;
  /** Motivo quando `status = ignored` (paused, result_phase, unmapped_gift, ...). */
  reason?: string;
  team?: Team;
  points: number;
  roundId?: number;
  sessionKey?: string;
  /** HMAC do identificador do espectador. Nunca o identificador original. */
  userHash?: string;
  /** ID real do presente no TikTok. */
  giftId?: string;
  slotId?: string;
}

export interface RoundRow {
  roundId: number;
  round: number;
  startedAt: number;
  endedAt: number | null;
  target: number;
  lula: number;
  bolsonaro: number;
  winner: Team | 'draw' | null;
}

export interface ComboRow {
  comboKey: string;
  sessionKey: string;
  giftId: string;
  userHash: string;
  processedCount: number;
  finished: boolean;
}

export interface FollowerClaim {
  sessionKey: string;
  userHash: string;
}

export interface CommitInput {
  event: EventRow;
  snapshot: PersistedGame;
  round: RoundRow;
  combo?: ComboRow;
  follower?: FollowerClaim;
}

export type CommitResult = 'ok' | 'duplicate' | 'duplicate_follower';

export interface GiftRegistryEntry {
  giftId: string;
  name: string | null;
  imageUrl: string | null;
  coins: number | null;
  source: 'catalog' | 'event' | 'manual';
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
}

export interface GiftMappingRow {
  slotId: string;
  giftId: string | null;
  blocks: number;
  active: boolean;
  /** Metadados do presente no momento da associação (validação adicional por giftId). */
  boundName: string | null;
  boundCoins: number | null;
  updatedAt: number;
}

export interface LiveSessionRow {
  sessionKey: string;
  username: string;
  startedAt: number;
  endedAt: number | null;
  connectCount: number;
}

export interface EventStats {
  origin: EventOrigin;
  kind: EventKind;
  status: EventStatus;
  events: number;
  points: number;
}

export interface IgnoredReason {
  origin: EventOrigin;
  kind: EventKind;
  reason: string;
  events: number;
}

export interface Store {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<boolean>;

  loadGame(): Promise<PersistedGame | null>;
  saveGame(game: PersistedGame, round: RoundRow): Promise<void>;
  getSetting<T>(key: string): Promise<T | null>;
  setSetting(key: string, value: unknown): Promise<void>;

  commitScoringEvent(input: CommitInput): Promise<CommitResult>;
  /** Registra (idempotente) um evento sem pontos. Devolve false se já existia. */
  recordIgnoredEvent(row: EventRow): Promise<boolean>;
  hasEvent(dedupeKey: string): Promise<boolean>;
  hasFollower(claim: FollowerClaim): Promise<boolean>;
  getCombo(comboKey: string): Promise<ComboRow | null>;
  /** Avança o estado de um combo sem pontuar (evento ignorado por fase da partida). */
  upsertCombo(row: ComboRow): Promise<void>;
  stats(sinceMs?: number): Promise<EventStats[]>;
  /** Eventos descartados agrupados pelo motivo registrado. */
  ignoredReasons(sinceMs?: number): Promise<IgnoredReason[]>;
  recentEvents(origin: EventOrigin | 'all', limit: number): Promise<Array<EventRow & { at: number }>>;

  listGiftRegistry(): Promise<GiftRegistryEntry[]>;
  upsertGiftRegistry(entries: Array<Pick<GiftRegistryEntry, 'giftId' | 'name' | 'imageUrl' | 'coins' | 'source'>>): Promise<void>;
  touchGift(giftId: string, patch: { name?: string | null; imageUrl?: string | null; coins?: number | null }): Promise<void>;
  listGiftMappings(): Promise<GiftMappingRow[]>;
  saveGiftMapping(row: GiftMappingRow): Promise<void>;

  openSession(session: { sessionKey: string; username: string }): Promise<LiveSessionRow>;
  closeSession(sessionKey: string): Promise<void>;

  logError(scope: string, message: string): Promise<void>;
  purge(olderThanMs: number): Promise<{ events: number; combos: number; followers: number; errors: number }>;

  listAudioClips(): Promise<AudioClipInfo[]>;
  getAudioClip(id: string): Promise<AudioClipInfo | null>;
  saveAudioClip(clip: AudioClipInfo): Promise<void>;
  /** Remove metadados e o binário guardado no banco (se houver). */
  deleteAudioClip(id: string): Promise<void>;
  putAudioBlob(id: string, data: Buffer): Promise<void>;
  getAudioBlob(id: string): Promise<Buffer | null>;

  /** Tenta virar o único consumidor/motor. Em memória, sempre verdadeiro. */
  acquireLeadership(): Promise<boolean>;
  releaseLeadership(): Promise<void>;
}
