// POST /api/checkout: the endpoint the whole second half of these docs is
// built around. Log lines, funnel metrics, spans and one alert all hang off it.
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../lib/config.js';
import { query } from '../lib/db.js';
import { ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  checkoutOutcomeTotal,
  checkoutStepTotal,
  orderValueCentsTotal,
  ordersInFlight,
  paymentFailuresTotal,
} from '../lib/metrics.js';
import { chargeCard } from '../lib/payments.js';
import { currentContext, hashIdentity, requireContext } from '../lib/tenancy.js';
import { withSpan, startSpan } from '../lib/trace.js';

export const checkoutRouter = Router();

// Fake test data only. These numbers are not real card numbers and must never
// be sent anywhere except the local payment stub.
const checkoutSchema = z.object({
  customer: z
    .object({
      email: z.string().email(),
      name: z.string().min(1),
    })
    .strict(),
  card: z
    .object({
      // Real systems tokenize in the browser and post a token here. We keep the
      // shape (so the redaction demo is realistic) but the value is fake.
      number: z.string().regex(/^4242\s?4242\s?4242\s?4242$/),
      exp: z.string().regex(/^\d{2}\/\d{2}$/),
      cvv: z.string().regex(/^\d{3}$/),
    })
    .strict(),
  items: z
    .array(
      z.object({ sku: z.string().min(1), quantity: z.number().int().min(1).max(99) }).strict(),
    )
    .min(1),
});

// Demo only. A real idempotency store is Postgres or Redis: an in-memory Map
// resets on restart and is not shared between pods.
const idempotencyCache = new Map<string, unknown>();

function funnel(step: string): void {
  checkoutStepTotal.inc({ tenant_id: currentContext().tenantId ?? 'none', step });
}

checkoutRouter.post('/api/checkout', async (req, res) => {
  const ctx = requireContext();
  const tenantId = ctx.tenantId ?? 'none';
  const chaos = req.header('x-chaos');

  if (!ctx.tenantId) throw new ValidationError('x-tenant-id header is required');

  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    funnel('cart_received');
    throw new ValidationError(`checkout payload invalid: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  const body = parsed.data;
  funnel('cart_received');
  funnel('validated');

  // Tokenization would happen here. We fake it: derive a token, and drop the
  // raw card data out of scope immediately so nothing downstream can log it.
  const cardToken = `tok_fake_${hashIdentity(body.card.number)}`;
  void body.card;

  const idempotencyKey = req.header('idempotency-key') ?? ctx.requestId;
  const cached = idempotencyCache.get(idempotencyKey);
  if (cached) {
    logger.info({ idempotency_replay: true }, 'checkout replayed from idempotency cache');
    res.status(200).json(cached);
    return;
  }

  ordersInFlight.inc({ tenant_id: tenantId });
  const inFlightSpan = startSpan('checkout.in_flight', { 'tenant.id': tenantId });
  try {
    // 1. Price the basket from the database, never from client input.
    const priced = await withSpan(
      'checkout.price_basket',
      { 'tenant.id': tenantId, 'basket.line_count': body.items.length },
      async (span) => {
        const result = await query<{ sku: string; price_cents: number; quantity: number }>(
          'checkout.price_basket',
          `SELECT p.sku, p.price_cents, i.quantity
             FROM unnest($1::text[], $2::int[]) AS i(sku, quantity)
             JOIN products p ON p.sku = i.sku AND p.tenant_id = $3
            WHERE p.is_active`,
          [body.items.map((i) => i.sku), body.items.map((i) => i.quantity), tenantId],
        );
        span.setAttribute('basket.priced_lines', result.rows.length);
        return result;
      },
    );

    if (priced.rows.length !== body.items.length) {
      throw new ValidationError('one or more skus are not available for this tenant');
    }
    const totalCents = priced.rows.reduce((sum, r) => sum + r.price_cents * r.quantity, 0);
    const currency = 'USD';
    funnel('basket_priced');

    // 2. Persist the order in `pending`, carrying request_id so a row in the
    //    database and a line in Loki refer to the same thing.
    // `id` is declared string, not number: the column is bigint and
    // node-postgres hands int8 back as a JS string. Annotating it `number`
    // typechecks but is a lie at runtime, and the bug shows up as a gateway
    // schema rejection (or silent precision loss on huge ids).
    const inserted = await query<{ id: string }>(
      'checkout.insert_order',
      `INSERT INTO orders (tenant_id, request_id, customer_hash, status, total_cents, currency)
       VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING id`,
      [tenantId, ctx.requestId, hashIdentity(body.customer.email), totalCents, currency],
    );
    const orderId = inserted.rows[0]!.id;
    await query(
      'checkout.insert_items',
      `INSERT INTO order_items (order_id, sku, quantity, unit_price_cents) SELECT * FROM unnest($1::int[], $2::text[], $3::int[], $4::int[])`,
      [
        priced.rows.map(() => orderId),
        priced.rows.map((r) => r.sku),
        priced.rows.map((r) => r.quantity),
        priced.rows.map((r) => r.price_cents),
      ],
    );
    funnel('order_created');
    logger.info({ order_id: orderId, total_cents: totalCents, currency }, 'order created');

    if (config.slowCheckoutMs > 0) {
      // Chaos switch: makes every checkout slow so latency alerting can be
      // practised safely, locally, with fake data.
      await new Promise((resolve) => setTimeout(resolve, config.slowCheckoutMs));
    }

    // 3. Charge.
    funnel('payment_attempted');
    const charge = await chargeCard({
      tenantId,
      orderId,
      cardToken,
      amountCents: totalCents,
      currency,
      idempotencyKey,
      chaos,
    });

    if (charge.status === 'declined') {
      await query('checkout.mark_failed', `UPDATE orders SET status = 'failed' WHERE id = $1`, [orderId]);
      paymentFailuresTotal.inc({
        tenant_id: tenantId,
        reason: charge.decline_reason ?? 'unknown',
      });
      checkoutOutcomeTotal.inc({ tenant_id: tenantId, outcome: 'declined' });
      logger.warn({ order_id: orderId, decline_reason: charge.decline_reason }, 'payment declined');
      res.status(402).json({ order_id: orderId, status: 'failed', reason: charge.decline_reason });
      return;
    }

    await query(
      'checkout.mark_paid',
      `INSERT INTO payments (order_id, tenant_id, provider, provider_charge_id, status, amount_cents, currency)
       VALUES ($1, $2, 'stub-gateway', $3, 'captured', $4, $5)`,
      [orderId, tenantId, charge.provider_charge_id, totalCents, currency],
    );
    await query('checkout.mark_confirmed', `UPDATE orders SET status = 'confirmed' WHERE id = $1`, [orderId]);
    funnel('payment_captured');
    funnel('confirmed');
    checkoutOutcomeTotal.inc({ tenant_id: tenantId, outcome: 'captured' });
    orderValueCentsTotal.inc({ tenant_id: tenantId, currency }, totalCents);
    logger.info({ order_id: orderId, provider_charge_id: charge.provider_charge_id }, 'checkout confirmed');

    const payload = { order_id: orderId, status: 'confirmed', total_cents: totalCents, currency };
    idempotencyCache.set(idempotencyKey, payload);
    res.status(201).json(payload);
  } catch (err) {
    inFlightSpan.setAttribute('error', true);
    checkoutOutcomeTotal.inc({ tenant_id: tenantId, outcome: 'error' });
    throw err;
  } finally {
    inFlightSpan.end();
    ordersInFlight.dec({ tenant_id: tenantId });
  }
});
