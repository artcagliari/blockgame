import type { Team } from './types';

export interface GiftDefinition {
  id: string;
  name: string;
  amount: number;
  labels: Record<Team, string>;
}

export const GIFTS: GiftDefinition[] = [
  { id: 'impulso', name: 'IMPULSO', amount: 5, labels: { lula: 'Rosa vermelha', bolsonaro: 'Rosa branca' } },
  { id: 'super-impulso', name: 'SUPER IMPULSO', amount: 10, labels: { lula: 'Flor rosa', bolsonaro: 'Dinossauro verde' } },
  { id: 'turbo', name: 'TURBO', amount: 30, labels: { lula: 'Donut', bolsonaro: 'Capivara' } },
  { id: 'escudo', name: 'ESCUDO', amount: 100, labels: { lula: 'Chapéu', bolsonaro: 'Origami branco' } },
  { id: 'recuperacao', name: 'RECUPERAÇÃO', amount: 500, labels: { lula: 'Gênio azul', bolsonaro: 'Saxofone' } },
  { id: 'ultra-turbo', name: 'ULTRA TURBO', amount: 1000, labels: { lula: 'Coroa', bolsonaro: 'Ilha tropical' } },
];

export function getGift(id?: string): GiftDefinition | undefined {
  return GIFTS.find((gift) => gift.id === id);
}
