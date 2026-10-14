import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { silentLogger } from './logger.js';
import { PgStore } from './store/pg-store.js';
import { FakeConnection } from './test-helpers.js';

const PORT = 54_332;
const TOKEN = 'token-de-teste-com-mais-de-16';
const connectionString = `postgres://postgres:pw@localhost:${PORT}/postgres`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let stop: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = mkdtempSync(path.join(tmpdir(), 'bdb-pg-app-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  stop = async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); };
}, 180_000);
afterAll(async () => { await stop?.(); }, 60_000);

async function boot(connection = new FakeConnection()) {
  const config = loadConfig({
    NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', ADMIN_TOKEN: TOKEN, AUTOPLAY: 'off',
    TIKTOK_USERNAME: 'canal_teste', TIKTOK_AUTOCONNECT: 'false', DATABASE_URL: connectionString,
  } as NodeJS.ProcessEnv);
  const store = new PgStore({ connectionString, ssl: false });
  const app: App = createApp({ config, store, logger: silentLogger, connectionFactory: () => connection });
  const port = await app.start();
  return { app, connection, base: `http://127.0.0.1:${port}` };
}

const admin = (base: string, route: string, init: RequestInit = {}) =>
  fetch(`${base}/api/admin${route}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } });

describe('aplicação completa sobre PostgreSQL real', () => {
  it('placar, mapeamentos e deduplicação sobrevivem ao reinício do servidor', async () => {
    const first = await boot();
    expect(first.app.role()).toBe('leader');
    await first.app.live.connect();
    await admin(first.base, '/gifts/slots/lula:turbo', { method: 'PUT', body: JSON.stringify({ giftId: '4321', allowManual: true }) });
    const gift = { common: { msgId: 'pg-gift-1' }, giftId: '4321', repeatCount: 2, repeatEnd: 0, groupId: '', user: { userId: '10' }, gift: { id: '4321', name: 'Donut', type: 0, diamondCount: 30 } };
    first.connection.emit('gift', gift);
    first.connection.emit('like', { common: { msgId: 'pg-like-1' }, count: 4, user: { userId: '11' } });
    first.connection.emit('follow', { common: { msgId: 'pg-follow-1' }, user: { userId: '12' } });
    await sleep(400);
    const before = first.app.game.getState();
    expect(before.teams.lula.score).toBe(2 * 30 + 4);
    expect(before.teams.bolsonaro.score).toBe(1);
    await first.app.stop();

    const second = await boot();
    const after = second.app.game.getState();
    expect(after.teams.lula.score).toBe(64);
    expect(after.teams.bolsonaro.score).toBe(1);
    expect(after.roundId).toBe(before.roundId);
    expect(after.seq).toBeGreaterThan(before.seq);
    await second.app.live.connect();
    second.connection.emit('gift', gift);
    second.connection.emit('like', { common: { msgId: 'pg-like-1' }, count: 4, user: { userId: '11' } });
    second.connection.emit('follow', { common: { msgId: 'pg-follow-2' }, user: { userId: '12' } });
    await sleep(400);
    expect(second.app.game.getState().teams.lula.score).toBe(64);
    expect(second.app.game.getState().teams.bolsonaro.score).toBe(1);
    const overview = await (await admin(second.base, '/overview')).json();
    expect(overview.server.store).toBe('postgres');
    expect(overview.slots.find((slot: { slotId: string }) => slot.slotId === 'lula:turbo').giftId).toBe('4321');
    await second.app.stop();
  }, 60_000);

  it('áudio (bytes no PostgreSQL), metadados e vínculos sobrevivem ao reinício', async () => {
    const { makeWav } = await import('./audio/fixtures.js');
    const first = await boot();
    const upload = await fetch(`${first.base}/api/admin/audio?name=Bordao&category=bordao&team=lula&credit=${encodeURIComponent('Autor (site) CC BY 4.0')}`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'audio/wav' }, body: makeWav(600),
    });
    expect(upload.status).toBe(201);
    const { clip } = await upload.json();
    await admin(first.base, '/audio/config', { method: 'PUT', body: JSON.stringify({ bindings: { 'gift:lula:impulso': { clipIds: [clip.id], mode: 'random', enabled: true, cooldownMs: 0 } } }) });
    await first.app.stop();
    const second = await boot();
    const data = await (await admin(second.base, '/audio')).json();
    expect(data.storage).toBe('database');
    expect(data.clips[0]).toMatchObject({ id: clip.id, durationMs: 600, team: 'lula', credit: 'Autor (site) CC BY 4.0' });
    expect(data.config.bindings['gift:lula:impulso'].clipIds).toEqual([clip.id]);
    const file = await fetch(`${second.base}/audio/${clip.id}`);
    expect(file.status).toBe(200);
    expect((await file.arrayBuffer()).byteLength).toBe(makeWav(600).length);
    await second.app.stop();
  }, 60_000);

  it('uma segunda instância fica em standby enquanto a primeira vive e assume ao parar', async () => {
    const leader = await boot();
    const standby = await boot();
    expect(leader.app.role()).toBe('leader');
    expect(standby.app.role()).toBe('standby');
    await leader.app.stop();
    for (let attempt = 0; attempt < 100 && standby.app.role() !== 'leader'; attempt += 1) await sleep(100);
    expect(standby.app.role()).toBe('leader');
    await standby.app.stop();
  }, 60_000);
});
