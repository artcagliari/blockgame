export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /token|cookie|authorization|secret|password|session(id|key)?$|apikey|api_key|signature|oauth/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Remove segredos (por nome de campo) e limita o tamanho de strings longas. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const scrubbed = value
      .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s/:@]+:[^\s/@]+@/gi, '$1://[redigido]@')
      .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redigido]')
      .replace(/((?:token|password|passwd|secret|sessionid|api[_-]?key)=)[^\s&;]+/gi, '$1[redigido]');
    return scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}…` : scrubbed;
  }
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (depth >= 4) return '[truncado]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE.test(key) ? '[redigido]' : redact(item, depth + 1);
  }
  return out;
}

export function createLogger(options: { level?: LogLevel; sink?: (line: string) => void; base?: Record<string, unknown> } = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const make = (base: Record<string, unknown>): Logger => {
    const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
      if (ORDER[lvl] < ORDER[level]) return;
      sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...(redact({ ...base, ...fields }) as object) }));
    };
    return {
      debug: (msg, fields) => write('debug', msg, fields),
      info: (msg, fields) => write('info', msg, fields),
      warn: (msg, fields) => write('warn', msg, fields),
      error: (msg, fields) => write('error', msg, fields),
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return make(options.base ?? {});
}

export const silentLogger: Logger = createLogger({ level: 'error', sink: () => {} });
