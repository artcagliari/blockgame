import { EventEmitter } from 'node:events';
import type { LivePipeline } from '../live-pipeline.js';
import type { GiftRegistry } from '../gift-registry.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/types.js';
import type { LiveEvent } from './events.js';
import { classifySocial, normalizeDiagnostic, normalizeFollow, normalizeGift, normalizeLike } from './normalize.js';

export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'LIVE_NOT_STARTED' | 'ERROR';

export interface ConnectionStatus {
  state: ConnectionState;
  username: string | null;
  roomId: string | null;
  sessionKey: string | null;
  since: number;
  attempts: number;
  nextRetryAt: number | null;
  lastError: string | null;
  lastEventAt: number | null;
  autoReconnect: boolean;
  counters: { gifts: number; likes: number; follows: number; shares: number; comments: number; socialOther: number };
}

/** Superfície mínima usada do conector; permite substituí-lo por um falso nos testes. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface LiveConnection {
  connect(): Promise<{ roomId?: string } | void>;
  disconnect(): Promise<void>;
  fetchAvailableGifts(): Promise<any>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
  readonly isConnected?: boolean;
  readonly roomId?: string;
}
export type ConnectionFactory = (username: string) => LiveConnection;

export interface LiveServiceOptions {
  factory: ConnectionFactory;
  /** Backoff exponencial: base * 2^n, limitado por maxDelayMs, com jitter. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Intervalo entre verificações quando o streamer ainda não está ao vivo (mín. 30s no conector). */
  offlineRetryMs?: number;
  /** No máximo `maxAttempts` tentativas por janela; depois espera esfriar. */
  maxAttempts?: number;
  attemptWindowMs?: number;
  connectTimeoutMs?: number;
  random?: () => number;
}

const USERNAME_PATTERN = /^[A-Za-z0-9._]{2,24}$/;

export function sanitizeUsername(input: string | null | undefined): string | null {
  const value = (input ?? '').trim().replace(/^@/, '');
  return USERNAME_PATTERN.test(value) ? value : null;
}

export class TikTokLiveService extends EventEmitter {
  private connection: LiveConnection | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attemptTimes: number[] = [];
  private failures = 0;
  private generation = 0;
  private desired = false;
  private readonly status: ConnectionStatus;
  private readonly opts: Required<Omit<LiveServiceOptions, 'factory'>>;
  private readonly factory: ConnectionFactory;
  private comments: Array<{ at: number; user: string; text: string }> = [];

  constructor(
    private readonly pipeline: LivePipeline,
    private readonly registry: GiftRegistry,
    private readonly store: Store,
    private readonly logger: Logger,
    options: LiveServiceOptions,
    username: string | null = null,
  ) {
    super();
    this.factory = options.factory;
    this.opts = {
      baseDelayMs: options.baseDelayMs ?? 5_000,
      maxDelayMs: options.maxDelayMs ?? 300_000,
      offlineRetryMs: options.offlineRetryMs ?? 60_000,
      maxAttempts: options.maxAttempts ?? 8,
      attemptWindowMs: options.attemptWindowMs ?? 600_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 45_000,
      random: options.random ?? Math.random,
    };
    this.status = {
      state: 'DISCONNECTED',
      username: sanitizeUsername(username),
      roomId: null,
      sessionKey: null,
      since: Date.now(),
      attempts: 0,
      nextRetryAt: null,
      lastError: null,
      lastEventAt: null,
      autoReconnect: false,
      counters: { gifts: 0, likes: 0, follows: 0, shares: 0, comments: 0, socialOther: 0 },
    };
  }

  getStatus(): ConnectionStatus {
    return { ...this.status, counters: { ...this.status.counters } };
  }

  getRecentComments() {
    return [...this.comments];
  }

  get sessionKey(): string | null {
    return this.status.sessionKey;
  }

  setUsername(username: string): void {
    const clean = sanitizeUsername(username);
    if (!clean) throw new Error('Usuário TikTok inválido. Use 2 a 24 caracteres: letras, números, ponto ou sublinhado.');
    this.status.username = clean;
    this.emitStatus();
  }

  /** Inicia a conexão e mantém reconexão automática enquanto desejada. */
  async connect(): Promise<void> {
    if (!this.status.username) throw new Error('Informe o usuário TikTok antes de conectar.');
    this.desired = true;
    this.status.autoReconnect = true;
    this.failures = 0;
    this.attemptTimes = [];
    this.clearRetry();
    await this.attempt();
  }

