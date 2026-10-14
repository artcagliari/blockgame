import { Container, Graphics } from 'pixi.js';
import { BASE_Y, SLAB_HEIGHT, layoutOffsets } from './tower-layout';
import { TowerAnimationQueue, type QueuedTowerPiece } from './tower-queue';
import type { IncrementEvent, Team } from './types';

/** Altura acima do topo da pilha em que a placa aparece antes de cair. */
const SPAWN_HEIGHT = 260;
const SPAWN_MIN_Y = -40;
const SLAB_WIDTHS = [220, 236, 228, 246, 232];
const SLAB_JITTER = [-12, 8, -5, 13, 0];

interface TowerPalette {
  main: number;
  light: number;
  dark: number;
  edge: number;
}

interface Slab {
  node: Graphics;
  targetY: number;
}

interface ActivePiece {
  item: QueuedTowerPiece;
  node: Container;
  plates: number;
  state: 'falling' | 'impact' | 'settling';
  elapsed: number;
  fall: number;
  impact: number;
  settle: number;
  startY: number;
  targetY: number;
  landedScore: number;
}

interface ImpactParticle {
  node: Graphics;
  vx: number;
  vy: number;
  life: number;
}

interface TowerControllerOptions {
  team: Team;
  x: number;
  palette: TowerPalette;
  debug?: boolean;
  target?: number;
}

/**
 * Uma torre independente. Cada instância possui fila, peça em queda, placas assentadas,
 * coordenadas e partículas próprias; nada é compartilhado entre as equipes.
 */
export class TowerController {
  readonly container = new Container();
  readonly settledLayer = new Container();
  readonly fallingLayer = new Container();
  readonly effectsLayer = new Container();

  private readonly team: Team;
  private readonly x: number;
  private readonly palette: TowerPalette;
  private readonly debug: boolean;
  private readonly queue = new TowerAnimationQueue();
  private slabs: Slab[] = [];
  private active: ActivePiece | null = null;
  private particles: ImpactParticle[] = [];
  /** Maior pontuação conhecida (eventos recebidos). */
  private logicalScore = 0;
  /** Pontuação já representada pela pilha assentada. */
  private landedScore = 0;
  private target: number;

  constructor({ team, x, palette, debug = false, target = 2000 }: TowerControllerOptions) {
    this.team = team;
    this.x = x;
    this.palette = palette;
    this.debug = debug;
    this.target = Math.max(1, target);
    this.container.addChild(this.settledLayer, this.fallingLayer, this.effectsLayer);
  }

  enqueue(event: IncrementEvent): void {
    if (event.team !== this.team) return;
    const planned = this.queue.enqueue(event);
    this.logicalScore = Math.max(this.logicalScore, event.total);
    this.log('queued', {
      eventId: event.id,
      score: event.total,
      amount: event.amount,
      pieces: planned.length,
      queueLength: this.queue.length,
    });
    this.startNextPiece();
  }

  /** Reconcilia com o estado oficial. Nunca reproduz animações antigas. */
  syncScore(score: number, target: number): void {
    const nextTarget = Math.max(1, target);
    const targetChanged = nextTarget !== this.target;
    this.target = nextTarget;
    const idle = !this.active && this.queue.length === 0;
    if (score < this.logicalScore || (targetChanged && idle)) {
      this.restore(score);
      return;
    }
    if (score > this.logicalScore) {
      this.logicalScore = score;
      if (idle) this.restore(score);
    }
  }

  update(dt: number): void {
    const safeDt = Math.min(dt, .05);
    for (const slab of this.slabs) {
      const diff = slab.targetY - slab.node.y;
      slab.node.y = Math.abs(diff) < .05 ? slab.targetY : slab.node.y + diff * Math.min(1, safeDt * 16);
    }
    this.updateActive(safeDt);
    this.updateParticles(safeDt);
    if (!this.active) this.startNextPiece();
  }

  reset(): void {
    this.restore(0);
  }

  getSnapshot() {
    const activePiece = this.active
      ? {
          id: this.active.item.id,
          state: this.active.state,
          x: this.active.node.x,
          y: this.active.node.y,
          targetY: this.active.targetY,
          plates: this.active.plates,
          weight: this.active.item.weight,
        }
      : null;
    const top = this.slabs.at(-1);
    return {
      team: this.team,
      x: this.x,
      logicalScore: this.logicalScore,
      landedScore: this.landedScore,
      queued: this.queue.length,
      queuedWeight: this.queue.pendingWeight,
      hasActivePiece: Boolean(this.active),
      activePiece,
      fallingNodes: this.fallingLayer.children.length,
      settledLayers: this.slabs.length,
      settledTopY: top?.targetY ?? null,
      stackHeight: top ? BASE_Y - top.targetY : 0,
      particles: this.particles.length,
    };
  }

