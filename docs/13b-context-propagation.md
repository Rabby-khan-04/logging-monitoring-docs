# 13b - Context propagation

## 1. Simple explanation

A relay race where every runner carries the same notebook. Before runner two starts, runner one
writes in it: "team 551, I was leg 3". Runner two opens a page for herself - still team 551, now
leg 4 - and hands that on. Afterwards whoever sorts the results can lay every leg in order,
because they all say team 551.

Now the runner who never looks at the notebook and simply starts a new team: same race, two sets
of paperwork, and the table lies - leg 4 looks like the whole race and leg 3 like nothing at all.
The notebook is what a request carries between services; the page you open for yourself is the
span from [13a](13a-spans.md). What people get wrong is not the writing, it is the **handing
over**: a call to another service, a message left on a queue, a job picked up ten minutes later
by a different process. Every time the work changes hands somebody has to pass the notebook, and
if nobody writes it into the message, the notebook gets left in the changing room.

## 2. Real name

**W3C Trace Context** defines the `traceparent` HTTP header: four dash-separated fields.

```
traceparent: 00-592cca726913ed0ef726558efb89aacb-6237afaa45878dcf-01
             ^   ^                                ^                ^
             |   |                                |                +-- flags, bit 0 = sampled
             |   |                                +------------------- sender's span id (16 hex)
             |   +---------------------------------------------------- trace id (32 hex)
             +--------------------------------------------------------header version (00)
```

Three catches: the middle field is named **parent-id** in the spec and holds the *sender's* span
id, which becomes the receiver's new span's `parentSpanId`; `flags` `01` means "being recorded"
and `00` "not sampled", and downstream services inherit that decision instead of re-rolling it;
`tracestate` may ride along with up to 32 vendor entries that you must **preserve even when you
do not understand them**. W3C also defines `baggage` - `key=percent-encoded-value` pairs of
application context, sent to every hop including third parties and size-capped by your proxies,
so identifiers only, never values.

The SDK side: **context** holds the active span (built on `AsyncLocalStorage` in Node, which is
why an `await` keeps the same active span); **propagators** move it to and from a carrier -
`propagation.inject(context.active(), carrier)` writes headers,
`propagation.extract(context, carrier)` reads them; **TextMapSetter / TextMapGetter** tell the
propagator how to touch that carrier (a plain object, a `Map`, gRPC metadata). Node's default
composite propagator is `tracecontext,baggage`, changed with `OTEL_PROPAGATORS`. Propagation and
**sampling** are one conversation from two sides: the decision is made once, at the root, travels
in the flags byte and is inherited. *Head-based* sampling decides before the work happens; *tail*
sampling decides afterwards in the collector, using facts the head could not know (duration,
error status, tenant).

## 3. Example

### 3.1 Who injects the header here, honestly

`chargeCard()` in `app/src/lib/payments.ts` sets `content-type`, `x-tenant-id`,
`idempotency-key` and **no `traceparent`**:

```ts
        const response = await fetch(config.paymentUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tenant-id': req.tenantId,
            'idempotency-key': req.idempotencyKey,
            ...(req.chaos ? { 'x-chaos': req.chaos } : {}),
          },
```

It does not need one: the call happens *inside* `withSpan('payment.charge', ...)`, so it is
active context, and `@opentelemetry/instrumentation-undici` patches Node's `fetch` and injects
the header for you - the proof is that one checkout trace contains spans from scopes
`instrumentation-http`, `-pg`, `-router`, `-undici` plus the tracers `shop-api` and
`payment-gateway`. `app/src/lib/trace.ts` ships the manual version so you have seen it once:

```ts
export function outboundTraceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, {
    set: (c, k, v) => { c[k] = v; },
  });
  return carrier;
}
```

That setter implements only `set`, and it is not laziness: `TextMapSetter` in
`@opentelemetry/api` 1.10.0 (pinned in `app/package.json`) has no `keys` member, so adding
`keys(carrier) { return Object.keys(carrier) }` to the literal is a TypeScript error for a
property that does not exist - older snippets include it, delete it. Note also that
`outboundTraceHeaders()` is currently **not called** anywhere, because undici's instrumentation
makes the same call internally: it is the code you write for a hop nobody instruments (a raw
socket, a hand-rolled retry loop, a vendor SDK client, a queue producer).

