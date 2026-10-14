import type { Team } from '../game/types';

interface TeamHudProps {
  team: Team;
  score: number;
  target: number;
  wins: number;
}

export function TeamHud({ team, score, target, wins }: TeamHudProps) {
  const label = team === 'lula' ? 'LULA' : 'BOLSONARO';
  const progress = Math.min(100, (score / target) * 100);
  return (
    <section className={`team-hud team-hud--${team}`} aria-label={`Equipe ${label}`}>
      <div className="team-hud__head">
        <span className="team-hud__dot" />
        <strong>{label}</strong>
        <span className="team-hud__wins">{wins}V</span>
      </div>
      <div className="team-hud__score">{score.toLocaleString('pt-BR')}</div>
      <div className="team-hud__goal">{score.toLocaleString('pt-BR')} / {target.toLocaleString('pt-BR')} blocos</div>
      <div className="progress-track">
        <span style={{ width: `${progress}%` }} />
      </div>
    </section>
  );
}
