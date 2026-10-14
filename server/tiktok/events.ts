/** Eventos normalizados, independentes da versão do conector. */
interface Base {
  /** Identificador único da mensagem no TikTok (common.msgId), quando existir. */
  msgId: string;
  roomId: string;
  userId: string;
  userName: string;
  at: number;
}

export interface GiftLiveEvent extends Base {
  type: 'gift';
  giftId: string;
  giftName: string | null;
  imageUrl: string | null;
  coins: number | null;
  /** Presente de sequência (combo): o repeatCount cresce a cada atualização. */
  streakable: boolean;
  repeatCount: number;
  repeatEnd: boolean;
  groupId: string;
  /** Somente simulações: resolve o slot diretamente. */
  slotId?: string;
}

export interface LikeLiveEvent extends Base {
  type: 'like';
  /** Curtidas NESTA mensagem (incremental). */
  count: number;
  /** Total acumulado da sala. Apenas diagnóstico; nunca é somado. */
  total: number | null;
}

export interface FollowLiveEvent extends Base {
  type: 'follow';
  via: 'follow' | 'social';
}

export interface DiagnosticLiveEvent extends Base {
  type: 'share' | 'comment' | 'social_other';
  text?: string;
}

export type LiveEvent = GiftLiveEvent | LikeLiveEvent | FollowLiveEvent | DiagnosticLiveEvent;
