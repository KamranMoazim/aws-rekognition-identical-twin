import type { ErrorRequestHandler } from 'express';

/** Throw this from any route; the error handler turns it into JSON. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal', message: (err as Error).message });
};

export function requireString(body: unknown, field: string, max = 200): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'bad_request', `${field} is required`);
  }
  if (value.length > max) throw new HttpError(400, 'bad_request', `${field} is too long`);
  return value.trim();
}
