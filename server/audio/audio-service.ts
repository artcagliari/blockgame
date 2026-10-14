import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  AUDIO_EVENT_KEYS,
  type AudioBinding,
  type AudioBindingKey,
  type AudioCategory,
  type AudioChannel,
  type AudioClipInfo,
  type AudioConfig,
  type AudioManifest,
  type AudioPlayCommand,
  type AudioReport,
  type AudioTeam,
  type GameState,
  type MusicSettings,
  type IncrementEvent,
} from '../../src/game/types.js';
import type { GameService } from '../game-service.js';
import { GIFT_SLOTS } from '../gift-slots.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/types.js';
import type { AudioBlobStore } from './blob-store.js';
import { probeAudio } from './probe.js';

export const AUDIO_CONFIG_KEY = 'audio.config';
export const AUDIO_CATEGORIES: AudioCategory[] = ['bordao', 'comemoracao', 'efeito', 'vinheta', 'musica'];
export const AUDIO_TEAMS: AudioTeam[] = ['lula', 'bolsonaro', 'geral'];
export const GIFT_BINDING_KEYS = GIFT_SLOTS.map((slot) => `gift:${slot.team}:${slot.visualId}` as AudioBindingKey);
export const ALL_BINDING_KEYS: AudioBindingKey[] = [...AUDIO_EVENT_KEYS, ...GIFT_BINDING_KEYS];

/** Cooldown padrão por gatilho: evita um som novo a cada curtida em rajada. */
const DEFAULT_COOLDOWN: Partial<Record<AudioBindingKey, number>> = {
  'event:like': 5_000,
  'event:follow': 2_000,
  'event:gift': 2_000,
  'event:combo': 3_000,
  'event:blocks': 1_500,
  'event:leadChange': 4_000,
};
const GIFT_COOLDOWN = 2_500;
const MAX_DIAGNOSTIC_DISPATCHES = 40;
const STALE_CLIENT_MS = 120_000;

export function priorityFor(key: AudioPlayCommand['key']): number {
  if (key === 'event:victory:lula' || key === 'event:victory:bolsonaro' || key === 'event:draw') return 100;
  if (key === 'manual') return 95;
  if (key.startsWith('gift:')) return /recuperacao|ultra-turbo/.test(key) ? 90 : 70;
  switch (key) {
    case 'event:gift': return 70;
    case 'event:combo': return 65;
    case 'event:roundStart': return 60;
    case 'event:leadChange': return 55;
    case 'event:countdown': return 50;
    case 'event:follow': return 40;
    case 'event:like': return 20;
    case 'random': return 15;
    case 'event:blocks': return 10;
    default: return 50;
  }
}

export function channelFor(category: AudioCategory): AudioChannel {
  if (category === 'musica') return 'music';
  return category === 'bordao' || category === 'comemoracao' ? 'voice' : 'sfx';
}

export function defaultMusic(): MusicSettings {
  return { enabled: false, clipIds: [], mode: 'shuffle', volume: 0.35, duck: 0.35, onlyDuringMatch: false };
}

export function defaultAudioConfig(): AudioConfig {
  return {
    masterVolume: 0.9,
    builtinEffects: true,
    maxConcurrent: 3,
    minVoiceGapMs: 1_500,
    bindings: {},
    randomBordoes: { enabled: false, intervalSeconds: 45, jitterPercent: 30, clipIds: [] },
    music: defaultMusic(),
  };
}

export class AudioValidationError extends Error {}

export interface UploadInput {
  data: Buffer;
  name: string;
  category: AudioCategory;
  team: AudioTeam;
  volume?: number;
  /** Duração medida pelo navegador (usada só quando o servidor não consegue calcular). */
  clientDurationMs?: number | null;
}

interface DiagnosticClient {
  clientId: string;
  socketId: string;
  lastSeen: number;
  status: Extract<AudioReport, { type: 'status' }> | null;
}

interface DispatchRecord {
  command: AudioPlayCommand;
  clipName: string;
  acks: Record<string, { status: string; error?: string; at: number }>;
}

export interface AudioServiceOptions {
  maxBytes: number;
  maxClips: number;
  maxDurationMs?: number;
  /** Limites próprios da música de fundo (faixas longas). */
  musicMaxBytes?: number;
  musicMaxDurationMs?: number;
  clock?: () => number;
  random?: () => number;
}

