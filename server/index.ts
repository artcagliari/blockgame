import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { MemoryStore } from './store/memory-store.js';
import { PgStore } from './store/pg-store.js';
import { createRealFactory } from './tiktok/live-service.js';
import { randomBytes } from 'node:crypto';

const bootstrapLogger = createLogger({ level: 'info' });

let config;
try {
  const env = { ...process.env };
  if (!env.ADMIN_TOKEN && env.NODE_ENV !== 'production') {
    // Desenvolvimento: gera um token temporário e mostra uma única vez no terminal.
    env.ADMIN_TOKEN = randomBytes(18).toString('base64url');
    bootstrapLogger.warn(`ADMIN_TOKEN não definido; token temporário de desenvolvimento: ${env.ADMIN_TOKEN}`);
  }
  config = loadConfig(env);
} catch (error) {
  bootstrapLogger.error((error as Error).message);
  process.exit(1);
}

const logger = createLogger({ level: config.LOG_LEVEL, base: { app: 'batalha-dos-blocos' } });
const store = config.DATABASE_URL
  ? new PgStore({ connectionString: config.DATABASE_URL, ssl: config.DATABASE_SSL === 'auto' ? 'auto' : config.DATABASE_SSL === 'true' })
  : new MemoryStore();
if (store.kind === 'memory') {
  logger.warn('DATABASE_URL ausente: usando armazenamento em memória. O placar NÃO sobrevive a reinícios.');
}

const factory = await createRealFactory({ signApiKey: config.EULER_SIGN_API_KEY });
const app = createApp({
  config,
  store,
  logger,
  connectionFactory: factory,
  staticDir: config.NODE_ENV === 'production' ? path.resolve(process.cwd(), 'dist') : undefined,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('encerrando com segurança', { signal });
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await app.stop();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('promessa rejeitada sem tratamento', { error: reason }));
process.on('uncaughtException', (error) => {
  logger.error('exceção não capturada; encerrando', { error });
  void shutdown('uncaughtException');
});

try {
  const port = await app.start();
  logger.info('servidor iniciado', { port, host: config.HOST, env: config.NODE_ENV, store: store.kind });
} catch (error) {
  logger.error('falha ao iniciar', { error });
  process.exit(1);
}
