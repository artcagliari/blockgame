import { GIFTS } from '../game/gifts';
import type { Team } from '../game/types';
import { GiftIcon } from './GiftIcon';

export function GiftRail({ team, activeId, specialActive, likesPerBlock = 1 }: { team: Team; activeId?: string; specialActive?: boolean; likesPerBlock?: number }) {
  return (
    <aside className={`gift-rail gift-rail--${team}`} aria-label={`Presentes da equipe ${team}`}>
      <div className={`special-trigger ${specialActive ? 'is-active' : ''}`}>
        <span>{team === 'lula' ? '❤' : '♟'}</span>
        {team === 'lula' && likesPerBlock > 1 ? (
          <div className="special-trigger__copy"><b>{likesPerBlock} LIKES</b><small>= 1 BLOCO</small></div>
        ) : (
          <>
            <b>{team === 'lula' ? 'LIKE' : 'SEGUIR'}</b>
            <small>+1 BLOCO</small>
          </>
        )}
      </div>
      <div className="gift-rail__title">PRESENTES</div>
      {GIFTS.map((gift) => (
        <div className={`gift-card ${activeId === gift.id ? 'is-active' : ''}`} key={gift.id} title={`${gift.labels[team]}: +${gift.amount} blocos`}>
          <GiftIcon team={team} giftId={gift.id} className="gift-card__icon" />
          <span className="gift-card__copy"><b>{gift.name}</b><small>+{gift.amount} BLOCOS</small></span>
        </div>
      ))}
    </aside>
  );
}
