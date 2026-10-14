import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioManager, type AudioBackend, type PlaybackHandle } from './audio-manager';
import type { AudioEngineState, AudioManifest, AudioPlayCommand, AudioReport } from './types';

class FakeBackend implements AudioBackend {
  engine: AudioEngineState = 'running';
  master = 1;
  failUrls = new Set<string>();
  plays: Array<{ url: string; volume: number; stopped: boolean; finish: () => void }> = [];
  state() { return this.engine; }
  async resume() { return this.engine; }
  async load(url: string) {
    if (this.failUrls.has(url)) throw new Error('404');
    return url;
  }
  play(buffer: unknown, volume: number): PlaybackHandle {
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => { finish = resolve; });
    const entry = { url: String(buffer), volume, stopped: false, finish };
    this.plays.push(entry);
    return { ended, stop: () => { entry.stopped = true; finish(); } };
  }
  setMaster(volume: number) { this.master = volume; }
  get playing() { return this.plays.filter((item) => !item.stopped && !(item as { done?: boolean }).done); }
}

let now = 1_000_000;
let seq = 0;
const url = (id: string) => `/audio/${id}?v=1`;
function command(id: string, over: Partial<AudioPlayCommand> = {}): AudioPlayCommand {
  return { playId: `p${++seq}`, clipId: id, url: url(id), key: 'event:like', priority: 20, channel: 'sfx', volume: 1, expiresAt: now + 5_000, at: now, ...over };
}
function manifest(ids: string[], over: Partial<AudioManifest> = {}): AudioManifest {
  return {
    clips: ids.map((id) => ({ id, url: url(id), volume: 1, channel: 'sfx' as const, durationMs: 500, name: id })),
    masterVolume: 0.8, builtinEffects: true, maxConcurrent: 3, minVoiceGapMs: 1_000, version: 1, ...over,
  };
}
async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
function finish(backend: FakeBackend, index: number) {
  const entry = backend.plays[index];
  (entry as { done?: boolean }).done = true;
  entry.finish();
}

