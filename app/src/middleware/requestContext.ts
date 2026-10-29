// The middleware that gives every log line its identity: request id, tenant,
// hashed customer. Everything downstream just reads AsyncLocalStorage.
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { requestStorage, type RequestContext, isKnownTenant, hashIdentity } from '../lib/tenancy.js';
import { UnknownTenantError } from '../lib/errors.js';
import { httpRequestsTotal } from '../lib/metrics.js';

// Honour an incoming X-Request-Id (a browser or another service may already
// have one) so the chain stays unbroken; otherwise mint a fresh id.
export function requestId(req: Request): string {
  const incoming = req.header('x-request-id');
  if (incoming && /^[\w-]{8,64}$/.test(incoming)) return incoming;
  return randomUUID();
}

export const httpLogger = pinoHttp({
  logger,
  genReqId: requestId,
  // Silence the per-request line for health checks and scrapes: polled every
  // few seconds, they would otherwise be the majority of your log volume and
  // the first thing that blows up the Loki bill.
  //
  // Two conditions, two different jobs.
  //
  // `ignore` is evaluated when the request ARRIVES (pino-http calls
  // autoLoggingIgnore(req) before your handlers run), so it can only filter on
  // things already known: the URL. Use it for health checks and scrapes.
  //
  // The double-logging fix does NOT belong here. errorHandler() logs the 5xx
  // with the typed error, and pino-http would log the same failure again when
  // the response finishes: two lines, one incident. `ignore` cannot see that
  // yet, so we use customLogLevel, which runs at response-finish time and may
  // return 'silent' to drop the line entirely (logger.js: if level === 'silent'
  // return). The error handler marks the response, we honour the mark.
  autoLogging: {
    ignore: (req) => {
      const url = (req as Request).url ?? '';
      return url.startsWith('/healthz') || url.startsWith('/readyz') || url.startsWith('/metrics');
    },
  },
  customLogLevel(req, res) {
    if ((res as Response).locals?.errorLogged) return 'silent';
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Express 5 sets req.route only inside handlers; req.url carries query
  // strings and ids, so use the matched route template for the log field too.
  customProps(req) {
    return { route: (req as Request).baseUrl };
  },
});

export function tenantContext(req: Request, res: Response, next: NextFunction): void {
  const tenantHeader = req.header('x-tenant-id');
  const ctx: RequestContext = { requestId: String(res.getHeader('x-request-id') ?? requestId(req)) };

  // Hand the id back to the caller BEFORE any validation: if we reject the
  // request, the response body contains this request_id and the customer can
  // quote it. Logging it is only possible if the context is already active.
  res.setHeader('x-request-id', ctx.requestId);

  const customer = req.header('x-customer-email');
  if (customer) ctx.customerHash = hashIdentity(customer);

  // Rejections must run inside the context too. The first version of this
  // function called next(error) before requestStorage.run(), so the
  // UnknownTenantError log line reached Loki with no request_id at all.
  requestStorage.run(ctx, () => {
    if (tenantHeader) {
      if (!isKnownTenant(tenantHeader)) {
        // Rejecting unknown tenants at the edge is also a data-isolation
        // control: it guarantees no query can run for a tenant we do not serve.
        next(new UnknownTenantError(tenantHeader));
        return;
      }
      ctx.tenantId = tenantHeader;
    }
    next();
  });
}

// Rate + status class counter, kept separate from the latency histogram so the
// RED panels do not all depend on one metric.
export function requestCount(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    const route = req.route?.path ?? (req.baseUrl || req.path);
    httpRequestsTotal.inc({
      method: req.method,
      route,
      status_class: `${Math.floor(res.statusCode / 10)}xx`,
    });
  });
  next();
}
