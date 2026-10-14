import type { DiagnosticLiveEvent, FollowLiveEvent, GiftLiveEvent, LikeLiveEvent } from './events.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>;

const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
const int = (value: unknown, fallback = 0): number => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
};
const firstUrl = (image: Raw | undefined | null): string | null => {
  const url = image?.urlList?.[0] ?? image?.url_list?.[0] ?? image?.url?.[0] ?? null;
  return typeof url === 'string' && url.length > 0 ? url : null;
};

function who(data: Raw) {
  const user: Raw = data.user ?? {};
  const userId = text(user.userId ?? user.userIdStr ?? user.id ?? user.uniqueId ?? user.displayId);
  const userName = text(user.nickname ?? user.uniqueId ?? user.displayId);
  return { userId: userId === '0' ? '' : userId, userName };
}

function envelope(data: Raw, now: number, roomFallback: string) {
  return {
    msgId: text(data.common?.msgId ?? data.msgId ?? data.logId),
    roomId: text(data.common?.roomId ?? data.roomId) || roomFallback,
    at: now,
    ...who(data),
  };
}

/**
 * tiktok-live-connector 2.x entrega as mensagens do protobuf v3 (giftId, repeatCount,
 * repeatEnd:number, groupId, gift{ id, name, diamondCount, type, combo, image }).
 * Versões/camadas legadas usam giftDetails, extendedGiftInfo, likeCount e totalLikeCount;
 * aceitamos ambos, sem inventar valores ausentes.
 */
export function normalizeGift(data: Raw, roomFallback: string, now = Date.now()): GiftLiveEvent {
  const details: Raw = data.gift ?? data.giftDetails ?? {};
  const extended: Raw = data.extendedGiftInfo ?? {};
  const giftType = details.type ?? details.giftType ?? data.giftType ?? extended.type;
  const groupId = text(data.groupId);
  const hasGroup = groupId !== '' && groupId !== '0';
  const streakable = giftType === 1 || details.combo === true || (giftType === undefined && hasGroup);
  return {
    type: 'gift',
    ...envelope(data, now, roomFallback),
    giftId: text(data.giftId ?? details.id),
    giftName: text(details.name ?? details.giftName ?? data.giftName ?? extended.name) || null,
    imageUrl:
      firstUrl(details.image) ?? firstUrl(details.icon)
      ?? (text(details.giftImage?.giftPictureUrl ?? data.giftPictureUrl) || null)
      ?? firstUrl(extended.image),
    coins: Number.isFinite(Number(details.diamondCount ?? details.diamond_count ?? data.diamondCount ?? extended.diamond_count))
      ? int(details.diamondCount ?? details.diamond_count ?? data.diamondCount ?? extended.diamond_count)
      : null,
    streakable,
    repeatCount: Math.max(1, int(data.repeatCount ?? data.comboCount, 1)),
    repeatEnd: Boolean(Number(data.repeatEnd)) || data.repeatEnd === true,
    groupId: hasGroup ? groupId : '',
  };
}

export function normalizeLike(data: Raw, roomFallback: string, now = Date.now()): LikeLiveEvent {
  const total = data.total ?? data.totalLikeCount;
  return {
    type: 'like',
    ...envelope(data, now, roomFallback),
    count: int(data.count ?? data.likeCount, 0),
    total: total === undefined || total === null || !Number.isFinite(Number(total)) ? null : int(total),
  };
}

export function normalizeFollow(data: Raw, via: 'follow' | 'social', roomFallback: string, now = Date.now()): FollowLiveEvent {
  return { type: 'follow', via, ...envelope(data, now, roomFallback) };
}

/** Classifica uma mensagem "social" genérica; só trata como follow quando houver evidência explícita. */
export function classifySocial(data: Raw): 'follow' | 'share' | 'other' {
  const haystack = [data.action, data.common?.displayText?.key, data.common?.displayText?.defaultPattern, data.displayType]
    .map((value) => text(value).toLowerCase())
    .join(' ');
  if (haystack.includes('follow')) return 'follow';
  if (haystack.includes('share')) return 'share';
  return 'other';
}

export function normalizeDiagnostic(type: DiagnosticLiveEvent['type'], data: Raw, roomFallback: string, now = Date.now()): DiagnosticLiveEvent {
  return { type, ...envelope(data, now, roomFallback), text: type === 'comment' ? text(data.comment).slice(0, 80) : undefined };
}
