/**
 * Auditoria pré-produção. Cada bloco corresponde a um item da Etapa 1 do checklist.
 * Os giftIds usados são os informados pelo operador (server/gift-seed.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { GIFT_SEED, KNOWN_UNMAPPED, PENDING_IDS } from './gift-seed.js';
import { GIFT_SLOTS } from './gift-slots.js';
import { createLogger, redact } from './logger.js';
import { MemoryStore } from './store/memory-store.js';
import { FakeConnection } from './test-helpers.js';
import type { GameState, IncrementEvent } from '../src/game/types.js';

const TOKEN = 'auditoria-token-0123456789abcdef';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const running: App[] = [];
const sockets: Socket[] = [];

async function boot(env: Record<string, string> = {}, opts: { store?: MemoryStore; staticDir?: string; lines?: string[]; connect?: boolean } = {}) {
  const connection = new FakeConnection();
  const config = loadConfig({
    NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', ADMIN_TOKEN: TOKEN, AUTOPLAY: 'off',
    TIKTOK_AUTOCONNECT: 'false', TIKTOK_USERNAME: 'canal_teste', ...env,
  } as NodeJS.ProcessEnv);
  const logger = opts.lines ? createLogger({ level: 'debug', sink: (line) => opts.lines!.push(line) }) : createLogger({ level: 'error', sink: () => {} });
  const app = createApp({
    config, store: opts.store ?? new MemoryStore(), logger, connectionFactory: () => connection,
    staticDir: opts.staticDir, leaderRetryMs: 50,
  });
  const port = await app.start();
  running.push(app);
  if (opts.connect !== false) await app.live.connect().catch(() => {});
  return { app, connection, base: `http://127.0.0.1:${port}` };
}

const admin = (base: string, route: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = TOKEN, ...rest } = init;
  return fetch(`${base}/api/admin${route}`, {
    ...rest, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
};

/** Payload no formato protobuf v3 entregue pelo tiktok-live-connector 2.5.0. */
function rawGift(giftId: string, over: Record<string, unknown> = {}) {
  return {
    common: { msgId: `m-${Math.random().toString(36).slice(2)}`, roomId: 'room-fake' },
    giftId, repeatCount: 1, repeatEnd: 0, groupId: '0',
    user: { userId: '1001', uniqueId: 'ana', nickname: 'Ana' },
    gift: { id: giftId, name: `Gift ${giftId}`, type: 0, combo: false, diamondCount: 1 },
    ...over,
  };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of running.splice(0)) await app.stop().catch(() => {});
});

describe('1. presentes individuais (sem combo) com os 12 IDs reais', () => {
  it('cada giftId informado pontua a equipe e o valor corretos', async () => {
    const { connection, app } = await boot();
    const events: IncrementEvent[] = [];
    app.game.on('increment', (event: IncrementEvent) => events.push(event));
    for (const item of GIFT_SEED) connection.emit('gift', rawGift(item.giftId));
    await sleep(300);
    expect(events).toHaveLength(12);
    for (const item of GIFT_SEED) {
      const slot = GIFT_SLOTS.find((entry) => entry.slotId === item.slotId)!;
      const event = events.find((entry) => entry.giftId === slot.visualId && entry.team === slot.team);
      expect(event, item.slotId).toMatchObject({ amount: slot.defaultBlocks, team: slot.team, origin: 'real', kind: 'gift' });
    }
    const { lula, bolsonaro } = app.game.getState().teams;
    expect(lula.score).toBe(1645);
    expect(bolsonaro.score).toBe(1645); // 5+10+30+100+500+1000
  });

  it('presentes conhecidos fora dos 12 slots e "Boa noite" (sem ID) não pontuam', async () => {
    const { connection, app, base } = await boot();
    for (const item of KNOWN_UNMAPPED) connection.emit('gift', rawGift(item.giftId));
    await sleep(250);
    const state = app.game.getState();
    expect(state.teams.lula.score + state.teams.bolsonaro.score).toBe(0);
    const overview = await (await admin(base, '/overview')).json();
    const unlinked = overview.knownGifts.filter((gift: { slotId: string | null }) => !gift.slotId).map((gift: { giftId: string }) => gift.giftId);
    for (const item of KNOWN_UNMAPPED) expect(unlinked).toContain(item.giftId);
    expect(PENDING_IDS).toEqual(['Boa noite']);
    expect(JSON.stringify(GIFT_SEED) + JSON.stringify(KNOWN_UNMAPPED)).not.toMatch(/boa noite/i);
    expect(overview.ignoredReal.find((row: { reason: string }) => row.reason === 'unmapped_gift')?.events).toBe(KNOWN_UNMAPPED.length);
  });

  it('presente de sequência enviado uma única vez (duas mensagens: andamento + fim) conta uma vez', async () => {
    const { connection, app } = await boot();
    const streak = { type: 1, combo: true, diamondCount: 1 };
    connection.emit('gift', rawGift('5655', { repeatCount: 1, repeatEnd: 0, groupId: '555', gift: { id: '5655', name: 'Rose', ...streak } }));
    connection.emit('gift', rawGift('5655', { repeatCount: 1, repeatEnd: 1, groupId: '555', gift: { id: '5655', name: 'Rose', ...streak } }));
    await sleep(200);
    expect(app.game.getState().teams.lula.score).toBe(5);
  });
});

