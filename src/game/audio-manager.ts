import type { AudioChannel, AudioEngineState, AudioManifest, AudioPlayCommand, AudioReport } from './types';

/** Motor de reprodução. Em produção, Web Audio; nos testes, um falso. */
export interface PlaybackHandle {
  stop(fadeMs?: number): void;
  readonly ended: Promise<void>;
}
export interface AudioBackend {
  state(): AudioEngineState;
  resume(): Promise<AudioEngineState>;
  load(url: string): Promise<unknown>;
  play(buffer: unknown, volume: number): PlaybackHandle;
  setMaster(volume: number): void;
}

interface Active {
  command: AudioPlayCommand;
  handle: PlaybackHandle;
  startedAt: number;
}

export interface AudioManagerOptions {
  clientId: string;
  page: 'overlay' | 'diagnostico';
  now?: () => number;
  report?: (report: AudioReport) => void;
  /** Tamanho máximo da fila de espera. */
  maxQueue?: number;
  userAgent?: string;
  onChange?: () => void;
  /** Avisado quando começa/termina um bordão (para baixar a música de fundo). */
  onVoiceChange?: (active: boolean) => void;
  /** Campos extras do relatório (ex.: estado da música de fundo). */
  extraStatus?: () => Partial<Extract<AudioReport, { type: 'status' }>>;
}

export interface AudioManagerStatus {
  engine: AudioEngineState;
  loaded: number;
  total: number;
  failedLoads: string[];
  playing: Array<{ key: string; clipId: string; channel: AudioChannel; priority: number }>;
  queued: number;
  lastError: string | null;
  masterVolume: number;
  log: Array<{ at: number; text: string }>;
}

const URGENT = 90;

/**
 * Fila de reprodução do overlay.
 * - canal "voice" (bordões/comemorações): um por vez, com intervalo mínimo entre eles;
 * - canal "sfx": até `maxConcurrent` no total, o mesmo efeito não empilha em < 120 ms;
 * - prioridade ≥ 90 (vitória, presentes especiais, manual) interrompe o que for menos importante;
 * - sons vencidos (expiresAt) são descartados em vez de tocar atrasados.
 */
export class AudioManager {
  private manifest: AudioManifest | null = null;
  private buffers = new Map<string, unknown>();
  private loading = new Map<string, Promise<unknown>>();
  private failed = new Set<string>();
  private queue: AudioPlayCommand[] = [];
  private active: Active[] = [];
  private lastVoiceEndedAt = 0;
  private lastStartByClip = new Map<string, number>();
  private lastError: string | null = null;
  private log: Array<{ at: number; text: string }> = [];
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private muted = false;
  private readonly now: () => number;

