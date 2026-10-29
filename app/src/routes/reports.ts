// Reporting endpoints. One fast, one deliberately slow and unindexed, so the
// database chapter has something real to measure.
import { Router } from 'express';
import { query } from '../lib/db.js';
import { currentContext } from '../lib/tenancy.js';
import { withSpan } from '../lib/trace.js';

export const reportRouter = Router();

interface SummaryRow extends Record<string, unknown> {
  status: string;
  orders: string;
  revenue_cents: string;
}

reportRouter.get('/api/reports/tenant-summary', async (_req, res) => {
  const ctx = currentContext();
  const rows = await withSpan(
    'report.tenant_summary',
    { 'tenant.id': ctx.tenantId ?? 'none' },
    async () =>
      query<SummaryRow>(
        'report.tenant_summary',
        `SELECT o.status,
                count(*) AS orders,
                coalesce(sum(o.total_cents), 0) AS revenue_cents
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           LEFT JOIN payments p ON p.order_id = o.id
          WHERE o.tenant_id = $1
          GROUP BY o.status
          ORDER BY o.status`,
        [ctx.tenantId],
      ),
  );
  res.json({ tenant_id: ctx.tenantId, summary: rows.rows });
});

// UNINDEXED JOIN + correlated subquery + a sort over the whole table.
// This is the "one customer's dashboard is melting the shared database"
// noisy-neighbour scenario, in one endpoint.
reportRouter.get('/api/reports/platform-slow', async (_req, res) => {
  const started = Date.now();
  const rows = await withSpan('report.platform_slow', { 'report.shape': 'unindexed' }, async (span) => {
    const result = await query<{ tenant_id: string; n: string }>(
      'report.platform_slow',
      `SELECT o.tenant_id,
              count(*) AS n,
              (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id) AS items
         FROM orders o
         JOIN products p ON p.tenant_id = o.tenant_id
        GROUP BY o.tenant_id, o.id
        ORDER BY n DESC, items DESC`,
    );
    span.setAttribute('report.rows', result.rows.length);
    return result;
  });
  res.json({ took_ms: Date.now() - started, rows: rows.rows.length });
});
