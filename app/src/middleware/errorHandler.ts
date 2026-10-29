// The single place server-side failures are logged. Routes must log a
// diagnosis-relevant `warn`/`debug` line if they want, but the error itself is
// recorded exactly once, here, with the stack.
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { AppError, errorFields } from '../lib/errors.js';
import { httpErrorsTotal } from '../lib/metrics.js';
import { currentContext } from '../lib/tenancy.js';
import { startSpan } from '../lib/trace.js';
import { SpanStatusCode, trace } from '@opentelemetry/api';

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: 'Route does not exist' } });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const ctx = currentContext();
  const fields = errorFields(err);
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const code = String(fields['error.code']);

  httpErrorsTotal.inc({ code, tenant_id: ctx.tenantId ?? 'none' });

  const span = trace.getActiveSpan();
  if (span) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
  }
  const errorSpan = startSpan('app.error', { 'error.code': code, 'http.status_code': statusCode });
  errorSpan.end();

  if (statusCode >= 500) {
    // One error, one log line. Mark the response so pino-http's own finish
    // line is suppressed for this request; without this you get two error
    // lines per failure and every Loki query over-counts by 2x.
    res.locals.errorLogged = true;
    // Full detail for on-call: message, stack, every safe field.
    logger.error(
      { err: err as Error, ...fields, 'http.method': req.method, 'http.route': req.route?.path ?? req.path },
      'request failed',
    );
  } else {
    // Client mistakes are normal traffic: one warn line, no stack, no page.
    logger.warn(
      { ...fields, 'http.method': req.method },
      (err as Error).message,
    );
  }

  // Never leak internals in the body. The request id is the bridge: the
  // customer quotes it, you grep it in Loki.
  res.status(statusCode).json({
    error: { code, message: isAppError ? err.message : 'Internal error', request_id: ctx.requestId },
  });
}
