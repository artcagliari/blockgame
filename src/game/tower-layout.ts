// Layout determinístico da torre: depende somente da pontuação lógica e da meta.
// A animação decide QUANDO cada placa aparece; esta função decide ONDE ela fica.
// Por isso a torre restaurada após recarregar o overlay é idêntica à construída ao vivo.

export const BASE_Y = 1712;
export const TOP_LIMIT = 800;
export const AVAILABLE_HEIGHT = BASE_Y - TOP_LIMIT;
export const SLAB_HEIGHT = 16;
/** Distância mínima entre duas placas assentadas; abaixo disso a placa é absorvida pela do topo. */
export const MIN_SLAB_GAP = 7;
const MAX_RISE_PER_POINT = 18;

function clampScore(score: number, target: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(Math.max(1, target), Math.max(0, Math.round(score)));
}

/**
 * Deslocamento vertical (px) da placa do topo em relação à primeira placa.
 * Curva logarítmica: cada ponto no início sobe ~15px (cada +1 é visível) e a torre
 * continua subindo até a meta, onde alcança exatamente o limite superior.
 */
export function towerHeight(score: number, target: number): number {
  const safeTarget = Math.max(1, target);
  const s = clampScore(score, safeTarget);
  if (s <= 1) return 0;
  const b = Math.max(1, safeTarget * .0055);
  const full = Math.log1p(safeTarget / b);
  const h = AVAILABLE_HEIGHT * Math.log1p(s / b) / full;
  const h1 = AVAILABLE_HEIGHT * Math.log1p(1 / b) / full;
  return Math.min(h - h1, (s - 1) * MAX_RISE_PER_POINT);
}

/**
 * Deslocamentos das placas da pilha, da base ao topo. A última é a placa do topo,
 * que acompanha a altura real; as demais ficam congeladas com espaçamento ≥ MIN_SLAB_GAP.
 * O número de placas é limitado (~130), independentemente da pontuação.
 */
export function layoutOffsets(score: number, target: number): number[] {
  const safeTarget = Math.max(1, target);
  const s = clampScore(score, safeTarget);
  if (s <= 0) return [];
  const frozen: number[] = [];
  let anchor = 0;
  let top = 0;
  for (let point = 2; point <= s; point += 1) {
    const offset = towerHeight(point, safeTarget);
    if (offset - anchor >= MIN_SLAB_GAP) {
      frozen.push(top);
      anchor = offset;
    }
    top = offset;
  }
  return [...frozen, top];
}
