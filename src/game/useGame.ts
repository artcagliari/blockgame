import { useEffect, useRef, useState } from 'react';
import { gameSocket } from './socket';
import { DEFAULT_CONFIG, type GameState, type IncrementEvent, type Team } from './types';

const initialState: GameState = {
  round: 1,
  roundId: 0,
  seq: 0,
  phase: 'playing',
  teams: { lula: { score: 0, wins: 0 }, bolsonaro: { score: 0, wins: 0 } },
  config: DEFAULT_CONFIG,
  startedAt: Date.now(),
  pausedAt: null,
  pauseAccumulatedMs: 0,
  resultStartedAt: null,
  winner: null,
  serverNow: Date.now(),
};

/**
 * Estado oficial vindo do servidor. O cliente apenas representa:
 * - snapshots (`state`) com `seq` menor que o já recebido são descartados;
 * - incrementos só animam depois do snapshot da conexão e nunca mais de uma vez;
 * - se um incremento não encaixa no placar local (evento perdido), pede novo snapshot.
 */
export function useGame(onIncrement?: (event: IncrementEvent) => void) {
  const [state, setState] = useState<GameState>(initialState);
  const [connected, setConnected] = useState(gameSocket.connected);
  const lastSeq = useRef(0);
  const lastRoundId = useRef(0);
  const lastIncrementSeq = useRef(0);
  const awaitingSnapshot = useRef(true);
  const scores = useRef<Record<Team, number>>({ lula: 0, bolsonaro: 0 });
  const handlerRef = useRef(onIncrement);
  handlerRef.current = onIncrement;

  useEffect(() => {
    const handleState = (next: GameState) => {
      const sameRound = next.roundId === lastRoundId.current;
      if (sameRound && next.seq < lastSeq.current) return;
      lastSeq.current = next.seq;
      if (!sameRound) lastIncrementSeq.current = 0;
      lastRoundId.current = next.roundId;
      scores.current = { lula: next.teams.lula.score, bolsonaro: next.teams.bolsonaro.score };
      awaitingSnapshot.current = false;
      setState(next);
    };
    const handleIncrement = (event: IncrementEvent) => {
      if (awaitingSnapshot.current) return;
      if (event.roundId !== lastRoundId.current) {
        // Mudança de rodada ainda não refletida: o snapshot que a acompanha cuida disso.
        gameSocket.emit('sync');
        return;
      }
      if (event.seq <= lastIncrementSeq.current) return;
      lastIncrementSeq.current = event.seq;
      if (scores.current[event.team] !== event.total - event.amount) gameSocket.emit('sync');
      scores.current = { ...scores.current, [event.team]: event.total };
      handlerRef.current?.(event);
    };
    const handleConnect = () => {
      // Nova conexão (inclusive reconexão): o servidor envia um snapshot completo antes de tudo.
      awaitingSnapshot.current = true;
      lastSeq.current = 0;
      lastIncrementSeq.current = 0;
      setConnected(true);
    };
    const handleDisconnect = () => setConnected(false);
    gameSocket.on('state', handleState);
    gameSocket.on('roundStarted', handleState);
    gameSocket.on('roundEnded', handleState);
    gameSocket.on('increment', handleIncrement);
    gameSocket.on('connect', handleConnect);
    gameSocket.on('disconnect', handleDisconnect);
    if (gameSocket.connected) handleConnect();
    else gameSocket.connect();
    return () => {
      gameSocket.off('state', handleState);
      gameSocket.off('roundStarted', handleState);
      gameSocket.off('roundEnded', handleState);
      gameSocket.off('increment', handleIncrement);
      gameSocket.off('connect', handleConnect);
      gameSocket.off('disconnect', handleDisconnect);
    };
  }, []);

  return { state, connected, socket: gameSocket };
}
