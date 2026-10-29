// DANGER DEMO. These endpoints log secrets on purpose, so you can watch the
// redaction config earn its place. Both are gated behind LOG_DANGER=1 so they
// cannot be reached by accident, and only fake values are ever used.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import { query } from '../lib/db.js';
import { currentContext, hashIdentity, KNOWN_TENANTS } from '../lib/tenancy.js';

export const dangerRouter = Router();

// A guard, not a delete: the demo has to be reachable for you to see the leak.
function dangerOnly(_req: Request, res: Response, next: NextFunction): void {
  if (process.env.LOG_DANGER !== '1') {
    res.status(403).json({ error: { code: 'danger_disabled', message: 'set LOG_DANGER=1 to run the demo' } });
    return;
  }
  next();
}

dangerRouter.use(dangerOnly);

// ---- Danger demo 1: a login handler that logs its own request body ----
dangerRouter.post('/danger/login', (req: Request, res: Response) => {
  // The mistake is very common: "log the request so I can debug it".
  // This line puts a password and an email into Loki, where everyone with
  // dashboard access can read them until the retention period expires.
  logger.info({ body: req.body }, 'danger demo: naive login logging');

  // ---- The fix. Same debugging value, no secrets: ----
  logger.info(
    {
      'auth.customer_hash': req.body?.email ? hashIdentity(String(req.body.email)) : undefined,
      'auth.password_present': Boolean(req.body?.password),
      'auth.result': 'success',
    },
    'login handled',
  );
  res.json({ status: 'logged' });
});

// ---- Danger demo 2: a handler that logs card data ----
dangerRouter.post('/danger/card', (req: Request, res: Response) => {
  logger.info({ body: req.body }, 'danger demo: naive card logging');
  logger.info({ 'payment.card_token_present': Boolean(req.body?.token) }, 'card handled safely');
  res.json({ status: 'logged' });
});

// ---- Danger demo 3: the cross-tenant leak ----
// A report endpoint that forgets its WHERE tenant_id clause. The SQL bug is
// realistic; the data is fake. This is how multi-tenant leaks actually happen.
dangerRouter.get('/danger/tenant-leak', async (_req: Request, res: Response) => {
  const ctx = currentContext();
  const rows = await query<{ tenant_id: string; customer_hash: string }>(
    'danger.leaky_report',
    // BUG ON PURPOSE: no tenant filter. Newest 20 orders, so the rows visibly
    // span several tenants instead of whatever the seed happened to insert first.
    'SELECT tenant_id, customer_hash FROM orders ORDER BY id DESC LIMIT 20',
  );

  // A second bug on purpose: the result set goes into the log line, so a
  // request tagged tenant A now writes tenant B's customer hashes to Loki.
  logger.warn({ other_tenant_rows: rows.rows }, 'danger demo: cross-tenant data in one log line');

  res.json({
    requesting_tenant: ctx.tenantId,
    leaked_rows: rows.rows.length,
    tenants_seen: [...new Set(rows.rows.map((r) => r.tenant_id))],
    known_tenants: KNOWN_TENANTS,
  });
});