describe('AudioManager (overlay)', () => {
  let backend: FakeBackend;
  let reports: AudioReport[];
  let manager: AudioManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    now = 1_000_000;
    backend = new FakeBackend();
    reports = [];
    manager = new AudioManager(backend, { clientId: 'c1', page: 'overlay', now: () => now, report: (report) => reports.push(report) });
    manager.setManifest(manifest(['a', 'b', 'c', 'd', 'v1', 'v2', 'win']));
    await flush();
  });
  afterEach(() => vi.useRealTimers());

  const acks = () => reports.filter((report): report is Extract<AudioReport, { type: 'ack' }> => report.type === 'ack');

  it('pré-carrega o manifesto e aplica o volume geral', () => {
    expect(manager.status()).toMatchObject({ loaded: 7, total: 7, engine: 'running' });
    expect(backend.master).toBe(0.8);
    manager.setMuted(true);
    expect(backend.master).toBe(0);
  });

  it('toca, aplica o volume individual e confirma ao servidor', () => {
    const cmd = command('a', { volume: 0.5 });
    manager.enqueue(cmd);
    expect(backend.plays).toHaveLength(1);
    expect(backend.plays[0].volume).toBe(0.5);
    expect(acks()).toEqual([expect.objectContaining({ playId: cmd.playId, status: 'played' })]);
  });

  it('canal de voz: um bordão por vez e intervalo mínimo entre bordões', async () => {
    manager.enqueue(command('v1', { channel: 'voice', priority: 70 }));
    manager.enqueue(command('v2', { channel: 'voice', priority: 70 }));
    expect(backend.plays.map((item) => item.url)).toEqual([url('v1')]);
    finish(backend, 0);
    await flush();
    expect(backend.plays).toHaveLength(1); // ainda dentro do intervalo mínimo
    now += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(backend.plays.map((item) => item.url)).toEqual([url('v1'), url('v2')]);
  });

  it('vitória/presente especial (prioridade ≥ 90) interrompe bordão comum', () => {
    manager.enqueue(command('v1', { channel: 'voice', priority: 70 }));
    manager.enqueue(command('win', { channel: 'voice', priority: 100, key: 'event:victory:lula' }));
    expect(backend.plays[0].stopped).toBe(true);
    expect(backend.plays[1].url).toBe(url('win'));
  });

  it('bordão comum não interrompe comemoração', () => {
    manager.enqueue(command('win', { channel: 'voice', priority: 100 }));
    manager.enqueue(command('v1', { channel: 'voice', priority: 90 }));
    expect(backend.plays).toHaveLength(1);
    expect(backend.plays[0].stopped).toBe(false);
  });

  it('limite de sons simultâneos; prioridade alta tira o mais fraco', () => {
    manager.enqueue(command('a', { priority: 10 }));
    manager.enqueue(command('b', { priority: 20 }));
    manager.enqueue(command('c', { priority: 30 }));
    manager.enqueue(command('d', { priority: 40 }));
    expect(backend.plays).toHaveLength(3);
    manager.enqueue(command('win', { priority: 100 }));
    expect(backend.plays[0].stopped).toBe(true); // prioridade 10 saiu
    expect(backend.plays.at(-1)?.url).toBe(url('win'));
    expect(manager.status().playing).toHaveLength(3);
  });

  it('rajada de 200 efeitos repetitivos não sobrepõe nem acumula', () => {
    for (let index = 0; index < 200; index += 1) {
      manager.enqueue(command(['a', 'b', 'c', 'd'][index % 4], { priority: 10, key: 'event:blocks' }));
      now += 5;
    }
    expect(backend.plays.length).toBeLessThanOrEqual(3);
    expect(manager.status().queued).toBeLessThanOrEqual(8);
    expect(acks().filter((ack) => ack.status === 'dropped').length).toBeGreaterThan(150);
  });

  it('o mesmo efeito não empilha em menos de 120 ms', () => {
    manager.enqueue(command('a'));
    finish(backend, 0);
    manager.enqueue(command('a'));
    expect(backend.plays).toHaveLength(1);
    expect(acks().at(-1)?.status).toBe('dropped');
  });

  it('som vencido é descartado em vez de tocar atrasado', () => {
    manager.enqueue(command('a', { expiresAt: now - 1 }));
    expect(backend.plays).toHaveLength(0);
    expect(acks()[0].status).toBe('dropped');
  });

  it('autoplay bloqueado: espera a liberação e informa "blocked" se expirar', async () => {
    backend.engine = 'locked';
    manager.enqueue(command('a', { expiresAt: now + 1_000 }));
    manager.enqueue(command('b', { expiresAt: now + 10_000 }));
    expect(backend.plays).toHaveLength(0);
    now += 1_500;
    vi.advanceTimersByTime(1_500);
    expect(acks().find((ack) => ack.status === 'blocked')).toBeTruthy();
    backend.engine = 'running';
    await manager.unlock();
    expect(backend.plays.map((item) => item.url)).toEqual([url('b')]);
  });

  it('falha ao carregar o arquivo é informada sem travar a fila', async () => {
    backend.failUrls.add(url('x'));
    manager.setManifest(manifest(['x', 'a']));
    await flush();
    expect(manager.status().failedLoads).toEqual(['x']);
    manager.enqueue(command('x'));
    manager.enqueue(command('a'));
    await flush();
    expect(acks().find((ack) => ack.status === 'failed')).toBeTruthy();
    expect(backend.plays.map((item) => item.url)).toEqual([url('a')]);
  });

  it('PARAR ÁUDIO interrompe tudo e esvazia a fila', () => {
    manager.enqueue(command('v1', { channel: 'voice', priority: 70 }));
    manager.enqueue(command('v2', { channel: 'voice', priority: 70 }));
    manager.stopAll();
    expect(backend.plays[0].stopped).toBe(true);
    expect(manager.status()).toMatchObject({ queued: 0, playing: [] });
  });

  it('envia status para o diagnóstico', () => {
    manager.sendStatus();
    expect(reports.filter((report) => report.type === 'status').at(-1)).toMatchObject({ type: 'status', clientId: 'c1', engine: 'running', loaded: 7, total: 7 });
  });
});