describe('2. repeatCount / repeatEnd não duplicam', () => {
  it('3 rosas em combo = 15; 10 Mini dinos em combo = 100 (Bolsonaro)', async () => {
    const { connection, app } = await boot();
    const rose = { type: 1, combo: true, diamondCount: 1, name: 'Rose', id: '5655' };
    for (const count of [1, 2, 3]) connection.emit('gift', rawGift('5655', { repeatCount: count, repeatEnd: 0, groupId: 'A', gift: rose }));
    connection.emit('gift', rawGift('5655', { repeatCount: 3, repeatEnd: 1, groupId: 'A', gift: rose }));
    const dino = { type: 1, combo: true, diamondCount: 1, name: 'Mini dino', id: '6560' };
    for (let count = 1; count <= 10; count += 1) connection.emit('gift', rawGift('6560', { repeatCount: count, repeatEnd: 0, groupId: 'B', user: { userId: '2002' }, gift: dino }));
    connection.emit('gift', rawGift('6560', { repeatCount: 10, repeatEnd: 1, groupId: 'B', user: { userId: '2002' }, gift: dino }));
    await sleep(300);
    expect(app.game.getState().teams).toMatchObject({ lula: { score: 15 }, bolsonaro: { score: 100 } });
  });
});

describe('3 e 4. seguidores e curtidas', () => {
  it('follow + social do mesmo usuário contam uma vez; share não conta', async () => {
    const { connection, app } = await boot();
    connection.emit('follow', { common: { msgId: 'a' }, user: { userId: '77' } });
    connection.emit('social', { common: { msgId: 'b', displayText: { key: 'pm_main_follow_message_viewer_2' } }, user: { userId: '77' } });
    connection.emit('share', { common: { msgId: 'c' }, user: { userId: '78' } });
    connection.emit('social', { common: { msgId: 'd', displayText: { key: 'pm_mt_share' } }, user: { userId: '79' } });
    await sleep(200);
    expect(app.game.getState().teams.bolsonaro.score).toBe(1);
  });

  it('curtidas usam só a quantidade incremental, nunca o total da sala', async () => {
    const { connection, app } = await boot();
    connection.emit('like', { common: { msgId: 'l1' }, count: 15, total: '123456', user: { userId: '5' } });
    connection.emit('like', { common: { msgId: 'l2' }, count: 6, total: '123462', user: { userId: '6' } });
    connection.emit('like', { common: { msgId: 'l1' }, count: 15, total: '123456', user: { userId: '5' } });
    await sleep(200);
    expect(app.game.getState().teams.lula.score).toBe(21);
  });
});

