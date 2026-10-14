import type { CSSProperties } from 'react';
import { GIFTS } from '../game/gifts';
import type { Team } from '../game/types';

interface GiftIconProps {
  team: Team;
  giftId: string;
  className?: string;
}

export function GiftIcon({ team, giftId, className = '' }: GiftIconProps) {
  const giftIndex = Math.max(0, GIFTS.findIndex((gift) => gift.id === giftId));
  const style = { '--gift-position': `${giftIndex * 20}%` } as CSSProperties;

  return (
    <span
      className={`gift-icon gift-icon--${team} ${className}`.trim()}
      style={style}
      role="img"
      aria-label={GIFTS[giftIndex]?.labels[team] ?? 'Presente'}
    />
  );
}
