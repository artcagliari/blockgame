import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { follow, gift, like, makeHarness, FakeConnection } from './test-helpers.js';
import { silentLogger } from './logger.js';
import { TikTokLiveService, sanitizeUsername, type ConnectionState } from './tiktok/live-service.js';

class OfflineError extends Error {
  constructor() {
    super('The requested user is not currently live.');
    this.name = 'UserOfflineError';
  }
}

async function makeService(connections: FakeConnection[], options: ConstructorParameters<typeof TikTokLiveService>[4] extends infer T ? Partial<NonNullable<T>> : never = {}) {
  const harness = await makeHarness();
  let index = 0;
  const factory = vi.fn(() => connections[Math.min(index++, connections.length - 1)]);
  const service = new TikTokLiveService(
    harness.pipeline, harness.registry, harness.store, silentLogger,
    { factory, baseDelayMs: 1_000, maxDelayMs: 16_000, offlineRetryMs: 30_000, random: () => 0.5, ...options },
    'streamer',
  );
  const states: ConnectionState[] = [];
  service.on('status', (status) => { if (states.at(-1) !== status.state) states.push(status.state); });
  return { ...harness, service, factory, states };
}

describe('TikTokLiveService', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('só informa CONECTADO depois da confirmação real do conector', async () => {
    const connection = new FakeConnection();
    let release!: () => void;
    connection.connectImpl = () => new Promise((resolve) => { release = () => resolve({ roomId: 'R1' }); });
    const { service, states } = await makeService([connection]);
    const pending = service.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(service.getStatus().state).toBe('CONNECTING');
    expect(states).not.toContain('CONNECTED');
    release();
    await pending;
    expect(service.getStatus()).toMatchObject({ state: 'CONNECTED', roomId: 'R1', sessionKey: 'R1' });
  });

  it('LIVE não iniciada: estado próprio e nova verificação periódica', async () => {
    const offline = new FakeConnection();
    offline.connectImpl = async () => { throw new OfflineError(); };
    const online = new FakeConnection();
    const { service, factory } = await makeService([offline, online]);
    await service.connect();
    expect(service.getStatus().state).toBe('LIVE_NOT_STARTED');
    expect(service.getStatus().nextRetryAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(service.getStatus().state).toBe('CONNECTED');
  });

  it('erro: estado ERROR com backoff exponencial e recuperação', async () => {
    const failing = Array.from({ length: 3 }, () => {
      const connection = new FakeConnection();
      connection.connectImpl = async () => { throw new Error('boom https://sign.example/ws?token=abc123 sessionid=deadbeef'); };
      return connection;
    });
    const ok = new FakeConnection();
    const { service, factory } = await makeService([...failing, ok]);
    await service.connect();
    expect(service.getStatus().state).toBe('ERROR');
    const message = service.getStatus().lastError ?? '';
    expect(message).not.toContain('abc123');
    expect(message).not.toContain('deadbeef');
    expect(message).not.toContain('https://');
    await vi.advanceTimersByTimeAsync(1_000);  // 1ª espera: 1 s
    expect(factory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);  // 2ª espera: 2 s (ainda não)
    expect(factory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(factory).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_000);  // 3ª espera: 4 s
    expect(factory).toHaveBeenCalledTimes(4);
    expect(service.getStatus().state).toBe('CONNECTED');
  });

  it('reconecta automaticamente quando a conexão cai e o jogo segue rodando', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    const { service, game, engine } = await makeService([first, second]);
    await service.connect();
    expect(service.getStatus().state).toBe('CONNECTED');
    first.emit('disconnected', { code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getStatus().state).toBe('DISCONNECTED');
    // O jogo continua aceitando eventos e o relógio segue.
    expect((await game.score({ dedupeKey: 'x', origin: 'test', kind: 'manual', team: 'lula', amount: 3 })).status).toBe('applied');
    expect(engine.getState().phase).toBe('playing');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.getStatus().state).toBe('CONNECTED');
  });

  it('respeita o limite de tentativas por intervalo', async () => {
    const connections = Array.from({ length: 20 }, () => {
      const connection = new FakeConnection();
      connection.connectImpl = async () => { throw new Error('falha'); };
      return connection;
    });
    const { service, factory } = await makeService(connections, { maxAttempts: 3, attemptWindowMs: 600_000, baseDelayMs: 1, maxDelayMs: 1 });
    await service.connect();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(factory).toHaveBeenCalledTimes(3);
    expect(service.getStatus().state).toBe('ERROR');
    expect(service.getStatus().lastError).toMatch(/Limite de tentativas/);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(factory.mock.calls.length).toBeGreaterThan(3);
  });

  it('desconexão manual cancela novas tentativas', async () => {
    const connection = new FakeConnection();
    const { service, factory } = await makeService([connection]);
    await service.connect();
    await service.disconnect();
    expect(service.getStatus()).toMatchObject({ state: 'DISCONNECTED', autoReconnect: false });
    connection.emit('disconnected', {});
    await vi.advanceTimersByTimeAsync(600_000);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('encaminha gift/like/follow/social ao pipeline e conta diagnósticos', async () => {
    const connection = new FakeConnection();
    const { service, engine, registry } = await makeService([connection]);
    await registry.assign('lula:impulso', { giftId: '5655', allowManual: true });
    await service.connect();
    connection.emit('gift', { common: { msgId: 'g1' }, giftId: '5655', repeatCount: 2, repeatEnd: 1, groupId: '10', user: { userId: '1', nickname: 'Ana' }, gift: { id: '5655', name: 'Rose', diamondCount: 1, type: 1 } });
    connection.emit('like', { common: { msgId: 'l1' }, count: 3, total: '50', user: { userId: '1' } });
    connection.emit('follow', { common: { msgId: 'f1' }, user: { userId: '2' } });
    connection.emit('social', { common: { msgId: 'f2', displayText: { key: 'pm_main_follow_message_viewer_2' } }, user: { userId: '2' } });
    connection.emit('share', { user: { userId: '3' } });
    connection.emit('chat', { comment: 'oi', user: { userId: '4', nickname: 'Cris' } });
    for (let index = 0; index < 20; index += 1) connection.emit('chat', { common: { msgId: `v${index}` }, comment: '22', user: { userId: `voter${index}` } });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const { lula, bolsonaro } = engine.getState().teams;
    expect(lula.score).toBe(2 * 5 + 3);
    expect(bolsonaro.score).toBe(2); // 1 seguidor + 20 comentários "22" (padrão 20 = 1 bloco)
    expect(service.getStatus().counters).toMatchObject({ gifts: 1, likes: 1, follows: 2, shares: 1, comments: 21 });
    // o diagnóstico guarda os 20 comentários mais recentes
    expect(service.getRecentComments()).toHaveLength(20);
    expect(service.getRecentComments().at(-1)).toMatchObject({ text: '22' });
  });

  it('atualiza o registro de presentes com fetchAvailableGifts', async () => {
    const connection = new FakeConnection();
    connection.gifts = [
      { id: 5655, name: 'Rose', diamond_count: 1, image: { url_list: ['https://cdn/rose.png'] } },
      { id: 'abc', name: 'Inválido', diamond_count: 5 },
    ];
    const { service, registry } = await makeService([connection]);
    await service.connect();
    await vi.advanceTimersByTimeAsync(0);
    const known = registry.known();
    expect(known.find((entry) => entry.giftId === '5655')).toMatchObject({ name: 'Rose', coins: 1, imageUrl: 'https://cdn/rose.png', source: 'catalog' });
    expect(known.some((entry) => entry.giftId === 'abc')).toBe(false);
  });

  it('valida o nome de usuário e exige configuração antes de conectar', async () => {
    expect(sanitizeUsername('@meu.canal_01')).toBe('meu.canal_01');
    expect(sanitizeUsername('x')).toBeNull();
    expect(sanitizeUsername('com espaço')).toBeNull();
    expect(sanitizeUsername('<script>')).toBeNull();
    const harness = await makeHarness();
    const service = new TikTokLiveService(harness.pipeline, harness.registry, harness.store, silentLogger, { factory: () => new FakeConnection() }, null);
    await expect(service.connect()).rejects.toThrow(/usuário/i);
    expect(like({}).type).toBe('like');
    expect(follow({}).type).toBe('follow');
    expect(gift({}).type).toBe('gift');
  });
});