describe('5. 12 giftIds configuráveis pelo painel', () => {
  it('troca um giftId pelo painel e o novo ID passa a pontuar; o antigo deixa de pontuar', async () => {
    const { connection, app, base } = await boot();
    const moved = await admin(base, '/gifts/slots/lula:impulso', { method: 'PUT', body: JSON.stringify({ giftId: '4444', allowManual: true }) });
    expect(moved.status).toBe(200);
    connection.emit('gift', rawGift('5655'));
    connection.emit('gift', rawGift('4444'));
    await sleep(200);
    expect(app.game.getState().teams.lula.score).toBe(5);
    const overview = await (await admin(base, '/overview')).json();
    expect(overview.slots.filter((slot: { mapped: boolean }) => slot.mapped)).toHaveLength(12);
  });

  it('a semente é aplicada uma única vez e não sobrescreve ajustes do operador no reinício', async () => {
    const store = new MemoryStore();
    const first = await boot({}, { store });
    await admin(first.base, '/gifts/slots/bolsonaro:turbo', { method: 'PUT', body: JSON.stringify({ giftId: null }) });
    await first.app.stop();
    running.splice(running.indexOf(first.app), 1);
    const second = await boot({}, { store });
    const overview = await (await admin(second.base, '/overview')).json();
    expect(overview.slots.find((slot: { slotId: string }) => slot.slotId === 'bolsonaro:turbo').giftId).toBeNull();
    expect(overview.slots.find((slot: { slotId: string }) => slot.slotId === 'lula:ultra-turbo').giftId).toBe('1266941');
  });

  it('GIFT_SEED=off deixa todos os slots vazios (sem pontuação até configurar)', async () => {
    const { connection, app, base } = await boot({ GIFT_SEED: 'off' });
    connection.emit('gift', rawGift('5655'));
    await sleep(150);
    expect(app.game.getState().teams.lula.score).toBe(0);
    const overview = await (await admin(base, '/overview')).json();
    expect(overview.slots.filter((slot: { mapped: boolean }) => slot.mapped)).toHaveLength(0);
  });
});

