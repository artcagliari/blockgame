import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { silentLogger } from './logger.js';
import { MemoryStore } from './store/memory-store.js';
import type { Store } from './store/types.js';
import { FakeConnection } from './test-helpers.js';
import type { GameState, IncrementEvent } from '../src/game/types.js';

const TOKEN = 'token-de-teste-com-mais-de-16';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Running {
  app: App;
  base: string;
  connection: FakeConnection;
  store: Store;
  sockets: Socket[];
}
const running: Running[] = [];
const extraSockets: Socket[] = [];

async function boot(options: { store?: Store; env?: Record<string, string>; connection?: FakeConnection } = {}): Promise<Running> {
  const store = options.store ?? new MemoryStore();
  const connection = options.connection ?? new FakeConnection();
  const config = loadConfig({
    NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', ADMIN_TOKEN: TOKEN, AUTOPLAY: 'off',
    TIKTOK_USERNAME: 'canal_teste', TIKTOK_AUTOCONNECT: 'false', ...options.env,
  } as NodeJS.ProcessEnv);
  const app = createApp({ config, store, logger: silentLogger, connectionFactory: () => connection, leaderRetryMs: 50 });
  const port = await app.start();
  const item = { app, base: `http://127.0.0.1:${port}`, connection, store, sockets: [] as Socket[] };
  running.push(item);
  return item;
}

function overlay(base: string, headers?: Record<string, string>): Socket {
  const socket = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: headers });
  extraSockets.push(socket);
  return socket;
}

const once = <T>(socket: Socket, event: string) => new Promise<T>((resolve) => socket.once(event, resolve));
const admin = (base: string, path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = TOKEN, ...rest } = init;
  return fetch(`${base}/api/admin${path}`, {
    ...rest,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(rest.headers as object) },
  });
};
const post = (base: string, path: string, body?: unknown, token?: string | null) =>
  admin(base, path, { method: 'POST', body: JSON.stringify(body ?? {}), token });

afterEach(async () => {
  for (const socket of extraSockets.splice(0)) socket.close();
  for (const item of running.splice(0)) await item.app.stop().catch(() => {});
});

