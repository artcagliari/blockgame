import pg from 'pg';
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

const LEADER_LOCK_KEY = 727_001;
const MIGRATION_LOCK_KEY = 727_002;

/** Migrações são somente de avanço. Nunca edite uma já publicada: acrescente uma nova. */
export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at bigint NOT NULL
      );
      CREATE TABLE game_state (
        id integer PRIMARY KEY CHECK (id = 1),
        state jsonb NOT NULL,
        seq bigint NOT NULL,
        saved_at bigint NOT NULL
      );
      CREATE TABLE rounds (
        round_id integer PRIMARY KEY,
        round integer NOT NULL,
        started_at bigint NOT NULL,
        ended_at bigint,
        target integer NOT NULL,
        lula integer NOT NULL DEFAULT 0,
        bolsonaro integer NOT NULL DEFAULT 0,
        winner text
      );
      CREATE TABLE live_sessions (
        session_key text PRIMARY KEY,
        username text NOT NULL,
        started_at bigint NOT NULL,
        ended_at bigint,
        connect_count integer NOT NULL DEFAULT 1
      );
      CREATE TABLE gift_registry (
        gift_id text PRIMARY KEY,
        name text,
        image_url text,
        coins integer,
        source text NOT NULL,
        first_seen_at bigint NOT NULL,
        last_seen_at bigint NOT NULL,
        seen_count integer NOT NULL DEFAULT 0
      );
      CREATE TABLE gift_mappings (
        slot_id text PRIMARY KEY,
        gift_id text UNIQUE,
        blocks integer NOT NULL,
        active boolean NOT NULL DEFAULT true,
        bound_name text,
        bound_coins integer,
        updated_at bigint NOT NULL
      );
      CREATE TABLE processed_events (
        dedupe_key text PRIMARY KEY,
        origin text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        reason text,
        team text,
        points integer NOT NULL DEFAULT 0,
        round_id integer,
        session_key text,
        user_hash text,
        gift_id text,
        slot_id text,
        created_at bigint NOT NULL
      );
      CREATE INDEX processed_events_created_idx ON processed_events (created_at);
      CREATE INDEX processed_events_origin_idx ON processed_events (origin, kind, status);
      CREATE TABLE combos (
        combo_key text PRIMARY KEY,
        session_key text NOT NULL,
        gift_id text NOT NULL,
        user_hash text NOT NULL,
        processed_count integer NOT NULL,
        finished boolean NOT NULL DEFAULT false,
        updated_at bigint NOT NULL
      );
      CREATE INDEX combos_updated_idx ON combos (updated_at);
      CREATE TABLE followers_seen (
        session_key text NOT NULL,
        user_hash text NOT NULL,
        seen_at bigint NOT NULL,
        PRIMARY KEY (session_key, user_hash)
      );
      CREATE INDEX followers_seen_at_idx ON followers_seen (seen_at);
      CREATE TABLE error_log (
        id bigserial PRIMARY KEY,
        at bigint NOT NULL,
        scope text NOT NULL,
        message text NOT NULL
      );
      CREATE INDEX error_log_at_idx ON error_log (at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE audio_clips (
        id text PRIMARY KEY,
        name text NOT NULL,
        category text NOT NULL,
        team text NOT NULL,
        mime text NOT NULL,
        size_bytes integer NOT NULL,
        duration_ms integer,
        volume real NOT NULL DEFAULT 1,
        active boolean NOT NULL DEFAULT true,
        sha256 text NOT NULL,
        created_at bigint NOT NULL,
        updated_at bigint NOT NULL
      );
      CREATE TABLE audio_blobs (
        id text PRIMARY KEY,
        data bytea NOT NULL
      );
    `,
  },
];

export interface PgStoreOptions {
  connectionString: string;
  ssl?: boolean | 'auto';
  poolSize?: number;
  clock?: () => number;
}

export class PgStore implements Store {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;
  private readonly clock: () => number;
  private leaderClient: pg.PoolClient | null = null;

  constructor(options: PgStoreOptions) {
    this.clock = options.clock ?? Date.now;
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 5,
      ssl: resolveSsl(options),
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    // Erros em conexões ociosas não podem derrubar o processo.
    this.pool.on('error', () => {});
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at bigint NOT NULL)');
      const applied = new Set<number>((await client.query('SELECT version FROM schema_migrations')).rows.map((row) => Number(row.version)));
      for (const migration of MIGRATIONS) {
        if (applied.has(migration.version)) continue;
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [migration.version, this.clock()]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.releaseLeadership();
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async loadGame(): Promise<PersistedGame | null> {
    const { rows } = await this.pool.query('SELECT state, saved_at FROM game_state WHERE id = 1');
    if (!rows[0]) return null;
    return { state: rows[0].state, savedAt: Number(rows[0].saved_at) };
  }

  async saveGame(game: PersistedGame, round: RoundRow): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await upsertGame(client, game);
      await upsertRound(client, round);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getSetting<T>(key: string): Promise<T | null> {
    const { rows } = await this.pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0] ? (rows[0].value as T) : null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(value), this.clock()],
    );
  }

  /**
   * Transação única: evento + (seguidor) + (combo) + estado do jogo + rodada.
   * A chave primária de `processed_events` é a barreira de idempotência: se duas
   * entregas do mesmo evento chegarem juntas, só uma consegue inserir.
   */
  async commitScoringEvent(input: CommitInput): Promise<CommitResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO processed_events
           (dedupe_key, origin, kind, status, reason, team, points, round_id, session_key, user_hash, gift_id, slot_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        eventParams(input.event, this.clock()),
      );
      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        return 'duplicate';
      }
      if (input.follower) {
        const claimed = await client.query(
          `INSERT INTO followers_seen (session_key, user_hash, seen_at) VALUES ($1,$2,$3)
           ON CONFLICT (session_key, user_hash) DO NOTHING`,
          [input.follower.sessionKey, input.follower.userHash, this.clock()],
        );
        if (claimed.rowCount === 0) {
          await client.query('ROLLBACK');
          return 'duplicate_follower';
        }
      }
      if (input.combo) {
        await client.query(
          `INSERT INTO combos (combo_key, session_key, gift_id, user_hash, processed_count, finished, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (combo_key) DO UPDATE
             SET processed_count = EXCLUDED.processed_count, finished = EXCLUDED.finished, updated_at = EXCLUDED.updated_at`,
          [input.combo.comboKey, input.combo.sessionKey, input.combo.giftId, input.combo.userHash, input.combo.processedCount, input.combo.finished, this.clock()],
        );
      }
      await upsertGame(client, input.snapshot);
      await upsertRound(client, input.round);
      await client.query('COMMIT');
      return 'ok';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recordIgnoredEvent(row: EventRow): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO processed_events
         (dedupe_key, origin, kind, status, reason, team, points, round_id, session_key, user_hash, gift_id, slot_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      eventParams(row, this.clock()),
    );
    return (result.rowCount ?? 0) > 0;
  }

  async hasEvent(dedupeKey: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM processed_events WHERE dedupe_key = $1', [dedupeKey]);
    return (rowCount ?? 0) > 0;
  }

  async hasFollower(claim: FollowerClaim): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM followers_seen WHERE session_key = $1 AND user_hash = $2', [claim.sessionKey, claim.userHash]);
    return (rowCount ?? 0) > 0;
  }

  async getCombo(comboKey: string): Promise<ComboRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM combos WHERE combo_key = $1', [comboKey]);
    const row = rows[0];
    if (!row) return null;
    return {
      comboKey: row.combo_key,
      sessionKey: row.session_key,
      giftId: row.gift_id,
      userHash: row.user_hash,
      processedCount: Number(row.processed_count),
      finished: row.finished,
    };
  }

  async upsertCombo(row: ComboRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO combos (combo_key, session_key, gift_id, user_hash, processed_count, finished, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (combo_key) DO UPDATE
         SET processed_count = GREATEST(combos.processed_count, EXCLUDED.processed_count),
             finished = EXCLUDED.finished, updated_at = EXCLUDED.updated_at`,
      [row.comboKey, row.sessionKey, row.giftId, row.userHash, row.processedCount, row.finished, this.clock()],
    );
  }

  async stats(sinceMs = 0): Promise<EventStats[]> {
    const { rows } = await this.pool.query(
      `SELECT origin, kind, status, count(*)::int AS events, coalesce(sum(points),0)::int AS points
         FROM processed_events WHERE created_at >= $1 GROUP BY origin, kind, status ORDER BY origin, kind, status`,
      [sinceMs],
    );
    return rows.map((row) => ({ origin: row.origin, kind: row.kind, status: row.status, events: row.events, points: row.points }));
  }

  async ignoredReasons(sinceMs = 0): Promise<IgnoredReason[]> {
    const { rows } = await this.pool.query(
      `SELECT origin, kind, coalesce(reason, 'desconhecido') AS reason, count(*)::int AS events
         FROM processed_events WHERE status = 'ignored' AND created_at >= $1
        GROUP BY origin, kind, reason ORDER BY events DESC`,
      [sinceMs],
    );
    return rows.map((row) => ({ origin: row.origin, kind: row.kind, reason: row.reason, events: row.events }));
  }

  async recentEvents(origin: EventOrigin | 'all', limit: number) {
    const { rows } = await this.pool.query(
      `SELECT * FROM processed_events WHERE ($1 = 'all' OR origin = $1) ORDER BY created_at DESC, dedupe_key LIMIT $2`,
      [origin, limit],
    );
    return rows.map((row) => ({
      dedupeKey: row.dedupe_key as string,
      origin: row.origin as EventOrigin,
      kind: row.kind,
      status: row.status,
      reason: row.reason ?? undefined,
      team: row.team ?? undefined,
      points: Number(row.points),
      roundId: row.round_id ?? undefined,
      sessionKey: row.session_key ?? undefined,
      userHash: row.user_hash ?? undefined,
      giftId: row.gift_id ?? undefined,
      slotId: row.slot_id ?? undefined,
      at: Number(row.created_at),
    }));
  }

  async listGiftRegistry(): Promise<GiftRegistryEntry[]> {
    const { rows } = await this.pool.query('SELECT * FROM gift_registry ORDER BY coins NULLS LAST, name NULLS LAST, gift_id');
    return rows.map((row) => ({
      giftId: row.gift_id,
      name: row.name,
      imageUrl: row.image_url,
      coins: row.coins,
      source: row.source,
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
      seenCount: row.seen_count,
    }));
  }

  async upsertGiftRegistry(entries: Array<Pick<GiftRegistryEntry, 'giftId' | 'name' | 'imageUrl' | 'coins' | 'source'>>): Promise<void> {
    if (entries.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const now = this.clock();
      for (const entry of entries) {
        await client.query(
          `INSERT INTO gift_registry (gift_id, name, image_url, coins, source, first_seen_at, last_seen_at, seen_count)
           VALUES ($1,$2,$3,$4,$5,$6,$6,0)
           ON CONFLICT (gift_id) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, gift_registry.name),
             image_url = COALESCE(EXCLUDED.image_url, gift_registry.image_url),
             coins = COALESCE(EXCLUDED.coins, gift_registry.coins),
             source = CASE WHEN gift_registry.source = 'manual' THEN 'manual' ELSE EXCLUDED.source END,
             last_seen_at = EXCLUDED.last_seen_at`,
          [entry.giftId, entry.name, entry.imageUrl, entry.coins, entry.source, now],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async touchGift(giftId: string, patch: { name?: string | null; imageUrl?: string | null; coins?: number | null }): Promise<void> {
    const now = this.clock();
    await this.pool.query(
      `INSERT INTO gift_registry (gift_id, name, image_url, coins, source, first_seen_at, last_seen_at, seen_count)
       VALUES ($1,$2,$3,$4,'event',$5,$5,1)
       ON CONFLICT (gift_id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, gift_registry.name),
         image_url = COALESCE(EXCLUDED.image_url, gift_registry.image_url),
         coins = COALESCE(EXCLUDED.coins, gift_registry.coins),
         last_seen_at = EXCLUDED.last_seen_at,
         seen_count = gift_registry.seen_count + 1`,
      [giftId, patch.name ?? null, patch.imageUrl ?? null, patch.coins ?? null, now],
    );
  }

  async listGiftMappings(): Promise<GiftMappingRow[]> {
    const { rows } = await this.pool.query('SELECT * FROM gift_mappings ORDER BY slot_id');
    return rows.map((row) => ({
      slotId: row.slot_id,
      giftId: row.gift_id,
      blocks: row.blocks,
      active: row.active,
      boundName: row.bound_name,
      boundCoins: row.bound_coins,
      updatedAt: Number(row.updated_at),
    }));
  }

  async saveGiftMapping(row: GiftMappingRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO gift_mappings (slot_id, gift_id, blocks, active, bound_name, bound_coins, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slot_id) DO UPDATE SET
         gift_id = EXCLUDED.gift_id, blocks = EXCLUDED.blocks, active = EXCLUDED.active,
         bound_name = EXCLUDED.bound_name, bound_coins = EXCLUDED.bound_coins, updated_at = EXCLUDED.updated_at`,
      [row.slotId, row.giftId, row.blocks, row.active, row.boundName, row.boundCoins, this.clock()],
    );
  }

  async openSession(session: { sessionKey: string; username: string }): Promise<LiveSessionRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO live_sessions (session_key, username, started_at, connect_count) VALUES ($1,$2,$3,1)
       ON CONFLICT (session_key) DO UPDATE
         SET username = EXCLUDED.username, ended_at = NULL, connect_count = live_sessions.connect_count + 1
       RETURNING *`,
      [session.sessionKey, session.username, this.clock()],
    );
    const row = rows[0];
    return {
      sessionKey: row.session_key,
      username: row.username,
      startedAt: Number(row.started_at),
      endedAt: row.ended_at ? Number(row.ended_at) : null,
      connectCount: row.connect_count,
    };
  }

  async closeSession(sessionKey: string): Promise<void> {
    await this.pool.query('UPDATE live_sessions SET ended_at = $2 WHERE session_key = $1', [sessionKey, this.clock()]);
  }

  async logError(scope: string, message: string): Promise<void> {
    await this.pool.query('INSERT INTO error_log (at, scope, message) VALUES ($1,$2,$3)', [this.clock(), scope, message.slice(0, 500)]);
  }

  async purge(olderThanMs: number) {
    const cutoff = this.clock() - olderThanMs;
    const events = await this.pool.query('DELETE FROM processed_events WHERE created_at < $1', [cutoff]);
    const combos = await this.pool.query('DELETE FROM combos WHERE updated_at < $1', [cutoff]);
    const followers = await this.pool.query('DELETE FROM followers_seen WHERE seen_at < $1', [cutoff]);
    const errors = await this.pool.query('DELETE FROM error_log WHERE at < $1', [cutoff]);
    await this.pool.query('DELETE FROM live_sessions WHERE ended_at IS NOT NULL AND ended_at < $1', [cutoff]);
    return {
      events: events.rowCount ?? 0,
      combos: combos.rowCount ?? 0,
      followers: followers.rowCount ?? 0,
      errors: errors.rowCount ?? 0,
    };
  }

  async listAudioClips(): Promise<AudioClipInfo[]> {
    const { rows } = await this.pool.query('SELECT * FROM audio_clips ORDER BY created_at, id');
    return rows.map(toClip);
  }

  async getAudioClip(id: string): Promise<AudioClipInfo | null> {
    const { rows } = await this.pool.query('SELECT * FROM audio_clips WHERE id = $1', [id]);
    return rows[0] ? toClip(rows[0]) : null;
  }

  async saveAudioClip(clip: AudioClipInfo): Promise<void> {
    await this.pool.query(
      `INSERT INTO audio_clips (id, name, category, team, mime, size_bytes, duration_ms, volume, active, sha256, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, category = EXCLUDED.category, team = EXCLUDED.team, mime = EXCLUDED.mime,
         size_bytes = EXCLUDED.size_bytes, duration_ms = EXCLUDED.duration_ms, volume = EXCLUDED.volume,
         active = EXCLUDED.active, sha256 = EXCLUDED.sha256, updated_at = EXCLUDED.updated_at`,
      [clip.id, clip.name, clip.category, clip.team, clip.mime, clip.sizeBytes, clip.durationMs, clip.volume, clip.active, clip.sha256, clip.createdAt, clip.updatedAt],
    );
  }

  async deleteAudioClip(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM audio_blobs WHERE id = $1', [id]);
      await client.query('DELETE FROM audio_clips WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async putAudioBlob(id: string, data: Buffer): Promise<void> {
    await this.pool.query(
      'INSERT INTO audio_blobs (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
      [id, data],
    );
  }

  async getAudioBlob(id: string): Promise<Buffer | null> {
    const { rows } = await this.pool.query('SELECT data FROM audio_blobs WHERE id = $1', [id]);
    return rows[0] ? (rows[0].data as Buffer) : null;
  }

  /**
   * Trava consultiva de sessão: enquanto este processo viver, nenhum outro pode consumir
   * a LIVE nem rodar o motor. Se o processo morrer, o Postgres libera a trava sozinho.
   */
  async acquireLeadership(): Promise<boolean> {
    if (this.leaderClient) return true;
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK_KEY]);
      if (!rows[0].ok) {
        client.release();
        return false;
      }
      client.on('error', () => {
        this.leaderClient = null;
      });
      this.leaderClient = client;
      return true;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async releaseLeadership(): Promise<void> {
    const client = this.leaderClient;
    this.leaderClient = null;
    if (!client) return;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]);
    } catch { /* a conexão pode já ter caído; a trava some junto */ }
    client.release();
  }

  /** A trava ainda é nossa? Falso se a conexão dedicada foi perdida. */
  async stillLeader(): Promise<boolean> {
    if (!this.leaderClient) return false;
    try {
      await this.leaderClient.query('SELECT 1');
      return true;
    } catch {
      this.leaderClient = null;
      return false;
    }
  }
}

