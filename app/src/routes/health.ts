// Health endpoints. Two different questions, so two different endpoints.
import { Router } from 'express';
import { checkDatabase } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export const healthRouter = Router();

// Liveness: "is this process able to answer at all?" No dependencies here.
// If this fails, the orchestrator restarts the container.
let ready = false;
export function markReady(): void {
  ready = true;
}

healthRouter.get('/healthz', (_req, res) => {
  res.json({ status: 'alive', service: 'shop-api' });
});

// Readiness: "can this instance serve real traffic right now?" Includes the
// database, because a pod without a database is a pod that returns 500s.
healthRouter.get('/readyz', async (_req, res) => {
  const db = await checkDatabase();
  const healthy = ready && db.ok;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ready' : 'not_ready',
    warmup_complete: ready,
    database: { ok: db.ok, latency_ms: Math.round(db.latencyMs * 100) / 100 },
  });
});

// Deep diagnostics for humans, never used by probes (it can be slow).
healthRouter.get('/healthz/detail', async (_req, res) => {
  const db = await checkDatabase();
  logger.debug({ db }, 'health detail requested');
  res.json({
    service: 'shop-api',
    uptime_seconds: Math.round(process.uptime()),
    database_latency_ms: Math.round(db.latencyMs * 100) / 100,
    memory: process.memoryUsage().rss,
  });
});
