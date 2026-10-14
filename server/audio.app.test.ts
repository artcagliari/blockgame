import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { AudioManifest, AudioPlayCommand } from '../src/game/types.js';
import { createApp, type App } from './app.js';
import { makeMp3, makeWav } from './audio/fixtures.js';
import { loadConfig } from './config.js';
import { silentLogger } from './logger.js';
import { MemoryStore } from './store/memory-store.js';
import { FakeConnection } from './test-helpers.js';

const TOKEN = 'audio-token-0123456789abcdef';
const running: App[] = [];
const sockets: Socket[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(store = new MemoryStore(), env: Record<string, string> = {}) {
  const config = loadConfig({ NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', ADMIN_TOKEN: TOKEN, AUTOPLAY: 'off', TIKTOK_AUTOCONNECT: 'false', AUDIO_MAX_BYTES: '200000', ...env } as NodeJS.ProcessEnv);
  const app = createApp({ config, store, logger: silentLogger, connectionFactory: () => new FakeConnection() });
  const port = await app.start();
  running.push(app);
  return { app, base: `http://127.0.0.1:${port}` };
}
const auth = { authorization: `Bearer ${TOKEN}` };
const json = (base: string, route: string, method: string, body?: unknown, token: boolean = true) =>
  fetch(`${base}/api/admin${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? auth : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const uploadRaw = (base: string, data: Buffer, query = 'name=Bord%C3%A3o&category=bordao&team=lula', token = true) =>
  fetch(`${base}/api/admin/audio?${query}`, { method: 'POST', headers: { 'content-type': 'audio/wav', ...(token ? auth : {}) }, body: data });
const overlay = (base: string) => {
  const socket = connect(base, { transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  return socket;
};

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of running.splice(0)) await app.stop().catch(() => {});
});

describe('áudio pela API e pelo Socket.IO', () => {
  it('somente administradores enviam, alteram, vinculam, excluem e reproduzem', async () => {
    const { base, app } = await boot();
    expect((await uploadRaw(base, makeWav(300), undefined, false)).status).toBe(401);
    const created = await (await uploadRaw(base, makeWav(300))).json();
    const id = created.clip.id;
    for (const [route, method, body] of [
      [`/audio/${id}`, 'PUT', { volume: 0 }],
      [`/audio/${id}`, 'DELETE', undefined],
      ['/audio/config', 'PUT', { masterVolume: 0 }],
      ['/audio/play', 'POST', { clipId: id }],
      ['/audio/stop', 'POST', {}],
      ['/audio/trigger', 'POST', { key: 'event:draw' }],
      ['/audio/random', 'POST', {}],
      [`/audio/${id}/file`, 'GET', undefined],
      ['/audio', 'GET', undefined],
    ] as const) {
      expect((await json(base, route, method, body, false)).status, `${method} ${route}`).toBe(401);
    }
    const replace = await fetch(`${base}/api/admin/audio/${id}/file`, { method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: makeWav(100) });
    expect(replace.status).toBe(401);
    expect(app.audio.listClips()[0]).toMatchObject({ volume: 1, durationMs: 300 });
  });

  it('upload valida formato e tamanho; nome/equipe/categoria inválidos são recusados', async () => {
    const { base } = await boot();
    expect((await uploadRaw(base, Buffer.from('GIF89a falso áudio'))).status).toBe(400);
    const tooLarge = await uploadRaw(base, makeWav(20_000));
    expect(tooLarge.status).toBe(413);
    expect((await uploadRaw(base, makeWav(100), 'name=x&category=hack&team=lula')).status).toBe(400);
    expect((await uploadRaw(base, makeWav(100), 'name=x&category=bordao&team=todos')).status).toBe(400);
    const ok = await uploadRaw(base, makeMp3(20), 'name=Efeito&category=efeito&team=geral&volume=0.5');
    expect(ok.status).toBe(201);
    expect((await ok.json()).clip).toMatchObject({ mime: 'audio/mpeg', volume: 0.5, category: 'efeito' });
  });

  it('overlay recebe o manifesto, baixa o arquivo público e recebe a ordem de reprodução manual e de parada', async () => {
    const { base } = await boot();
    const socket = overlay(base);
    const initial = await new Promise<AudioManifest>((resolve) => socket.once('audio:manifest', resolve));
    expect(initial.clips).toHaveLength(0);
    const nextManifest = new Promise<AudioManifest>((resolve) => socket.once('audio:manifest', resolve));
    const { clip } = await (await uploadRaw(base, makeWav(300))).json();
    const manifest = await nextManifest;
    expect(manifest.clips[0]).toMatchObject({ id: clip.id, channel: 'voice' });

    const file = await fetch(`${base}${manifest.clips[0].url}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('audio/wav');
    expect(file.headers.get('cache-control')).toContain('immutable');
    expect((await file.arrayBuffer()).byteLength).toBe(makeWav(300).length);

    const play = new Promise<AudioPlayCommand>((resolve) => socket.once('audio:play', resolve));
    expect((await json(base, '/audio/play', 'POST', { clipId: clip.id })).status).toBe(200);
    expect(await play).toMatchObject({ clipId: clip.id, key: 'manual', priority: 95 });

    const stop = new Promise<boolean>((resolve) => socket.once('audio:stop', () => resolve(true)));
    await json(base, '/audio/stop', 'POST', {});
    expect(await stop).toBe(true);
  });

  it('arquivo desativado ou inexistente não é servido publicamente; o id é validado', async () => {
    const { base } = await boot();
    const { clip } = await (await uploadRaw(base, makeWav(200))).json();
    await json(base, `/audio/${clip.id}`, 'PUT', { active: false });
    expect((await fetch(`${base}/audio/${clip.id}`)).status).toBe(404);
    expect((await fetch(`${base}/audio/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    const preview = await fetch(`${base}/api/admin/audio/${clip.id}/file`, { headers: auth });
    expect(preview.status).toBe(200); // prévia do administrador funciona mesmo desativado
  });

  it('presente simulado e vitória disparam os sons vinculados no overlay', async () => {
    const { base } = await boot(new MemoryStore(), { ENABLE_TEST_EVENTS: 'true' });
    const rose = (await (await uploadRaw(base, makeWav(200), 'name=Rosa&category=bordao&team=lula')).json()).clip;
    const win = (await (await uploadRaw(base, makeWav(200), 'name=Vitoria&category=comemoracao&team=lula')).json()).clip;
    const save = await json(base, '/audio/config', 'PUT', { bindings: {
      'gift:lula:impulso': { clipIds: [rose.id], mode: 'random', enabled: true, cooldownMs: 0 },
      'event:victory:lula': { clipIds: [win.id], mode: 'random', enabled: true, cooldownMs: 0 },
    } });
    expect(save.status).toBe(200);
    const socket = overlay(base);
    await new Promise((resolve) => socket.once('audio:manifest', resolve));
    const received: AudioPlayCommand[] = [];
    socket.on('audio:play', (command: AudioPlayCommand) => received.push(command));
    await json(base, '/game/config', 'PUT', { target: 10 });
    await json(base, '/test/gift', 'POST', { slotId: 'lula:impulso' });
    await json(base, '/test/gift', 'POST', { slotId: 'lula:impulso' });
    await sleep(150);
    expect(received.map((item) => item.key)).toEqual(expect.arrayContaining(['gift:lula:impulso', 'event:victory:lula']));
    expect(received.find((item) => item.key === 'event:victory:lula')?.priority).toBe(100);
  });

  it('gatilho de teste e vínculos inválidos', async () => {
    const { base } = await boot();
    const { clip } = await (await uploadRaw(base, makeWav(200))).json();
    expect((await json(base, '/audio/config', 'PUT', { bindings: { 'event:hack': { clipIds: [clip.id], mode: 'random', enabled: true, cooldownMs: 0 } } })).status).toBe(400);
    expect((await json(base, '/audio/config', 'PUT', { masterVolume: 3 })).status).toBe(400);
    const empty = await (await json(base, '/audio/trigger', 'POST', { key: 'event:draw' })).json();
    expect(empty.command).toBeNull();
    await json(base, '/audio/config', 'PUT', { bindings: { 'event:draw': { clipIds: [clip.id], mode: 'random', enabled: true, cooldownMs: 0 } } });
    const fired = await (await json(base, '/audio/trigger', 'POST', { key: 'event:draw' })).json();
    expect(fired.command).toMatchObject({ key: 'event:draw', clipId: clip.id });
  });

  it('telemetria do overlay chega ao diagnóstico; relatório malformado é ignorado', async () => {
    const { base } = await boot();
    const { clip } = await (await uploadRaw(base, makeWav(200))).json();
    const socket = overlay(base);
    await new Promise((resolve) => socket.once('audio:manifest', resolve));
    const command = await new Promise<AudioPlayCommand>((resolve) => {
      socket.once('audio:play', resolve);
      void json(base, '/audio/play', 'POST', { clipId: clip.id });
    });
    socket.emit('audio:report', { type: 'status', clientId: 'overlay-1', page: 'overlay', engine: 'running', loaded: 1, total: 1, failedLoads: [], playing: 1, queued: 0, lastError: null, masterVolume: 0.9, userAgent: 'TikTok LIVE Studio' });
    socket.emit('audio:report', { type: 'ack', clientId: 'overlay-1', playId: command.playId, status: 'played' });
    socket.emit('audio:report', { type: 'status', clientId: 'x', engine: 'running', extra: '<script>' });
    socket.emit('audio:report', 'lixo');
    await sleep(150);
    const data = await (await json(base, '/audio', 'GET')).json();
    expect(data.diagnostics.overlays).toEqual([expect.objectContaining({ clientId: 'overlay-1', status: expect.objectContaining({ engine: 'running' }) })]);
    expect(data.diagnostics.dispatches[0].acks['overlay-1'].status).toBe('played');
  });

  it('áudios e vínculos sobrevivem ao reinício do servidor', async () => {
    const store = new MemoryStore();
    const first = await boot(store);
    const { clip } = await (await uploadRaw(first.base, makeWav(250))).json();
    await json(first.base, '/audio/config', 'PUT', { masterVolume: 0.4, bindings: { 'event:like': { clipIds: [clip.id], mode: 'sequential', enabled: true, cooldownMs: 3000 } } });
    await first.app.stop();
    running.splice(running.indexOf(first.app), 1);
    const second = await boot(store);
    const data = await (await json(second.base, '/audio', 'GET')).json();
    expect(data.clips[0]).toMatchObject({ id: clip.id, durationMs: 250 });
    expect(data.config).toMatchObject({ masterVolume: 0.4, bindings: { 'event:like': { mode: 'sequential', cooldownMs: 3000 } } });
    expect((await fetch(`${second.base}/audio/${clip.id}`)).status).toBe(200);
  });
});
