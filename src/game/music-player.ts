import type { AudioManifest, MusicState } from './types';

/** Subconjunto de HTMLAudioElement usado; permite testar sem navegador. */
export interface MediaLike {
  src: string;
  volume: number;
  loop: boolean;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: 'ended' | 'error', listener: () => void): void;
  removeEventListener(type: 'ended' | 'error', listener: () => void): void;
}

export interface MusicStatus {
  state: MusicState;
  track: string | null;
  /** Crédito da faixa atual (licença), quando houver. */
  credit: string | null;
  /** Volume efetivo aplicado agora (0..1). */
  volume: number;
}

type Music = AudioManifest['music'];

const FADE_MS = 600;
const FADE_STEPS = 12;

/**
 * Música de fundo contínua. Toca a playlist em loop, baixa o volume enquanto houver
 * bordão/comemoração (ducking) e respeita volume geral, mudo e "só durante a rodada".
 */
export class MusicPlayer {
  private settings: Music | null = null;
  private master = 1;
  private muted = false;
  private ducked = false;
  private matchRunning = false;
  private media: MediaLike | null = null;
  private trackIndex = -1;
  private order: number[] = [];
  private state: MusicState = 'off';
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  private current = 0;
  private lastError: string | null = null;

  constructor(
    private readonly createMedia: () => MediaLike,
    private readonly options: { onChange?: () => void; random?: () => number } = {},
  ) {}

  configure(music: Music | null): void {
    const previousIds = this.settings?.tracks.map((track) => track.id).join(',');
    this.settings = music;
    const ids = music?.tracks.map((track) => track.id).join(',');
    if (ids !== previousIds) {
      this.order = [];
      this.trackIndex = -1;
      if (this.media && this.state === 'playing') this.load(this.nextIndex());
    }
    this.apply();
  }

  setMaster(volume: number): void { this.master = volume; this.applyVolume(); }
  setMuted(muted: boolean): void { this.muted = muted; this.applyVolume(); }
  setDucked(ducked: boolean): void {
    if (this.ducked === ducked) return;
    this.ducked = ducked;
    this.fadeTo(this.targetVolume(), 300);
  }
  setMatchRunning(running: boolean): void {
    if (this.matchRunning === running) return;
    this.matchRunning = running;
    this.apply();
  }

  /** Nova tentativa após liberação do autoplay. */
  retry(): void {
    if (this.state === 'blocked' || this.state === 'error') this.apply(true);
  }

  next(): void {
    if (!this.wanted()) return;
    this.load(this.nextIndex());
    void this.start();
  }

  stop(): void {
    this.fadeOut(() => this.media?.pause());
    if (this.state === 'playing') this.setState('paused');
  }

  status(): MusicStatus {
    const current = this.settings?.tracks[this.trackIndex];
    const visible = this.state !== 'off';
    return {
      state: this.state,
      track: visible ? current?.name ?? null : null,
      credit: visible ? current?.credit ?? null : null,
      volume: Math.round(this.current * 100) / 100,
    };
  }

  get error(): string | null {
    return this.lastError;
  }

  // --------------------------------------------------------------- internos

  private wanted(): boolean {
    const music = this.settings;
    if (!music || !music.enabled || music.tracks.length === 0) return false;
    return !music.onlyDuringMatch || this.matchRunning;
  }

  private apply(force = false): void {
    const music = this.settings;
    if (!music || !music.enabled || music.tracks.length === 0) {
      if (this.state !== 'off') this.fadeOut(() => this.media?.pause());
      this.setState('off');
      return;
    }
    if (!this.wanted()) {
      if (this.state === 'playing') this.fadeOut(() => this.media?.pause());
      this.setState('waiting');
      return;
    }
    if (this.state === 'playing' && !force) {
      this.applyVolume();
      return;
    }
    if (!this.media || this.trackIndex < 0) this.load(this.nextIndex());
    void this.start();
  }

  private ensureMedia(): MediaLike {
    if (this.media) return this.media;
    const media = this.createMedia();
    media.addEventListener('ended', () => {
      if (!this.wanted()) return;
      this.load(this.nextIndex());
      void this.start();
    });
    media.addEventListener('error', () => {
      this.lastError = `falha ao carregar a faixa ${this.settings?.tracks[this.trackIndex]?.name ?? ''}`.trim();
      this.setState('error');
      // Pula a faixa problemática se houver outra.
      if ((this.settings?.tracks.length ?? 0) > 1) setTimeout(() => this.next(), 1_000);
    });
    this.media = media;
    return media;
  }

  private load(index: number): void {
    const tracks = this.settings?.tracks ?? [];
    if (index < 0 || !tracks[index]) return;
    const media = this.ensureMedia();
    this.trackIndex = index;
    media.loop = tracks.length === 1;
    media.src = tracks[index].url;
  }

  private async start(): Promise<void> {
    const media = this.ensureMedia();
    this.current = 0;
    media.volume = 0;
    try {
      await media.play();
      this.lastError = null;
      this.setState('playing');
      this.fadeTo(this.targetVolume(), FADE_MS);
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'NotAllowedError') {
        this.lastError = 'música bloqueada pelo navegador (autoplay)';
        this.setState('blocked');
      } else if (name !== 'AbortError') {
        this.lastError = `falha ao tocar a música: ${(error as Error)?.message ?? error}`;
        this.setState('error');
      }
    }
  }

  private nextIndex(): number {
    const count = this.settings?.tracks.length ?? 0;
    if (count === 0) return -1;
    if (this.settings?.mode === 'sequential') return (this.trackIndex + 1) % count;
    if (this.order.length === 0) {
      // Embaralha sem repetir a faixa atual logo em seguida.
      const random = this.options.random ?? Math.random;
      this.order = Array.from({ length: count }, (_, index) => index).sort(() => random() - 0.5);
      if (count > 1 && this.order[0] === this.trackIndex) this.order.push(this.order.shift()!);
    }
    return this.order.shift()!;
  }

  private targetVolume(): number {
    if (this.muted || !this.settings) return 0;
    const base = this.settings.volume * this.master;
    return Math.max(0, Math.min(1, this.ducked ? base * this.settings.duck : base));
  }

  private applyVolume(): void {
    if (this.state === 'playing') this.fadeTo(this.targetVolume(), 200);
  }

  private fadeTo(target: number, ms: number, done?: () => void): void {
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    this.fadeTimer = null;
    const media = this.media;
    if (!media) { done?.(); return; }
    const start = this.current;
    let step = 0;
    const steps = Math.max(1, Math.round((ms / FADE_MS) * FADE_STEPS));
    this.fadeTimer = setInterval(() => {
      step += 1;
      this.current = start + (target - start) * (step / steps);
      media.volume = Math.max(0, Math.min(1, this.current));
      if (step >= steps) {
        if (this.fadeTimer) clearInterval(this.fadeTimer);
        this.fadeTimer = null;
        this.current = target;
        media.volume = target;
        done?.();
        this.options.onChange?.();
      }
    }, Math.max(10, ms / steps));
  }

  private fadeOut(done: () => void): void {
    this.fadeTo(0, 400, done);
  }

  private setState(state: MusicState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onChange?.();
  }
}
