# 20a - One checkout, end to end

The capstone starts with a single request. By the end of this chapter you can
follow one fake purchase through a log line, a metric, a trace, a database row
and an alert without leaving the machine.

## 1. Simple explanation

A parcel has a tracking number. With it you can ask the post office where the
parcel is, the warehouse whether it was packed, the driver whether it was
delivered, and the bank whether it was paid for. Four systems, one identifier.

A checkout is a parcel. `request_id` is the tracking number printed on every
label. `trace_id` links the parcel's journey across services; `order_id` links
it to the database; the metric tells you how many parcels there were; the alert
tells you when parcels are going missing.

## 2. Real name

- **Correlation ID / request ID**: an identifier minted at the edge and copied
  onto every log line for that request.
- **Trace ID**: a W3C identifier propagated over HTTP so spans in different
  services join one trace.
- **Span**: one timed operation inside a trace. A trace is a tree of spans.
- **Funnel metric**: a counter incremented at each checkout step.
- **Alert**: a query over metrics that fires when the shape of the funnel or
  the error rate goes wrong.
- **The four signals together**: logs tell you what happened, metrics how
  often, traces where the time went, and alerts tell you without being asked.

## 3. Example

The request carries an id in, and every layer stamps it. `httpLogger` accepts an
incoming `x-request-id` if it looks sane, and `mixin()` adds the current span's
`trace_id` to every line:

```ts
// app/src/middleware/requestContext.ts
export function requestId(req: Request): string {
  const incoming = req.header('x-request-id');
  if (incoming && /^[\w-]{8,64}$/.test(incoming)) return incoming;
  return randomUUID();
}
```

```ts
// app/src/lib/logger.ts, inside mixin()
const span = trace.getSpan(context.active());
if (span) {
  const sc = span.spanContext();
  additions['trace_id'] = sc.traceId;
  additions['span_id'] = sc.spanId;
}
```

The handler increments the funnel exactly where the work happens:

```ts
funnel('cart_received');
funnel('validated');
// price basket -> funnel('basket_priced')
// INSERT order   -> funnel('order_created')
funnel('payment_attempted');
// charge card
funnel('payment_captured');
funnel('confirmed');
checkoutOutcomeTotal.inc({ tenant_id: tenantId, outcome: 'captured' });
orderValueCentsTotal.inc({ tenant_id: tenantId, currency }, totalCents);
```

The trace is produced by auto-instrumentation for HTTP and `pg`, plus two
explicit spans for the business operations:

```ts
const priced = await withSpan('checkout.price_basket', { 'tenant.id': tenantId }, async (span) => { ... });
const charge = await chargeCard({ ..., chaos });   // wrapped in 'payment.charge' inside payments.ts
```

This is the whole pattern: **one id in the request, one line per event, one
span per operation, one counter per business step.** Everything else in the
course is a variation.

## 4. What you should see

A real request, with the id chosen so it can be found again:

```bash
$ RID=chap20a2-1793268932
$ curl -s -X POST localhost:8000/api/checkout \
  -H 'content-type: application/json' -H 'x-tenant-id: tenant_globex' \
  -H "x-request-id: $RID" -d '{"customer":{"email":"capstone.buyer@example.com","name":"Capstone Buyer"},
  "card":{"number":"4242 4242 4242 4242","exp":"11/29","cvv":"123"},
  "items":[{"sku":"tenant_globex-SKU0012","quantity":2}]}'
{"order_id":"17405","status":"confirmed","total_cents":1980,"currency":"USD"}
```

Four log lines, all carrying the same `request_id` and the same `trace_id`:

```bash
$ # Loki: {service_name="shop-api"} |= "chap20a2-1793268932"
{"level":"info","msg":"order created","order_id":"17405","trace_id":"6d14ee1914c992e93413989b435d6cc7","tenant_id":"tenant_globex"}
{"level":"info","msg":"payment gateway responded","order_id":null,"trace_id":"6d14ee1914c992e93413989b435d6cc7","tenant_id":"tenant_globex"}
{"level":"info","msg":"checkout confirmed","order_id":"17405","trace_id":"6d14ee1914c992e93413989b435d6cc7","tenant_id":"tenant_globex"}
{"level":"info","msg":"request completed","order_id":null,"trace_id":"6d14ee1914c992e93413989b435d6cc7","tenant_id":"tenant_globex"}
```

Paste the trace id into Tempo and the request becomes a tree. The slow parts
here are the gateway and the first pool connection, not SQL:

```bash
$ curl -s localhost:3201/api/v2/traces/6d14ee1914c992e93413989b435d6cc7 | ...
shop-api  request handler - /api/checkout   107ms
shop-api  checkout.price_basket              14ms
shop-api  payment.charge                     80ms
shop-api  pg.query:INSERT shop                3ms
shop-api  pg.query:UPDATE shop                1ms
```

The metric moves by exactly one, and the database agrees on the same order:

```bash
$ # confirmed counter, before -> after one scrape
113 -> 114

$ docker compose exec -T postgres psql -U shop -d shop -Atc \
  "SELECT id, tenant_id, request_id, status, total_cents FROM orders WHERE request_id='chap20a2-1793268932'"
17405|tenant_globex|chap20a2-1793268932|confirmed|1980
```

