import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ApplicationError } from '../../../application/errors/ApplicationError';

export interface AuthContext {
  sub: string;
  email: string;
  permissions: string[];
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export const ACCESS_TOKEN_COOKIE = 'access_token';

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function extractToken(req: Request): string | null {
  const authorization = req.header('authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1];
  }
  return readCookie(req.headers.cookie, ACCESS_TOKEN_COOKIE);
}

export function verifyAccessToken(token: string, secret: string): AuthContext | null {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string') return null;
    const permissions = Array.isArray(decoded.permissions)
      ? (decoded.permissions as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
    return { sub: decoded.sub, email: typeof decoded.email === 'string' ? decoded.email : '', permissions };
  } catch {
    return null;
  }
}

/** Verifies the HS256 access token locally (no call to auth-service) and sets req.auth. */
export const createAuthMiddleware =
  (secret: string): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const token = extractToken(req);
    const auth = token ? verifyAccessToken(token, secret) : null;
    if (!auth) {
      next(new ApplicationError('Unauthorized', 401));
      return;
    }
    req.auth = auth;
    next();
  };

/** Requires at least one of the given permissions in req.auth.permissions. */
export const requirePermission =
  (...permissions: string[]): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const granted = req.auth?.permissions ?? [];
    if (!permissions.some((permission) => granted.includes(permission))) {
      next(new ApplicationError('Forbidden', 403));
      return;
    }
    next();
  };
