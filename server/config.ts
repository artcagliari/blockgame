import { z } from 'zod';

const bool = (fallback: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === '') return fallback;
    return ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());
  }, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Token do painel administrativo. Obrigatório em produção. */
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN precisa ter ao menos 16 caracteres').optional(),
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: z.enum(['true', 'false', 'auto']).default('auto'),
  /** Permite subir em produção sem banco (estado volátil). Só para diagnóstico. */
  ALLOW_EPHEMERAL: bool(false),
  TIKTOK_USERNAME: z.string().optional(),
  TIKTOK_AUTOCONNECT: bool(true),
  /** Chave opcional do serviço de assinatura Euler Stream usado pelo conector. */
  EULER_SIGN_API_KEY: z.string().optional(),
  /** Origens extras autorizadas (CORS/Socket.IO), separadas por vírgula. Same-origin sempre vale. */
  ALLOWED_ORIGINS: z.string().default(''),
  AUTOPLAY: z.string().default('on'),
  /** Simulações do painel. Padrão: desligadas em produção, ligadas em desenvolvimento. */
  ENABLE_TEST_EVENTS: z.string().optional(),
  /** Diretório persistente para os áudios (ex.: volume do Railway). Sem ele, os bytes ficam no PostgreSQL. */
  AUDIO_STORAGE_DIR: z.string().optional(),
  AUDIO_MAX_BYTES: z.coerce.number().int().min(50_000).max(50_000_000).default(5 * 1024 * 1024),
  /** Limite para faixas de música de fundo (mais longas). */
  AUDIO_MUSIC_MAX_BYTES: z.coerce.number().int().min(50_000).max(80_000_000).default(20 * 1024 * 1024),
  AUDIO_MAX_CLIPS: z.coerce.number().int().min(1).max(1_000).default(200),
  /** Aplica uma única vez o mapeamento inicial de presentes (server/gift-seed.ts). */
  GIFT_SEED: bool(true),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Limite de curtidas aceitas em uma única mensagem do TikTok. */
  MAX_LIKES_PER_EVENT: z.coerce.number().int().min(1).max(5000).default(100),
  /** Segredo do HMAC que anonimiza identificadores de espectadores. Padrão: derivado do ADMIN_TOKEN. */
  HASH_SECRET: z.string().min(16).optional(),
});

export type AppConfig = z.infer<typeof schema> & {
  autoplay: boolean;
  enableTestEvents: boolean;
  allowedOrigins: string[];
  hashSecret: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Configuração inválida: ${detail}`);
  }
  const data = parsed.data;
  if (data.NODE_ENV === 'production') {
    if (!data.ADMIN_TOKEN) throw new Error('ADMIN_TOKEN é obrigatório em produção.');
    if (!data.DATABASE_URL && !data.ALLOW_EPHEMERAL) {
      throw new Error('DATABASE_URL é obrigatório em produção (ou ALLOW_EPHEMERAL=true para estado volátil).');
    }
  }
  return {
    ...data,
    autoplay: data.AUTOPLAY.toLowerCase() !== 'off',
    enableTestEvents: data.ENABLE_TEST_EVENTS === undefined || data.ENABLE_TEST_EVENTS === ''
      ? data.NODE_ENV !== 'production'
      : ['1', 'true', 'on', 'yes'].includes(data.ENABLE_TEST_EVENTS.toLowerCase()),
    allowedOrigins: data.ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter(Boolean),
    hashSecret: data.HASH_SECRET ?? `${data.ADMIN_TOKEN ?? 'dev-only-secret'}:viewer-hash`,
  };
}
