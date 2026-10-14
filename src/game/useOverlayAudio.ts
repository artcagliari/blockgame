import { useCallback, useEffect, useMemo, useState } from 'react';
import { AudioManager, WebAudioBackend, type AudioManagerStatus } from './audio-manager';
import { MusicPlayer, type MediaLike, type MusicStatus } from './music-player';
import { gameSocket } from './socket';
import type { AudioManifest, AudioPlayCommand } from './types';

function makeClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Áudio do overlay: recebe ordens do servidor (Socket.IO), pré-carrega a biblioteca e
 * reproduz localmente. Envia telemetria para o diagnóstico do painel administrativo.
 */
export function useOverlayAudio(page: 'overlay' | 'diagnostico' = 'overlay') {
  const [status, setStatus] = useState<AudioManagerStatus | null>(null);
  const [builtinEffects, setBuiltinEffects] = useState(true);
  const [musicStatus, setMusicStatus] = useState<MusicStatus | null>(null);
  const { manager, music } = useMemo(() => {
    let reportTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReport = () => {
      if (!reportTimer) reportTimer = setTimeout(() => { reportTimer = null; instance.sendStatus(); }, 300);
    };
    const player = new MusicPlayer(() => {
      const element = new Audio();
      element.preload = 'auto';
      return element as unknown as MediaLike;
    }, { onChange: () => { setMusicStatus(player.status()); scheduleReport(); } });
    const instance: AudioManager = new AudioManager(new WebAudioBackend(), {
      onVoiceChange: (active) => player.setDucked(active),
      extraStatus: () => ({ music: player.status() }),
      clientId: makeClientId(),
      page,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      report: (report) => { if (gameSocket.connected) gameSocket.emit('audio:report', report); },
      // Mudanças (tocou, parou, fila) chegam ao diagnóstico do painel em até 300 ms.
      onChange: () => {
        setStatus(instance.status());
        scheduleReport();
      },
    });
    return { manager: instance, music: player };
  }, [page]);

  useEffect(() => {
    const onManifest = (manifest: AudioManifest) => {
      setBuiltinEffects(manifest.builtinEffects);
      manager.setManifest(manifest);
      music.setMaster(manifest.masterVolume);
      music.configure(manifest.music ?? null);
    };
    const onMusic = (command: { action: 'next' }) => { if (command.action === 'next') music.next(); };
    const onPlay = (command: AudioPlayCommand) => manager.enqueue(command);
    const onStop = () => manager.stopAll();
    const onConnect = () => manager.sendStatus();
    gameSocket.on('audio:manifest', onManifest);
    gameSocket.on('audio:play', onPlay);
    gameSocket.on('audio:stop', onStop);
    gameSocket.on('audio:music', onMusic);
    gameSocket.on('connect', onConnect);

    // Fontes de navegador (LIVE Studio/OBS) costumam permitir autoplay: tenta liberar sozinho.
    void manager.unlock().then(() => music.retry());
    const onGesture = () => {
      if (manager.engineState !== 'running') void manager.unlock();
      music.retry();
    };
    window.addEventListener('pointerdown', onGesture);
    window.addEventListener('keydown', onGesture);
    const heartbeat = window.setInterval(() => manager.sendStatus(), 5_000);
    return () => {
      gameSocket.off('audio:manifest', onManifest);
      gameSocket.off('audio:play', onPlay);
      gameSocket.off('audio:stop', onStop);
      gameSocket.off('audio:music', onMusic);
      gameSocket.off('connect', onConnect);
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
      window.clearInterval(heartbeat);
      manager.stopAll();
      music.configure(null);
    };
  }, [manager, music]);

  const unlock = useCallback(async () => {
    const state = await manager.unlock();
    music.retry();
    return state;
  }, [manager, music]);
  return { manager, music, status, musicStatus, builtinEffects, unlock };
}