async function upsertGame(client: pg.PoolClient, game: PersistedGame): Promise<void> {
  await client.query(
    `INSERT INTO game_state (id, state, seq, saved_at) VALUES (1, $1::jsonb, $2, $3)
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, seq = EXCLUDED.seq, saved_at = EXCLUDED.saved_at
     WHERE game_state.seq <= EXCLUDED.seq`,
    [JSON.stringify(game.state), game.state.seq, game.savedAt],
  );
}

async function upsertRound(client: pg.PoolClient, round: RoundRow): Promise<void> {
  await client.query(
    `INSERT INTO rounds (round_id, round, started_at, ended_at, target, lula, bolsonaro, winner)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (round_id) DO UPDATE SET
       ended_at = EXCLUDED.ended_at, target = EXCLUDED.target,
       lula = EXCLUDED.lula, bolsonaro = EXCLUDED.bolsonaro, winner = EXCLUDED.winner`,
    [round.roundId, round.round, round.startedAt, round.endedAt, round.target, round.lula, round.bolsonaro, round.winner],
  );
}

function eventParams(row: EventRow, now: number): unknown[] {
  return [
    row.dedupeKey, row.origin, row.kind, row.status, row.reason ?? null, row.team ?? null, row.points,
    row.roundId ?? null, row.sessionKey ?? null, row.userHash ?? null, row.giftId ?? null, row.slotId ?? null, now,
  ];
}

function toClip(row: Record<string, unknown>): AudioClipInfo {
  return {
    id: String(row.id),
    name: String(row.name),
    category: row.category as AudioClipInfo['category'],
    team: row.team as AudioClipInfo['team'],
    mime: String(row.mime),
    sizeBytes: Number(row.size_bytes),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    volume: Number(row.volume),
    active: Boolean(row.active),
    sha256: String(row.sha256),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function resolveSsl(options: PgStoreOptions): pg.PoolConfig['ssl'] {
  const mode = options.ssl ?? 'auto';
  if (mode === true) return { rejectUnauthorized: false };
  if (mode === false) return false;
  try {
    const host = new URL(options.connectionString).hostname;
    const internal = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.internal');
    return internal ? false : { rejectUnauthorized: false };
  } catch {
    return false;
  }
}
