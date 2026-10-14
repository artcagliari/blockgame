import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface Auth {
  verify(candidate: string | undefined | null): boolean;
  middleware(req: Request, res: Response, next: NextFunction): void;
  /** Para Socket.IO: lê `auth.token` do handshake. */
  fromHandshake(auth: unknown): string | undefined;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Autenticação por token portador, comparação em tempo constante. O token nunca vai em URL. */
export function createAuth(token: string): Auth {
  const expected = digest(token);
  const verify = (candidate: string | undefined | null): boolean => {
    if (!candidate) return false;
    return timingSafeEqual(digest(candidate), expected);
  };
  return {
    verify,
    middleware(req, res, next) {
      const header = req.headers.authorization ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match || !verify(match[1].trim())) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    },
    fromHandshake(auth) {
      const value = (auth as { token?: unknown } | undefined)?.token;
      return typeof value === 'string' ? value : undefined;
    },
  };
}
