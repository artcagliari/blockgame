import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './types';

export const gameSocket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  autoConnect: true,
  transports: ['websocket', 'polling'],
});
