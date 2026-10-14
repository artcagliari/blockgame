import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicPlayer, type MediaLike } from './music-player';
import type { AudioManifest } from './types';

class FakeMedia implements MediaLike {
  src = '';
  volume = 1;
  loop = false;
  paused = true;
  allow = true;
  played: string[] = [];
  private listeners: Record<string, Array<() => void>> = {};
  async play() {
    if (!this.allow) throw Object.assign(new Error('autoplay'), { name: 'NotAllowedError' });
    this.paused = false;
    this.played.push(this.src);
  }
  pause() { this.paused = true; }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  emit(type: string) { for (const fn of this.listeners[type] ?? []) fn(); }
}

const music = (over: Partial<AudioManifest['music']> = {}): AudioManifest['music'] => ({
  enabled: true, clipIds: ['a', 'b', 'c'], mode: 'sequential', volume: 0.5, duck: 0.2, onlyDuringMatch: false,
  tracks: ['a', 'b', 'c'].map((id) => ({ id, url: `/audio/${id}`, name: `Faixa ${id}`, credit: id === 'a' ? 'Faixa a Autor (site) CC BY 4.0' : null })), ...over,
});
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe('MusicPlayer (música de fundo)', () => {
  let media: FakeMedia;
  let player: MusicPlayer;
  beforeEach(() => {
    vi.useFakeTimers();
    media = new FakeMedia();
    player = new MusicPlayer(() => media, { random: () => 0.3 });
  });
  afterEach(() => vi.useRealTimers());

  it('toca a playlist em ordem e em loop, com fade até o volume configurado × volume geral', async () => {
    player.setMaster(0.8);
    player.configure(music());
    await flush();
    vi.advanceTimersByTime(1_000);
    expect(player.status()).toMatchObject({ state: 'playing', track: 'Faixa a', volume: 0.4 });
    media.emit('ended'); await flush();
    media.emit('ended'); await flush();
    media.emit('ended'); await flush();
    expect(media.played).toEqual(['/audio/a', '/audio/b', '/audio/c', '/audio/a']);
  });

  it('uma única faixa fica em loop nativo', async () => {
    player.configure(music({ tracks: [{ id: 'a', url: '/audio/a', name: 'A', credit: null }], clipIds: ['a'] }));
    await flush();
    expect(media.loop).toBe(true);
  });

  it('embaralhar toca todas as faixas antes de repetir', async () => {
    player.configure(music({ mode: 'shuffle' }));
    await flush();
    media.emit('ended'); await flush();
    media.emit('ended'); await flush();
    expect(new Set(media.played).size).toBe(3);
  });

  it('abaixa durante bordões e volta depois', async () => {
    player.configure(music());
    await flush();
    vi.advanceTimersByTime(1_000);
    player.setDucked(true);
    vi.advanceTimersByTime(500);
    expect(media.volume).toBeCloseTo(0.1);
    player.setDucked(false);
    vi.advanceTimersByTime(500);
    expect(media.volume).toBeCloseTo(0.5);
  });

  it('mudo e desligar silenciam; religar retoma', async () => {
    player.configure(music());
    await flush();
    vi.advanceTimersByTime(1_000);
    player.setMuted(true);
    vi.advanceTimersByTime(500);
    expect(media.volume).toBe(0);
    player.setMuted(false);
    player.configure(music({ enabled: false }));
    vi.advanceTimersByTime(600);
    expect(media.paused).toBe(true);
    expect(player.status().state).toBe('off');
    player.configure(music());
    await flush();
    expect(player.status().state).toBe('playing');
  });

  it('“só durante a rodada” espera a partida começar', async () => {
    player.configure(music({ onlyDuringMatch: true }));
    await flush();
    expect(player.status().state).toBe('waiting');
    expect(media.played).toHaveLength(0);
    player.setMatchRunning(true);
    await flush();
    expect(player.status().state).toBe('playing');
    player.setMatchRunning(false);
    vi.advanceTimersByTime(600);
    expect(media.paused).toBe(true);
  });

  it('autoplay bloqueado é informado e a música começa após a liberação', async () => {
    media.allow = false;
    player.configure(music());
    await flush();
    expect(player.status().state).toBe('blocked');
    expect(player.error).toMatch(/autoplay/);
    media.allow = true;
    player.retry();
    await flush();
    expect(player.status().state).toBe('playing');
  });

  it('faixa com erro é pulada', async () => {
    player.configure(music());
    await flush();
    media.emit('error');
    expect(player.status().state).toBe('error');
    vi.advanceTimersByTime(1_100);
    await flush();
    expect(media.played.at(-1)).toBe('/audio/b');
  });

  it('informa o crédito da faixa tocando; desligada não mostra crédito', async () => {
    player.configure(music());
    await flush();
    expect(player.status()).toMatchObject({ state: 'playing', credit: 'Faixa a Autor (site) CC BY 4.0' });
    player.next();
    await flush();
    expect(player.status().credit).toBeNull();
    player.configure(music({ enabled: false }));
    expect(player.status()).toMatchObject({ state: 'off', credit: null });
  });

  it('próxima faixa pelo painel', async () => {
    player.configure(music());
    await flush();
    player.next();
    await flush();
    expect(media.played).toEqual(['/audio/a', '/audio/b']);
  });
});
