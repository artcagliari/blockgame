import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { Server as IoServer, type Namespace } from 'socket.io';
import { z } from 'zod';
import { AUDIO_EVENT_KEYS, type AudioBindingKey, type AudioReport, type ClientToServerEvents, type ServerToClientEvents } from '../src/game/types.js';
import { ALL_BINDING_KEYS, AUDIO_CATEGORIES, AUDIO_TEAMS, AudioService, AudioValidationError, defaultCooldown } from './audio/audio-service.js';
import { DatabaseBlobStore, FilesystemBlobStore } from './audio/blob-store.js';
import { createAuth, type Auth } from './auth.js';
import type { AppConfig } from './config.js';
import { GameEngine, normalizeConfig } from './game-engine.js';
import { GameService } from './game-service.js';
import { GiftMappingError, GiftRegistry } from './gift-registry.js';
import { GIFT_SLOTS } from './gift-slots.js';
import { LivePipeline, type PipelineSummary } from './live-pipeline.js';
import type { Logger } from './logger.js';
import type { Store } from './store/types.js';
import type { LiveEvent } from './tiktok/events.js';
import { TikTokLiveService, sanitizeUsername, type ConnectionFactory } from './tiktok/live-service.js';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  logger: Logger;
  /** Fábrica do conector TikTok (real em produção; falsa nos testes). */
  connectionFactory: ConnectionFactory;
  /** Diretório do frontend compilado. Quando presente, serve /overlay e /admin. */
  staticDir?: string;
  liveOptions?: ConstructorParameters<typeof TikTokLiveService>[4];
  enableTestEvents?: boolean;
  /** Intervalo de checagem da liderança; testes reduzem. */
  leaderRetryMs?: number;
}

const USERNAME_KEY = 'tiktok.username';
const RECENT_PROCESSED = 60;

export interface App {
  httpServer: HttpServer;
  io: IoServer<ClientToServerEvents, ServerToClientEvents>;
  game: GameService;
  live: TikTokLiveService;
  registry: GiftRegistry;
  pipeline: LivePipeline;
  store: Store;
  auth: Auth;
  audio: AudioService;
  role(): 'leader' | 'standby' | 'starting' | 'stopped';
  start(): Promise<number>;
  stop(): Promise<void>;
}

