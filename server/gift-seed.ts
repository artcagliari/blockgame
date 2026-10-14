/**
 * Mapeamento inicial informado pelo operador (IDs reais do TikTok).
 *
 * - Cada slot recebe o giftId cujo nome corresponde ao ícone do jogo; para a faixa de
 *   +500 a correspondência vem da ordem da tabela original (Lula, depois Bolsonaro).
 * - NENHUM ID é inventado: "Boa noite" ainda não tem ID e fica fora.
 * - A semente só preenche slots VAZIOS e é aplicada uma única vez por banco; depois disso
 *   o painel administrativo é a fonte da verdade.
 */
export interface SeedMapping {
  slotId: string;
  giftId: string;
  /** Nome informado pelo operador (não é o nome do TikTok). */
  name: string;
  basis: 'name' | 'tier-order';
}

export const GIFT_SEED_VERSION = 1;

export const GIFT_SEED: SeedMapping[] = [
  { slotId: 'lula:impulso', giftId: '5655', name: 'Rose', basis: 'name' },
  { slotId: 'lula:super-impulso', giftId: '8913', name: 'Rosa', basis: 'tier-order' },
  { slotId: 'lula:turbo', giftId: '5879', name: 'Rosquinha', basis: 'name' },
  { slotId: 'lula:escudo', giftId: '6427', name: 'Chapéu e Bigode', basis: 'name' },
  { slotId: 'lula:recuperacao', giftId: '919332', name: 'Ney místico', basis: 'tier-order' },
  { slotId: 'lula:ultra-turbo', giftId: '1266941', name: 'Coroa', basis: 'name' },
  { slotId: 'bolsonaro:impulso', giftId: '8239', name: 'Rosa branca', basis: 'name' },
  { slotId: 'bolsonaro:super-impulso', giftId: '6560', name: 'Mini dino', basis: 'name' },
  { slotId: 'bolsonaro:turbo', giftId: '14488', name: 'Capybara', basis: 'name' },
  { slotId: 'bolsonaro:escudo', giftId: '5659', name: 'Grou de papel', basis: 'name' },
  { slotId: 'bolsonaro:recuperacao', giftId: '282718', name: 'Clarinete do groove', basis: 'tier-order' },
  { slotId: 'bolsonaro:ultra-turbo', giftId: '5794', name: 'Coqueiro', basis: 'name' },
];

/** Presentes conhecidos que NÃO pertencem a nenhum dos 12 slots (ficam sem pontuar). */
export const KNOWN_UNMAPPED: Array<{ giftId: string; name: string }> = [
  { giftId: '7934', name: 'Heart Me' },
  { giftId: '231956', name: 'Palmas' },
  { giftId: '6007', name: 'Luvas de boxe' },
  { giftId: '6267', name: 'Corgi' },
  { giftId: '58236', name: 'Dança do Cacto' },
  { giftId: '7168', name: 'Pistola de dinheiro' },
  { giftId: '9948', name: 'Você é demais' },
];

/** Informados sem ID. Nunca inventar. */
export const PENDING_IDS = ['Boa noite'];
