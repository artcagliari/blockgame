import { describe, expect, it } from 'vitest';
import { classifySocial, normalizeFollow, normalizeGift, normalizeLike } from './tiktok/normalize.js';

describe('normalização de eventos do conector', () => {
  it('presente no formato protobuf v3 (tiktok-live-connector 2.x)', () => {
    const event = normalizeGift({
      common: { msgId: '7300000000000000001', roomId: '7299' },
      giftId: '5655', repeatCount: 3, repeatEnd: 0, groupId: '123456',
      user: { userId: '555', uniqueId: 'ana', nickname: 'Ana' },
      gift: { id: '5655', name: 'Rose', diamondCount: 1, type: 1, combo: true, image: { urlList: ['https://cdn/rose.png'] } },
    }, 'fallback-room');
    expect(event).toMatchObject({
      type: 'gift', msgId: '7300000000000000001', roomId: '7299', userId: '555', userName: 'Ana',
      giftId: '5655', giftName: 'Rose', coins: 1, imageUrl: 'https://cdn/rose.png',
      streakable: true, repeatCount: 3, repeatEnd: false, groupId: '123456',
    });
  });

  it('presente no formato legado (giftDetails)', () => {
    const event = normalizeGift({
      giftId: 5655, repeatCount: 2, repeatEnd: true, groupId: '9',
      user: { userId: '77', uniqueId: 'bob' },
      giftDetails: { giftName: 'Donut', giftType: 1, diamondCount: 30, giftImage: { giftPictureUrl: 'https://cdn/d.png' } },
    }, 'room');
    expect(event).toMatchObject({ giftId: '5655', giftName: 'Donut', coins: 30, repeatEnd: true, streakable: true, imageUrl: 'https://cdn/d.png', roomId: 'room' });
  });

  it('presente sem metadados nem groupId não é sequência e nada é inventado', () => {
    const event = normalizeGift({ giftId: '1', repeatCount: 1, user: {} }, 'room');
    expect(event).toMatchObject({ streakable: false, groupId: '', coins: null, giftName: null, userId: '', msgId: '', imageUrl: null });
  });

  it('tipo desconhecido com groupId é tratado como sequência (conservador contra duplicação)', () => {
    const event = normalizeGift({ giftId: '1', repeatCount: 2, groupId: '88', user: { userId: '1' } }, 'room');
    expect(event.streakable).toBe(true);
  });

  it('curtida: usa count incremental; total fica só para diagnóstico', () => {
    expect(normalizeLike({ common: { msgId: 'L1' }, count: 12, total: '98765', user: { userId: '1' } }, 'room'))
      .toMatchObject({ count: 12, total: 98765, msgId: 'L1' });
    expect(normalizeLike({ likeCount: 4, totalLikeCount: 500, user: { userId: '1' } }, 'room'))
      .toMatchObject({ count: 4, total: 500 });
  });

  it('follow e classificação de social', () => {
    expect(normalizeFollow({ user: { userId: '9', nickname: 'Z' } }, 'follow', 'room')).toMatchObject({ type: 'follow', userId: '9', via: 'follow' });
    expect(classifySocial({ common: { displayText: { key: 'pm_main_follow_message_viewer_2' } } })).toBe('follow');
    expect(classifySocial({ action: 'share' })).toBe('share');
    expect(classifySocial({ common: { displayText: { key: 'unknown' } } })).toBe('other');
  });
});
