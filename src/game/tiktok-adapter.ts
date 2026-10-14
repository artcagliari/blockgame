import type { Team } from './types';

/**
 * Contrato reservado para uma integração futura com TikTok LIVE.
 * A implementação atual não abre conexão nem interpreta presentes reais.
 */
export interface LiveEventAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onTeamIncrement(callback: (team: Team, amount: number) => void): () => void;
  onGiftEffect(callback: (giftId: string, sender: string) => void): () => void;
}