  private startNextPiece(): void {
    if (this.active) return;
    const item = this.queue.shift();
    if (!item) return;

    const newScore = Math.min(this.target, Math.max(this.landedScore + 1, Math.round(item.scoreAtLanding)));
    const offsets = layoutOffsets(newScore, this.target);
    const topIndex = Math.max(0, offsets.length - 1);
    const targetY = BASE_Y - (offsets.at(-1) ?? 0);
    const startY = Math.max(SPAWN_MIN_Y, targetY - SPAWN_HEIGHT);
    const plates = item.weight >= 40 ? 3 : item.weight >= 8 ? 2 : 1;

    // Quanto maior o atraso da fila, mais rápida a cadência; a fila nunca fica para trás.
    const pace = Math.min(4.5, 1 + this.queue.length / 3);
    const group = new Container();
    group.x = this.x + this.horizontalOffset(topIndex);
    group.y = startY;
    group.alpha = 0;
    for (let plate = 0; plate < plates; plate += 1) {
      const slab = this.makeBlock(topIndex - plate);
      slab.y = -plate * (SLAB_HEIGHT + 3);
      group.addChild(slab);
    }
    this.fallingLayer.addChild(group);
    this.active = {
      item,
      node: group,
      plates,
      state: 'falling',
      elapsed: 0,
      fall: .3 / pace,
      impact: .07 / Math.min(pace, 2),
      settle: .08 / Math.min(pace, 2),
      startY,
      targetY,
      landedScore: newScore,
    };
    this.log('falling', {
      pieceId: item.id,
      score: item.scoreAtLanding,
      weight: item.weight,
      x: group.x,
      startY,
      targetY,
      queueLength: this.queue.length,
    });
  }

  private updateActive(dt: number): void {
    const piece = this.active;
    if (!piece) return;
    piece.elapsed += dt;

    if (piece.state === 'falling') {
      const t = Math.min(1, piece.elapsed / piece.fall);
      piece.node.y = piece.startY + (piece.targetY - piece.startY) * t * t;
      piece.node.alpha = Math.min(1, t * 5);
      piece.node.rotation = (1 - t) * (this.team === 'lula' ? -.03 : .03);
      if (t >= 1) {
        piece.state = 'impact';
        piece.elapsed = 0;
        piece.node.rotation = 0;
        this.createImpact(piece.node.x, piece.targetY, piece.item.weight);
        this.log('impact', { pieceId: piece.item.id, score: piece.item.scoreAtLanding, x: piece.node.x, y: piece.targetY });
      }
      return;
    }

    if (piece.state === 'impact') {
      const t = Math.min(1, piece.elapsed / piece.impact);
      const pulse = Math.sin(t * Math.PI);
      piece.node.y = piece.targetY + pulse * 4;
      piece.node.scale.set(1 + pulse * .035, 1 - pulse * .22);
      if (t >= 1) {
        piece.state = 'settling';
        piece.elapsed = 0;
      }
      return;
    }

    const t = Math.min(1, piece.elapsed / piece.settle);
    const bounce = Math.sin(t * Math.PI) * (1 - t);
    piece.node.y = piece.targetY - bounce * 4;
    piece.node.scale.set(1 - bounce * .018, 1 + bounce * .09);
    if (t >= 1) this.commitActivePiece();
  }

  /** Converte a peça em queda em camadas assentadas. A altura sempre aumenta ou acompanha o placar. */
  private commitActivePiece(): void {
    const piece = this.active;
    if (!piece) return;
    const landingX = piece.node.x;
    const landingY = piece.targetY;
    this.fallingLayer.removeChild(piece.node);
    piece.node.destroy({ children: true });
    this.active = null;

    this.landedScore = Math.max(this.landedScore, piece.landedScore);
    this.applyLayout(layoutOffsets(this.landedScore, this.target), landingX, landingY);
    this.log('settled', {
      pieceId: piece.item.id,
      score: piece.item.scoreAtLanding,
      settledLayers: this.slabs.length,
      stackHeight: BASE_Y - (this.slabs.at(-1)?.targetY ?? BASE_Y),
      queueLength: this.queue.length,
    });
    this.startNextPiece();
  }