/**
 * Decide QUANDO e O QUE tocar; quem reproduz é o overlay (Socket.IO).
 * O servidor do Railway nunca reproduz áudio.
 */
export class AudioService extends EventEmitter {
  private clips = new Map<string, AudioClipInfo>();
  private config: AudioConfig = defaultAudioConfig();
  private lastPlayed = new Map<string, number>();
  private lastClip = new Map<string, string>();
  private sequence = new Map<string, number>();
  private lastVoiceAt = 0;
  private randomTimer: NodeJS.Timeout | null = null;
  private countdownRound = -1;
  private leader: { roundId: number; team: 'lula' | 'bolsonaro' | null } = { roundId: -1, team: null };
  private manifestVersion = 0;
  private clients = new Map<string, DiagnosticClient>();
  private dispatches: DispatchRecord[] = [];
  private listening = false;
  private readonly clock: () => number;
  private readonly random: () => number;

  constructor(
    private readonly store: Store,
    private readonly blobs: AudioBlobStore,
    private readonly logger: Logger,
    private readonly options: AudioServiceOptions,
  ) {
    super();
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async init(): Promise<void> {
    for (const clip of await this.store.listAudioClips()) this.clips.set(clip.id, clip);
    const saved = await this.store.getSetting<AudioConfig>(AUDIO_CONFIG_KEY);
    this.config = this.normalize(saved ?? defaultAudioConfig());
    this.manifestVersion = this.clock();
  }

  get storageKind() {
    return this.blobs.kind;
  }

  // ------------------------------------------------------------------ biblioteca

  listClips(): AudioClipInfo[] {
    return [...this.clips.values()].sort((a, b) => a.createdAt - b.createdAt).map((clip) => ({ ...clip }));
  }

  async upload(input: UploadInput): Promise<AudioClipInfo> {
    if (this.clips.size >= this.options.maxClips) throw new AudioValidationError(`Limite de ${this.options.maxClips} áudios atingido.`);
    const meta = this.validateFile(input.data, input.clientDurationMs, input.category);
    const now = this.clock();
    const clip: AudioClipInfo = {
      id: randomUUID(),
      name: cleanName(input.name),
      category: input.category,
      team: input.team,
      mime: meta.mime,
      sizeBytes: input.data.length,
      durationMs: meta.durationMs,
      volume: clampVolume(input.volume ?? 1),
      active: true,
      sha256: meta.sha256,
      createdAt: now,
      updatedAt: now,
    };
    await this.blobs.put(clip.id, input.data);
    try {
      await this.store.saveAudioClip(clip);
    } catch (error) {
      await this.blobs.delete(clip.id).catch(() => {});
      throw error;
    }
    this.clips.set(clip.id, clip);
    this.logger.info('áudio enviado', { id: clip.id, mime: clip.mime, bytes: clip.sizeBytes });
    this.publishManifest();
    return { ...clip };
  }

  async replaceFile(id: string, data: Buffer, clientDurationMs?: number | null): Promise<AudioClipInfo> {
    const current = this.requireClip(id);
    const meta = this.validateFile(data, clientDurationMs, current.category);
    await this.blobs.put(id, data);
    const next: AudioClipInfo = { ...current, mime: meta.mime, sizeBytes: data.length, durationMs: meta.durationMs, sha256: meta.sha256, updatedAt: this.clock() };
    await this.store.saveAudioClip(next);
    this.clips.set(id, next);
    this.publishManifest();
    return { ...next };
  }

  async updateClip(id: string, patch: Partial<Pick<AudioClipInfo, 'name' | 'category' | 'team' | 'volume' | 'active'>>): Promise<AudioClipInfo> {
    const current = this.requireClip(id);
    if (patch.category && patch.category !== current.category && current.category === 'musica') {
      const limit = this.options.maxDurationMs ?? 120_000;
      if ((current.durationMs ?? 0) > limit || current.sizeBytes > this.options.maxBytes) {
        throw new AudioValidationError('Esta faixa é longa demais para ser bordão ou efeito.');
      }
    }
    const next: AudioClipInfo = {
      ...current,
      name: patch.name !== undefined ? cleanName(patch.name) : current.name,
      category: patch.category ?? current.category,
      team: patch.team ?? current.team,
      volume: patch.volume !== undefined ? clampVolume(patch.volume) : current.volume,
      active: patch.active ?? current.active,
      updatedAt: this.clock(),
    };
    await this.store.saveAudioClip(next);
    this.clips.set(id, next);
    this.publishManifest();
    return { ...next };
  }

  async deleteClip(id: string): Promise<void> {
    this.requireClip(id);
    await this.store.deleteAudioClip(id);
    await this.blobs.delete(id).catch(() => {});
    this.clips.delete(id);
    // Remove o áudio de todos os vínculos para não sobrar referência quebrada.
    const bindings: AudioConfig['bindings'] = {};
    for (const [key, binding] of Object.entries(this.config.bindings) as Array<[AudioBindingKey, AudioBinding]>) {
      bindings[key] = { ...binding, clipIds: binding.clipIds.filter((clipId) => clipId !== id) };
    }
    this.config = {
      ...this.config,
      bindings,
      randomBordoes: { ...this.config.randomBordoes, clipIds: this.config.randomBordoes.clipIds.filter((clipId) => clipId !== id) },
      music: { ...this.config.music, clipIds: this.config.music.clipIds.filter((clipId) => clipId !== id) },
    };
    await this.store.setSetting(AUDIO_CONFIG_KEY, this.config);
    this.publishManifest();
  }

  /** Arquivo para o overlay (somente ativos) ou para a prévia do administrador. */
  async getFile(id: string, options: { includeInactive: boolean }): Promise<{ data: Buffer; clip: AudioClipInfo } | null> {
    const clip = this.clips.get(id);
    if (!clip || (!clip.active && !options.includeInactive)) return null;
    const data = await this.blobs.get(id);
    return data ? { data, clip: { ...clip } } : null;
  }

  // ------------------------------------------------------------------ configuração

  getConfig(): AudioConfig {
    return structuredClone(this.config);
  }

  async updateConfig(patch: Partial<AudioConfig>): Promise<AudioConfig> {
    const merged: AudioConfig = {
      ...this.config,
      ...patch,
      bindings: { ...this.config.bindings, ...(patch.bindings ?? {}) },
      randomBordoes: { ...this.config.randomBordoes, ...(patch.randomBordoes ?? {}) },
      music: { ...this.config.music, ...(patch.music ?? {}) },
    };
    for (const clipId of merged.music.clipIds) {
      const clip = this.clips.get(clipId);
      if (!clip) throw new AudioValidationError(`Faixa inexistente na música de fundo: ${clipId}`);
      if (clip.category !== 'musica') throw new AudioValidationError(`“${clip.name}” não é da categoria Música de fundo.`);
    }
    for (const binding of Object.values(merged.bindings)) {
      for (const clipId of binding?.clipIds ?? []) {
        if (!this.clips.has(clipId)) throw new AudioValidationError(`Áudio inexistente no vínculo: ${clipId}`);
        if (this.clips.get(clipId)?.category === 'musica') throw new AudioValidationError('Música de fundo não pode ser usada como bordão ou efeito.');
      }
    }
    for (const clipId of merged.randomBordoes.clipIds) {
      if (!this.clips.has(clipId)) throw new AudioValidationError(`Áudio inexistente nos bordões aleatórios: ${clipId}`);
    }
    this.config = this.normalize(merged);
    await this.store.setSetting(AUDIO_CONFIG_KEY, this.config);
    this.publishManifest();
    if (this.listening) this.scheduleRandom();
    return this.getConfig();
  }

  manifest(baseUrl = ''): AudioManifest {
    return {
      clips: this.listClips()
        .filter((clip) => clip.active && clip.category !== 'musica')
        .map((clip) => ({ id: clip.id, url: this.clipUrl(clip, baseUrl), volume: clip.volume, channel: channelFor(clip.category), durationMs: clip.durationMs, name: clip.name })),
      masterVolume: this.config.masterVolume,
      builtinEffects: this.config.builtinEffects,
      maxConcurrent: this.config.maxConcurrent,
      minVoiceGapMs: this.config.minVoiceGapMs,
      music: {
        ...this.config.music,
        tracks: this.config.music.clipIds
          .map((id) => this.clips.get(id))
          .filter((clip): clip is AudioClipInfo => Boolean(clip?.active))
          .map((clip) => ({ id: clip.id, url: this.clipUrl(clip, baseUrl), name: clip.name })),
      },
      version: this.manifestVersion,
    };
  }

  // ------------------------------------------------------------------ disparos

  /** Gatilho de evento: respeita vínculo ativo, cooldown e seleção aleatória/sequencial. */
  trigger(key: AudioBindingKey, options: { force?: boolean } = {}): AudioPlayCommand | null {
    const binding = this.config.bindings[key];
    if (!binding || !binding.enabled) return null;
    const candidates = binding.clipIds.filter((id) => this.clips.get(id)?.active && this.clips.get(id)?.category !== 'musica');
    if (candidates.length === 0) return null;
    const now = this.clock();
    if (!options.force && now - (this.lastPlayed.get(key) ?? 0) < binding.cooldownMs) return null;
    const clipId = this.pick(key, candidates, binding.mode);
    this.lastPlayed.set(key, now);
    return this.dispatch(clipId, key);
  }

  playManual(clipId: string): AudioPlayCommand {
    const clip = this.requireClip(clipId);
    if (!clip.active) throw new AudioValidationError('Áudio desativado. Ative-o antes de reproduzir na LIVE.');
    if (clip.category === 'musica') throw new AudioValidationError('Música de fundo é controlada pela seção Música de fundo.');
    return this.dispatch(clipId, 'manual');
  }

  stopAll(): void {
    this.emit('stop');
    this.logger.info('áudio interrompido pelo administrador');
  }

  /** Pula para a próxima faixa em todos os overlays. */
  nextTrack(): void {
    this.emit('music', { action: 'next' });
  }

  /** Um bordão aleatório (usado pelo temporizador). */
  playRandom(): AudioPlayCommand | null {
    const { randomBordoes, minVoiceGapMs } = this.config;
    const candidates = randomBordoes.clipIds.filter((id) => this.clips.get(id)?.active && this.clips.get(id)?.category !== 'musica');
    if (candidates.length === 0) return null;
    if (this.clock() - this.lastVoiceAt < Math.max(minVoiceGapMs, 3_000)) return null;
    return this.dispatch(this.pick('random', candidates, 'random'), 'random');
  }

  // ------------------------------------------------------------------ automação

  /** Liga os gatilhos aos eventos oficiais do jogo. */
  attach(game: GameService): void {
    if (this.listening) return;
    this.listening = true;
    game.on('increment', (event: IncrementEvent) => this.onIncrement(event));
    game.on('state', (state: GameState) => this.onState(state));
    game.on('roundStarted', (state: GameState) => {
      this.leader = { roundId: state.roundId, team: null };
      this.trigger('event:roundStart');
    });
    game.on('roundEnded', (state: GameState) => {
      if (state.winner === 'lula') this.trigger('event:victory:lula', { force: true });
      else if (state.winner === 'bolsonaro') this.trigger('event:victory:bolsonaro', { force: true });
      else if (state.winner === 'draw') this.trigger('event:draw', { force: true });
    });
    this.isMatchRunning = () => {
      const state = game.getState();
      return state.phase === 'playing' && state.startedAt !== null;
    };
    this.scheduleRandom();
  }

  detach(): void {
    this.listening = false;
    if (this.randomTimer) clearTimeout(this.randomTimer);
    this.randomTimer = null;
  }

  private isMatchRunning: () => boolean = () => false;

  private onIncrement(event: IncrementEvent): void {
    if (event.kind === 'like') this.trigger('event:like');
    else if (event.kind === 'follow') this.trigger('event:follow');
    else if (event.kind === 'gift') {
      const key = `gift:${event.team}:${event.giftId ?? ''}` as AudioBindingKey;
      const played = event.giftId ? this.trigger(key) : null;
      if (!played) this.trigger('event:gift');
      if ((event.count ?? 1) > 1) this.trigger('event:combo');
    }
    this.trigger('event:blocks');
  }

  private onState(state: GameState): void {
    // Virada na liderança (empate não é virada; a primeira liderança da rodada também não).
    const { lula, bolsonaro } = state.teams;
    const current = lula.score === bolsonaro.score ? null : lula.score > bolsonaro.score ? 'lula' : 'bolsonaro';
    if (this.leader.roundId !== state.roundId) this.leader = { roundId: state.roundId, team: current };
    else if (current && this.leader.team && current !== this.leader.team && state.phase === 'playing') this.trigger('event:leadChange');
    if (current) this.leader.team = current;

    // Últimos 10 segundos: uma vez por rodada.
    if (state.phase === 'playing' && state.startedAt !== null && this.countdownRound !== state.roundId) {
      const elapsed = state.serverNow - state.startedAt - state.pauseAccumulatedMs;
      const remaining = state.config.durationSeconds * 1_000 - elapsed;
      if (remaining > 0 && remaining <= 10_000) {
        this.countdownRound = state.roundId;
        this.trigger('event:countdown', { force: true });
      }
    }
  }

  private scheduleRandom(): void {
    if (this.randomTimer) clearTimeout(this.randomTimer);
    this.randomTimer = null;
    const { enabled, intervalSeconds, jitterPercent } = this.config.randomBordoes;
    if (!enabled || !this.listening) return;
    const base = intervalSeconds * 1_000;
    const jitter = base * (jitterPercent / 100) * (this.random() * 2 - 1);
    this.randomTimer = setTimeout(() => {
      this.randomTimer = null;
      if (this.isMatchRunning()) this.playRandom();
      this.scheduleRandom();
    }, Math.max(5_000, Math.round(base + jitter)));
    this.randomTimer.unref?.();
  }

  // ------------------------------------------------------------------ diagnóstico

  report(socketId: string, report: AudioReport): void {
    const now = this.clock();
    const client = this.clients.get(report.clientId) ?? { clientId: report.clientId, socketId, lastSeen: now, status: null };
    client.lastSeen = now;
    client.socketId = socketId;
    if (report.type === 'status') client.status = report;
    else {
      const record = this.dispatches.find((item) => item.command.playId === report.playId);
      if (record) record.acks[report.clientId] = { status: report.status, error: report.error, at: now };
    }
    this.clients.set(report.clientId, client);
    if (this.clients.size > 50) {
      const oldest = [...this.clients.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      this.clients.delete(oldest.clientId);
    }
    this.emit('diagnostics');
  }

  disconnectClient(socketId: string): void {
    for (const client of this.clients.values()) if (client.socketId === socketId) client.lastSeen = Math.min(client.lastSeen, this.clock() - STALE_CLIENT_MS + 10_000);
  }

  diagnostics() {
    const now = this.clock();
    return {
      storage: this.blobs.kind,
      overlays: [...this.clients.values()]
        .filter((client) => now - client.lastSeen < STALE_CLIENT_MS)
        .map((client) => ({ ...client, ageMs: now - client.lastSeen })),
      dispatches: this.dispatches.slice(0, 20).map((item) => ({
        playId: item.command.playId, key: item.command.key, clipName: item.clipName, at: item.command.at, priority: item.command.priority, acks: item.acks,
      })),
    };
  }

  // ------------------------------------------------------------------ internos

  private dispatch(clipId: string, key: AudioPlayCommand['key']): AudioPlayCommand {
    const clip = this.requireClip(clipId);
    const now = this.clock();
    const priority = priorityFor(key);
    const channel = channelFor(clip.category);
    if (channel === 'voice') this.lastVoiceAt = now;
    const command: AudioPlayCommand = {
      playId: randomUUID(),
      clipId,
      url: this.clipUrl(clip),
      key,
      priority,
      channel,
      volume: clip.volume,
      expiresAt: now + (priority >= 90 ? 15_000 : priority >= 50 ? 6_000 : 3_000),
      at: now,
    };
    this.dispatches.unshift({ command, clipName: clip.name, acks: {} });
    if (this.dispatches.length > MAX_DIAGNOSTIC_DISPATCHES) this.dispatches.length = MAX_DIAGNOSTIC_DISPATCHES;
    this.emit('play', command);
    return command;
  }

  private pick(key: string, candidates: string[], mode: AudioBinding['mode']): string {
    if (candidates.length === 1) return candidates[0];
    if (mode === 'sequential') {
      const index = (this.sequence.get(key) ?? 0) % candidates.length;
      this.sequence.set(key, index + 1);
      return candidates[index];
    }
    const last = this.lastClip.get(key);
    const pool = candidates.filter((id) => id !== last);
    const chosen = pool[Math.floor(this.random() * pool.length)] ?? candidates[0];
    this.lastClip.set(key, chosen);
    return chosen;
  }

  private clipUrl(clip: AudioClipInfo, baseUrl = ''): string {
    return `${baseUrl}/audio/${clip.id}?v=${clip.sha256.slice(0, 12)}`;
  }

  private requireClip(id: string): AudioClipInfo {
    const clip = this.clips.get(id);
    if (!clip) throw new AudioValidationError('Áudio não encontrado.');
    return clip;
  }

  private validateFile(data: Buffer, clientDurationMs: number | null | undefined, category: AudioCategory) {
    const music = category === 'musica';
    const maxBytes = music ? this.options.musicMaxBytes ?? this.options.maxBytes : this.options.maxBytes;
    if (!data || data.length === 0) throw new AudioValidationError('Arquivo vazio.');
    if (data.length > maxBytes) {
      throw new AudioValidationError(`Arquivo maior que o limite de ${Math.round(maxBytes / 1024 / 1024)} MB${music ? ' para música' : ''}.`);
    }
    const probe = probeAudio(data);
    if (!probe) throw new AudioValidationError('Formato não suportado. Envie MP3, WAV ou OGG.');
    const fallback = typeof clientDurationMs === 'number' && Number.isFinite(clientDurationMs) && clientDurationMs > 0 ? Math.round(clientDurationMs) : null;
    const durationMs = probe.durationMs ?? fallback;
    const maxDuration = music ? this.options.musicMaxDurationMs ?? 900_000 : this.options.maxDurationMs ?? 120_000;
    if (durationMs !== null && durationMs > maxDuration) {
      throw new AudioValidationError(`Áudio longo demais (máximo ${Math.round(maxDuration / 1000)} s).`);
    }
    return { mime: probe.mime, durationMs, sha256: createHash('sha256').update(data).digest('hex') };
  }

  private normalize(input: AudioConfig): AudioConfig {
    const base = defaultAudioConfig();
    const bindings: AudioConfig['bindings'] = {};
    for (const key of ALL_BINDING_KEYS) {
      const value = input.bindings?.[key];
      if (!value) continue;
      bindings[key] = {
        clipIds: [...new Set((value.clipIds ?? []).filter((id) => this.clips.has(id)))].slice(0, 30),
        mode: value.mode === 'sequential' ? 'sequential' : 'random',
        enabled: Boolean(value.enabled),
        cooldownMs: clampInt(value.cooldownMs, 0, 600_000, DEFAULT_COOLDOWN[key] ?? (key.startsWith('gift:') ? GIFT_COOLDOWN : 0)),
      };
    }
    const random = input.randomBordoes ?? base.randomBordoes;
    const music = { ...base.music, ...(input.music ?? {}) };
    return {
      masterVolume: clampVolume(input.masterVolume ?? base.masterVolume),
      builtinEffects: input.builtinEffects ?? base.builtinEffects,
      maxConcurrent: clampInt(input.maxConcurrent, 1, 6, base.maxConcurrent),
      minVoiceGapMs: clampInt(input.minVoiceGapMs, 0, 60_000, base.minVoiceGapMs),
      bindings,
      randomBordoes: {
        enabled: Boolean(random.enabled),
        intervalSeconds: clampInt(random.intervalSeconds, 10, 3_600, base.randomBordoes.intervalSeconds),
        jitterPercent: clampInt(random.jitterPercent, 0, 90, base.randomBordoes.jitterPercent),
        clipIds: [...new Set((random.clipIds ?? []).filter((id) => this.clips.has(id)))].slice(0, 50),
      },
      music: {
        enabled: Boolean(music.enabled),
        clipIds: [...new Set((music.clipIds ?? []).filter((id) => this.clips.get(id)?.category === 'musica'))].slice(0, 50),
        mode: music.mode === 'sequential' ? 'sequential' : 'shuffle',
        volume: clampVolume(music.volume),
        duck: clampVolume(music.duck),
        onlyDuringMatch: Boolean(music.onlyDuringMatch),
      },
    };
  }

  private publishManifest(): void {
    this.manifestVersion = Math.max(this.manifestVersion + 1, this.clock());
    this.emit('manifest');
  }
}

export function defaultCooldown(key: AudioBindingKey): number {
  return DEFAULT_COOLDOWN[key] ?? (key.startsWith('gift:') ? GIFT_COOLDOWN : 0);
}

function cleanName(name: string): string {
  const value = String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
  if (!value) throw new AudioValidationError('Informe um nome para o áudio.');
  return value;
}

function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, Math.round(value * 100) / 100)) : 1;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
