// Endpoints whose only job is to misbehave, so alerting, tracing and the
// cardinality trap can be practised without touching a production system.
import { Router } from 'express';
import { logger } from '../lib/logger.js';
import { badRequestPathTotal } from '../lib/metrics.js';
import { NotFoundError, PaymentDeclinedError, ValidationError } from '../lib/errors.js';
import { query } from '../lib/db.js';
import { currentContext } from '../lib/tenancy.js';
import { withSpan } from '../lib/trace.js';

export const debugRouter = Router();

// Artificial latency, for percentile and alert-threshold practice.
debugRouter.get('/api/slow', async (req, res) => {
  const ms = Math.min(Number(req.query.ms ?? 200), 10_000);
  if (!Number.isFinite(ms)) throw new ValidationError('ms must be a number');
  await new Promise((resolve) => setTimeout(resolve, ms));
  res.json({ slept_ms: ms });
});

// A genuine bug: reading a property of undefined. This is what an unhandled
// TypeError looks like in logs, metrics and Sentry.
debugRouter.get('/api/boom', (_req, res) => {
  const basket: { items?: unknown[] } = {};
  // TypeError: Cannot read properties of undefined (reading 'length')
  res.json({ count: (basket.items as unknown[]).length });
});

// Typed errors on demand, to compare 4xx and 5xx behaviour.
debugRouter.get('/api/error/:kind', (req, res) => {
  const kind = req.params.kind;
  if (kind === 'validation') throw new ValidationError('demo validation failure');
  if (kind === 'not-found') throw new NotFoundError('Demo widget');
  if (kind === 'declined') throw new PaymentDeclinedError('insufficient_funds');
  if (kind === 'crash') {
    logger.fatal({ 'demo.reason': 'uncaught in handler' }, 'about to throw');
    throw new Error('demo crash');
  }
  res.json({ error: { code: 'unknown_kind', message: 'try validation|not-found|declined|crash' } });
});

// CARDINALITY TRAP. One counter, two labels, and the label values come from
// user input. Chapter 07b measures what this does to Prometheus.
// Served only on /metrics/demo, so the real /metrics stays clean.
debugRouter.get('/api/cardinality', (req, res) => {
  const value = String(req.query.value ?? Math.random().toString(36).slice(2));
  badRequestPathTotal.inc({ path: req.originalUrl, client_ip: req.ip ?? 'unknown' });
  // Also touch the DB so the demo produces traces and logs, not just metrics.
  void query('demo.cardinality', 'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [
    currentContext().tenantId ?? 'tenant_acme',
  ]);
  res.json({ recorded_for: value });
});

// A query that holds a connection: how pool exhaustion starts.
debugRouter.get('/api/pool-hog', async (req, res) => {
  const seconds = Math.min(Number(req.query.seconds ?? 5), 30);
  await withSpan('demo.pool_hog', { 'db.sleep_seconds': seconds }, async () => {
    await query('demo.pg_sleep', `SELECT pg_sleep($1)`, [seconds]);
  });
  res.json({ held_seconds: seconds, pool: 'released' });
});