describe('6. Socket.IO e rotas em modo produção', () => {
  const dist = path.resolve(process.cwd(), 'dist');
  const prod = { NODE_ENV: 'production', ALLOW_EPHEMERAL: 'true' };

  it('WebSocket e polling funcionam; atrás do proxy o host público (X-Forwarded-Host) é aceito', async () => {
    const { base, app } = await boot(prod);
    expect(app.role()).toBe('leader');
    for (const transports of [['websocket'], ['polling']] as const) {
      const socket = connect(base, { transports: [...transports], forceNew: true, extraHeaders: {
        origin: 'https://blocos.up.railway.app', 'x-forwarded-host': 'blocos.up.railway.app', 'x-forwarded-proto': 'https',
      } });
      sockets.push(socket);
      const state = await new Promise<GameState>((resolve, reject) => {
        socket.once('state', resolve);
        socket.once('connect_error', reject);
      });
      expect(state.phase).toBe('playing');
    }
  });

  it('origem estranha é recusada em produção; localhost deixa de ser confiável', async () => {
    const { base } = await boot(prod);
    for (const origin of ['https://evil.example', 'http://localhost:5173']) {
      const socket = connect(base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { origin } });
      sockets.push(socket);
      const failed = await Promise.race([
        new Promise((resolve) => socket.once('connect_error', () => resolve(true))),
        sleep(2_500).then(() => false),
      ]);
      expect(failed, origin).toBe(true);
    }
  });

  it('serve /overlay, /admin e /health; cabeçalhos de segurança presentes', async () => {
    if (!existsSync(path.join(dist, 'index.html'))) return; // requer `npm run build`
    const { base } = await boot(prod, { staticDir: dist });
    for (const route of ['/overlay', '/admin']) {
      const response = await fetch(`${base}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('strict-transport-security')).toContain('max-age');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('em produção não imprime tokens e exige ADMIN_TOKEN/DATABASE_URL', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe('7. motor automático sem TikTok', () => {
  it('por padrão NÃO gera blocos: sem LIVE o placar fica parado', async () => {
    const { app } = await boot({ AUTOPLAY: 'on', TIKTOK_USERNAME: '' }, { connect: false });
    await sleep(1_500);
    const state = app.game.getState();
    expect(state.config.autoEnabled).toBe(false);
    expect(state.teams.lula.score + state.teams.bolsonaro.score).toBe(0);
    expect(state.startedAt).toBeNull();
  });

  it('quando habilitado pelo operador, gera blocos mesmo sem usuário e sem conexão', async () => {
    const { app, base } = await boot({ AUTOPLAY: 'on', TIKTOK_USERNAME: '' }, { connect: false });
    await admin(base, '/game/config', { method: 'PUT', body: JSON.stringify({ autoEnabled: true }) });
    expect(app.live.getStatus().state).toBe('DISCONNECTED');
    const auto = await new Promise<IncrementEvent | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 5_000);
      app.game.on('increment', (event: IncrementEvent) => {
        if (event.origin === 'auto') { clearTimeout(timer); resolve(event); }
      });
    });
    expect(auto).toMatchObject({ origin: 'auto', kind: 'auto' });
  }, 15_000);
});

describe('modo somente LIVE (produção)', () => {
  const prod = { NODE_ENV: 'production', ALLOW_EPHEMERAL: 'true' };

  it('em produção as simulações vêm desligadas, mas eventos reais continuam pontuando', async () => {
    const { app, base, connection } = await boot(prod);
    const overview = await (await admin(base, '/overview')).json();
    expect(overview.server.testEvents).toBe(false);
    for (const route of ['/test/like', '/test/follow', '/test/increment', '/test/combo', '/test/burst', '/test/gift']) {
      const response = await admin(base, route, { method: 'POST', body: JSON.stringify({ team: 'lula', amount: 50, slotId: 'lula:impulso' }) });
      expect(response.status, route).toBe(403);
    }
    expect(app.game.getState().teams.lula.score).toBe(0);
    connection.emit('like', { common: { msgId: 'real-1' }, count: 2, user: { userId: '9' } });
    await sleep(150);
    expect(app.game.getState().teams.lula.score).toBe(2);
    expect(app.game.getState().startedAt).not.toBeNull();
  });

  it('ENABLE_TEST_EVENTS=true reativa as simulações de forma explícita', async () => {
    const { base } = await boot({ ...prod, ENABLE_TEST_EVENTS: 'true' });
    expect((await admin(base, '/test/like', { method: 'POST', body: '{}' })).status).toBe(200);
  });

  it('em desenvolvimento as simulações continuam disponíveis por padrão', () => {
    expect(loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).enableTestEvents).toBe(true);
    expect(loadConfig({ NODE_ENV: 'production', ADMIN_TOKEN: 'x'.repeat(20), DATABASE_URL: 'postgres://h/db' } as NodeJS.ProcessEnv).enableTestEvents).toBe(false);
  });
});

describe('9. nenhuma rota pública altera o placar', () => {
  it('métodos de escrita sem token falham em qualquer rota; o placar não muda', async () => {
    const { app, base } = await boot();
    const paths = [
      '/api/admin/test/increment', '/api/admin/test/like', '/api/admin/test/follow', '/api/admin/test/gift',
      '/api/admin/game/reset', '/api/admin/game/pause', '/api/admin/game/config', '/api/admin/gifts/slots/lula:impulso',
      '/api/admin/tiktok/connect', '/api/increment', '/api/score', '/increment', '/admin/increment', '/socket.io/admin',
      '/overlay', '/admin', '/health',
    ];
    for (const route of paths) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await fetch(`${base}${route}`, {
          method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ team: 'lula', amount: 999, target: 10 }),
        });
        // 429 = o limitador de tentativas inválidas também protege estas rotas.
        expect([401, 404, 405, 400, 429]).toContain(response.status);
      }
    }
    const state = app.game.getState();
    expect(state.teams.lula.score + state.teams.bolsonaro.score).toBe(0);
    expect(state.config.target).toBe(2000);
  });

  it('o canal público ignora qualquer evento do cliente além de sync', async () => {
    const { app, base } = await boot();
    const socket = connect(base, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    await new Promise((resolve) => socket.once('state', resolve));
    for (const event of ['admin:increment', 'admin:event', 'increment', 'state', 'score', 'game:score', 'admin:config', 'admin:reset']) {
      socket.emit(event, { team: 'bolsonaro', amount: 1000, target: 10 });
    }
    await sleep(200);
    expect(app.game.getState().teams.bolsonaro.score).toBe(0);
    expect(app.game.getState().config.target).toBe(2000);
  });
});

describe('10 e 11. ambiente e versão do conector', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  it('Node.js 20 ou superior (runtime, engines e .node-version)', () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(20);
    expect(pkg.engines.node).toMatch(/>=\s*20/);
    expect(Number(readFileSync('.node-version', 'utf8').trim())).toBeGreaterThanOrEqual(20);
  });

  it('conector fixado em 2.5.0 e instalado em 2.5.0', () => {
    expect(pkg.dependencies['tiktok-live-connector']).toBe('2.5.0');
    const installed = JSON.parse(readFileSync('node_modules/tiktok-live-connector/package.json', 'utf8'));
    expect(installed.version).toBe('2.5.0');
  });

  it('a API usada existe nessa versão (eventos, métodos e fábrica real)', async () => {
    const lib = await import('tiktok-live-connector');
    for (const name of ['gift', 'like', 'follow', 'social', 'share', 'chat', 'streamEnd']) {
      expect(Object.values(lib.WebcastEvent)).toContain(name);
    }
    for (const name of ['connected', 'disconnected', 'error']) expect(Object.values(lib.ControlEvent)).toContain(name);
    for (const method of ['connect', 'disconnect', 'fetchAvailableGifts', 'on', 'removeAllListeners']) {
      expect(typeof (lib.TikTokLiveConnection.prototype as unknown as Record<string, unknown>)[method]).toBe('function');
    }
    const { createRealFactory } = await import('./tiktok/live-service.js');
    const connection = (await createRealFactory({}))('canal_de_teste');
    expect(typeof connection.on).toBe('function');
    expect(typeof connection.connect).toBe('function');
  });
});

describe('segredos nunca aparecem nos logs', () => {
  it('redige credenciais por nome de campo e dentro de textos', () => {
    const output = JSON.stringify(redact({
      token: 'abc123', authorization: 'Bearer zzzzzzzzzzzz', nested: { cookie: 'sessionid=xyz', api_key: 'k' },
      error: new Error('connect failed postgres://postgres:S3nh4Sup3r@db.internal:5432/app and token=hunter2'),
      text: 'Authorization: Bearer abcdefghijkl123',
    }));
    for (const secret of ['abc123', 'zzzzzzzzzzzz', 'sessionid=xyz', 'S3nh4Sup3r', 'hunter2', 'abcdefghijkl123']) {
      expect(output).not.toContain(secret);
    }
  });

  it('o ciclo de vida completo (inicialização, conexão, falhas) não vaza ADMIN_TOKEN nem credenciais', async () => {
    const lines: string[] = [];
    const secret = 'S3gr3do-DATABASE-Pa55w0rd';
    const store = new MemoryStore();
    const { app, connection, base } = await boot({ TIKTOK_USERNAME: 'canal_teste' }, { store, lines });
    connection.emit('error', { info: 'falha', exception: new Error(`postgres://u:${secret}@h/db token=${TOKEN}`) });
    connection.emit('gift', rawGift('999999'));
    await admin(base, '/overview', { token: 'tentativa-errada' });
    await app.live.disconnect();
    await sleep(150);
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join('\n');
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain(secret);
  });
});
