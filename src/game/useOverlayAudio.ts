import { useCallback, useEffect, useMemo, useState } from 'react';
import { AudioManager, WebAudioBackend, type AudioManagerStatus } from './audio-manager';
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
  const manager = useMemo(() => {
    let reportTimer: ReturnType<typeof setTimeout> | null = null;
    const instance: AudioManager = new AudioManager(new WebAudioBackend(), {
      clientId: makeClientId(),
      page,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      report: (report) => { if (gameSocket.connected) gameSocket.emit('audio:report', report); },
      // Mudanças (tocou, parou, fila) chegam ao diagnóstico do painel em até 300 ms.
      onChange: () => {
        setStatus(instance.status());
        if (!reportTimer) reportTimer = setTimeout(() => { reportTimer = null; instance.sendStatus(); }, 300);
      },
    });
    return instance;
  }, [page]);

  useEffect(() => {
    const onManifest = (manifest: AudioManifest) => {
      setBuiltinEffects(manifest.builtinEffects);
      manager.setManifest(manifest);
    };
    const onPlay = (command: AudioPlayCommand) => manager.enqueue(command);
    const onStop = () => manager.stopAll();
    const onConnect = () => manager.sendStatus();
    gameSocket.on('audio:manifest', onManifest);
    gameSocket.on('audio:play', onPlay);
    gameSocket.on('audio:stop', onStop);
    gameSocket.on('connect', onConnect);

    // Fontes de navegador (LIVE Studio/OBS) costumam permitir autoplay: tenta liberar sozinho.
    void manager.unlock();
    const onGesture = () => { if (manager.engineState !== 'running') void manager.unlock(); };
    window.addEventListener('pointerdown', onGesture);
    window.addEventListener('keydown', onGesture);
    const heartbeat = window.setInterval(() => manager.sendStatus(), 5_000);
    return () => {
      gameSocket.off('audio:manifest', onManifest);
      gameSocket.off('audio:play', onPlay);
      gameSocket.off('audio:stop', onStop);
      gameSocket.off('connect', onConnect);
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
      window.clearInterval(heartbeat);
      manager.stopAll();
    };
  }, [manager]);

  const unlock = useCallback(() => manager.unlock(), [manager]);
  return { manager, status, builtinEffects, unlock };
}
