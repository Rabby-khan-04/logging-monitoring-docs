// The fake payment gateway: a second service, so cross-service log correlation,
// context propagation and per-service latency actually have somewhere to go.
// It is deliberately flaky. That flakiness is the subject of half these docs.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { withSpan } from './lib/trace.js';
import client from 'prom-client';

const store = new AsyncLocalStorage<{ requestId: string; tenantId?: string }>();

const chargeSchema = z
  .object({
    tenant_id: z.string(),
    order_id: z.string().regex(/^\d+$/),
    card_token: z.string().min(1),
    amount_cents: z.number().int().min(1),
    currency: z.string().length(3),
  })
  .strict();

const chargeDuration = new client.Histogram({
  name: 'gateway_charge_duration_seconds',
  help: 'Latency of the fake gateway per charge.',
  labelNames: ['tenant_id', 'outcome'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});
const chargesTotal = new client.Counter({
  name: 'gateway_charges_total',
  help: 'Charges handled by the fake gateway.',
  labelNames: ['tenant_id', 'outcome'] as const,
});

// Fake tenants get fake behaviour. tenant_initech is the noisy neighbour:
// a real acquirer would throttle one merchant, never the whole platform.
const BEHAVIOUR: Record<string, { declineRate: number; extraLatencyMs: number }> = {
  tenant_acme: { declineRate: 0.02, extraLatencyMs: 0 },
  tenant_globex: { declineRate: 0.02, extraLatencyMs: 0 },
  tenant_initech: { declineRate: 0.25, extraLatencyMs: 260 },
  tenant_umbrella: { declineRate: 0.05, extraLatencyMs: 20 },
};

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = String(req.header('x-request-id') ?? randomUUID());
  res.setHeader('x-request-id', requestId);
  store.run({ requestId, tenantId: req.header('x-tenant-id') ?? undefined }, () => next());
});

app.get('/healthz', (_req, res) => res.json({ status: 'alive', service: config.serviceName }));
app.get('/metrics', async (_req, res) => {
  res.setHeader('content-type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.post('/charge', async (req: Request, res: Response) => {
  const parsed = chargeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'validation_failed', issues: parsed.error.issues.map((i) => i.path.join('.')) } });
    return;
  }
  const charge = parsed.data;
  const chaos = req.header('x-chaos') ?? '';
  const behaviour = BEHAVIOUR[charge.tenant_id] ?? { declineRate: 0.05, extraLatencyMs: 0 };

  const started = process.hrtime.bigint();
  const outcome = await withSpan(
    'gateway.charge',
    { 'tenant.id': charge.tenant_id, 'payment.amount_cents': charge.amount_cents },
    async (span) => {
      const latency = 60 + behaviour.extraLatencyMs + Math.random() * 40;
      await new Promise((resolve) => setTimeout(resolve, latency));

      if (chaos === 'timeout') {
        // Longer than the caller's 2.5s deadline: the deadline, not this
        // service, decides the outcome. Classic distributed-system story.
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
      if (chaos === 'error') {
        span.setAttribute('gateway.forced_error', true);
        res.status(500).json({ error: { code: 'upstream_error', message: 'forced chaos error' } });
        return 'error';
      }

      const declined = chaos === 'decline' || Math.random() < behaviour.declineRate;
      const result = declined ? 'declined' : 'captured';
      chargesTotal.inc({ tenant_id: charge.tenant_id, outcome: result });
      logger.info(
        {
          'payment.outcome': result,
          'payment.amount_cents': charge.amount_cents,
          'gateway.latency_ms': Math.round(Number(process.hrtime.bigint() - started) / 1e6),
          'gateway.decline_reason': declined ? 'card_declined' : null,
        },
        'gateway charge handled',
      );
      res.json({
        status: result,
        provider_charge_id: `chb_fake_${randomUUID().slice(0, 8)}`,
        ...(declined ? { decline_reason: 'card_declined' } : {}),
      });
      return result;
    },
  );

  chargeDuration.observe({ tenant_id: charge.tenant_id, outcome }, Number(process.hrtime.bigint() - started) / 1e9);
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'payment gateway request failed');
  res.status(500).json({ error: { code: 'internal_error' } });
});

app.listen(config.port, () => {
  logger.info({ 'network.port': config.port }, 'payment gateway listening');
});