  async disconnect(): Promise<void> {
    this.desired = false;
    this.status.autoReconnect = false;
    this.clearRetry();
    this.generation += 1;
    await this.teardown();
    await this.closeSession();
    this.setState('DISCONNECTED', null);
  }

  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  async refreshGifts(): Promise<number> {
    const connection = this.connection ?? this.factory(this.requireUsername());
    const list = await connection.fetchAvailableGifts();
    const items = Array.isArray(list) ? list : Array.isArray(list?.gifts) ? list.gifts : [];
    const parsed = items.map((gift: any) => ({
      giftId: gift?.id === undefined || gift?.id === null ? '' : String(gift.id),
      name: typeof gift?.name === 'string' ? gift.name : null,
      imageUrl: gift?.image?.url_list?.[0] ?? gift?.image?.urlList?.[0] ?? gift?.icon?.url_list?.[0] ?? null,
      coins: Number.isFinite(Number(gift?.diamond_count ?? gift?.diamondCount)) ? Number(gift?.diamond_count ?? gift?.diamondCount) : null,
    }));
    const imported = await this.registry.importCatalog(parsed);
    this.logger.info('catálogo de presentes atualizado', { received: items.length, imported });
    this.emit('giftsUpdated');
    return imported;
  }

  // ---- internos ----

  private requireUsername(): string {
    if (!this.status.username) throw new Error('Usuário TikTok não configurado.');
    return this.status.username;
  }

  private async attempt(): Promise<void> {
    if (!this.desired) return;
    const now = Date.now();
    this.attemptTimes = this.attemptTimes.filter((time) => now - time < this.opts.attemptWindowMs);
    if (this.attemptTimes.length >= this.opts.maxAttempts) {
      const wait = this.attemptTimes[0] + this.opts.attemptWindowMs - now;
      this.logger.warn('limite de tentativas de conexão atingido; aguardando', { waitMs: wait });
      this.setState('ERROR', 'Limite de tentativas de conexão atingido. Nova tentativa automática em breve.');
      this.scheduleRetry(Math.max(1_000, wait));
      return;
    }
    this.attemptTimes.push(now);
    this.status.attempts += 1;
    const generation = ++this.generation;
    await this.teardown();
    this.setState('CONNECTING', null);

    const username = this.requireUsername();
    let connection: LiveConnection;
    try {
      connection = this.factory(username);
    } catch (error) {
      this.handleFailure(generation, error);
      return;
    }
    this.connection = connection;
    this.wire(connection, generation);

    try {
      const state = await withTimeout(connection.connect(), this.opts.connectTimeoutMs, 'Tempo esgotado ao conectar.');
      if (generation !== this.generation) return;
      // Só aqui, depois da confirmação real do conector, o estado vira CONECTADO.
      const roomId = String((state as { roomId?: string } | undefined)?.roomId ?? connection.roomId ?? '');
      if (!roomId) throw new Error('Conexão aberta sem identificação da sala.');
      this.failures = 0;
      this.status.roomId = roomId;
      this.status.sessionKey = roomId;
      await this.store.openSession({ sessionKey: roomId, username });
      this.setState('CONNECTED', null);
      this.logger.info('conectado à LIVE', { username, roomId });
      void this.refreshGifts().catch((error) => this.logger.warn('não foi possível listar presentes', { error }));
    } catch (error) {
      this.handleFailure(generation, error);
    }
  }

  private wire(connection: LiveConnection, generation: number): void {
    const live = () => generation === this.generation;
    const forward = (event: LiveEvent) => {
      if (!live()) return;
      this.status.lastEventAt = Date.now();
      const session = this.status.sessionKey ?? event.roomId ?? 'unknown-room';
      void this.pipeline.handle(event, 'real', session).catch((error) => this.logger.error('erro no pipeline', { error }));
    };
    const room = () => this.status.roomId ?? '';

    connection.on('gift', (data: any) => {
      try { this.status.counters.gifts += 1; forward(normalizeGift(data, room())); } catch (error) { this.logger.warn('gift inválido', { error }); }
    });
    connection.on('like', (data: any) => {
      try { this.status.counters.likes += 1; forward(normalizeLike(data, room())); } catch (error) { this.logger.warn('like inválido', { error }); }
    });
    connection.on('follow', (data: any) => {
      try { this.status.counters.follows += 1; forward(normalizeFollow(data, 'follow', room())); } catch (error) { this.logger.warn('follow inválido', { error }); }
    });
    connection.on('social', (data: any) => {
      try {
        const kind = classifySocial(data);
        if (kind === 'follow') { this.status.counters.follows += 1; forward(normalizeFollow(data, 'social', room())); }
        else if (kind === 'share') { this.status.counters.shares += 1; }
        else { this.status.counters.socialOther += 1; }
      } catch (error) { this.logger.warn('social inválido', { error }); }
    });
    connection.on('share', () => { this.status.counters.shares += 1; });
    connection.on('chat', (data: any) => {
      try {
        this.status.counters.comments += 1;
        const event = normalizeDiagnostic('comment', data, room());
        this.comments.push({ at: event.at, user: event.userName.slice(0, 24), text: event.text ?? '' });
        if (this.comments.length > 20) this.comments.shift();
      } catch { /* diagnóstico apenas */ }
    });
    connection.on('streamEnd', () => {
      if (!live()) return;
      this.logger.info('LIVE encerrada pelo streamer');
      void this.onClosed('LIVE encerrada.');
    });
    connection.on('disconnected', () => {
      if (!live()) return;
      this.logger.warn('conexão com a LIVE perdida');
      void this.onClosed('Conexão perdida.');
    });
    connection.on('error', (payload: any) => {
      const message = describeError(payload?.exception ?? payload);
      this.logger.warn('erro do conector', { info: payload?.info, message });
      void this.store.logError('tiktok', message).catch(() => {});
    });
  }

