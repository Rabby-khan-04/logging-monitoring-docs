// Latency histogram middleware. The important detail is WHICH url gets used:
// the route template, never the raw URL, or the cardinality explodes.
import type { Request, Response, NextFunction } from 'express';
import { httpRequestDurationSeconds } from '../lib/metrics.js';
import { currentContext } from '../lib/tenancy.js';

export function observeLatency(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    // req.route exists once a route matched. For 404s it does not, and we must
    // NOT fall back to req.url: that would create a new time series per
    // random bot scan. '/unmatched' is a single bounded bucket.
    const route = req.route?.path ?? (req.baseUrl || '/unmatched');
    httpRequestDurationSeconds.observe(
      {
        method: req.method,
        route,
        status_code: String(res.statusCode),
        tenant_id: currentContext().tenantId ?? 'none',
      },
      seconds,
    );
  });

  next();
}
