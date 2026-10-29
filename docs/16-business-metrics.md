# 16 - Business metrics

Errors and latency tell you whether the shop works. Business metrics tell you
whether it is a shop. This chapter puts orders, money, declines and checkout
drop-off next to the technical signals, with `tenant_id` attached.

## 1. Simple explanation

A hospital can report perfect vital signs for every patient and still be in
trouble if nobody is being discharged cured. The heart monitor is the technical
signal; "how many patients got better this week" is the business one.

In a shop, the equivalent is: how many people started a checkout, how many
paid, how much money that was, and which shop the money came from. If those
numbers fall while every CPU graph is green, the problem is still an incident -
it just lives in the part of the system the technical dashboards do not watch.

## 2. Real name

- **Business metric**: a counter or gauge whose meaning comes from the product,
  not the infrastructure: orders, revenue, checkout completion, payment
  decline rate.
- **Funnel**: ordered steps a customer passes through. Each step is a counter;
  the drop between two steps is the conversion.
- **GMV** (gross merchandise value): the money value of orders. Here it is a
  counter in **cents**, because floating-point dollars do not sum cleanly.
- **Conversion rate**: `completed / started` over a window, usually per tenant
  and per step.
- **Cardinality discipline**: business metrics get `tenant_id` (four values)
  and a bounded `step` or `reason`; never `order_id`, `customer_id` or an email
  address.

## 3. Example

The counters are defined in `app/src/lib/metrics.ts` and incremented in
`app/src/routes/checkout.ts`:

```ts
// One counter per funnel step. Checkout drop-off is the difference between
// these series, which is why they all carry tenant_id.
export const checkoutStepTotal = new client.Counter({
  name: 'shop_checkout_step_total',
  help: 'Orders reaching each checkout step.',
  labelNames: ['tenant_id', 'step'] as const,
  registers: [register],
});

export const checkoutOutcomeTotal = new client.Counter({
  name: 'shop_checkout_outcome_total',
  help: 'Final checkout outcomes.',
  labelNames: ['tenant_id', 'outcome'] as const,
  registers: [register],
});

// Money as a counter of cents, not a gauge of "revenue": gauges cannot be
// summed correctly over time, and cents avoid floating-point drift.
export const orderValueCentsTotal = new client.Counter({
  name: 'shop_order_value_cents_total',
  help: 'Sum of captured order value in cents.',
  labelNames: ['tenant_id', 'currency'] as const,
  registers: [register],
});
```

The endpoint increments a step exactly where the step happens. The funnel is
therefore the code path, not a second implementation that can drift:

```ts
funnel('cart_received');
funnel('validated');
// ... price the basket, insert the order ...
funnel('basket_priced');
funnel('order_created');
funnel('payment_attempted');

if (charge.status === 'declined') {
  paymentFailuresTotal.inc({ tenant_id: tenantId, reason: charge.decline_reason ?? 'unknown' });
  checkoutOutcomeTotal.inc({ tenant_id: tenantId, outcome: 'declined' });
  // ... return 402
}

funnel('payment_captured');
funnel('confirmed');
checkoutOutcomeTotal.inc({ tenant_id: tenantId, outcome: 'captured' });
orderValueCentsTotal.inc({ tenant_id: tenantId, currency }, totalCents);
```

Funnel queries are plain PromQL. Conversion between two steps:

```promql
# Checkout completion per tenant: confirmed / carts started.
sum by (tenant_id) (shop_checkout_step_total{step="confirmed"})
/
sum by (tenant_id) (shop_checkout_step_total{step="cart_received"})
```

## 4. What you should see

Cumulative values per tenant, captured at one moment after the stack had been
driven by load generators and two outage runs. These are counters since the
last `shop-api` restart, so your numbers will be different - the **shape**
(which tenant is bigger, where the drop-off is) is the part that should match:

```bash
$ curl -sG localhost:9090/api/v1/query --data-urlencode \
  'query=sum by (tenant_id, step) (shop_checkout_step_total)' \
  | jq -r '.data.result[] | [.metric.tenant_id, .metric.step, .value[1]] | @tsv'

tenant_acme      cart_received      660
tenant_acme      validated          659
tenant_acme      basket_priced      657
tenant_acme      order_created      657
tenant_acme      payment_attempted  657
tenant_acme      payment_captured   640
tenant_acme      confirmed          640
tenant_initech   cart_received      3032
tenant_initech   validated          3032
tenant_initech   basket_priced      3031
tenant_initech   order_created      3031
tenant_initech   payment_attempted  3031
tenant_initech   payment_captured   487
tenant_initech   confirmed          487
tenant_umbrella  cart_received      664
tenant_umbrella  validated          664
tenant_umbrella  basket_priced      664
tenant_umbrella  order_created      664
tenant_umbrella  payment_attempted  664
tenant_umbrella  payment_captured   625
tenant_umbrella  confirmed          625
tenant_globex    cart_received      612
tenant_globex    validated          612
tenant_globex    basket_priced      609
tenant_globex    order_created      609
tenant_globex    payment_attempted  609
tenant_globex    payment_captured   591
tenant_globex    confirmed          591
```

