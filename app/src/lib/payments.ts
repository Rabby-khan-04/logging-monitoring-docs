// The outbound call to the payment gateway, with everything a production
// client needs: a deadline, typed errors, a metric, and a span.
import { config } from './config.js';
import { UpstreamError, UpstreamTimeoutError } from './errors.js';
import { paymentProviderDurationSeconds } from './metrics.js';
import { withSpan } from './trace.js';
import { logger } from './logger.js';

export interface ChargeRequest {
  tenantId: string;
  // node-postgres returns bigint columns as STRINGS (int64 does not fit a JS
  // number without losing precision), so `orders.id` arrives as "1234". Sending
  // it as a number would either be rejected by the gateway's schema or silently
  // round-trip wrong for large ids. Keep ids as strings across the wire.
  orderId: string;
  // A token from the card vault. Never a card number, never a CVV. This is the
  // single most important data-minimisation decision in the checkout path.
  cardToken: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  chaos?: string;
}

export interface ChargeResponse {
  status: 'captured' | 'declined';
  provider_charge_id: string;
  decline_reason?: string;
}

export async function chargeCard(req: ChargeRequest): Promise<ChargeResponse> {
  const started = process.hrtime.bigint();
  try {
    return await withSpan(
      'payment.charge',
      {
        'tenant.id': req.tenantId,
        'order.id': req.orderId,
        'payment.amount_cents': req.amountCents,
      },
      async (span) => {
        const response = await fetch(config.paymentUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tenant-id': req.tenantId,
            'idempotency-key': req.idempotencyKey,
            ...(req.chaos ? { 'x-chaos': req.chaos } : {}),
          },
          body: JSON.stringify({
            tenant_id: req.tenantId,
            order_id: req.orderId,
            card_token: req.cardToken,
            amount_cents: req.amountCents,
            currency: req.currency,
          }),
          // A deadline is not optional. Without it, one stuck upstream turns
          // into a full connection-pool and thread exhaustion in your own API.
          signal: AbortSignal.timeout(2_500),
        });

        if (!response.ok) {
          const text = await response.text();
          span.setAttribute('http.response.status_code', response.status);
          throw new UpstreamError('payment-gateway', `${response.status} ${text.slice(0, 100)}`);
        }

        const body = (await response.json()) as ChargeResponse;
        span.setAttribute('payment.status', body.status);
        if (body.decline_reason) span.setAttribute('payment.decline_reason', body.decline_reason);
        logger.info(
          {
            'payment.status': body.status,
            'payment.decline_reason': body.decline_reason ?? null,
            duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
          },
          'payment gateway responded',
        );
        paymentProviderDurationSeconds.observe({ outcome: body.status }, Number(process.hrtime.bigint() - started) / 1e9);
        return body;
      },
    );
  } catch (err) {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    paymentProviderDurationSeconds.observe({ outcome: err instanceof UpstreamTimeoutError ? 'timeout' : 'error' }, seconds);
    throw err;
  }
}
