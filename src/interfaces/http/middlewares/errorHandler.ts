import type { NextFunction, Request, Response } from 'express';
import { ApplicationError } from '../../../application/errors/ApplicationError';

export const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  if (error instanceof ApplicationError) {
    res.status(error.statusCode).json({ message: error.message });
    return;
  }

  // body-parser errors (malformed JSON, payload too large, ...) carry a 4xx status.
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ message: 'Invalid request' });
    return;
  }

  console.error('Unhandled error:', error);
  res.status(500).json({ message: 'Internal server error' });
};
