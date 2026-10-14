import type { AudioManagerStatus } from '../game/audio-manager';
import type { MusicStatus } from '../game/music-player';

const ENGINE_LABEL: Record<string, string> = {
  running: 'ATIVO',
  locked: 'BLOQUEADO (aguardando interação/autoplay)',
  suspended: 'SUSPENSO',
  unsupported: 'SEM SUPORTE A WEB AUDIO',
  error: 'ERRO',
};

/** Painel de diagnóstico do áudio do overlay. Só é montado com ?audioDebug=1 ou na rota de diagnóstico. */
export function AudioDiagnostics({ status, music, onUnlock, compact = false }: { status: AudioManagerStatus | null; music?: MusicStatus | null; onUnlock: () => void; compact?: boolean }) {
  return (
    <section className={`audio-diag ${compact ? 'audio-diag--compact' : ''}`} aria-live="polite">
      <header>
        <b>DIAGNÓSTICO DE ÁUDIO</b>
        <span className={`audio-diag__engine audio-diag__engine--${status?.engine ?? 'locked'}`}>{ENGINE_LABEL[status?.engine ?? 'locked']}</span>
      </header>
      {status?.engine !== 'running' && <button type="button" onClick={onUnlock}>ATIVAR ÁUDIO</button>}
      <dl>
        <div><dt>Arquivos carregados</dt><dd>{status ? `${status.loaded}/${status.total}` : '—'}</dd></div>
        <div><dt>Tocando</dt><dd>{status?.playing.map((item) => item.key).join(', ') || '—'}</dd></div>
        <div><dt>Na fila</dt><dd>{status?.queued ?? 0}</dd></div>
        <div><dt>Música de fundo</dt><dd>{music ? `${music.state}${music.track ? ` · ${music.track}` : ''} · vol. ${Math.round(music.volume * 100)}%` : '—'}</dd></div>
        <div><dt>Volume geral</dt><dd>{Math.round((status?.masterVolume ?? 1) * 100)}%</dd></div>
        <div><dt>Falhas de carga</dt><dd>{status?.failedLoads.length ? status.failedLoads.join(', ') : 'nenhuma'}</dd></div>
        <div><dt>Último erro</dt><dd>{status?.lastError ?? 'nenhum'}</dd></div>
      </dl>
      <ol>
        {status?.log.slice(0, compact ? 8 : 30).map((entry, index) => (
          <li key={`${entry.at}-${index}`}><time>{new Date(entry.at).toLocaleTimeString('pt-BR')}</time> {entry.text}</li>
        ))}
      </ol>
    </section>
  );
}