### 3.2 Who extracts it

`app/src/payment-service.ts` has no extraction code at all. It boots the same SDK
(`--import ./src/instrumentation.ts`, `OTEL_SERVICE_NAME: payment-gateway`), the `http`
instrumentation extracts `traceparent` before the first middleware runs, and this business span
hangs itself under shop-api's client span with no glue:

```ts
  const outcome = await withSpan(
    'gateway.charge',
    { 'tenant.id': charge.tenant_id, 'payment.amount_cents': charge.amount_cents },
    async (span) => { /* fake acquirer latency and decline logic */ },
  );
```

Same trace id, same tree, two processes, two containers.

### 3.3 Why the log lines cross, and why one field does not

Both services share `app/src/lib/logger.ts`, whose mixin reads the active span rather than a
request-scoped variable:

```ts
      const span = trace.getSpan(context.active());
      if (span) {
        const sc = span.spanContext();
        additions['trace_id'] = sc.traceId;
        additions['span_id'] = sc.spanId;
      }
```

The consequence is the useful part: the gateway's line carries `trace_id` and `span_id` but **no
`request_id` and no `tenant_id`** (verbatim in 4.1). The gateway runs its own `AsyncLocalStorage`
in `payment-service.ts` and never populates `lib/tenancy`'s store, so `currentContext()` in the
mixin sees nothing - while the trace context arrived perfectly, because it travelled in a header.
Correlation that rides the trace crosses the hop for free; correlation kept in your own request
scope does not, unless you propagate it on purpose. Grafana is provisioned to exploit the ids
both ways (`grafana/provisioning/datasources/datasources.yaml`) - the affordance; the panels are
[09a](09a-grafana-dashboards.md) and [13c](13c-find-the-slow-part.md):

```yaml
  - name: Loki
    jsonData:
      lokiSearchTraces: { datasourceUid: tempo }     # click trace_id on a line -> Tempo
  - name: Tempo
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        filterByTraceID: true                        # from a span -> that trace's lines
        filterBySpanID: false
        spanEndTimeLimit: 3000
```

### 3.4 Sampling: what this box runs, and what a shop should run

`instrumentation.ts` sets no sampler, so the SDK default applies: parent-based with an always-on
root, every span of every request recorded. Right for a learning box where the point is to see
everything; wrong for a shop. Section 4.3 shows the parent-based half working - a remote "not
sampled" is honoured downstream - and 4.2 the reverse direction, a `traceparent` written by hand
into `curl` and accepted as truth. The shape for real use (sketched, **not run on this
machine**):

```ts
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
new NodeSDK({
  // Roots: keep 1 in 10. Everything else inherits, so a trace is never half-recorded.
  sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.1) }),
});
```

A rate **cap** on top (never more than N traces a second, whatever the ratio says) is not in the
JS core SDK: you get it from a custom sampler or, more often, from the collector, which sees all
services at once - and a cap is what stops a traffic surge buying you ten times the storage
exactly when the box is already struggling. Use a trace-id ratio, never a per-span probability, or
your kept traces are Swiss cheese. **Tail** sampling belongs on the collector's `tail_sampling`
processor: buffer a trace and keep all of it if `status = error`, or `duration > 2s`, or
`tenant.id = tenant_initech`. That keeps the interesting 1% instead of a random 1%, paid for with
a collector that must see every span of a trace on one instance (consistent routing between
replicas) and memory to hold traces while it decides.

## 4. What you should see

### 4.1 One trace id, two services, two log lines

The declined `tenant_acme` checkout from 13a, trace `592cca726913ed0ef726558efb89aacb`. Caller,
verbatim from Loki:

```json
{"level":"info","time":"2026-10-29T08:19:45.821Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"ch13a-demo-002","tenant_id":"tenant_acme","trace_id":"592cca726913ed0ef726558efb89aacb","span_id":"6237afaa45878dcf","payment.status":"declined","payment.decline_reason":"card_declined","duration_ms":95,"msg":"payment gateway responded"}
```

