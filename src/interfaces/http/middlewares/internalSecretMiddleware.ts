import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApplicationError } from '../../../application/errors/ApplicationError';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export const createInternalSecretMiddleware =
  (expected: string): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const provided = req.get('x-internal-secret') ?? '';

    if (!expected || !provided || !timingSafeEqual(digest(expected), digest(provided))) {
      next(new ApplicationError('Forbidden', 403));
      return;
    }

    next();
  };
