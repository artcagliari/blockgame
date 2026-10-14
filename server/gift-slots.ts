import type { Team } from '../src/game/types.js';

/**
 * Os 12 presentes VISUAIS do jogo. Não são IDs do TikTok: cada slot é associado, pelo
 * administrador, a um giftId real. Espelha src/game/gifts.ts (há teste garantindo igualdade).
 */
export interface GiftSlot {
  slotId: string;
  team: Team;
  /** Identificador visual (usado pelo overlay para destacar o ícone). */
  visualId: string;
  visualName: string;
  label: string;
  defaultBlocks: number;
}

const BASE = [
  { visualId: 'impulso', visualName: 'IMPULSO', blocks: 5, lula: 'Rosa vermelha', bolsonaro: 'Rosa branca' },
  { visualId: 'super-impulso', visualName: 'SUPER IMPULSO', blocks: 10, lula: 'Flor rosa', bolsonaro: 'Dinossauro verde' },
  { visualId: 'turbo', visualName: 'TURBO', blocks: 30, lula: 'Donut', bolsonaro: 'Capivara' },
  { visualId: 'escudo', visualName: 'ESCUDO', blocks: 100, lula: 'Chapéu', bolsonaro: 'Origami branco' },
  { visualId: 'recuperacao', visualName: 'RECUPERAÇÃO', blocks: 500, lula: 'Gênio azul', bolsonaro: 'Saxofone' },
  { visualId: 'ultra-turbo', visualName: 'ULTRA TURBO', blocks: 1000, lula: 'Coroa', bolsonaro: 'Ilha tropical' },
] as const;

export const GIFT_SLOTS: GiftSlot[] = (['lula', 'bolsonaro'] as const).flatMap((team) =>
  BASE.map((gift) => ({
    slotId: `${team}:${gift.visualId}`,
    team,
    visualId: gift.visualId,
    visualName: gift.visualName,
    label: gift[team],
    defaultBlocks: gift.blocks,
  })),
);

export function getSlot(slotId: string): GiftSlot | undefined {
  return GIFT_SLOTS.find((slot) => slot.slotId === slotId);
}
