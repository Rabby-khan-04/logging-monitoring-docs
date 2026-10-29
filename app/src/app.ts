import express from 'express';
import { catalogRouter } from './routes/catalog.js';
import { checkoutRouter } from './routes/checkout.js';
import { dangerRouter } from './routes/danger.js';
import { debugRouter } from './routes/debug.js';
import { healthRouter } from './routes/health.js';
import { reportRouter } from './routes/reports.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { httpLogger, requestCount, tenantContext } from './middleware/requestContext.js';
import { observeLatency } from './middleware/latency.js';
import { demoRegistry, register } from './lib/metrics.js';
import { config } from './lib/config.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  // Order matters. The latency observer attaches a 'finish' listener before
  // any handler runs, so it must be registered above the routers.
  app.use(httpLogger); // per-request log line + req.id
  app.use(tenantContext); // AsyncLocalStorage: request_id, tenant_id, hash
  app.use(observeLatency); // histogram
  app.use(requestCount); // counter

  app.use(healthRouter);
  app.use(catalogRouter);
  app.use(checkoutRouter);
  app.use(reportRouter);
  app.use(debugRouter);
  app.use(dangerRouter);

  app.get('/', (_req, res) => {
    res.json({
      service: config.serviceName,
      release: config.release,
      endpoints: [
        'GET  /healthz  /readyz  /healthz/detail',
        'GET  /api/products?limit=',
        'POST /api/checkout  (x-tenant-id required)',
        'GET  /api/orders/:id',
        'GET  /api/reports/tenant-summary  /api/reports/platform-slow',
        'GET  /api/slow?ms=  /api/boom  /api/error/:kind  /api/pool-hog?seconds=  /api/cardinality?value=',
        'GET  /metrics  /metrics/demo',
        'POST /danger/login  /danger/card  GET /danger/tenant-leak  (LOG_DANGER=1)',
      ],
    });
  });

  // Two scrape targets on purpose: the clean one, and the quarantined
  // cardinality demo, so a bad metric never touches the good registry.
  app.get('/metrics', async (_req, res) => {
    res.setHeader('content-type', register.contentType);
    res.end(await register.metrics());
  });
  app.get('/metrics/demo', async (_req, res) => {
    res.setHeader('content-type', demoRegistry.contentType);
    res.end(await demoRegistry.metrics());
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