Read the last two columns as a sentence. Three tenants convert at 94-97%.
tenant_initech converts **487 / 3032 = 16.1%**, while doing five times the
checkout volume of anyone else. The technical dashboards would show a busy,
healthy tenant; the business metric shows hundreds of customers failing to pay.

Outcomes and money, same moment:

```bash
$ # outcomes per tenant
tenant_acme      captured 639   declined 17    error 1
tenant_initech   captured 487   declined 949   error 1329
tenant_umbrella  captured 625   declined 39    error 0
tenant_globex    captured 591   declined 18    error 2

$ # captured revenue (counter / 100 = dollars)
tenant_acme      15157.30
tenant_initech   11049.10
tenant_umbrella  14018.70
tenant_globex    14599.34

$ # average captured order value in cents
tenant_acme      2375.26
tenant_initech   2268.81
tenant_umbrella  2242.99
tenant_globex    2470.28
```

The initech revenue is close to the others despite three times the cart count,
because most of its attempts ended in `declined` or `error`. That is the
sentence a product manager understands instantly.

## 5. In a real multi-tenant e-commerce platform

This is the dashboard the head of commerce looks at on Monday: orders per
minute, captured GMV, conversion by tenant, declines by reason. It answers
questions the RED dashboard cannot:

- "Did yesterday's release cost us money?" Compare GMV now with the same hour
  last week (`offset 7d`), not with an absolute target.
- "Is the decline spike fraud, a broken card form, or the bank having a bad
  day?" `shop_payment_failures_total{reason=...}` splits it; the log line has
  `decline_reason`.
- "Which tenant needs a customer-success call?" The one whose conversion fell
  from 96% to 16%, while everyone else stayed flat.

The initech story is the noisy neighbour in business terms: 25% of its cards
are declined by design in the fake gateway, and chaos runs add timeouts. It
produces most of the log volume and most of the support tickets, and it is the
reason a per-tenant dashboard exists. Without tenant labels, its failures would
be invisible inside a comfortable platform-wide 96% average.

Two rules keep business metrics honest. First, the metric is an operational
approximation; the finance ledger is the truth. Reconcile daily
(`shop_order_value_cents_total` against `SELECT sum(total_cents) FROM orders
WHERE status='confirmed'` for the same window) and expect a small gap from
retries. Second, never put a person or an order in a label. `order_id` is
unbounded and would create one time series per order, which is the cardinality
disaster of chapter 07b wearing a business hat.

## 6. When to use it, when not to

Use business metrics when a technical signal cannot answer a product question,
when you need to prioritise tenants, or when a release needs a "did it make
money?" follow-up. Add them from the first day for checkout, signup and
payment; those are the paths where silence is expensive.

Do not use business metrics as a substitute for health checks, and do not page
on raw business counters. A quiet night has low orders; "orders below ten in
the last five minutes" fires every night at 03:00. Alert on a ratio or a
comparison with the same hour yesterday, with a minimum-volume guard.

Cost: each counter is cheap to store, but each label value multiplies series.
Four tenants times seven steps is 28 series, which is nothing. A `sku` label
would be 160 products today and thousands next year; a `country` label is fine
until the business expands. Also remember that counters reset when the process
restarts; always use `rate`/`increase`, never the raw value, in a query that
must survive a deploy.

## 7. Common mistakes

1. **A gauge for revenue.** `revenue = 12345` overwrites itself; you cannot add
   yesterday's value to today's. Use a counter of cents and `increase()`.
2. **Dollars as floats.** `0.1 + 0.2` is not `0.3` in binary floating point.
   Counters of integer cents avoid the argument entirely.
3. **Missing `tenant_id`.** A platform-wide conversion rate hides one tenant
   failing. The whole point of this stack is that the label is on every line
   and every series.
4. **`step` values that overlap.** If `payment_attempted` is also incremented
   on retries, the funnel counts customers twice. Define each step once, at
   the place it happens.
5. **Alerting on the counter.** Absolute order counts are a function of traffic
   and time of day. Alert on conversion or on a ratio versus the same hour
   last week.
6. **Logging the customer instead of a metric.** High-cardinality identities
   belong in logs (hashed) and in the database, not in labels.
7. **Trusting the metric over the ledger.** The counter is in memory and
   resets; the database has the orders. Reconcile, do not argue.

## 8. Try it yourself

Compute the conversion rate for each tenant and find the outlier.

```bash
for step in cart_received confirmed; do
  echo "== $step"
  curl -sG localhost:9090/api/v1/query --data-urlencode \
    "query=sum by (tenant_id) (shop_checkout_step_total{step=\"$step\"})" \
    | jq -r '.data.result[] | "\(.metric.tenant_id) \(.value[1])"'
done
```

**Hint:** the ratio is `confirmed / cart_received`. tenant_initech's number
should be near 0.16 while the others are near 0.95. If every tenant looks
equally bad, check whether a load generator is still running - a shared
external cause looks different from a tenant-specific one.

**Cleanup:** nothing to clean. If you started a load generator for this, stop
it with Ctrl-C; the counters keep their values until the container restarts.

## 9. Next

Business metrics say what customers did. [17 - Docker monitoring](17-docker-monitoring.md)
says whether the machines underneath could have done anything else.
