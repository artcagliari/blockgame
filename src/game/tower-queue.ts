import { getVisualBlockCount } from './block-visuals';
import type { IncrementEvent, Team } from './types';

/** Limite de peças aguardando queda por torre. Acima disso, peças vizinhas são agrupadas. */
export const MAX_QUEUED_PIECES = 12;

export interface QueuedTowerPiece {
  id: string;
  team: Team;
  /** Pontos representados por esta peça. Nunca se perde pontuação ao agrupar. */
  weight: number;
  scoreAtLanding: number;
  burstSize: number;
  merged?: boolean;
}

export class TowerAnimationQueue {
  private items: QueuedTowerPiece[] = [];

  enqueue(event: IncrementEvent): QueuedTowerPiece[] {
    const count = getVisualBlockCount(event.amount);
    const amount = Math.max(1, Math.round(event.amount));
    const previousTotal = Math.max(0, event.total - amount);
    const base = Math.floor(amount / count);
    const remainder = amount - base * count;
    let landed = previousTotal;
    const planned = Array.from({ length: count }, (_, index) => {
      const weight = base + (index < remainder ? 1 : 0);
      landed += weight;
      return {
        id: `${event.id}-piece-${index + 1}`,
        team: event.team,
        weight,
        scoreAtLanding: landed,
        burstSize: count,
      };
    });
    this.items.push(...planned);
    this.coalesce();
    return planned;
  }

  /** Une as peças vizinhas mais leves até respeitar o limite, preservando a soma dos pontos. */
  coalesce(maxItems = MAX_QUEUED_PIECES): void {
    while (this.items.length > maxItems && this.items.length > 1) {
      let best = 0;
      let bestWeight = Infinity;
      for (let index = 0; index < this.items.length - 1; index += 1) {
        const combined = this.items[index].weight + this.items[index + 1].weight;
        if (combined < bestWeight) {
          bestWeight = combined;
          best = index;
        }
      }
      const first = this.items[best];
      const second = this.items[best + 1];
      this.items.splice(best, 2, {
        ...second,
        weight: first.weight + second.weight,
        merged: true,
      });
    }
  }

  shift(): QueuedTowerPiece | undefined {
    return this.items.shift();
  }

  clear(): void {
    this.items.length = 0;
  }

  get length(): number {
    return this.items.length;
  }

  get pendingWeight(): number {
    return this.items.reduce((sum, item) => sum + item.weight, 0);
  }

  snapshot(): readonly QueuedTowerPiece[] {
    return [...this.items];
  }
}