  constructor(private readonly backend: AudioBackend, private readonly options: AudioManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  get engineState(): AudioEngineState {
    return this.backend.state();
  }

  async unlock(): Promise<AudioEngineState> {
    const state = await this.backend.resume();
    if (state === 'running') {
      if (this.lastError?.startsWith('áudio bloqueado')) this.lastError = null;
      this.note('mecanismo de áudio liberado');
    }
    else this.fail(`áudio bloqueado pelo navegador (${state}); é preciso uma interação ou permitir autoplay na fonte de navegador`);
    this.pump();
    this.sendStatus();
    return state;
  }

  setManifest(manifest: AudioManifest): void {
    this.manifest = manifest;
    this.applyMaster();
    const ids = new Set(manifest.clips.map((clip) => clip.id));
    for (const id of [...this.buffers.keys()]) if (!ids.has(this.idOfUrl(id))) this.buffers.delete(id);
    this.note(`manifesto recebido: ${manifest.clips.length} áudio(s)`);
    void Promise.all(manifest.clips.map((clip) => this.ensure(clip.url).catch(() => undefined))).then(() => this.sendStatus());
    this.sendStatus();
  }

  /** Silencia sem perder a fila de configuração (toggle "efeitos sonoros" do jogo). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMaster();
  }

  enqueue(command: AudioPlayCommand): void {
    this.note(`recebido: ${command.key} (prioridade ${command.priority})`);
    if (command.expiresAt <= this.now()) {
      this.ack(command, 'dropped', 'chegou vencido');
      return;
    }
    this.queue.push(command);
    this.queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    const max = this.options.maxQueue ?? 8;
    while (this.queue.length > max) {
      const dropped = this.queue.pop()!;
      this.ack(dropped, 'dropped', 'fila cheia');
    }
    this.pump();
  }

  stopAll(): void {
    for (const item of this.active) item.handle.stop(120);
    this.active = [];
    for (const item of this.queue) this.ack(item, 'dropped', 'parado pelo administrador');
    this.queue = [];
    this.notifyVoice();
    this.note('todos os áudios interrompidos');
    this.sendStatus();
  }

  status(): AudioManagerStatus {
    const urls = this.manifest?.clips.map((clip) => clip.url) ?? [];
    return {
      engine: this.backend.state(),
      loaded: urls.filter((url) => this.buffers.has(url)).length,
      total: urls.length,
      failedLoads: [...this.failed].map((url) => this.idOfUrl(url)),
      playing: this.active.map((item) => ({ key: item.command.key, clipId: item.command.clipId, channel: item.command.channel, priority: item.command.priority })),
      queued: this.queue.length,
      lastError: this.lastError,
      masterVolume: this.manifest?.masterVolume ?? 1,
      log: [...this.log],
    };
  }

  sendStatus(): void {
    const status = this.status();
    this.options.report?.({
      type: 'status',
      clientId: this.options.clientId,
      page: this.options.page,
      engine: status.engine,
      loaded: status.loaded,
      total: status.total,
      failedLoads: status.failedLoads.slice(0, 50),
      playing: status.playing.length,
      queued: status.queued,
      lastError: status.lastError,
      masterVolume: status.masterVolume,
      userAgent: (this.options.userAgent ?? '').slice(0, 240),
      ...(this.options.extraStatus?.() ?? {}),
    });
  }

  // ----------------------------------------------------------------- internos

  private pump(): void {
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    const now = this.now();
    let nextCheck = Infinity;

    for (const command of [...this.queue]) {
      if (command.expiresAt <= now) {
        this.remove(command);
        this.ack(command, this.backend.state() === 'running' ? 'dropped' : 'blocked', this.backend.state() === 'running' ? 'expirou na fila' : 'áudio bloqueado pelo navegador');
        continue;
      }
      nextCheck = Math.min(nextCheck, command.expiresAt);
      if (this.backend.state() !== 'running') continue;

      const buffer = this.buffers.get(command.url);
      if (!buffer) {
        if (this.failed.has(command.url)) {
          this.remove(command);
          this.ack(command, 'failed', 'arquivo não pôde ser carregado');
        } else {
          void this.ensure(command.url).then(() => this.pump(), () => this.pump());
        }
        continue;
      }

      const urgent = command.priority >= URGENT;
      if (command.channel === 'voice') {
        const voice = this.active.find((item) => item.command.channel === 'voice');
        if (voice) {
          if (urgent && command.priority > voice.command.priority) this.halt(voice, 'interrompido por som prioritário');
          else continue;
        } else {
          const gapEnds = this.lastVoiceEndedAt + (this.manifest?.minVoiceGapMs ?? 0);
          if (!urgent && gapEnds > now) { nextCheck = Math.min(nextCheck, gapEnds); continue; }
        }
      } else if (now - (this.lastStartByClip.get(command.clipId) ?? 0) < 120) {
        this.remove(command);
        this.ack(command, 'dropped', 'mesmo efeito acabou de tocar');
        continue;
      }

      const limit = this.manifest?.maxConcurrent ?? 3;
      if (this.active.length >= limit) {
        const weakest = [...this.active].sort((a, b) => a.command.priority - b.command.priority)[0];
        if (urgent && weakest && weakest.command.priority < command.priority) this.halt(weakest, 'interrompido por som prioritário');
        else continue;
      }
      this.start(command, buffer);
    }

    if (this.queue.length && Number.isFinite(nextCheck)) {
      this.pumpTimer = setTimeout(() => this.pump(), Math.max(30, Math.min(500, nextCheck - now)));
    }
  }

  private start(command: AudioPlayCommand, buffer: unknown): void {
    this.remove(command);
    let handle: PlaybackHandle;
    try {
      handle = this.backend.play(buffer, Math.max(0, Math.min(1, command.volume)));
    } catch (error) {
      this.fail(`falha ao reproduzir: ${(error as Error).message}`);
      this.ack(command, 'failed', (error as Error).message);
      return;
    }
    const entry: Active = { command, handle, startedAt: this.now() };
    this.active.push(entry);
    this.lastStartByClip.set(command.clipId, entry.startedAt);
    this.note(`tocando: ${command.key}`);
    this.ack(command, 'played');
    this.notifyVoice();
    void handle.ended.then(() => {
      const index = this.active.indexOf(entry);
      if (index >= 0) this.active.splice(index, 1);
      if (command.channel === 'voice') this.lastVoiceEndedAt = this.now();
      this.notifyVoice();
      this.pump();
      this.options.onChange?.();
    });
    this.options.onChange?.();
  }

  private halt(entry: Active, reason: string): void {
    entry.handle.stop(120);
    const index = this.active.indexOf(entry);
    if (index >= 0) this.active.splice(index, 1);
    this.notifyVoice();
    this.note(`${entry.command.key}: ${reason}`);
  }

  private ensure(url: string): Promise<unknown> {
    if (this.buffers.has(url)) return Promise.resolve(this.buffers.get(url));
    const pending = this.loading.get(url);
    if (pending) return pending;
    const task = this.backend.load(url).then(
      (buffer) => {
        this.buffers.set(url, buffer);
        this.failed.delete(url);
        this.loading.delete(url);
        return buffer;
      },
      (error) => {
        this.failed.add(url);
        this.loading.delete(url);
        this.fail(`falha ao carregar ${this.idOfUrl(url)}: ${(error as Error)?.message ?? error}`);
        throw error;
      },
    );
    this.loading.set(url, task);
    return task;
  }

  private voiceActive = false;
  private notifyVoice(): void {
    const active = this.active.some((item) => item.command.channel === 'voice');
    if (active === this.voiceActive) return;
    this.voiceActive = active;
    this.options.onVoiceChange?.(active);
  }

  private remove(command: AudioPlayCommand): void {
    const index = this.queue.indexOf(command);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private applyMaster(): void {
    this.backend.setMaster(this.muted ? 0 : this.manifest?.masterVolume ?? 1);
  }

  private ack(command: AudioPlayCommand, status: 'played' | 'failed' | 'dropped' | 'blocked', error?: string): void {
    if (status !== 'played') this.note(`${command.key}: ${status}${error ? ` (${error})` : ''}`);
    this.options.report?.({ type: 'ack', clientId: this.options.clientId, playId: command.playId, status, error: error?.slice(0, 240) });
  }

  private note(text: string): void {
    this.log.unshift({ at: this.now(), text });
    if (this.log.length > 30) this.log.length = 30;
    this.options.onChange?.();
  }

  private fail(message: string): void {
    this.lastError = message.slice(0, 240);
    this.note(message);
  }

  private idOfUrl(url: string): string {
    return url.split('/').pop()?.split('?')[0] ?? url;
  }
}

/** Implementação real com Web Audio: decodifica uma vez, toca com ganho individual + geral. */
export class WebAudioBackend implements AudioBackend {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterVolume = 1;

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const Ctor = typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
    if (!Ctor) return null;
    this.context = new Ctor();
    this.master = this.context.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(this.context.destination);
    return this.context;
  }

  state(): AudioEngineState {
    if (typeof window === 'undefined' || !(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext)) return 'unsupported';
    if (!this.context) return 'locked';
    return this.context.state === 'running' ? 'running' : this.context.state === 'suspended' ? 'locked' : 'error';
  }

  async resume(): Promise<AudioEngineState> {
    const context = this.ensureContext();
    if (!context) return 'unsupported';
    try {
      if (context.state === 'suspended') await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, 800))]);
    } catch { /* autoplay bloqueado */ }
    return this.state();
  }

  async load(url: string): Promise<unknown> {
    const context = this.ensureContext();
    if (!context) throw new Error('Web Audio indisponível');
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    return await context.decodeAudioData(data);
  }

  play(buffer: unknown, volume: number): PlaybackHandle {
    const context = this.ensureContext();
    if (!context || !this.master) throw new Error('Web Audio indisponível');
    const source = context.createBufferSource();
    source.buffer = buffer as AudioBuffer;
    const gain = context.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(this.master);
    let done!: () => void;
    const ended = new Promise<void>((resolve) => { done = resolve; });
    source.onended = () => done();
    source.start();
    return {
      ended,
      stop: (fadeMs = 0) => {
        try {
          const at = context.currentTime;
          gain.gain.setValueAtTime(gain.gain.value, at);
          gain.gain.linearRampToValueAtTime(0, at + fadeMs / 1000);
          source.stop(at + fadeMs / 1000 + 0.01);
        } catch { done(); }
      },
    };
  }

  setMaster(volume: number): void {
    this.masterVolume = volume;
    if (this.master && this.context) this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.05);
  }
}