Callee - same trace id, different span, no `request_id`, no `tenant_id` -
`curl -sG -m 20 http://localhost:3101/loki/api/v1/query_range --data-urlencode
'query={service_name="payment-gateway"} |= "592cca726913ed0ef726558efb89aacb"' --data-urlencode
"start=$(date -d '-20 minutes' +%s)000000000" --data-urlencode "end=$(date +%s)000000000"
--data-urlencode 'limit=3' | jq -r '.data.result[].values[][1]'`:

```json
{"level":"info","time":"2026-10-29T08:19:45.820Z","service.name":"payment-gateway","app.env":"production","app.release":"1.0.0","trace_id":"592cca726913ed0ef726558efb89aacb","span_id":"d8f14b98b2dfdfc9","payment.outcome":"declined","payment.amount_cents":3888,"gateway.latency_ms":93,"gateway.decline_reason":"card_declined","msg":"gateway charge handled"}
```

The boundary in the trace, five lines of the 28-span tree: the service name changes once and the
ids never break.

```
    [shop-api] payment.charge 95.4ms id=YjevqkWHjc8= STATUS_CODE_OK {"tenant.id": "tenant_acme", "payment.amount_cents": "3888", "payment.status": "declined", "payment.decline_reason": "card_declined"}
      [shop-api] POST 94.7ms id=JUjEBYF+UcM=  {"http.response.status_code": "200", "http.request.method": "POST"}
        [payment-gateway] POST 93.8ms id=rwJlCO7u4jA=  {"http.response.status_code": "200", "http.request.method": "POST"}
          [payment-gateway] request handler - /charge 93.5ms id=miUT3o6WfSM=  {"http.route": "/charge"}
            [payment-gateway] gateway.charge 93.4ms id=2PFLmLLf38k= STATUS_CODE_OK {"tenant.id": "tenant_acme", "payment.amount_cents": "3888"}
```

The gateway line's `span_id` `d8f14b98b2dfdfc9` *is* the base64 `2PFLmLLf38k=` of
`gateway.charge`: the same bytes in a different encoding, which is how a log line in one service
names an exact span inside another.

### 4.2 The hand-made traceparent

```bash
curl -s -m 15 -H 'x-tenant-id: tenant_acme' \
  -H 'traceparent: 00-11111111111111111111111111111111-2222222222222222-01' \
  "http://localhost:8000/api/products?limit=1" -o /dev/null -w '%{http_code}\n'
curl -s -m 20 localhost:3201/api/v2/traces/11111111111111111111111111111111 | jq -r '[.. | .name? // empty] | join(", ")'
```
```
@opentelemetry/instrumentation-router, middleware - jsonParser, middleware - result, middleware - tenantContext, middleware - observeLatency, middleware - requestCount, request handler - /api/products, @opentelemetry/instrumentation-pg, pg.connect, pg-pool.connect, pg.query:SELECT shop, pg.query:SELECT shop, shop-api, catalog.list_products, @opentelemetry/instrumentation-http, GET
```

`catalog.list_products` is our manual span, filed under a trace id invented on a laptop. The log
line agrees - `...` marks fields elided for width, everything else verbatim, including pino-http
echoing the headers it received:

```
{"level":"info","time":"2026-10-29T08:20:24.183Z","service.name":"shop-api",...,"headers":{"host":"localhost:8000","user-agent":"curl/8.18.0","accept":"*/*","x-tenant-id":"tenant_acme","traceparent":"00-11111111111111111111111111111111-2222222222222222-01"},...,"request_id":"bc9beaa8-8767-4de8-b4f2-d168f4f464ac","tenant_id":"tenant_acme","trace_id":"11111111111111111111111111111111","span_id":"e519200f8d9e68ad",...,"responseTime":10,"msg":"request completed"}
```

### 4.3 The flags byte, measured

Same URL, two more requests: one with `-00`, one with no header at all (a fresh root trace).