describe('backend integrado', () => {
  it('inicia, responde /health e entrega o estado completo ao overlay', async () => {
    const { base } = await boot();
    const health = await (await fetch(`${base}/health`)).json();
    expect(health).toMatchObject({ ok: true, role: 'leader', phase: 'playing', store: 'memory' });
    const socket = overlay(base);
    const state = await once<GameState>(socket, 'state');
    expect(state).toMatchObject({ phase: 'playing', round: 1 });
    expect(state.seq).toBeGreaterThan(0);
    expect(state.roundId).toBeGreaterThan(0);
    expect(state.config).toMatchObject({ target: 2000, durationSeconds: 300, resultSeconds: 10 });
  });

  it('o canal público é somente leitura: comandos de admin enviados pelo overlay são ignorados', async () => {
    const { base, app } = await boot();
    const socket = overlay(base);
    await once(socket, 'state');
    socket.emit('admin:increment', { team: 'lula', amount: 500 });
    socket.emit('admin:event', { team: 'bolsonaro', amount: 1000, effect: 'gift' });
    socket.emit('admin:reset');
    await sleep(150);
    expect(app.game.getState().teams.lula.score).toBe(0);
    expect(app.game.getState().teams.bolsonaro.score).toBe(0);
  });

  it('painel administrativo exige autenticação e não aceita alteração pública', async () => {
    const { base, app } = await boot();
    expect((await admin(base, '/overview', { token: null })).status).toBe(401);
    expect((await admin(base, '/overview', { token: 'errado' })).status).toBe(401);
    expect((await post(base, '/test/like', { count: 5 }, null)).status).toBe(401);
    expect((await post(base, '/game/reset', {}, 'errado')).status).toBe(401);
    expect((await admin(base, '/game/config', { method: 'PUT', body: JSON.stringify({ target: 10 }), token: null })).status).toBe(401);
    expect(app.game.getState().teams.lula.score).toBe(0);
    expect(app.game.getState().config.target).toBe(2000);
    expect((await admin(base, '/overview')).status).toBe(200);
    // token na URL nunca é aceito
    expect((await fetch(`${base}/api/admin/overview?token=${TOKEN}`)).status).toBe(401);
  });

  it('namespace administrativo do Socket.IO também exige token', async () => {
    const { base } = await boot();
    const bad = connect(`${base}/admin`, { transports: ['websocket'], forceNew: true, auth: { token: 'nope' } });
    extraSockets.push(bad);
    const error = await once<Error>(bad, 'connect_error');
    expect(error.message).toBe('unauthorized');
    const good = connect(`${base}/admin`, { transports: ['websocket'], forceNew: true, auth: { token: TOKEN } });
    extraSockets.push(good);
    await once(good, 'connect');
    const processed = once<{ origin: string; kind: string }>(good, 'processed');
    await post(base, '/test/like', { count: 2 });
    expect(await processed).toMatchObject({ origin: 'test', kind: 'like' });
  });

  it('limita tentativas de autenticação inválidas', async () => {
    const { base } = await boot();
    let blocked = 0;
    for (let index = 0; index < 30; index += 1) {
      const response = await admin(base, '/overview', { token: `errado-${index}` });
      if (response.status === 429) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it('like real do TikTok → Lula +1 e o overlay recebe o incremento com todos os campos', async () => {
    const { base, connection, app } = await boot();
    await app.live.connect();
    const socket = overlay(base);
    await once(socket, 'state');
    const incoming = once<IncrementEvent>(socket, 'increment');
    // padrão do jogo: 120 curtidas = 1 bloco
    connection.emit('like', { common: { msgId: 'like-0', roomId: 'room-fake' }, count: 60, total: '717', user: { userId: '41', nickname: 'João' } });
    connection.emit('like', { common: { msgId: 'like-1', roomId: 'room-fake' }, count: 60, total: '777', user: { userId: '42', nickname: 'Maria' } });
    const event = await incoming;
    expect(event).toMatchObject({
      team: 'lula', amount: 1, total: 1, count: 60, opponentTotal: 0, origin: 'real', kind: 'like', effect: 'like',
      viewerName: 'Maria', roundId: 1,
    });
    expect(typeof event.id).toBe('string');
    expect(event.seq).toBeGreaterThan(1);
    expect(typeof event.at).toBe('number');
  });

  it('follow real → Bolsonaro +1; FOLLOW + SOCIAL da mesma pessoa contam uma vez', async () => {
    const { base, connection, app } = await boot();
    await app.live.connect();
    connection.emit('follow', { common: { msgId: 'f-1' }, user: { userId: '9', nickname: 'João' } });
    connection.emit('social', { common: { msgId: 'f-2', displayText: { key: 'pm_main_follow_message_viewer_2' } }, user: { userId: '9' } });
    await sleep(120);
    const state = await (await admin(base, '/overview')).json();
    expect(state.state.teams.bolsonaro.score).toBe(1);
    expect(state.state.teams.lula.score).toBe(0);
  });

  it('presente mapeado pontua; combo de 5 rosas = 25; presente desconhecido não pontua', async () => {
    const { base, connection, app } = await boot();
    await app.live.connect();
    const mapped = await admin(base, '/gifts/slots/lula:impulso', { method: 'PUT', body: JSON.stringify({ giftId: '5655', allowManual: true }) });
    expect(mapped.status).toBe(200);
    for (let count = 1; count <= 5; count += 1) {
      connection.emit('gift', { common: { msgId: `rose-${count}` }, giftId: '5655', repeatCount: count, repeatEnd: 0, groupId: 'G', user: { userId: '1' }, gift: { id: '5655', name: 'Rose', type: 1, diamondCount: 1 } });
    }
    connection.emit('gift', { common: { msgId: 'rose-end' }, giftId: '5655', repeatCount: 5, repeatEnd: 1, groupId: 'G', user: { userId: '1' }, gift: { id: '5655', name: 'Rose', type: 1, diamondCount: 1 } });
    connection.emit('gift', { common: { msgId: 'lion-1' }, giftId: '31337', repeatCount: 1, repeatEnd: 0, groupId: '', user: { userId: '2' }, gift: { id: '31337', name: 'Lion', type: 0, diamondCount: 29999 } });
    await sleep(200);
    const overview = await (await admin(base, '/overview')).json();
    expect(overview.state.teams.lula.score).toBe(25);
    expect(overview.state.teams.bolsonaro.score).toBe(0);
    expect(overview.knownGifts.find((gift: { giftId: string }) => gift.giftId === '31337')).toMatchObject({ name: 'Lion', slotId: null });
    expect(overview.statsReal.find((row: { kind: string; status: string }) => row.kind === 'gift' && row.status === 'ignored')).toBeTruthy();
  });

  it('simulações são marcadas TESTE e ficam fora das estatísticas reais', async () => {
    const { base, app, connection } = await boot();
    await app.live.connect();
    await admin(base, '/game/config', { method: 'PUT', body: JSON.stringify({ likesPerBlock: 1 }) });
    await post(base, '/test/like', { count: 3 });
    await post(base, '/test/follow');
    await post(base, '/test/gift', { slotId: 'bolsonaro:turbo' });
    const combo = await (await post(base, '/test/combo', { slotId: 'lula:impulso', total: 5 })).json();
    expect(combo.applied).toBe(25);
    const reconnect = await (await post(base, '/test/reconnect', { slotId: 'bolsonaro:super-impulso' })).json();
    expect(reconnect).toMatchObject({ applied: 50, expected: 50, ok: true });
    connection.emit('like', { common: { msgId: 'real-like' }, count: 2, user: { userId: '5' } });
    await sleep(100);
    const overview = await (await admin(base, '/overview')).json();
    const sum = (rows: Array<{ points: number }>) => rows.reduce((total, row) => total + row.points, 0);
    expect(sum(overview.statsReal)).toBe(2);
    expect(sum(overview.statsTest.filter((row: { status: string }) => row.status === 'applied'))).toBe(3 + 1 + 30 + 25 + 50);
    const events = await (await admin(base, '/events?origin=real')).json();
    expect(events.events.every((event: { origin: string }) => event.origin === 'real')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('userHash');
  });

  it('eventos simultâneos para as duas equipes não interferem', async () => {
    const { base, app } = await boot();
    const response = await (await post(base, '/test/burst', { size: 30 })).json();
    expect(response.sent).toBe(30);
    const { lula, bolsonaro } = app.game.getState().teams;
    // 10 likes (+1 Lula) | 10 follows (+1 Bolsonaro) | 10 presentes alternando equipes e valores
    expect(lula.score).toBeGreaterThanOrEqual(10);
    expect(bolsonaro.score).toBeGreaterThanOrEqual(10);
    await post(base, '/game/reset');
    const ids = new Set<string>();
    const socket = overlay(base);
    socket.on('increment', (event: IncrementEvent) => ids.add(event.id));
    await once(socket, 'state');
    await post(base, '/test/burst', { size: 20 });
    await sleep(100);
    expect(ids.size).toBeGreaterThan(0);
  });

  it('recarregar o overlay recupera o placar sem reproduzir eventos antigos', async () => {
    const { base } = await boot();
    await post(base, '/test/increment', { team: 'lula', amount: 120 });
    await post(base, '/test/increment', { team: 'bolsonaro', amount: 75 });
    const replayed: IncrementEvent[] = [];
    const socket = overlay(base);
    socket.on('increment', (event: IncrementEvent) => replayed.push(event));
    const state = await once<GameState>(socket, 'state');
    await sleep(100);
    expect(state.teams.lula.score).toBe(120);
    expect(state.teams.bolsonaro.score).toBe(75);
    expect(replayed).toHaveLength(0);
  });

  it('comentários "13"/"22" pelo teste do painel: 20 = 1 bloco, cada equipe no seu contador', async () => {
    const { base, app } = await boot();
    const lula = await (await post(base, '/test/comment', { team: 'lula', count: 20 })).json();
    const bolso = await (await post(base, '/test/comment', { team: 'bolsonaro', count: 7 })).json();
    expect(lula).toMatchObject({ sent: 20, blocks: 1, pending: 0 });
    expect(bolso).toMatchObject({ sent: 7, blocks: 0, pending: 7 });
    expect(app.game.getState().teams).toMatchObject({ lula: { score: 1 }, bolsonaro: { score: 0 } });
  });

  it('pede snapshot atualizado via sync', async () => {
    const { base } = await boot();
    const socket = overlay(base);
    await once(socket, 'state');
    await post(base, '/test/increment', { team: 'lula', amount: 9 });
    await sleep(50);
    const snapshot = once<GameState>(socket, 'state');
    socket.emit('sync');
    expect((await snapshot).teams.lula.score).toBe(9);
  });

  it('reiniciar o servidor recupera o estado e não reaplica presentes já processados', async () => {
    const store = new MemoryStore();
    const first = await boot({ store });
    await first.app.live.connect();
    await admin(first.base, '/gifts/slots/bolsonaro:escudo', { method: 'PUT', body: JSON.stringify({ giftId: '8888', allowManual: true }) });
    const payload = { common: { msgId: 'once-only' }, giftId: '8888', repeatCount: 1, repeatEnd: 0, groupId: '', user: { userId: '3' }, gift: { id: '8888', name: 'Hat', type: 0, diamondCount: 99 } };
    first.connection.emit('gift', payload);
    await sleep(120);
    expect(first.app.game.getState().teams.bolsonaro.score).toBe(100);
    const savedSeq = first.app.game.getState().seq;
    await first.app.stop();
    running.splice(running.indexOf(first), 1);

    const second = await boot({ store });
    const state = second.app.game.getState();
    expect(state.teams.bolsonaro.score).toBe(100);
    expect(state.round).toBe(1);
    expect(state.seq).toBeGreaterThan(savedSeq);
    // O TikTok reentrega a mesma mensagem após o reinício: não pontua de novo.
    await second.app.live.connect();
    second.connection.emit('gift', payload);
    await sleep(120);
    expect(second.app.game.getState().teams.bolsonaro.score).toBe(100);
    // O mapeamento também sobreviveu.
    const overview = await (await admin(second.base, '/overview')).json();
    expect(overview.slots.find((slot: { slotId: string }) => slot.slotId === 'bolsonaro:escudo').giftId).toBe('8888');
  });

  it('queda da conexão com o TikTok não derruba o jogo nem o gerador automático', async () => {
    const { base, connection, app } = await boot({ env: { AUTOPLAY: 'on' } });
    await admin(base, '/game/config', { method: 'PUT', body: JSON.stringify({ autoEnabled: true }) });
    await app.live.connect();
    expect(app.live.getStatus().state).toBe('CONNECTED');
    connection.emit('disconnected', { code: 1006, reason: '' });
    await sleep(50);
    expect(app.live.getStatus().state).toBe('DISCONNECTED');
    const socket = overlay(base);
    const auto = new Promise<IncrementEvent>((resolve) => {
      socket.on('increment', (event: IncrementEvent) => { if (event.origin === 'auto') resolve(event); });
    });
    const event = await Promise.race([auto, sleep(5_000).then(() => null)]);
    expect(event).not.toBeNull();
    expect(event).toMatchObject({ origin: 'auto', kind: 'auto' });
    expect((await (await fetch(`${base}/health`)).json()).phase).toBe('playing');
  }, 15_000);

  it('rodada termina na meta e reinicia sozinha após o intervalo', async () => {
    const { base, app } = await boot();
    await admin(base, '/game/config', { method: 'PUT', body: JSON.stringify({ target: 10, resultSeconds: 3 }) });
    const rounds: GameState[] = [];
    app.game.on('roundStarted', (state: GameState) => rounds.push(state));
    await post(base, '/test/increment', { team: 'bolsonaro', amount: 10 });
    expect(app.game.getState()).toMatchObject({ phase: 'result', winner: 'bolsonaro' });
    // Durante a tela de resultado nada pontua.
    const during = await (await post(base, '/test/like', { count: 5 })).json();
    expect(during).toMatchObject({ status: 'ignored', reason: 'result_phase' });
    await sleep(4_000);
    const state = app.game.getState();
    expect(state.phase).toBe('playing');
    expect(state.round).toBe(2);
    expect(state.teams.lula.score).toBe(0);
    expect(state.teams.bolsonaro.wins).toBe(1);
    expect(rounds).toHaveLength(1);
  }, 15_000);

  it('valida configurações e nome de usuário', async () => {
    const { base, app } = await boot();
    const bad = await admin(base, '/game/config', { method: 'PUT', body: JSON.stringify({ target: 'muito', hack: true }) });
    expect(bad.status).toBe(400);
    expect((await admin(base, '/tiktok/username', { method: 'PUT', body: JSON.stringify({ username: '<img src=x>' }) })).status).toBe(400);
    const ok = await admin(base, '/tiktok/username', { method: 'PUT', body: JSON.stringify({ username: '@novo.canal' }) });
    expect(await ok.json()).toEqual({ username: 'novo.canal' });
    expect(app.live.getStatus().username).toBe('novo.canal');
    expect(await app.store.getSetting('tiktok.username')).toBe('novo.canal');
    expect((await post(base, '/test/gift', { slotId: 'inexistente' })).status).toBe(400);
  });

  it('CORS restrito: origem externa não recebe permissão e o websocket é recusado', async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const socket = connect(base, { transports: ['websocket'], forceNew: true, extraHeaders: { origin: 'https://evil.example' }, reconnection: false });
    extraSockets.push(socket);
    const error = await Promise.race([once<Error>(socket, 'connect_error'), sleep(3_000).then(() => null)]);
    expect(error).not.toBeNull();
    expect(socket.connected).toBe(false);
  });

  it('usuário TikTok inválido no ambiente não impede o jogo de iniciar', async () => {
    const { base, app } = await boot({ env: { TIKTOK_USERNAME: 'um nome invalido com espaços', TIKTOK_AUTOCONNECT: 'true' } });
    expect(app.role()).toBe('leader');
    expect((await admin(base, '/overview')).status).toBe(200);
    expect(app.live.getStatus()).toMatchObject({ state: 'DISCONNECTED', username: null });
  });

  it('respostas 503/400 legítimas não esgotam o limite de autenticação', async () => {
    const { base } = await boot();
    for (let index = 0; index < 30; index += 1) {
      expect((await admin(base, '/game/config', { method: 'PUT', body: JSON.stringify({ target: 'x' }) })).status).toBe(400);
    }
    expect((await admin(base, '/overview')).status).toBe(200);
  });

  it('instância sem a liderança não roda motor nem aceita comandos', async () => {
    class FollowerStore extends MemoryStore {
      override async acquireLeadership() { return false; }
    }
    const { base, app } = await boot({ store: new FollowerStore() });
    expect(app.role()).toBe('standby');
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, role: 'standby', phase: null });
    expect((await post(base, '/game/reset')).status).toBe(503);
    expect((await post(base, '/tiktok/connect')).status).toBe(503);
  });
});

describe('configuração', () => {
  it('produção exige ADMIN_TOKEN e banco de dados', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ NODE_ENV: 'production', ADMIN_TOKEN: 'x'.repeat(20) } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
    const ok = loadConfig({ NODE_ENV: 'production', ADMIN_TOKEN: 'x'.repeat(20), DATABASE_URL: 'postgres://u:p@h/db', PORT: '8080' } as NodeJS.ProcessEnv);
    expect(ok.PORT).toBe(8080);
  });

  it('usuário do TikTok vem do ambiente, nunca do código', () => {
    const config = loadConfig({ NODE_ENV: 'test', TIKTOK_USERNAME: 'meucanal' } as NodeJS.ProcessEnv);
    expect(config.TIKTOK_USERNAME).toBe('meucanal');
    expect(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).TIKTOK_USERNAME).toBeUndefined();
  });
});
