import { AudioDiagnostics } from '../components/AudioDiagnostics';
import { useGame } from '../game/useGame';
import { useOverlayAudio } from '../game/useOverlayAudio';

/**
 * /audio-diagnostico — abre o mesmo mecanismo de áudio do overlay, sem o jogo, para testar
 * a fonte de navegador do LIVE Studio. Recebe exatamente os mesmos comandos do servidor.
 */
export function AudioCheck() {
  const { connected } = useGame();
  const { status, unlock } = useOverlayAudio('diagnostico');
  return (
    <main className="admin-page">
      <div className="admin-wrap">
        <p className="admin-kicker">BATALHA DOS BLOCOS</p>
        <h1 className="audio-check__title">Diagnóstico de áudio</h1>
        <p className="admin-hint">Servidor: {connected ? 'conectado' : 'desconectado'}. Use “REPRODUZIR NA LIVE” no painel /admin e confirme aqui e na captura do LIVE Studio.</p>
        <AudioDiagnostics status={status} onUnlock={() => void unlock()} />
      </div>
    </main>
  );
}
