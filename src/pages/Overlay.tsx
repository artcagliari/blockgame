import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TeamHud } from '../components/TeamHud';
import { GiftRail } from '../components/GiftRail';
import { GiftIcon } from '../components/GiftIcon';
import { gameAudio } from '../game/audio';
import { getGift } from '../game/gifts';
import { GameStage } from '../game/GameStage';
import { useGame } from '../game/useGame';
import { useOverlayAudio } from '../game/useOverlayAudio';
import { AudioDiagnostics } from '../components/AudioDiagnostics';
import type { GameState, IncrementEvent, Team } from '../game/types';

interface FloatingGain extends IncrementEvent {
  createdAt: number;
}

export function Overlay() {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<GameStage | null>(null);
  const previousLeader = useRef<Team | null>(null);
  const previousPhase = useRef<GameState['phase']>('playing');
  const [gains, setGains] = useState<FloatingGain[]>([]);
  const [audioReady, setAudioReady] = useState(false);
  const { manager: audioManager, music, status: audioStatus, musicStatus, builtinEffects, unlock: unlockLibrary } = useOverlayAudio('overlay');
  const audioDebug = useMemo(() => new URLSearchParams(window.location.search).has('audioDebug'), []);
  const [clockNow, setClockNow] = useState(Date.now());

  const onIncrement = useCallback((event: IncrementEvent) => {
    stageRef.current?.impact(event);
    gameAudio.play(event.source === 'gift' ? 'gift' : 'block');
    setGains((current) => [...current.slice(-3), { ...event, createdAt: Date.now() }]);
  }, []);
  const { state, connected } = useGame(onIncrement);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClockNow(now);
      setGains((current) => current.filter((gain) => now - gain.createdAt < 1_900));
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    const stage = new GameStage();
    stageRef.current = stage;
    void stage.mount(hostRef.current);
    return () => {
      stageRef.current = null;
      stage.destroy();
    };
  }, []);

  useEffect(() => {
    stageRef.current?.setState(state);
    gameAudio.setEnabled(state.config.soundEnabled && builtinEffects);
    audioManager.setMuted(!state.config.soundEnabled);
    music.setMuted(!state.config.soundEnabled);
    music.setMatchRunning(state.phase === 'playing' && state.startedAt !== null);
    const leader: Team | null = state.teams.lula.score === state.teams.bolsonaro.score
      ? null
      : state.teams.lula.score > state.teams.bolsonaro.score ? 'lula' : 'bolsonaro';
    if (leader && previousLeader.current && leader !== previousLeader.current) gameAudio.play('lead');
    previousLeader.current = leader;
    if (state.phase === 'result' && previousPhase.current !== 'result') gameAudio.play('victory');
    if (state.phase === 'playing' && previousPhase.current !== 'playing') gameAudio.play('round');
    previousPhase.current = state.phase;
  }, [state, builtinEffects, audioManager, music]);

  const remaining = getRemainingSeconds(state, clockNow);
  useEffect(() => {
    if (state.phase === 'playing' && remaining > 0 && remaining <= 10) gameAudio.play('countdown');
  }, [remaining, state.phase]);

  const timeLabel = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  const resultText = useMemo(() => {
    if (state.winner === 'draw') return 'EMPATE!';
    if (state.winner === 'lula') return 'LULA VENCEU!';
    if (state.winner === 'bolsonaro') return 'BOLSONARO VENCEU!';
    return '';
  }, [state.winner]);
  const latestEffect = gains.at(-1);

  const unlockAudio = async () => {
    const [builtin, library] = await Promise.all([gameAudio.unlock(), unlockLibrary()]);
    setAudioReady(builtin && library === 'running');
  };
  // Na fonte de navegador do LIVE Studio/OBS o autoplay costuma ser permitido: o aviso some sozinho.
  useEffect(() => {
    if (audioStatus?.engine === 'running') void gameAudio.unlock().then((ok) => { if (ok) setAudioReady(true); });
  }, [audioStatus?.engine]);

  return (
    <main className="overlay-shell">
      <div className="game-frame">
        <div className="arena-photo" aria-hidden="true" />
        <div className="arena-vignette" aria-hidden="true" />
        <img className="politician politician--lula" src="/assets/lula-recorte.png" alt="Lula com traje presidencial" />
        <img className="politician politician--bolsonaro" src="/assets/bolsonaro-recorte.png" alt="Bolsonaro com traje presidencial" />
        <div ref={hostRef} className="pixi-host" />
        <div className="top-glass" />
        <header className="game-header">
          <div className="brand-mark"><span /><span /><span /></div>
          <div className="round-label">BATALHA DOS BLOCOS <b>• RODADA {state.round}</b></div>
          <div className={`connection-dot ${connected ? 'is-online' : ''}`} title={connected ? 'Conectado' : 'Reconectando'} />
          <div className="goal-pill"><small>META</small><strong>{state.config.target.toLocaleString('pt-BR')}</strong><span>▰</span></div>
          <div className={`timer-pill ${remaining <= 10 && state.phase === 'playing' ? 'is-critical' : ''}`}>
            <small>{state.phase === 'result' ? 'PRÓXIMA' : state.phase === 'paused' ? 'PAUSADO' : 'TEMPO'}</small>
            <strong>{state.phase === 'paused' ? 'Ⅱ' : timeLabel}</strong>
          </div>
        </header>

        <div className="teams-row">
          <TeamHud team="lula" score={state.teams.lula.score} target={state.config.target} wins={state.teams.lula.wins} />
          <TeamHud team="bolsonaro" score={state.teams.bolsonaro.score} target={state.config.target} wins={state.teams.bolsonaro.wins} />
        </div>

        <div className="versus-badge"><span>{state.teams.lula.wins}</span><b>×</b><span>{state.teams.bolsonaro.wins}</span></div>

        <GiftRail
          team="lula"
          activeId={latestEffect?.team === 'lula' ? latestEffect.giftId : undefined}
          specialActive={latestEffect?.team === 'lula' && latestEffect.effect === 'like'}
        />
        <GiftRail
          team="bolsonaro"
          activeId={latestEffect?.team === 'bolsonaro' ? latestEffect.giftId : undefined}
          specialActive={latestEffect?.team === 'bolsonaro' && latestEffect.effect === 'follow'}
        />

        <div className="gain-feed" aria-live="polite">
          {gains.map((gain) => {
            const gift = getGift(gain.giftId);
            const special = gain.effect === 'like' ? { icon: '❤', label: 'LIKE' } : gain.effect === 'follow' ? { icon: '♟', label: 'SEGUIR' } : null;
            return (
              <div className={`gain-chip gain-chip--${gain.team} ${gain.effect ? 'gain-chip--event' : ''}`} key={gain.id}>
                {gift ? (
                  <GiftIcon team={gain.team} giftId={gift.id} className="gain-chip__gift" />
                ) : (
                  <span className="gain-chip__icon">{special?.icon ?? '▰'}</span>
                )}
                <span className="gain-chip__copy"><small>{gift?.name ?? special?.label ?? 'CONSTRUÇÃO'}</small><b>+{gain.amount} BLOCOS</b></span>
              </div>
            );
          })}
        </div>

        {state.phase === 'result' && (
          <div className={`result-card result-card--${state.winner ?? 'draw'}`}>
            <span className="result-card__eyebrow">FIM DA RODADA {state.round}</span>
            <strong>{resultText}</strong>
            <p>Próxima batalha em {remaining}s</p>
          </div>
        )}

        {state.phase === 'paused' && <div className="paused-banner">PARTIDA PAUSADA</div>}

        {!audioReady && state.config.soundEnabled && (
          <button className="audio-consent" onClick={unlockAudio} aria-label="Ativar efeitos sonoros">
            <span>♪</span> TOQUE PARA ATIVAR O SOM
          </button>
        )}

        {audioDebug && <AudioDiagnostics status={audioStatus} music={musicStatus} onUnlock={() => void unlockAudio()} compact />}

        <footer className="disclaimer">JOGO INTERATIVO <span>•</span> NÃO É PESQUISA OU VOTAÇÃO ELEITORAL</footer>
      </div>
    </main>
  );
}

function getRemainingSeconds(state: GameState, now: number): number {
  if (state.phase === 'result' && state.resultStartedAt) {
    return Math.max(0, Math.ceil(state.config.resultSeconds - (now - state.resultStartedAt) / 1000));
  }
  if (!state.startedAt) return state.config.durationSeconds;
  const anchor = state.phase === 'paused' && state.pausedAt ? state.pausedAt : now;
  const elapsed = anchor - state.startedAt - state.pauseAccumulatedMs;
  return Math.max(0, Math.ceil(state.config.durationSeconds - elapsed / 1000));
}
