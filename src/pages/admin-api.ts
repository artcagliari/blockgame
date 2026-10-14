import { io, type Socket } from 'socket.io-client';
import type { EventKind, GameConfig, GameState, Team } from '../game/types';

const TOKEN_KEY = 'bdb-admin-token';

export function loadToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}
export function saveToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* armazenamento indisponível */ }
}

export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'LIVE_NOT_STARTED' | 'ERROR';

export interface ConnectionStatus {
  state: ConnectionState;
  username: string | null;
  roomId: string | null;
  since: number;
  attempts: number;
  nextRetryAt: number | null;
  lastError: string | null;
  lastEventAt: number | null;
  autoReconnect: boolean;
  counters: { gifts: number; likes: number; follows: number; shares: number; comments: number; socialOther: number };
}

export interface SlotView {
  slotId: string;
  team: Team;
  visualId: string;
  visualName: string;
  label: string;
  defaultBlocks: number;
  giftId: string | null;
  blocks: number;
  active: boolean;
  giftName: string | null;
  giftImageUrl: string | null;
  giftCoins: number | null;
  mapped: boolean;
}

export interface KnownGift {
  giftId: string;
  name: string | null;
  imageUrl: string | null;
  coins: number | null;
  source: string;
  seenCount: number;
  lastSeenAt: number;
  slotId: string | null;
}

export interface ProcessedSummary {
  at: number;
  origin: 'real' | 'test';
  kind: string;
  status: 'applied' | 'duplicate' | 'ignored' | 'error';
  reason?: string;
  team?: Team;
  points?: number;
  giftId?: string;
  giftName?: string | null;
  viewer?: string;
}

export interface StatRow { origin: string; kind: EventKind; status: string; events: number; points: number }

export interface IgnoredReasonRow { origin: string; kind: EventKind; reason: string; events: number }

export interface Overview {
  server: { role: string; store: 'memory' | 'postgres'; env: string; uptime: number; autoplay: boolean; testEvents: boolean };
  state: GameState;
  connection: ConnectionStatus;
  slots: SlotView[];
  knownGifts: KnownGift[];
  statsReal: StatRow[];
  statsTest: StatRow[];
  statsAuto: StatRow[];
  ignoredReal: IgnoredReasonRow[];
  lastRealEvent: ProcessedSummary | null;
  recentReal: ProcessedSummary[];
  recentTest: ProcessedSummary[];
  comments: Array<{ at: number; user: string; text: string }>;
  mismatches: Array<{ at: number; giftId: string; expectedCoins: number; receivedCoins: number }>;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data?.message ?? data?.error ?? `Erro ${response.status}`);
  return data as T;
}

export function openAdminSocket(token: string): Socket {
  return io('/admin', { auth: { token }, transports: ['websocket', 'polling'] });
}

export type ConfigPatch = Partial<GameConfig>;
