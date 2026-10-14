import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioPlayCommand } from '../src/game/types.js';
import { AudioService, AudioValidationError, priorityFor } from './audio/audio-service.js';
import { DatabaseBlobStore, FilesystemBlobStore } from './audio/blob-store.js';
import { makeMp3, makeOggOpus, makeWav } from './audio/fixtures.js';
import { probeAudio } from './audio/probe.js';
import { GameEngine } from './game-engine.js';
import { GameService } from './game-service.js';
import { silentLogger } from './logger.js';
import { MemoryStore } from './store/memory-store.js';

const MB = 1024 * 1024;

async function makeAudio(store = new MemoryStore(), blobs?: FilesystemBlobStore, clock?: () => number, maxClips = 20) {
  await store.init();
  const audio = new AudioService(store, blobs ?? new DatabaseBlobStore(store), silentLogger, { maxBytes: 2 * MB, maxClips, clock });
  await audio.init();
  const played: AudioPlayCommand[] = [];
  audio.on('play', (command: AudioPlayCommand) => played.push(command));
  return { store, audio, played };
}

const upload = (audio: AudioService, name: string, over: Partial<Parameters<AudioService['upload']>[0]> = {}) =>
  audio.upload({ data: makeWav(400), name, category: 'bordao', team: 'geral', ...over });

describe('validação de arquivos', () => {
  it('reconhece WAV, MP3 e OGG pelo conteúdo e calcula a duração', () => {
    expect(probeAudio(makeWav(1500))).toEqual({ format: 'wav', mime: 'audio/wav', durationMs: 1500 });
    const mp3 = probeAudio(makeMp3(100)); // 100 quadros × 1152 / 44100 ≈ 2,6 s
    expect(mp3?.format).toBe('mp3');
    expect(mp3?.durationMs).toBeGreaterThan(2_500);
    expect(mp3?.durationMs).toBeLessThan(2_700);
    expect(probeAudio(makeOggOpus(3_000))).toEqual({ format: 'ogg', mime: 'audio/ogg', durationMs: 3_000 });
  });

  it('rejeita conteúdo que não é áudio, mesmo com “extensão” de áudio', () => {
    expect(probeAudio(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(probeAudio(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]))).toBeNull();
    expect(probeAudio(Buffer.alloc(3))).toBeNull();
  });

  it('upload valida tamanho, formato, duração, nome e limite de arquivos', async () => {
    const { audio } = await makeAudio(new MemoryStore(), undefined, undefined, 5);
    await expect(upload(audio, 'x', { data: Buffer.alloc(3 * MB, 1) })).rejects.toThrow(/limite/);
    await expect(upload(audio, 'x', { data: Buffer.from('não é áudio nenhum') })).rejects.toThrow(AudioValidationError);
    await expect(upload(audio, 'x', { data: makeWav(130_000) })).rejects.toThrow(/longo/);
    await expect(upload(audio, '   ')).rejects.toThrow(/nome/);
    for (let index = 0; index < 5; index += 1) await upload(audio, `a${index}`);
    await expect(upload(audio, 'sexto')).rejects.toThrow(/Limite de 5/);
  });

  it('usa a duração do navegador só quando o servidor não consegue calcular', async () => {
    const { audio } = await makeAudio();
    const wav = await upload(audio, 'wav', { clientDurationMs: 99_999 });
    expect(wav.durationMs).toBe(400);
  });
});