  private async onClosed(reason: string): Promise<void> {
    await this.closeSession();
    if (!this.desired) {
      this.setState('DISCONNECTED', null);
      return;
    }
    this.setState('DISCONNECTED', reason);
    this.scheduleRetry(this.backoff(0));
  }

  private handleFailure(generation: number, error: unknown): void {
    if (generation !== this.generation) return;
    const offline = isOfflineError(error);
    const message = describeError(error);
    void this.teardown();
    if (offline) {
      this.logger.info('streamer ainda não está ao vivo', { username: this.status.username });
      this.setState('LIVE_NOT_STARTED', 'A LIVE ainda não foi iniciada.');
      if (this.desired) this.scheduleRetry(this.opts.offlineRetryMs);
      return;
    }
    this.failures += 1;
    this.logger.warn('falha ao conectar', { message, failures: this.failures });
    void this.store.logError('tiktok-connect', message).catch(() => {});
    this.setState('ERROR', message);
    if (this.desired) this.scheduleRetry(this.backoff(this.failures));
  }

  private backoff(failures: number): number {
    const raw = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** Math.max(0, failures - 1));
    const jitter = 0.8 + this.opts.random() * 0.4;
    return Math.round(raw * jitter);
  }

  private scheduleRetry(delayMs: number): void {
    this.clearRetry();
    this.status.nextRetryAt = Date.now() + delayMs;
    this.emitStatus();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.status.nextRetryAt = null;
      void this.attempt();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.status.nextRetryAt = null;
  }

  private async teardown(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (!connection) return;
    try { connection.removeAllListeners(); } catch { /* ignore */ }
    try { await connection.disconnect(); } catch { /* ignore */ }
  }

  private async closeSession(): Promise<void> {
    if (this.status.sessionKey) await this.store.closeSession(this.status.sessionKey).catch(() => {});
  }

  private setState(state: ConnectionState, error: string | null): void {
    this.status.state = state;
    this.status.lastError = error;
    this.status.since = Date.now();
    if (state !== 'CONNECTED') this.status.roomId = state === 'CONNECTING' ? this.status.roomId : null;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }
}

function isOfflineError(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? '';
  const message = describeError(error).toLowerCase();
  return name === 'UserOfflineError' || /not (currently )?live|user.*offline|isn't live|is not hosting|not hosting a live/.test(message);
}

/** Mensagem curta, sem URLs completas, cookies ou tokens. */
function describeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'erro desconhecido');
  if (/Failed to retrieve Room ID/i.test(raw)) {
    return 'Não foi possível obter a sala da LIVE: usuário inexistente, LIVE não iniciada ou serviço de assinatura indisponível.';
  }
  return raw
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/(sessionid|token|cookie|authorization|api[_-]?key)[=:]\s*\S+/gi, '$1=[redigido]')
    .slice(0, 240);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Fábrica real: carrega o conector sob demanda. */
export async function createRealFactory(options: { signApiKey?: string }): Promise<ConnectionFactory> {
  const lib = await import('tiktok-live-connector');
  return (username: string) =>
    new lib.TikTokLiveConnection(username, {
      signApiKey: options.signApiKey,
      // Não reprocessar o histórico recente da sala como se fosse novo.
      processInitialData: false,
      fetchRoomInfoOnConnect: true,
      enableExtendedGiftInfo: false,
    }) as unknown as LiveConnection;
}
