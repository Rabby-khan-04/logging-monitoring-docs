// Catalog + orders: the read paths. Everything is tenant-scoped in the WHERE
// clause, which is the only reason the logs can stay tenant-scoped too.
import { Router } from 'express';
import { query } from '../lib/db.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { currentContext } from '../lib/tenancy.js';
import { logger } from '../lib/logger.js';
import { withSpan } from '../lib/trace.js';

export const catalogRouter = Router();

interface ProductRow extends Record<string, unknown> {
  id: number;
  sku: string;
  title: string;
  price_cents: number;
}

catalogRouter.get('/api/products', async (req, res) => {
  const ctx = currentContext();
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  if (!Number.isFinite(limit)) throw new ValidationError('limit must be a number');

  const products = await withSpan(
    'catalog.list_products',
    { 'tenant.id': ctx.tenantId ?? 'none', 'db.limit': limit },
    async (span) => {
      const result = await query<ProductRow>(
        'catalog.list_products',
        'SELECT id, sku, title, price_cents FROM products WHERE tenant_id = $1 AND is_active = true ORDER BY id LIMIT $2',
        [ctx.tenantId, limit],
      );
      span.setAttribute('db.returned_rows', result.rows.length);
      return result.rows;
    },
  );

  logger.debug({ product_count: products.length }, 'catalog listed');
  res.json({ tenant_id: ctx.tenantId, products });
});

interface OrderRow extends Record<string, unknown> {
  id: number;
  status: string;
  total_cents: number;
  currency: string;
  request_id: string | null;
}

catalogRouter.get('/api/orders/:id', async (req, res) => {
  const ctx = currentContext();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('order id must be a positive integer');

  const result = await query<OrderRow>(
    'orders.get_by_id',
    'SELECT id, status, total_cents, currency, request_id FROM orders WHERE id = $1 AND tenant_id = $2',
    [id, ctx.tenantId],
  );

  const order = result.rows[0];
  if (!order) throw new NotFoundError('Order');

  // Note what is absent: customer email, address, card token. The API returns
  // them to authorised callers; the logs never see them.
  res.json({ tenant_id: ctx.tenantId, order });
});
