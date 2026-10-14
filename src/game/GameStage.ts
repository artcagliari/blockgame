import { Application, Container, Graphics } from 'pixi.js';
import { TowerController } from './TowerController';
import type { GameState, IncrementEvent, Team } from './types';

const WIDTH = 1080;
const HEIGHT = 1920;
// Centros das torres: entre as listas de presentes (bordas) e a linha central,
// à frente do corpo dos candidatos e sem cobrir os rostos.
const TOWER_X: Record<Team, number> = { lula: 400, bolsonaro: 680 };
const COLORS = {
  lula: 0xef233c,
  bolsonaro: 0x24d66f,
  gold: 0xffcb45,
};

interface CelebrationParticle {
  node: Graphics;
  vx: number;
  vy: number;
  life: number;
  gravity: number;
  spin: number;
}

function towerDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('debugTower');
}

export class GameStage {
  private app = new Application();
  private root = new Container();
  private lulaTower = new TowerController({
    team: 'lula',
    x: TOWER_X.lula,
    debug: towerDebugEnabled(),
    palette: { main: 0xff304a, light: 0xd91435, dark: 0x8d1025, edge: 0xff7588 },
  });
  private bolsonaroTower = new TowerController({
    team: 'bolsonaro',
    x: TOWER_X.bolsonaro,
    debug: towerDebugEnabled(),
    palette: { main: 0x1ed779, light: 0x13a95d, dark: 0x08753b, edge: 0x78ffc0 },
  });
  private towers: Record<Team, TowerController> = {
    lula: this.lulaTower,
    bolsonaro: this.bolsonaroTower,
  };
  private celebrationLayer = new Container();
  private celebrationParticles: CelebrationParticle[] = [];
  private previousPhase: GameState['phase'] = 'playing';
  private destroyed = false;
  private initialized = false;

  async mount(host: HTMLElement): Promise<void> {
    await this.app.init({
      width: WIDTH,
      height: HEIGHT,
      antialias: true,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    this.initialized = true;
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    this.app.canvas.className = 'game-canvas';
    // O Pixi (autoDensity) grava style.width/height inline em px de design (1080×1920),
    // o que vence qualquer regra CSS e deixa as torres fora do quadro quando o overlay
    // não mede exatamente 1080×1920. O canvas precisa acompanhar o host.
    this.app.canvas.style.width = '100%';
    this.app.canvas.style.height = '100%';
    this.app.canvas.setAttribute('aria-label', 'Duas torres independentes da Batalha dos Blocos');
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.root);
    this.drawBackground();
    this.root.addChild(this.lulaTower.container);
    this.root.addChild(this.bolsonaroTower.container);
    this.root.addChild(this.celebrationLayer);
    if (towerDebugEnabled()) {
      // Leitura somente para diagnóstico/testes: window.__towers() devolve o estado das duas torres.
      (window as unknown as { __towers?: () => unknown }).__towers = () => this.getTowerSnapshots();
    }
    this.app.ticker.add((ticker) => this.animate(ticker.deltaMS / 1000));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.initialized) this.app.destroy(true, { children: true });
  }

  setState(state: GameState): void {
    this.lulaTower.syncScore(state.teams.lula.score, state.config.target);
    this.bolsonaroTower.syncScore(state.teams.bolsonaro.score, state.config.target);
    if (state.phase === 'result' && this.previousPhase !== 'result') this.celebrate(state.winner);
    this.previousPhase = state.phase;
  }

  impact(event: IncrementEvent): void {
    this.towers[event.team].enqueue(event);
  }

  getTowerSnapshots() {
    return {
      lula: this.lulaTower.getSnapshot(),
      bolsonaro: this.bolsonaroTower.getSnapshot(),
    };
  }

  private animate(dt: number): void {
    this.lulaTower.update(dt);
    this.bolsonaroTower.update(dt);
    this.celebrationParticles = this.celebrationParticles.filter((particle) => {
      particle.life -= dt;
      particle.vy += particle.gravity * dt;
      particle.node.x += particle.vx * dt;
      particle.node.y += particle.vy * dt;
      particle.node.rotation += particle.spin * dt;
      particle.node.alpha = Math.min(1, particle.life * 1.8);
      if (particle.life <= 0) {
        this.celebrationLayer.removeChild(particle.node);
        particle.node.destroy();
        return false;
      }
      return true;
    });
  }

  private drawBackground(): void {
    const split = new Graphics();
    split.rect(0, 300, 540, 1620).fill({ color: COLORS.lula, alpha: .065 });
    split.rect(540, 300, 540, 1620).fill({ color: COLORS.bolsonaro, alpha: .06 });
    split.rect(535, 330, 10, 1530).fill({ color: 0xffffff, alpha: .16 });
    split.rect(538, 330, 4, 1530).fill({ color: 0xffffff, alpha: .58 });
    this.root.addChild(split);

    const constructionLanes = new Graphics();
    constructionLanes.roundRect(TOWER_X.lula - 155, 650, 310, 1090, 34).fill({ color: 0x260713, alpha: .12 });
    constructionLanes.roundRect(TOWER_X.bolsonaro - 155, 650, 310, 1090, 34).fill({ color: 0x032d1a, alpha: .11 });
    constructionLanes.moveTo(TOWER_X.lula, 690).lineTo(TOWER_X.lula, 1730).stroke({ color: COLORS.lula, alpha: .11, width: 3 });
    constructionLanes.moveTo(TOWER_X.bolsonaro, 690).lineTo(TOWER_X.bolsonaro, 1730).stroke({ color: COLORS.bolsonaro, alpha: .11, width: 3 });
    this.root.addChild(constructionLanes);

    const floor = new Graphics();
    floor.moveTo(0, 1720).lineTo(1080, 1720).lineTo(1080, 1920).lineTo(0, 1920).closePath().fill({ color: 0x061321, alpha: .88 });
    for (let y = 1730; y < 1920; y += 46) {
      floor.moveTo(0, y).lineTo(1080, y).stroke({ color: 0x1b405e, alpha: .32, width: 2 });
    }
    this.root.addChild(floor);
  }

  private celebrate(winner: Team | 'draw' | null): void {
    const center = winner === 'lula' ? TOWER_X.lula : winner === 'bolsonaro' ? TOWER_X.bolsonaro : 540;
    for (let index = 0; index < 120; index += 1) {
      const palette = [COLORS.lula, COLORS.bolsonaro, COLORS.gold, 0xffffff, 0x41b6ff];
      const node = new Graphics().roundRect(-7, -13, 14, 26, 3).fill(palette[index % palette.length]);
      node.x = center + (Math.random() - .5) * 380;
      node.y = 430 + Math.random() * 120;
      this.celebrationLayer.addChild(node);
      this.celebrationParticles.push({
        node,
        vx: (Math.random() - .5) * 530,
        vy: -180 - Math.random() * 500,
        life: 2.8 + Math.random() * 2,
        gravity: 330,
        spin: (Math.random() - .5) * 12,
      });
    }
  }
}
