import type { Request, RequestHandler, Response } from 'express';

/** An error that maps to an HTTP status. Thrown by services, rendered by app.ts. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `"${field}" must be a non-empty string`);
  }
  return value;
}

/** Express 4 does not catch rejected promises; this forwards them to the error handler. */
export function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}
