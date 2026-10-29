// Typed errors. The log line and the HTTP response are derived from the type,
// so a route never has to remember how serious its own failure is.
export type ErrorCode =
  | 'validation_failed'
  | 'unknown_tenant'
  | 'not_found'
  | 'payment_declined'
  | 'upstream_timeout'
  | 'upstream_error'
  | 'db_error'
  | 'internal_error';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  // Only `true` errors are logged at error level with a stack. Client mistakes
  // are logged at warn and never page anyone: a 404 is not an outage.
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { code: ErrorCode; statusCode: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request body did not validate') {
    super(message, { code: 'validation_failed', statusCode: 400 });
  }
}

export class UnknownTenantError extends AppError {
  constructor( tenantId: string) {
    super(`Unknown tenant '${tenantId}'`, { code: 'unknown_tenant', statusCode: 403 });
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Resource') {
    super(`${what} not found`, { code: 'not_found', statusCode: 404 });
  }
}

export class PaymentDeclinedError extends AppError {
  constructor(reason: string) {
    super(`Payment declined: ${reason}`, { code: 'payment_declined', statusCode: 402 });
  }
}

export class UpstreamTimeoutError extends AppError {
  constructor(upstream: string) {
    super(`Timed out talking to ${upstream}`, {
      code: 'upstream_timeout',
      statusCode: 504,
      retryable: true,
    });
  }
}

export class UpstreamError extends AppError {
  constructor(upstream: string, detail: string) {
    super(`${upstream} returned ${detail}`, { code: 'upstream_error', statusCode: 502, retryable: true });
  }
}

export class DatabaseError extends AppError {
  constructor(detail: string, cause?: unknown) {
    super(`Database error: ${detail}`, { code: 'db_error', statusCode: 500, retryable: true, cause });
  }
}

// Serialise an error into safe, indexable fields. Note what is NOT here:
// no request body, no headers, no stack in the metric label.
export function errorFields(err: unknown): Record<string, string | number | boolean> {
  if (err instanceof AppError) {
    return {
      'error.name': err.name,
      'error.code': err.code,
      'error.status': err.statusCode,
      'error.retryable': err.retryable,
    };
  }
  if (err instanceof Error) {
    return { 'error.name': err.name, 'error.code': 'internal_error', 'error.message': err.message };
  }
  return { 'error.name': 'unknown', 'error.code': 'internal_error' };
}
