import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { PgStore } from './store/pg-store.js';

/** Executa as migrações e sai. Usado como `preDeployCommand` no Railway. */
const logger = createLogger({ level: 'info', base: { app: 'batalha-dos-blocos', task: 'migrate' } });

try {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL ausente: nada a migrar.');
  const config = loadConfig({ ...process.env, ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? 'migracao-sem-token-0000' });
  const store = new PgStore({ connectionString: url, ssl: config.DATABASE_SSL === 'auto' ? 'auto' : config.DATABASE_SSL === 'true' });
  await store.init();
  await store.close();
  logger.info('migrações aplicadas');
} catch (error) {
  logger.error('falha na migração', { message: (error as Error).message });
  process.exit(1);
}
