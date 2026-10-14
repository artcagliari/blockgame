import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameEngine } from './game-engine.js';
import { roundRow } from './game-service.js';
import { MemoryStore } from './store/memory-store.js';
import { PgStore } from './store/pg-store.js';
import type { CommitInput, Store } from './store/types.js';

const PORT = 54_331;
let embedded: { stop(): Promise<void> } | null = null;
let connectionString = '';
let pgAvailable = false;
let pgError = '';

beforeAll(async () => {
  try {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const dir = mkdtempSync(path.join(tmpdir(), 'bdb-pg-'));
    const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
    await server.initialise();
    await server.start();
    embedded = { stop: async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); } };
    connectionString = `postgres://postgres:pw@localhost:${PORT}/postgres`;
    pgAvailable = true;
  } catch (error) {
    pgError = String((error as Error).message);
  }
}, 180_000);

afterAll(async () => { await embedded?.stop(); }, 60_000);

function sampleCommit(key: string, extra: Partial<CommitInput> = {}): CommitInput {
  const engine = new GameEngine({}, { autoplay: false });
  const plan = engine.plan('lula', 5, { origin: 'real', kind: 'gift' });
  if ('rejected' in plan) throw new Error('plano inválido');
  return {
    event: { dedupeKey: key, origin: 'real', kind: 'gift', status: 'applied', team: 'lula', points: 5, roundId: 1, sessionKey: 's1', userHash: 'h1', giftId: '5655', slotId: 'lula:impulso' },
    snapshot: { state: plan.next, savedAt: Date.now() },
    round: roundRow(plan.next, Date.now()),
    ...extra,
  };
}

type Factory = { name: string; make: (clock?: () => number) => Promise<Store>; reset?: () => Promise<void> };

const factories: Factory[] = [
  { name: 'MemoryStore', make: async (clock) => new MemoryStore(clock) },
  {
    name: 'PostgreSQL real',
    make: async (clock) => {
      if (!pgAvailable) throw new Error(`PostgreSQL embarcado indisponível: ${pgError}`);
      return new PgStore({ connectionString, ssl: false, clock });
    },
    reset: async () => {
      const pg = await import('pg');
      const client = new pg.default.Client({ connectionString });
      await client.connect();
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await client.end();
    },
  },
];