export function createApp(deps: AppDeps): App {
  const { config, store, logger } = deps;
  const adminToken = config.ADMIN_TOKEN;
  if (!adminToken) throw new Error('ADMIN_TOKEN ausente.');
  const auth = createAuth(adminToken);
  const production = config.NODE_ENV === 'production';
  const testEnabled = deps.enableTestEvents ?? config.enableTestEvents;

  const engine = new GameEngine({}, { autoplay: config.autoplay });
  const game = new GameService(engine, store, logger.child({ c: 'game' }), { retentionDays: config.RETENTION_DAYS });
  const registry = new GiftRegistry(store);
  const pipeline = new LivePipeline(game, registry, store, logger.child({ c: 'pipeline' }), {
    hashSecret: config.hashSecret,
    maxLikesPerEvent: config.MAX_LIKES_PER_EVENT,
  });
  const live = new TikTokLiveService(
    pipeline, registry, store, logger.child({ c: 'tiktok' }),
    { factory: deps.connectionFactory, ...deps.liveOptions },
    config.TIKTOK_USERNAME ?? null,
  );

  const audio = new AudioService(
    store,
    config.AUDIO_STORAGE_DIR ? new FilesystemBlobStore(path.resolve(config.AUDIO_STORAGE_DIR)) : new DatabaseBlobStore(store),
    logger.child({ c: 'audio' }),
    { maxBytes: config.AUDIO_MAX_BYTES, musicMaxBytes: config.AUDIO_MUSIC_MAX_BYTES, maxClips: config.AUDIO_MAX_CLIPS },
  );

  let role: 'leader' | 'standby' | 'starting' | 'stopped' = 'starting';
  let leaderTimer: NodeJS.Timeout | null = null;
  const processed: PipelineSummary[] = [];
  const mismatches: Array<{ at: number; giftId: string; expectedCoins: number; receivedCoins: number }> = [];

  // ---------- HTTP ----------
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const isOriginAllowed = (origin: string | undefined, host: string | undefined, forwardedHost?: string | undefined): boolean => {
    if (!origin) return true;
    try {
      const url = new URL(origin);
      if (host && url.host === host) return true;
      // Atrás do proxy do Railway o host público pode chegar em X-Forwarded-Host.
      if (forwardedHost && url.host === forwardedHost.split(',')[0].trim()) return true;
      if (config.allowedOrigins.includes(origin)) return true;
      if (!production && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
    } catch { /* origem inválida */ }
    return false;
  };

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  });
  app.use(cors((req, callback) => {
    const origin = req.headers.origin;
    callback(null, { origin: isOriginAllowed(origin, req.headers.host, req.headers['x-forwarded-host'] as string | undefined) ? (origin ?? false) : false });
  }));
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', async (_req, res) => {
    const dbOk = await store.ping();
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      role: role,
      phase: role === 'leader' ? game.getState().phase : null,
      store: store.kind,
      uptime: Math.round(process.uptime()),
    });
  });

  // ---------- Admin REST ----------
  const adminLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false });
  const failedAuthLimiter = rateLimit({
    windowMs: 60_000, limit: 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
    // Só tentativas de autenticação recusadas (401) contam; 503/400 legítimos não bloqueiam o operador.
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    message: { error: 'too_many_attempts' },
  });
  const admin = express.Router();
  admin.use(failedAuthLimiter, adminLimiter, auth.middleware);

  const wrap = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
  const needLeader = (_req: Request, res: Response, next: NextFunction) => {
    if (role !== 'leader') {
      res.status(503).json({ error: 'standby', message: 'Esta instância não é a líder do jogo.' });
      return;
    }
    next();
  };

  admin.get('/session', (_req, res) => { res.json({ ok: true }); });

  const overview = async () => {
    const stats = await store.stats();
    const reasons = await store.ignoredReasons();
    const realFeed = processed.filter((item) => item.origin === 'real');
    return {
      server: { role, store: store.kind, env: config.NODE_ENV, uptime: Math.round(process.uptime()), autoplay: config.autoplay, testEvents: testEnabled },
      state: game.getState(),
      connection: live.getStatus(),
      slots: registry.view(),
      knownGifts: registry.known(),
      statsReal: stats.filter((row) => row.origin === 'real'),
      statsTest: stats.filter((row) => row.origin === 'test'),
      statsAuto: stats.filter((row) => row.origin === 'auto'),
      ignoredReal: reasons.filter((row) => row.origin === 'real'),
      lastRealEvent: realFeed[0] ?? null,
      recentReal: realFeed.slice(0, 30),
      recentTest: processed.filter((item) => item.origin === 'test').slice(0, 30),
      comments: live.getRecentComments().slice(-10),
      mismatches: mismatches.slice(0, 10),
    };
  };
  admin.get('/overview', needLeader, wrap(async (_req, res) => { res.json(await overview()); }));

  admin.post('/game/pause', needLeader, wrap(async (_req, res) => { res.json({ ok: await game.pause() }); }));
  admin.post('/game/resume', needLeader, wrap(async (_req, res) => { res.json({ ok: await game.resume() }); }));
  admin.post('/game/reset', needLeader, wrap(async (_req, res) => { await game.resetRound(); res.json({ ok: true }); }));
  const configSchema = z.object({
    target: z.number().int().min(10).max(100_000),
    durationSeconds: z.number().int().min(10).max(3_600),
    resultSeconds: z.number().int().min(3).max(60),
    autoSpeed: z.number().min(0.1).max(5),
    soundEnabled: z.boolean(),
    autoEnabled: z.boolean(),
    autoTeams: z.object({ lula: z.boolean(), bolsonaro: z.boolean() }).partial(),
    autoRestart: z.boolean(),
    likesPerBlock: z.number().int().min(1).max(10_000),
  }).partial().strict();
  admin.put('/game/config', needLeader, wrap(async (req, res) => {
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return; }
    res.json({ config: await game.updateConfig(parsed.data as Parameters<typeof game.updateConfig>[0]) });
  }));

  admin.put('/tiktok/username', wrap(async (req, res) => {
    const parsed = z.object({ username: z.string().max(40) }).safeParse(req.body);
    const clean = parsed.success ? sanitizeUsername(parsed.data.username) : null;
    if (!clean) { res.status(400).json({ error: 'invalid_username' }); return; }
    live.setUsername(clean);
    await store.setSetting(USERNAME_KEY, clean);
    res.json({ username: clean });
  }));
  admin.post('/tiktok/connect', needLeader, wrap(async (_req, res) => {
    void live.connect().catch((error) => logger.warn('connect manual falhou', { error }));
    res.status(202).json({ accepted: true });
  }));
  admin.post('/tiktok/disconnect', wrap(async (_req, res) => { await live.disconnect(); res.json({ ok: true }); }));
  admin.post('/tiktok/reconnect', needLeader, wrap(async (_req, res) => {
    void live.reconnect().catch((error) => logger.warn('reconnect manual falhou', { error }));
    res.status(202).json({ accepted: true });
  }));
  admin.post('/tiktok/refresh-gifts', needLeader, wrap(async (_req, res) => {
    try {
      res.json({ imported: await live.refreshGifts() });
    } catch (error) {
      logger.warn('falha ao atualizar presentes', { error });
      res.status(502).json({ error: 'gift_list_unavailable', message: 'Não foi possível obter a lista de presentes do TikTok agora.' });
    }
  }));

  const slotSchema = z.object({
    giftId: z.union([z.string().regex(/^\d{1,20}$/), z.null()]).optional(),
    blocks: z.number().int().min(1).max(5_000).optional(),
    active: z.boolean().optional(),
    allowManual: z.boolean().optional(),
  }).strict();
  admin.get('/gifts', needLeader, wrap(async (_req, res) => { res.json({ slots: registry.view(), known: registry.known() }); }));
  admin.put('/gifts/slots/:slotId', needLeader, wrap(async (req, res) => {
    const parsed = slotSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return; }
    try {
      res.json({ slot: await registry.assign(String(req.params.slotId), parsed.data) });
    } catch (error) {
      if (error instanceof GiftMappingError) { res.status(409).json({ error: 'mapping_rejected', message: error.message }); return; }
      throw error;
    }
  }));

  // ---- Simulações (sempre origem "test") ----
  const testGuard = (_req: Request, res: Response, next: NextFunction) => {
    if (!testEnabled) { res.status(403).json({ error: 'test_events_disabled' }); return; }
    next();
  };
  const testSession = () => `test-session`;
  const base = (userId = `test-${randomUUID()}`) => ({ msgId: `test-${randomUUID()}`, roomId: 'test-room', userId, userName: 'TESTE', at: Date.now() });
  const sendTest = (event: LiveEvent) => pipeline.handle(event, 'test', testSession());
  const giftEvent = (slotId: string, over: Partial<Extract<LiveEvent, { type: 'gift' }>> = {}): Extract<LiveEvent, { type: 'gift' }> => ({
    type: 'gift', ...base(), giftId: '', giftName: null, imageUrl: null, coins: null,
    streakable: false, repeatCount: 1, repeatEnd: false, groupId: '', slotId, ...over,
  });
  const slotIdSchema = z.string().refine((value) => GIFT_SLOTS.some((slot) => slot.slotId === value), 'slot inválido');

  const test = express.Router();
  test.use(needLeader, testGuard);
  test.post('/like', wrap(async (req, res) => {
    const { count } = z.object({ count: z.number().int().min(1).max(100).default(1) }).parse(req.body ?? {});
    res.json(await sendTest({ type: 'like', ...base(), count, total: null }));
  }));
  test.post('/follow', wrap(async (_req, res) => { res.json(await sendTest({ type: 'follow', via: 'follow', ...base() })); }));
  test.post('/gift', wrap(async (req, res) => {
    const { slotId, repeatCount } = z.object({ slotId: slotIdSchema, repeatCount: z.number().int().min(1).max(100).default(1) }).parse(req.body);
    res.json(await sendTest(giftEvent(slotId, { repeatCount })));
  }));
  test.post('/increment', wrap(async (req, res) => {
    const { team, amount } = z.object({ team: z.enum(['lula', 'bolsonaro']), amount: z.number().int().min(1).max(5_000) }).parse(req.body);
    res.json(await game.score({ dedupeKey: `test:manual:${randomUUID()}`, origin: 'test', kind: 'manual', team, amount }));
  }));
  /** Combo: repeatCount 1..N com o mesmo groupId e fechamento (repeatEnd). */
  test.post('/combo', wrap(async (req, res) => {
    const { slotId, total } = z.object({ slotId: slotIdSchema, total: z.number().int().min(1).max(50).default(5) }).parse(req.body);
    const user = `test-${randomUUID()}`;
    const groupId = `g-${randomUUID()}`;
    const outcomes = [];
    for (let count = 1; count <= total; count += 1) {
      outcomes.push(await sendTest(giftEvent(slotId, { ...base(user), streakable: true, groupId, repeatCount: count })));
    }
    outcomes.push(await sendTest(giftEvent(slotId, { ...base(user), streakable: true, groupId, repeatCount: total, repeatEnd: true })));
    const applied = outcomes.reduce((sum, item) => sum + (item.status === 'applied' ? item.event.amount : 0), 0);
    res.json({ applied, steps: outcomes.length });
  }));
  /** Combo com "queda e reconexão" no meio: reentrega de atualizações antigas não pode duplicar. */
  test.post('/reconnect', wrap(async (req, res) => {
    const { slotId } = z.object({ slotId: slotIdSchema }).parse(req.body);
    const user = `test-${randomUUID()}`;
    const groupId = `g-${randomUUID()}`;
    const step = (count: number, end = false) => sendTest(giftEvent(slotId, { ...base(user), streakable: true, groupId, repeatCount: count, repeatEnd: end }));
    const results = [];
    for (const count of [1, 2, 3]) results.push(await step(count));
    for (const count of [1, 2, 3]) results.push(await step(count)); // reentrega após reconexão
    for (const count of [4, 5]) results.push(await step(count));
    results.push(await step(5, true));
    const applied = results.reduce((sum, item) => sum + (item.status === 'applied' ? item.event.amount : 0), 0);
    const blocks = registry.resolveSlot(slotId)?.mapping.blocks ?? 0;
    res.json({ applied, expected: blocks * 5, ok: applied === blocks * 5 });
  }));
  /** Eventos simultâneos para as duas equipes. */
  test.post('/burst', wrap(async (req, res) => {
    const { size } = z.object({ size: z.number().int().min(2).max(40).default(10) }).parse(req.body ?? {});
    const tasks: Array<Promise<unknown>> = [];
    for (let index = 0; index < size; index += 1) {
      const slot = GIFT_SLOTS[index % GIFT_SLOTS.length];
      if (index % 3 === 0) tasks.push(sendTest({ type: 'like', ...base(), count: 1, total: null }));
      else if (index % 3 === 1) tasks.push(sendTest({ type: 'follow', via: 'follow', ...base() }));
      else tasks.push(sendTest(giftEvent(slot.slotId)));
    }
    await Promise.all(tasks);
    res.json({ sent: size });
  }));
  admin.use('/test', test);

  admin.get('/events', needLeader, wrap(async (req, res) => {
    const origin = z.enum(['real', 'test', 'auto', 'all']).default('real').parse(req.query.origin);
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
    // Nunca devolve hashes de usuário.
    const rows = (await store.recentEvents(origin, limit)).map(({ userHash: _hash, ...rest }) => rest);
    res.json({ origin, events: rows });
  }));


  // ---- Sons e bordões (somente administradores) ----
  const rawAudio = express.raw({ type: () => true, limit: Math.max(config.AUDIO_MAX_BYTES, config.AUDIO_MUSIC_MAX_BYTES) });
  const uploadQuery = z.object({
    name: z.string().min(1).max(60),
    category: z.enum(AUDIO_CATEGORIES as [string, ...string[]]),
    team: z.enum(AUDIO_TEAMS as [string, ...string[]]),
    volume: z.coerce.number().min(0).max(1).optional(),
    durationMs: z.coerce.number().int().min(1).max(3_600_000).optional(),
    credit: z.string().max(200).optional(),
  });
  const audioError = (res: Response, error: unknown): boolean => {
    if (error instanceof AudioValidationError) { res.status(400).json({ error: 'invalid_audio', message: error.message }); return true; }
    return false;
  };
  admin.get('/audio', needLeader, (_req, res) => {
    res.json({
      clips: audio.listClips(),
      config: audio.getConfig(),
      diagnostics: audio.diagnostics(),
      storage: audio.storageKind,
      limits: { maxBytes: config.AUDIO_MAX_BYTES, musicMaxBytes: config.AUDIO_MUSIC_MAX_BYTES, maxClips: config.AUDIO_MAX_CLIPS, formats: ['mp3', 'wav', 'ogg'] },
      eventKeys: AUDIO_EVENT_KEYS,
      slots: GIFT_SLOTS.map((slot) => ({ key: `gift:${slot.team}:${slot.visualId}`, team: slot.team, label: slot.label, visualId: slot.visualId, blocks: slot.defaultBlocks })),
      defaultCooldowns: Object.fromEntries(ALL_BINDING_KEYS.map((key) => [key, defaultCooldown(key)])),
    });
  });
  admin.post('/audio', needLeader, rawAudio, wrap(async (req, res) => {
    const query = uploadQuery.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: 'invalid_query', issues: query.error.issues }); return; }
    if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'invalid_audio', message: 'Envie o arquivo no corpo da requisição.' }); return; }
    try {
      const clip = await audio.upload({
        data: req.body, name: query.data.name, category: query.data.category as never, team: query.data.team as never,
        volume: query.data.volume, clientDurationMs: query.data.durationMs, credit: query.data.credit,
      });
      res.status(201).json({ clip });
    } catch (error) {
      if (!audioError(res, error)) throw error;
    }
  }));
  const bindingSchema = z.object({
    clipIds: z.array(z.string().uuid()).max(30),
    mode: z.enum(['random', 'sequential']),
    enabled: z.boolean(),
    cooldownMs: z.number().int().min(0).max(600_000),
  }).strict();
  const audioConfigSchema = z.object({
    masterVolume: z.number().min(0).max(1),
    builtinEffects: z.boolean(),
    maxConcurrent: z.number().int().min(1).max(6),
    minVoiceGapMs: z.number().int().min(0).max(60_000),
    bindings: z.record(z.string(), bindingSchema).refine((value) => Object.keys(value).every((key) => (ALL_BINDING_KEYS as string[]).includes(key)), 'gatilho desconhecido'),
    music: z.object({
      enabled: z.boolean(),
      clipIds: z.array(z.string().uuid()).max(50),
      mode: z.enum(['sequential', 'shuffle']),
      volume: z.number().min(0).max(1),
      duck: z.number().min(0).max(1),
      onlyDuringMatch: z.boolean(),
    }).partial().strict(),
    randomBordoes: z.object({
      enabled: z.boolean(),
      intervalSeconds: z.number().int().min(10).max(3_600),
      jitterPercent: z.number().int().min(0).max(90),
      clipIds: z.array(z.string().uuid()).max(50),
    }).partial().strict(),
  }).partial().strict();
  admin.put('/audio/config', needLeader, wrap(async (req, res) => {
    const parsed = audioConfigSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return; }
    try {
      res.json({ config: await audio.updateConfig(parsed.data as never) });
    } catch (error) {
      if (!audioError(res, error)) throw error;
    }
  }));
  admin.post('/audio/play', needLeader, wrap(async (req, res) => {
    const { clipId } = z.object({ clipId: z.string().uuid() }).parse(req.body);
    try {
      res.json({ command: audio.playManual(clipId) });
    } catch (error) {
      if (!audioError(res, error)) throw error;
    }
  }));
  admin.post('/audio/stop', needLeader, (_req, res) => { audio.stopAll(); res.json({ ok: true }); });
  /** Dispara um gatilho como se o evento tivesse acontecido (sem mexer no placar). */
  admin.post('/audio/trigger', needLeader, wrap(async (req, res) => {
    const { key } = z.object({ key: z.string().refine((value) => (ALL_BINDING_KEYS as string[]).includes(value), 'gatilho desconhecido') }).parse(req.body);
    const command = audio.trigger(key as AudioBindingKey, { force: true });
    res.json({ command, message: command ? undefined : 'Gatilho sem áudio ativo vinculado.' });
  }));
  admin.post('/audio/music/next', needLeader, (_req, res) => { audio.nextTrack(); res.json({ ok: true }); });
  admin.post('/audio/random', needLeader, (_req, res) => {
    const command = audio.playRandom();
    res.json({ command, message: command ? undefined : 'Nenhum bordão aleatório disponível agora (lista vazia ou intervalo mínimo entre bordões).' });
  });
  admin.get('/audio/:id/file', needLeader, wrap(async (req, res) => {
    const file = await audio.getFile(String(req.params.id), { includeInactive: true });
    if (!file) { res.status(404).json({ error: 'not_found' }); return; }
    res.setHeader('Content-Type', file.clip.mime);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.data);
  }));
  admin.put('/audio/:id', needLeader, wrap(async (req, res) => {
    const patch = z.object({
      name: z.string().min(1).max(60),
      category: z.enum(AUDIO_CATEGORIES as [string, ...string[]]),
      team: z.enum(AUDIO_TEAMS as [string, ...string[]]),
      volume: z.number().min(0).max(1),
      active: z.boolean(),
      credit: z.string().max(200).nullable(),
    }).partial().strict().safeParse(req.body);
    if (!patch.success) { res.status(400).json({ error: 'invalid_body', issues: patch.error.issues }); return; }
    try {
      res.json({ clip: await audio.updateClip(String(req.params.id), patch.data as never) });
    } catch (error) {
      if (!audioError(res, error)) throw error;
    }
  }));
  admin.put('/audio/:id/file', needLeader, rawAudio, wrap(async (req, res) => {
    const duration = z.coerce.number().int().min(1).max(3_600_000).optional().safeParse(req.query.durationMs);
    if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'invalid_audio', message: 'Envie o arquivo no corpo da requisição.' }); return; }
    try {
      res.json({ clip: await audio.replaceFile(String(req.params.id), req.body, duration.success ? duration.data : undefined) });
    } catch (error) {
      if (!audioError(res, error)) throw error;
    }
  }));
  admin.delete('/audio/:id', needLeader, wrap(async (req, res) => {
    try {
      await audio.deleteClip(String(req.params.id));
      res.json({ ok: true });
    } catch (error) {
      if (!audioError(res, error)) throw error;
    }
  }));

  app.use('/api/admin', admin);
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'not_found' }); });

  // Arquivos de áudio para o overlay: somente leitura, somente áudios ATIVOS.
  app.get('/audio/:id', wrap(async (req, res) => {
    if (role !== 'leader') { res.status(503).end(); return; }
    const id = String(req.params.id);
    if (!/^[a-f0-9-]{36}$/.test(id)) { res.status(404).end(); return; }
    const file = await audio.getFile(id, { includeInactive: false });
    if (!file) { res.status(404).end(); return; }
    const etag = `"${file.clip.sha256.slice(0, 32)}"`;
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.setHeader('Content-Type', file.clip.mime);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(file.data);
  }));

  if (deps.staticDir) {
    const dist = path.resolve(deps.staticDir);
    // index.html nunca em cache: um deploy novo precisa chegar ao LIVE Studio.
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/assets/') && !req.path.startsWith('/audio/')) res.setHeader('Cache-Control', 'no-cache');
      next();
    });
    app.use(express.static(dist, { index: false }));
    app.get('*path', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_body', issues: error.issues }); return; }
    const type = (error as { type?: string })?.type;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: 'too_large', message: `Arquivo maior que o limite de ${Math.round(Math.max(config.AUDIO_MAX_BYTES, config.AUDIO_MUSIC_MAX_BYTES) / 1024 / 1024)} MB.` });
      return;
    }
    if (type === 'entity.parse.failed') { res.status(400).json({ error: 'invalid_body' }); return; }
    logger.error('erro não tratado na requisição', { error });
    void store.logError('http', String((error as Error)?.message ?? error)).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  // Script principal publicado (muda a cada build): o overlay compara e se recarrega.
  let buildScript: string | null = null;
  if (deps.staticDir) {
    try {
      const html = readFileSync(path.join(path.resolve(deps.staticDir), 'index.html'), 'utf8');
      buildScript = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1] ?? null;
    } catch { buildScript = null; }
  }

  // ---------- Socket.IO ----------
  const httpServer = createServer(app);
  const allowRequest = (req: { headers: Record<string, string | string[] | undefined> }, cb: (err: string | null | undefined, ok: boolean) => void) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
    const forwarded = typeof req.headers['x-forwarded-host'] === 'string' ? req.headers['x-forwarded-host'] : undefined;
    cb(null, isOriginAllowed(origin, host, forwarded));
  };
  const io = new IoServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    allowRequest,
    maxHttpBufferSize: 10_000,
    pingInterval: 10_000,
    pingTimeout: 10_000,
  });

  // Canal público: somente leitura. Nenhum evento do cliente altera o jogo.
  const reportSchema = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('status'),
      clientId: z.string().min(4).max(64),
      page: z.enum(['overlay', 'diagnostico']),
      engine: z.enum(['unsupported', 'locked', 'running', 'suspended', 'error']),
      loaded: z.number().int().min(0).max(10_000),
      total: z.number().int().min(0).max(10_000),
      failedLoads: z.array(z.string().max(80)).max(50),
      playing: z.number().int().min(0).max(100),
      queued: z.number().int().min(0).max(100),
      lastError: z.string().max(240).nullable(),
      masterVolume: z.number().min(0).max(1),
      userAgent: z.string().max(240),
      music: z.object({
        state: z.enum(['off', 'playing', 'paused', 'waiting', 'blocked', 'error']),
        track: z.string().max(80).nullable(),
        volume: z.number().min(0).max(1),
        credit: z.string().max(200).nullable().optional(),
      }).strict().optional(),
    }).strict(),
    z.object({
      type: z.literal('ack'),
      clientId: z.string().min(4).max(64),
      playId: z.string().max(64),
      status: z.enum(['played', 'failed', 'dropped', 'blocked']),
      error: z.string().max(240).optional(),
    }).strict(),
  ]);

  io.on('connection', (socket) => {
    socket.emit('build', { script: buildScript });
    if (role === 'leader') {
      socket.emit('state', game.getState());
      socket.emit('audio:manifest', audio.manifest());
    }
    // Telemetria de áudio: apenas diagnóstico, validada e limitada por conexão.
    let reportWindow = Date.now();
    let reportCount = 0;
    socket.on('audio:report', (payload: AudioReport) => {
      const now = Date.now();
      if (now - reportWindow > 10_000) { reportWindow = now; reportCount = 0; }
      if (++reportCount > 40 || role !== 'leader') return;
      const parsed = reportSchema.safeParse(payload);
      if (parsed.success) audio.report(socket.id, parsed.data as AudioReport);
    });
    socket.on('disconnect', () => audio.disconnectClient(socket.id));
    let lastSync = 0;
    socket.on('sync', () => {
      const now = Date.now();
      if (now - lastSync < 1_000 || role !== 'leader') return;
      lastSync = now;
      socket.emit('state', game.getState());
    });
  });
  game.on('state', (state) => io.emit('state', state));
  game.on('increment', (event) => io.emit('increment', event));
  game.on('roundStarted', (state) => io.emit('roundStarted', state));
  game.on('roundEnded', (state) => io.emit('roundEnded', state));
  audio.on('play', (command) => io.emit('audio:play', command));
  audio.on('stop', () => io.emit('audio:stop'));
  audio.on('music', (command: { action: 'next' }) => io.emit('audio:music', command));
  audio.on('manifest', () => io.emit('audio:manifest', audio.manifest()));

  // Canal administrativo (namespace autenticado): status e feed de eventos em tempo real.
  const adminIo = io.of('/admin') as unknown as Namespace;
  adminIo.use((socket, next) => {
    if (auth.verify(auth.fromHandshake(socket.handshake.auth))) next();
    else next(new Error('unauthorized'));
  });
  live.on('status', (status) => adminIo.emit('connectionStatus', status));
  live.on('giftsUpdated', () => adminIo.emit('giftsUpdated'));
  pipeline.on('processed', (summary: PipelineSummary) => {
    processed.unshift(summary);
    if (processed.length > RECENT_PROCESSED * 2) processed.length = RECENT_PROCESSED * 2;
    adminIo.emit('processed', summary);
  });
  pipeline.on('unknownGift', (gift) => adminIo.emit('unknownGift', gift));
  let diagnosticsTimer: NodeJS.Timeout | null = null;
  audio.on('diagnostics', () => {
    if (diagnosticsTimer) return;
    diagnosticsTimer = setTimeout(() => { diagnosticsTimer = null; adminIo.emit('audioDiagnostics'); }, 500);
    diagnosticsTimer.unref?.();
  });
  audio.on('play', (command) => adminIo.emit('audioPlayed', command));
  pipeline.on('metadataMismatch', (item) => {
    mismatches.unshift({ at: Date.now(), ...item });
    if (mismatches.length > 20) mismatches.length = 20;
  });

  // ---------- Ciclo de vida ----------
  async function becomeLeader(): Promise<void> {
    await registry.init();
    if (config.GIFT_SEED) {
      try {
        const seeded = await registry.applySeed();
        if (!seeded.alreadyApplied) logger.info('mapeamento inicial de presentes aplicado', { applied: seeded.applied.length, skipped: seeded.skipped.length });
      } catch (error) {
        logger.warn('não foi possível aplicar o mapeamento inicial', { error });
      }
    }
    await game.init();
    await audio.init();
    audio.attach(game);
    const saved = await store.getSetting<string>(USERNAME_KEY);
    let username = saved ?? config.TIKTOK_USERNAME ?? null;
    if (username) {
      try {
        live.setUsername(username);
      } catch {
        // Usuário inválido não pode impedir o jogo de rodar; o operador corrige no painel.
        logger.warn('TIKTOK_USERNAME inválido; o jogo inicia sem conexão com a LIVE');
        username = null;
      }
    }
    role = 'leader';
    game.start();
    logger.info('instância líder: motor do jogo ativo');
    if (username && config.TIKTOK_AUTOCONNECT) {
      void live.connect().catch((error) => logger.warn('conexão automática falhou', { error }));
    }
  }

  async function tryLead(): Promise<void> {
    try {
      if (await store.acquireLeadership()) {
        if (leaderTimer) clearInterval(leaderTimer);
        leaderTimer = null;
        await becomeLeader();
      } else if (role !== 'standby') {
        role = 'standby';
        logger.warn('outra instância detém a liderança; aguardando (não consome a LIVE nem roda rodadas)');
      }
    } catch (error) {
      logger.error('falha ao obter liderança', { error });
    }
  }

  return {
    httpServer, io, game, live, registry, pipeline, store, auth, audio,
    role: () => role,
    async start() {
      await store.init();
      await new Promise<void>((resolve) => httpServer.listen(config.PORT, config.HOST, resolve));
      await tryLead();
      if (role !== 'leader') {
        leaderTimer = setInterval(() => void tryLead(), deps.leaderRetryMs ?? 5_000);
        leaderTimer.unref?.();
      }
      const address = httpServer.address();
      return typeof address === 'object' && address ? address.port : config.PORT;
    },
    async stop() {
      if (leaderTimer) clearInterval(leaderTimer);
      leaderTimer = null;
      role = 'stopped';
      audio.detach();
      await live.disconnect().catch(() => {});
      await game.stop().catch(() => {});
      await new Promise<void>((resolve) => { io.close(() => resolve()); });
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await store.releaseLeadership().catch(() => {});
      await store.close().catch(() => {});
    },
  };
}

export { normalizeConfig };