```bash
curl -s -H 'x-tenant-id: tenant_acme' \
  -H 'traceparent: 00-33333333333333333333333333333333-4444444444444444-00' \
  "http://localhost:8000/api/products?limit=1" -o /dev/null -w '%{http_code}\n'
curl -s -m 20 -o /tmp/f00.json -w 'HTTP=%{http_code} bytes=%{size_download}\n' \
  http://localhost:3201/api/v2/traces/33333333333333333333333333333333; head -c 200 /tmp/f00.json
```
```
200
HTTP=200 bytes=25
{"trace":{},"metrics":{}}
```

And the three requests' log lines side by side:

```
2026-10-29T08:22:34.550Z trace_id= 33333333333333333333333333333333 span_id= 7e9d203796347223 traceparent= 00-33333333333333333333333333333333-4444444444444444-00
2026-10-29T08:20:24.183Z trace_id= 11111111111111111111111111111111 span_id= e519200f8d9e68ad traceparent= 00-11111111111111111111111111111111-2222222222222222-01
2026-10-29T08:22:42.196Z trace_id= 8d7742c835a2b99e7199f5926004c448 span_id= 9ec9f9b477b70322 traceparent= None
```

Row one is the whole lesson. Flags `00`: the request **still** got a trace id and a span id on its
log lines - correlation survives - but Tempo holds nothing, and answers HTTP 200 with an empty
`{"trace":{}}`, not a 404. So "the trace is missing" is the normal appearance of a not-sampled
request, and the fix is never "turn tracing down to 1%" but "sample 1% *and* always keep the
errors and the slow ones".

## 5. In a real multi-tenant e-commerce platform

A `tenant_globex` checkout starts on the storefront, then shop-api, order-service,
payment-service, the real acquirer. **The edge:** Globex's own order pipeline calls
`POST /api/checkout` with their ERP's tracing on, so a `traceparent` arrives already set.
Inheriting it is usually right - one trace spanning both companies is how you settle an argument
about who was slow - but it lets a stranger choose your trace ids, so accept it only for
authenticated per-tenant API traffic and cap it: a client minting one id per request is normal, a
client reusing one id builds an unbounded trace. **The boundary you do not cross:** never send
your `traceparent` to a third-party acquirer or a merchant webhook - it is a correlation id for
your internal topology, and it invites an outside system to parent your spans. Calls out to the
world start a **new** trace, joined to the old one with a span link or with `order_id` on both
sides. **The hops that lose the notebook:** the classic is a queue, and **this stack has no
queue, so that part is stated, not demonstrated** - when shop-api publishes `OrderConfirmed` for a
fulfilment worker, the producer calls `propagation.inject(context.active(), message.headers)` and
the consumer extracts before starting its span, so fulfilment lands inside the checkout's trace.
Without those two lines fulfilment looks like an unrelated trace that happens to start 40ms later,
and "why is this order not shipping" becomes guesswork; same shape for a scheduled job draining a
table, a `setTimeout` that outlives the request, or a worker thread. And the tenant itself:
`tenant_id` reaches the gateway as an `x-tenant-id` header, not as baggage, and the gateway must
rebuild its own tenancy context from it - the missing `tenant_id` in 4.1 is what a half-done
version of that looks like in real data.

## 6. When to use it, when not to

Propagate always: once the SDK is in it costs nothing, and it is the difference between one tree
and six orphans. The judgement is **how much you record**, and that is measurable - one checkout is
28 spans and 19,836 bytes of OTLP JSON for 101ms of work. At 50 checkouts a minute that is 40,000
spans a minute for the checkout path alone, before catalog reads, session lookups and webhooks,
every one of them having inherited "yes". Lowering a sample rate does not shrink
`traces_spanmetrics_latency_bucket` either (750 series on this box): it shrinks the counts feeding
the percentiles, which changes what your p99 means ([08c](08c-percentiles.md)).

Head-based ratio sampling is cheap and blind: it keeps a representative sample of traces you
already know about, and the rare four-second `tenant_initech` decline is exactly the tail event a
1-in-10 coin flip throws away - the one request you needed. The order for a real platform:
parent-based inheritance in every service; a rate-capped ratio at the edge; tail rules keeping 100%
of errors, 100% of requests over your p99 threshold, and a per-tenant override for whoever is on
fire today. Do not propagate where there is no relationship to preserve - a cron running 6,000
unrelated reports belongs in 6,000 traces, not one - and do not put business state in baggage
"because it travels anyway": it goes upstream to every dependency, including the acquirer.