describe.each(factories)('contrato do Store — $name', (factory) => {
  async function fresh(clock?: () => number): Promise<Store> {
    await factory.reset?.();
    const store = await factory.make(clock);
    await store.init();
    return store;
  }

  it('grava evento + estado de forma idempotente', async () => {
    const store = await fresh();
    expect(await store.commitScoringEvent(sampleCommit('k1'))).toBe('ok');
    expect(await store.commitScoringEvent(sampleCommit('k1'))).toBe('duplicate');
    expect((await store.loadGame())?.state.teams.lula.score).toBe(5);
    const stats = await store.stats();
    expect(stats).toEqual([expect.objectContaining({ origin: 'real', kind: 'gift', status: 'applied', events: 1, points: 5 })]);
    await store.close();
  });

  it('entregas concorrentes da mesma chave resultam em um único evento aplicado', async () => {
    const store = await fresh();
    const results = await Promise.all(Array.from({ length: 12 }, () => store.commitScoringEvent(sampleCommit('same'))));
    expect(results.filter((result) => result === 'ok')).toHaveLength(1);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(11);
    await store.close();
  });

  it('seguidor repetido na sessão desfaz a transação inteira (nada é gravado)', async () => {
    const store = await fresh();
    const claim = { sessionKey: 's1', userHash: 'u-a' };
    expect(await store.commitScoringEvent(sampleCommit('f1', { follower: claim }))).toBe('ok');
    expect(await store.commitScoringEvent(sampleCommit('f2', { follower: claim }))).toBe('duplicate_follower');
    expect(await store.hasEvent('f2')).toBe(false);
    expect(await store.hasFollower(claim)).toBe(true);
    await store.close();
  });

  it('combo persiste junto do evento', async () => {
    const store = await fresh();
    const combo = { comboKey: 's1:h1:5655:g1', sessionKey: 's1', giftId: '5655', userHash: 'h1', processedCount: 3, finished: false };
    await store.commitScoringEvent(sampleCommit('c1', { combo }));
    expect(await store.getCombo(combo.comboKey)).toEqual(combo);
    await store.upsertCombo({ ...combo, processedCount: 5, finished: true });
    expect(await store.getCombo(combo.comboKey)).toMatchObject({ processedCount: 5, finished: true });
    await store.close();
  });

  it('eventos ignorados são idempotentes', async () => {
    const store = await fresh();
    const row = { dedupeKey: 'ign1', origin: 'real' as const, kind: 'gift' as const, status: 'ignored' as const, reason: 'unmapped_gift', points: 0 };
    expect(await store.recordIgnoredEvent(row)).toBe(true);
    expect(await store.recordIgnoredEvent(row)).toBe(false);
    await store.close();
  });

  it('mapeamento: um giftId só pode pertencer a um slot', async () => {
    const store = await fresh();
    const base = { blocks: 5, active: true, boundName: null, boundCoins: null, updatedAt: 0 };
    await store.saveGiftMapping({ ...base, slotId: 'lula:impulso', giftId: '1' });
    await expect(store.saveGiftMapping({ ...base, slotId: 'bolsonaro:impulso', giftId: '1' })).rejects.toThrow();
    await store.saveGiftMapping({ ...base, slotId: 'bolsonaro:impulso', giftId: null });
    expect((await store.listGiftMappings()).map((row) => row.slotId).sort()).toEqual(['bolsonaro:impulso', 'lula:impulso']);
    await store.close();
  });

  it('registro de presentes e configurações persistem', async () => {
    const store = await fresh();
    await store.upsertGiftRegistry([{ giftId: '7', name: 'Rose', imageUrl: 'https://x/y.png', coins: 1, source: 'catalog' }]);
    await store.touchGift('7', {});
    await store.touchGift('8', { name: 'Leão' });
    const list = await store.listGiftRegistry();
    expect(list.find((entry) => entry.giftId === '7')).toMatchObject({ name: 'Rose', coins: 1, seenCount: 1 });
    expect(list.find((entry) => entry.giftId === '8')).toMatchObject({ name: 'Leão', source: 'event' });
    await store.setSetting('tiktok.username', 'streamer');
    expect(await store.getSetting<string>('tiktok.username')).toBe('streamer');
    await store.close();
  });

  it('retenção remove dados antigos e preserva os recentes', async () => {
    let now = Date.UTC(2026, 0, 1);
    const store = await fresh(() => now);
    await store.commitScoringEvent(sampleCommit('old', { follower: { sessionKey: 's', userHash: 'x' } }));
    now += 40 * 86_400_000;
    await store.commitScoringEvent(sampleCommit('new'));
    const purged = await store.purge(30 * 86_400_000);
    expect(purged.events).toBe(1);
    expect(purged.followers).toBe(1);
    expect(await store.hasEvent('old')).toBe(false);
    expect(await store.hasEvent('new')).toBe(true);
    await store.close();
  });

  it('o evento guarda apenas HMAC do usuário, nunca dados pessoais', async () => {
    const store = await fresh();
    await store.commitScoringEvent(sampleCommit('p1'));
    const [row] = await store.recentEvents('real', 5);
    expect(row.userHash).toBe('h1');
    expect(Object.keys(row)).not.toContain('nickname');
    await store.close();
  });
});

describe('PostgreSQL: reinício e liderança', () => {
  it('estado sobrevive a um reinício do processo (nova conexão, mesmo banco)', async () => {
    if (!pgAvailable) throw new Error(`PostgreSQL embarcado indisponível: ${pgError}`);
    const pg = await import('pg');
    const admin = new pg.default.Client({ connectionString });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await admin.end();

    const first = new PgStore({ connectionString, ssl: false });
    await first.init();
    await first.commitScoringEvent(sampleCommit('persist-1'));
    await first.close();

    const second = new PgStore({ connectionString, ssl: false });
    await second.init(); // migrações são idempotentes
    expect((await second.loadGame())?.state.teams.lula.score).toBe(5);
    expect(await second.commitScoringEvent(sampleCommit('persist-1'))).toBe('duplicate');
    await second.close();
  });

  it('apenas uma instância detém a liderança; ao liberar, outra assume', async () => {
    if (!pgAvailable) throw new Error(`PostgreSQL embarcado indisponível: ${pgError}`);
    const a = new PgStore({ connectionString, ssl: false });
    const b = new PgStore({ connectionString, ssl: false });
    await a.init();
    expect(await a.acquireLeadership()).toBe(true);
    expect(await b.acquireLeadership()).toBe(false);
    await a.releaseLeadership();
    expect(await b.acquireLeadership()).toBe(true);
    await b.close();
    await a.close();
  });

  it('migrações concorrentes não colidem', async () => {
    if (!pgAvailable) throw new Error(`PostgreSQL embarcado indisponível: ${pgError}`);
    const pg = await import('pg');
    const admin = new pg.default.Client({ connectionString });
    await admin.connect();
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await admin.end();
    const stores = [0, 1, 2, 3].map(() => new PgStore({ connectionString, ssl: false }));
    await Promise.all(stores.map((store) => store.init()));
    await Promise.all(stores.map((store) => store.close()));
  });
});
