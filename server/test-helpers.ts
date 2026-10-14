import { EventEmitter } from 'node:events';
import { GameEngine } from './game-engine.js';
import { GameService } from './game-service.js';
import { GiftRegistry } from './gift-registry.js';
import { LivePipeline } from './live-pipeline.js';
import { silentLogger } from './logger.js';
import { MemoryStore } from './store/memory-store.js';
import type { Store } from './store/types.js';
import type { FollowLiveEvent, GiftLiveEvent, LikeLiveEvent } from './tiktok/events.js';
import type { LiveConnection } from './tiktok/live-service.js';

export async function makeHarness(options: { store?: Store; target?: number; mapAll?: boolean; likesPerBlock?: number } = {}) {
  const store = options.store ?? new MemoryStore();
  await store.init();
  // Testes de ingestão usam 1 curtida = 1 bloco; a conversão 120:1 tem testes próprios.
  const engine = new GameEngine({ target: options.target ?? 2000, likesPerBlock: options.likesPerBlock ?? 1 }, { autoplay: false });
  const game = new GameService(engine, store, silentLogger);
  const registry = new GiftRegistry(store);
  await registry.init();
  await game.init();
  const pipeline = new LivePipeline(game, registry, store, silentLogger, { hashSecret: 'test-secret-0123456789', maxLikesPerEvent: 100 });
  return { store, engine, game, registry, pipeline };
}

let counter = 0;
const nextId = () => `m${++counter}`;

export function gift(over: Partial<GiftLiveEvent> = {}): GiftLiveEvent {
  return {
    type: 'gift', msgId: nextId(), roomId: 'room1', userId: 'u1', userName: 'Ana', at: Date.now(),
    giftId: '5655', giftName: 'Rose', imageUrl: null, coins: 1,
    streakable: true, repeatCount: 1, repeatEnd: false, groupId: 'g1', ...over,
  };
}

export function like(over: Partial<LikeLiveEvent> = {}): LikeLiveEvent {
  return { type: 'like', msgId: nextId(), roomId: 'room1', userId: 'u1', userName: 'Ana', at: Date.now(), count: 1, total: 100, ...over };
}

export function follow(over: Partial<FollowLiveEvent> = {}): FollowLiveEvent {
  return { type: 'follow', via: 'follow', msgId: nextId(), roomId: 'room1', userId: 'u1', userName: 'Ana', at: Date.now(), ...over };
}

/** Conector falso com a mesma superfície que o serviço usa do real. */
export class FakeConnection extends EventEmitter implements LiveConnection {
  isConnected = false;
  roomId = '';
  connectImpl: () => Promise<{ roomId: string }> = async () => ({ roomId: 'room-fake' });
  gifts: unknown = [];
  disconnected = 0;
  async connect() {
    const state = await this.connectImpl();
    this.isConnected = true;
    this.roomId = state.roomId;
    this.emit('connected', state);
    return state;
  }
  async disconnect() {
    this.disconnected += 1;
    this.isConnected = false;
  }
  async fetchAvailableGifts() {
    return this.gifts;
  }
}