describe('biblioteca e persistência', () => {
  it('envia, altera, substitui e exclui; metadados e bytes sobrevivem a um novo processo', async () => {
    const store = new MemoryStore();
    const first = await makeAudio(store);
    const clip = await upload(first.audio, '  Bordão <b>1</b> ', { team: 'lula', volume: 0.7 });
    expect(clip).toMatchObject({ name: 'Bordão b1/b', team: 'lula', volume: 0.7, active: true, mime: 'audio/wav', durationMs: 400 });
    await first.audio.updateClip(clip.id, { volume: 0.4, category: 'comemoracao' });
    await first.audio.updateConfig({ bindings: { 'event:like': { clipIds: [clip.id], mode: 'random', enabled: true, cooldownMs: 1000 } } });
    const replaced = await first.audio.replaceFile(clip.id, makeWav(900));
    expect(replaced.sha256).not.toBe(clip.sha256);

    const second = await makeAudio(store);
    expect(second.audio.listClips()).toEqual([expect.objectContaining({ id: clip.id, volume: 0.4, category: 'comemoracao', durationMs: 900 })]);
    expect(second.audio.getConfig().bindings['event:like']?.clipIds).toEqual([clip.id]);
    const file = await second.audio.getFile(clip.id, { includeInactive: false });
    expect(probeAudio(file!.data)?.durationMs).toBe(900);

    await second.audio.deleteClip(clip.id);
    expect(second.audio.listClips()).toHaveLength(0);
    expect(second.audio.getConfig().bindings['event:like']?.clipIds).toEqual([]);
    expect(await store.getAudioBlob(clip.id)).toBeNull();
  });

  it('driver de disco (volume do Railway) grava e lê de forma persistente', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bdb-audio-'));
    try {
      const store = new MemoryStore();
      const first = await makeAudio(store, new FilesystemBlobStore(dir));
      const clip = await upload(first.audio, 'disco');
      const second = await makeAudio(store, new FilesystemBlobStore(dir));
      expect((await second.audio.getFile(clip.id, { includeInactive: true }))?.data.length).toBe(makeWav(400).length);
      expect(await store.getAudioBlob(clip.id)).toBeNull(); // bytes não foram para o banco
      await second.audio.deleteClip(clip.id);
      expect(await new FilesystemBlobStore(dir).get(clip.id)).toBeNull();
      await expect(new FilesystemBlobStore(dir).get('../../etc/passwd')).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('arquivo desativado não é entregue ao overlay nem pode tocar', async () => {
    const { audio } = await makeAudio();
    const clip = await upload(audio, 'off');
    await audio.updateClip(clip.id, { active: false });
    expect(await audio.getFile(clip.id, { includeInactive: false })).toBeNull();
    expect(await audio.getFile(clip.id, { includeInactive: true })).not.toBeNull();
    expect(() => audio.playManual(clip.id)).toThrow(/desativado/);
    expect(audio.manifest().clips).toHaveLength(0);
  });

  it('não aceita vínculo com áudio inexistente', async () => {
    const { audio } = await makeAudio();
    await expect(audio.updateConfig({ bindings: { 'event:like': { clipIds: ['00000000-0000-0000-0000-000000000000'], mode: 'random', enabled: true, cooldownMs: 0 } } })).rejects.toThrow(/inexistente/);
  });
});

describe('gatilhos automáticos', () => {
  async function wired(target = 2000) {
    const harness = await makeAudio();
    const engine = new GameEngine({ target, durationSeconds: 300 }, { autoplay: false });
    const game = new GameService(engine, harness.store, silentLogger);
    await game.init();
    harness.audio.attach(game);
    return { ...harness, engine, game };
  }
  const bind = async (audio: AudioService, key: string, clipIds: string[], over: Record<string, unknown> = {}) =>
    audio.updateConfig({ bindings: { [key]: { clipIds, mode: 'random', enabled: true, cooldownMs: 0, ...over } } });

  it('presente simulado toca o bordão vinculado a ele; sem vínculo, cai no som genérico de presente', async () => {
    const { audio, played, engine } = await wired();
    const rose = await upload(audio, 'Bordão rosa', { team: 'lula' });
    const generic = await upload(audio, 'Presente genérico', { category: 'efeito' });
    await bind(audio, 'gift:lula:impulso', [rose.id]);
    await bind(audio, 'event:gift', [generic.id]);
    engine.increment('lula', 5, { origin: 'test', kind: 'gift', giftId: 'impulso', count: 1 });
    engine.increment('bolsonaro', 5, { origin: 'test', kind: 'gift', giftId: 'impulso', count: 1 });
    expect(played.map((item) => [item.key, item.clipId])).toEqual([
      ['gift:lula:impulso', rose.id],
      ['event:gift', generic.id],
    ]);
    expect(played[0]).toMatchObject({ channel: 'voice', priority: 70, url: expect.stringContaining(`/audio/${rose.id}?v=`) });
    expect(played[1].channel).toBe('sfx');
  });

  it('centenas de curtidas em sequência geram um único som por intervalo', async () => {
    let now = 1_000_000;
    const harness = await makeAudio(new MemoryStore(), undefined, () => now);
    const engine = new GameEngine({}, { autoplay: false, now: () => now });
    const game = new GameService(engine, harness.store, silentLogger);
    await game.init();
    harness.audio.attach(game);
    const clip = await upload(harness.audio, 'like', { category: 'efeito' });
    await bind(harness.audio, 'event:like', [clip.id], { cooldownMs: 5_000 });
    for (let index = 0; index < 300; index += 1) {
      engine.increment('lula', 1, { origin: 'real', kind: 'like' });
      now += 10; // 300 curtidas em 3 s
    }
    expect(harness.played.filter((item) => item.key === 'event:like')).toHaveLength(1);
    now += 5_000;
    engine.increment('lula', 1, { origin: 'real', kind: 'like' });
    expect(harness.played.filter((item) => item.key === 'event:like')).toHaveLength(2);
  });

  it('combo, queda de blocos, início, últimos 10 s, virada, vitória e empate', async () => {
    let now = 0;
    const harness = await makeAudio(new MemoryStore(), undefined, () => now);
    const engine = new GameEngine({ target: 100, durationSeconds: 30, resultSeconds: 3 }, { autoplay: false, now: () => now });
    const game = new GameService(engine, harness.store, silentLogger);
    await game.init();
    harness.audio.attach(game);
    const ids: Record<string, string> = {};
    for (const key of ['event:combo', 'event:blocks', 'event:roundStart', 'event:countdown', 'event:leadChange', 'event:victory:lula', 'event:victory:bolsonaro', 'event:draw']) {
      ids[key] = (await upload(harness.audio, key, { category: 'comemoracao' })).id;
      await bind(harness.audio, key, [ids[key]]);
    }
    const keys = () => harness.played.map((item) => item.key);

    engine.increment('lula', 10, { origin: 'test', kind: 'gift', giftId: 'impulso', count: 2 });
    expect(keys()).toEqual(['event:combo', 'event:blocks']);
    engine.increment('bolsonaro', 20, { origin: 'test', kind: 'manual' });
    expect(keys()).toContain('event:leadChange');
    now += 21_000;
    engine.broadcast();
    engine.broadcast();
    expect(keys().filter((key) => key === 'event:countdown')).toHaveLength(1);
    engine.increment('bolsonaro', 80, { origin: 'test', kind: 'manual' });
    expect(keys()).toContain('event:victory:bolsonaro');
    now += 3_500;
    engine.tick();
    expect(keys()).toContain('event:roundStart');
    // empate por tempo
    engine.increment('lula', 5, { origin: 'test', kind: 'manual' });
    engine.increment('bolsonaro', 5, { origin: 'test', kind: 'manual' });
    now += 31_000;
    engine.tick();
    expect(keys()).toContain('event:draw');
    const victory = harness.played.find((item) => item.key === 'event:victory:bolsonaro')!;
    expect(victory.priority).toBe(100);
    expect(victory.priority).toBeGreaterThan(priorityFor('event:like'));
  });

  it('modo sequencial percorre a lista; aleatório não repete o último', async () => {
    const { audio, played } = await makeAudio();
    const a = await upload(audio, 'a');
    const b = await upload(audio, 'b');
    const c = await upload(audio, 'c');
    await bind(audio, 'event:follow', [a.id, b.id, c.id], { mode: 'sequential' });
    for (let index = 0; index < 4; index += 1) audio.trigger('event:follow');
    expect(played.map((item) => item.clipId)).toEqual([a.id, b.id, c.id, a.id]);
    played.length = 0;
    await bind(audio, 'event:like', [a.id, b.id]);
    for (let index = 0; index < 10; index += 1) audio.trigger('event:like');
    for (let index = 1; index < played.length; index += 1) expect(played[index].clipId).not.toBe(played[index - 1].clipId);
  });

  it('vínculo desativado ou sem áudio ativo não toca; manual ignora o intervalo', async () => {
    const { audio, played } = await makeAudio();
    const clip = await upload(audio, 'x');
    await bind(audio, 'event:like', [clip.id], { enabled: false });
    expect(audio.trigger('event:like')).toBeNull();
    await bind(audio, 'event:like', [clip.id], { cooldownMs: 60_000 });
    expect(audio.trigger('event:like')).not.toBeNull();
    expect(audio.trigger('event:like')).toBeNull();
    audio.playManual(clip.id);
    audio.playManual(clip.id);
    expect(played.filter((item) => item.key === 'manual')).toHaveLength(2);
    expect(played.at(-1)?.priority).toBe(95);
  });

  describe('bordões aleatórios por intervalo', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('tocam no intervalo configurado e só com a partida em andamento', async () => {
      const { audio, played, engine } = await wired();
      const a = await upload(audio, 'a');
      const b = await upload(audio, 'b');
      await audio.updateConfig({ randomBordoes: { enabled: true, intervalSeconds: 30, jitterPercent: 0, clipIds: [a.id, b.id] } });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(played).toHaveLength(0); // rodada ainda aguardando o primeiro evento
      engine.increment('lula', 1, { origin: 'real', kind: 'like' });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(played.filter((item) => item.key === 'random')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(played.filter((item) => item.key === 'random')).toHaveLength(2);
      expect(played[0].priority).toBe(15);
      await audio.updateConfig({ randomBordoes: { enabled: false } });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(played.filter((item) => item.key === 'random')).toHaveLength(2);
    });
  });
});

describe('diagnóstico', () => {
  it('registra estado do overlay e confirmações de reprodução', async () => {
    const { audio } = await makeAudio();
    const clip = await upload(audio, 'x');
    const command = audio.playManual(clip.id);
    audio.report('sock1', { type: 'status', clientId: 'c1', page: 'overlay', engine: 'running', loaded: 1, total: 1, failedLoads: [], playing: 0, queued: 0, lastError: null, masterVolume: 0.9, userAgent: 'LIVE Studio' });
    audio.report('sock1', { type: 'ack', clientId: 'c1', playId: command.playId, status: 'played' });
    const diagnostics = audio.diagnostics();
    expect(diagnostics.overlays[0]).toMatchObject({ clientId: 'c1', status: { engine: 'running', loaded: 1 } });
    expect(diagnostics.dispatches[0]).toMatchObject({ playId: command.playId, clipName: 'x', acks: { c1: { status: 'played' } } });
  });
});

describe('música de fundo', () => {
  async function musicAudio() {
    const store = new MemoryStore();
    await store.init();
    const audio = new AudioService(store, new DatabaseBlobStore(store), silentLogger, { maxBytes: 100_000, musicMaxBytes: 2 * MB, maxClips: 20 });
    await audio.init();
    return { audio };
  }

  it('aceita faixas longas só na categoria música', async () => {
    const { audio } = await musicAudio();
    const long = makeWav(150_000); // 2,5 min, ~2,4 MB? (8 kHz mono = 16 KB/s → 2,4 MB)
    const small = makeWav(5_000);
    await expect(audio.upload({ data: long, name: 'faixa', category: 'bordao', team: 'geral' })).rejects.toThrow(/limite|longo/);
    const shortTrack = await audio.upload({ data: makeWav(100_000), name: 'Trilha', category: 'musica', team: 'geral' });
    expect(shortTrack).toMatchObject({ category: 'musica', durationMs: 100_000 });
    await expect(audio.upload({ data: small, name: 'ok', category: 'bordao', team: 'geral' })).resolves.toBeTruthy();
  });

  it('playlist só aceita faixas de música; música não vira bordão nem toca na mesa', async () => {
    const { audio } = await musicAudio();
    const track = await audio.upload({ data: makeWav(20_000), name: 'Trilha', category: 'musica', team: 'geral' });
    const bordao = await audio.upload({ data: makeWav(500), name: 'B', category: 'bordao', team: 'lula' });
    await expect(audio.updateConfig({ music: { clipIds: [bordao.id] } as never })).rejects.toThrow(/Música de fundo/);
    await expect(audio.updateConfig({ bindings: { 'event:like': { clipIds: [track.id], mode: 'random', enabled: true, cooldownMs: 0 } } })).rejects.toThrow(/não pode/);
    expect(() => audio.playManual(track.id)).toThrow(/Música de fundo/);
    await expect(audio.updateClip(track.id, { category: 'bordao' })).rejects.toThrow(/longa demais/);
  });

  it('manifesto traz a playlist ativa e não pré-carrega a música junto dos efeitos', async () => {
    const { audio } = await musicAudio();
    const track = await audio.upload({ data: makeWav(20_000), name: 'Trilha', category: 'musica', team: 'geral' });
    await audio.upload({ data: makeWav(500), name: 'B', category: 'bordao', team: 'lula' });
    await audio.updateConfig({ music: { enabled: true, clipIds: [track.id], volume: 0.3, duck: 0.25, mode: 'shuffle', onlyDuringMatch: false } });
    const manifest = audio.manifest();
    expect(manifest.clips.map((clip) => clip.name)).toEqual(['B']);
    expect(manifest.music).toMatchObject({ enabled: true, volume: 0.3, duck: 0.25, tracks: [{ id: track.id, name: 'Trilha' }] });
    await audio.updateClip(track.id, { active: false });
    expect(audio.manifest().music.tracks).toHaveLength(0);
    await audio.deleteClip(track.id);
    expect(audio.getConfig().music.clipIds).toEqual([]);
  });

  it('crédito da licença: salvo, limpo de marcação, editável e enviado no manifesto', async () => {
    const { audio } = await musicAudio();
    const track = await audio.upload({ data: makeWav(20_000), name: 'Mischief Maker', category: 'musica', team: 'geral', credit: '  Mischief Maker <b>Kevin</b>\nMacLeod (incompetech.com)  ' });
    expect(track.credit).toBe('Mischief Maker bKevin/b MacLeod (incompetech.com)');
    await audio.updateConfig({ music: { enabled: true, clipIds: [track.id] } as never });
    expect(audio.manifest().music.tracks[0].credit).toBe(track.credit);
    expect((await audio.updateClip(track.id, { credit: '' })).credit).toBeNull();
    expect((await audio.updateClip(track.id, { credit: 'x'.repeat(500) })).credit).toHaveLength(200);
  });

  it('próxima faixa é enviada aos overlays', async () => {
    const { audio } = await musicAudio();
    const commands: unknown[] = [];
    audio.on('music', (command) => commands.push(command));
    audio.nextTrack();
    expect(commands).toEqual([{ action: 'next' }]);
  });
});