## 7. Common mistakes

1. **A new trace at every hop.** Symptom: `gateway.charge` with a trace id that appears nowhere in
   shop-api. Causes: a client the instrumentation does not patch, `startSpan` where the child
   needed an active parent, a queue hop with no header injection. Two traces are worse than none:
   each looks complete.
2. **Carrying context in a module-level variable** "because it is one request at a time". Under
   load, tenant A's spans get parented to tenant B's trace - a leak inside your own observability
   tooling. Use the SDK's context; on Node it is `AsyncLocalStorage` for a reason.
3. **Reading `traceparent` backwards.** The middle id is the sender's span, and it becomes your new
   span's `parentSpanId`.
4. **Implementing `keys` on a `TextMapSetter`.** Not declared in `@opentelemetry/api` 1.10.0, so it
   fails typecheck; `set` is enough.
5. **Sampling per span instead of per trace.** A 10% per-span drop leaves parents with missing
   children and a waterfall that blames the wrong step.
6. **Head-only sampling at a low rate, then finding no errors in Tempo.** Failures are both what you
   care about and what is rare; tail rules make a low rate survivable.
7. **Shipping `traceparent` to third parties**, or letting unauthenticated public traffic steer your
   traces.
8. **Double-tracing with Sentry.** Chapter 12 pins `tracesSampleRate: 0` in the Sentry init on
   purpose: with OTel tracing the same work you pay twice and reconcile never. (`initSentry()` only
   runs when `SENTRY_DSN` is set; there is no DSN on this box, and chapter 12's Sentry material is
   labelled not executed.)
9. **Reading "no data in Tempo" as "tracing is broken".** Check the flags byte first (4.3), then the
   URL: `/api/trace/<id>`, `/api/v1/traces?traceID=` and `/api/services` answer 404 on Tempo 3.1.1;
   `/api/v2/traces/<id>` and `/api/search` work here.
10. **Confusing `trace_id` with `request_id` (04a).** One trace can hold several retried requests;
    one request id can appear in two traces. Keep both, ask each its own question.

## 8. Try it yourself

Prove that a trace id is just an id, and that one trace can hold more than one request. Pick a
32-hex trace id of your own and call twice with the **same trace id, different span ids**:

```bash
curl -s -H 'x-tenant-id: tenant_globex' -H 'traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' \
  "http://localhost:8000/api/products?limit=1" -o /dev/null
curl -s -H 'x-tenant-id: tenant_globex' -H 'traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-cccccccccccccccc-01' \
  "http://localhost:8000/api/orders/1" -o /dev/null
curl -s http://localhost:3201/api/v2/traces/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | python3 -c "
import json,sys
d=json.load(sys.stdin).get('trace',{})
for rs in d.get('resourceSpans',[]):
    for ss in rs['scopeSpans']:
        for s in ss['spans']: print(s['name'], s.get('parentSpanId'))"
```

**Hint:** expect spans from *both* calls under one trace id, each parented to the span id you
supplied. Tempo's v2 API returns ids base64-encoded, so `bbbbbbbbbbbbbbbb` arrives looking nothing
like what you typed -
`python3 -c "import base64,sys;print(base64.b64decode(sys.argv[1]).hex())" <id>` converts it back
to hex; compare structure, not glyphs. Then repeat with `-00` and compare what the log line says
with what Tempo returns: the empty `{"trace":{}}` of 4.3.

**Cleanup:** nothing to delete and nothing to restart. Hand-made traces expire with Tempo's
`block_retention: 72h`, the fake orders age out with Loki's window, you can stop
`scripts/loadgen.sh` if you want quiet, and `docker compose ps` should still show 13 services up.

## 9. Next

[13c - Find the slow part](13c-find-the-slow-part.md): with a complete, correctly joined tree, how
to read a waterfall, and how the service graph and span metrics turn those spans into numbers you
can alert on.