If this request had timed out instead, the same trace would show the parent span
ending at 2.5s while the gateway child kept running for 4.3s (chapter 18), the
log would carry `error_code=internal_error`, and `CheckoutFailureBurst` would
begin its `for: 3m` countdown for tenant_globex. One id follows the request
through all four tools; none of them is the whole story alone.

## 5. In a real multi-tenant e-commerce platform

This is the drill for every new endpoint, in order:

1. **Log the decision, not the payload.** `order created`, `payment declined`,
   `checkout confirmed`, each with `request_id`, `tenant_id`, `order_id` and
   the business reason. Never the card, email or address.
2. **Add one metric per business step and one outcome counter.** If the step
   can fail in more than one way, split by a bounded `reason` label.
3. **Span the work that can be slow or fail.** HTTP and SQL come free from
   auto-instrumentation; the payment call and the report need explicit spans
   because they are where the money and the time go.
4. **Write the alert before the incident.** `CheckoutFailureBurst` exists
   because a checkout can fail; it is a ratio with a volume guard, not a count.
5. **Make the runbook one query.** The alert's `runbook` annotation names the
   exact Loki filter and Tempo search. In an incident nobody has time to
   rediscover the query language.

The payoff is measurable in the outage exercise: the alert named tenant_initech,
the log query returned 267 failures with one error code, the trace showed a
2.5s deadline against a 4.3s dependency, and the metric showed who was affected.
Four tools, one request id, one answer.

## 6. When to use it, when not to

Do this for money paths, authentication, and anything a customer can notice.
A checkout, a login and a search deserve all four signals. A health endpoint
does not: it gets a log line at most, because it runs every few seconds and
your bill is measured in lines.

Do not add a span per line of code. Spans are for operations you would draw on
a whiteboard: an HTTP call, a query, a payment charge, a report. Do not add a
metric per branch; metrics are for things you will graph, alert on, or sum.
Logs are for the details you cannot predict.

Cost: the histogram with four label dimensions is the largest app metric here
(432 series for the duration buckets), and the trace bucket is larger still
(750 series from span metrics). That is fine at this scale and would need
sampling at a larger one. Chapter 13b covers sampling; the point for now is
that "instrument everything" is not free.

## 7. Common mistakes

1. **A different id per layer.** If the log uses `req.id`, the trace uses a new
   id and the database stores another, correlation is a manual join by
   timestamp - which fails under load.
2. **Logging the payload "for debugging".** It is the leak in chapter 19 and
   the redaction lesson in chapter 03a; log fields, not bodies.
3. **A metric with no tenant label.** It cannot answer "who is affected?".
4. **A trace with no business span.** The HTTP span says 400ms; it does not say
   whether the gateway or the database took the time. The tree does.
5. **An alert with no runbook.** The annotation is the difference between a
   page and a puzzle.
6. **Forgetting the failed branch.** The success path is instrumented first and
   the failure path last; incidents live on the failure path. The `catch` in
   checkout increments `outcome="error"` and the error handler logs once.
7. **Trusting a stale dashboard.** The counters reset when the process
   restarts. A dashboard showing a flat line after a deploy may be a reset, not
   an outage; `rate()` handles it, raw totals do not.

## 8. Try it yourself

Follow your own checkout through all four tools.

```bash
RID="my-checkout-$(date +%s)"
curl -s -X POST localhost:8000/api/checkout \
  -H 'content-type: application/json' -H 'x-tenant-id: tenant_acme' \
  -H "x-request-id: $RID" \
  -d '{"customer":{"email":"me@example.com","name":"Me"},"card":{"number":"4242 4242 4242 4242","exp":"11/29","cvv":"123"},"items":[{"sku":"tenant_acme-SKU0003","quantity":1}]}'

# 1. Logs: the four lines
curl -sG localhost:3101/loki/api/v1/query_range --data-urlencode \
  "query={service_name=\"shop-api\"} |= \"$RID\"" \
  --data-urlencode "start=$(( ($(date +%s)-300) * 1000000000 ))" \
  | jq -r '.data.result[].values[][1]' | jq -c '{msg,trace_id,order_id}'

# 2. Trace: use the trace_id from the output above
#    curl -s localhost:3201/api/v2/traces/<trace_id> | jq

# 3. Metric: the counter for this tenant
curl -sG localhost:9090/api/v1/query --data-urlencode \
  'query=sum by (tenant_id) (shop_checkout_step_total{step="confirmed"})' \
  | jq -r '.data.result[] | "\(.metric.tenant_id) \(.value[1])"'

# 4. Database: the row
docker compose exec -T postgres psql -U shop -d shop -Atc \
  "SELECT id, tenant_id, status, total_cents FROM orders WHERE request_id='$RID'"
```

**Hint:** the log line order in Loki is newest-first; the `request completed`
line is written last but appears first. The `order_id` in the response is the
same string in the database and in the `order created` line; if it differs, you
are looking at another request (or a bigint-as-number bug, chapter 05a).

**Cleanup:** the order is fake and harmless; leave it. If you want a clean
counter for a demo, restart shop-api, which resets all counters - and remember
that a restart is itself a signal in the container dashboard.

## 9. Next

One request is understood. [20b - The golden-signals dashboard](20b-golden-signals-dashboard.md)
zooms out to every request, every tenant, and builds the panels that answer
"is the shop healthy?" in ten seconds.