  private applyLayout(offsets: number[], landingX: number, landingY: number): void {
    const previous = this.slabs.length;
    if (offsets.length > previous) {
      for (let index = previous; index < offsets.length; index += 1) {
        const node = this.makeBlock(index);
        const isTop = index === offsets.length - 1;
        node.x = isTop ? landingX : this.x + this.horizontalOffset(index);
        node.y = landingY;
        this.settledLayer.addChild(node);
        this.slabs.push({ node, targetY: BASE_Y - offsets[index] });
      }
    } else if (offsets.length === previous && previous > 0) {
      // Placa absorvida: a nova placa assume o topo, que sobe de forma contínua.
      const topIndex = previous - 1;
      const old = this.slabs[topIndex];
      this.settledLayer.removeChild(old.node);
      old.node.destroy();
      const node = this.makeBlock(topIndex);
      node.x = landingX;
      node.y = landingY;
      this.settledLayer.addChild(node);
      this.slabs[topIndex] = { node, targetY: landingY };
    } else {
      while (this.slabs.length > offsets.length) {
        const removed = this.slabs.pop();
        if (removed) {
          this.settledLayer.removeChild(removed.node);
          removed.node.destroy();
        }
      }
    }
    offsets.forEach((offset, index) => {
      this.slabs[index].targetY = BASE_Y - offset;
    });
  }

  private restore(score: number): void {
    this.clearVisuals();
    const safeScore = Math.max(0, score);
    this.logicalScore = safeScore;
    this.landedScore = safeScore;
    const offsets = layoutOffsets(safeScore, this.target);
    offsets.forEach((offset, index) => {
      const node = this.makeBlock(index);
      node.x = this.x + this.horizontalOffset(index);
      node.y = BASE_Y - offset;
      this.settledLayer.addChild(node);
      this.slabs.push({ node, targetY: node.y });
    });
    this.log('restored', { score: safeScore, settledLayers: offsets.length });
  }

  private clearVisuals(): void {
    this.queue.clear();
    this.active = null;
    this.slabs = [];
    this.particles = [];
    for (const layer of [this.settledLayer, this.fallingLayer, this.effectsLayer]) {
      for (const child of layer.removeChildren()) child.destroy({ children: true });
    }
  }

  /** Placa fina, horizontal e comprida: face frontal, topo claro, sombra inferior e lateral escura. */
  private makeBlock(index: number): Graphics {
    const safeIndex = Math.max(0, index);
    const width = SLAB_WIDTHS[(safeIndex * 3) % SLAB_WIDTHS.length];
    const half = width / 2;
    const h = SLAB_HEIGHT;
    const color = safeIndex % 2 === 0 ? this.palette.main : this.palette.light;
    const block = new Graphics();
    block.roundRect(-half + 3, h / 2 - 3, width, 5, 2).fill({ color: 0x020912, alpha: .4 });
    block.roundRect(-half, -h / 2, width, h, 3).fill(color).stroke({ color: this.palette.edge, alpha: .9, width: 1.5 });
    block.rect(-half + 4, -h / 2 + 1.5, width - 8, 4).fill({ color: 0xffffff, alpha: .28 });
    block.rect(-half + 2, h / 2 - 5, width - 4, 4).fill({ color: this.palette.dark, alpha: .75 });
    block.poly([half - 10, -h / 2 + 2, half - 1, -h / 2 + 2, half - 1, h / 2 - 2, half - 10, h / 2 - 2]).fill({ color: this.palette.dark, alpha: .55 });
    return block;
  }

  private horizontalOffset(index: number): number {
    return SLAB_JITTER[Math.max(0, index) % SLAB_JITTER.length];
  }

  private createImpact(x: number, y: number, weight: number): void {
    const flash = new Graphics();
    flash.ellipse(0, 0, 112, 20).fill({ color: this.palette.edge, alpha: weight >= 8 ? .5 : .32 });
    flash.x = x;
    flash.y = y;
    this.effectsLayer.addChild(flash);
    this.particles.push({ node: flash, vx: 0, vy: 0, life: .2 });
    const count = 5 + Math.min(7, Math.floor(weight / 6));
    for (let index = 0; index < count; index += 1) {
      const node = new Graphics().circle(0, 0, 3 + Math.random() * 4).fill(this.palette.edge);
      node.x = x + (Math.random() - .5) * 190;
      node.y = y;
      this.effectsLayer.addChild(node);
      this.particles.push({
        node,
        vx: (Math.random() - .5) * 230,
        vy: -70 - Math.random() * 135,
        life: .4 + Math.random() * .25,
      });
    }
  }

  private updateParticles(dt: number): void {
    this.particles = this.particles.filter((particle) => {
      particle.life -= dt;
      particle.vy += 420 * dt;
      particle.node.x += particle.vx * dt;
      particle.node.y += particle.vy * dt;
      particle.node.alpha = Math.max(0, Math.min(1, particle.life * 4));
      if (particle.life <= 0) {
        this.effectsLayer.removeChild(particle.node);
        particle.node.destroy();
        return false;
      }
      return true;
    });
  }

  private log(state: string, details: Record<string, unknown>): void {
    if (!this.debug) return;
    console.debug('[TowerController]', {
      team: this.team,
      state,
      timestamp: performance.now().toFixed(1),
      ...details,
    });
  }
}
