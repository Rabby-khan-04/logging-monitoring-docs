# 13a - Spans

## 1. Simple explanation

You time something with a stopwatch and write a card: what you timed, when it started, when
it stopped, and a sticky note or two about what you learned ("which shop", "how much", "did
it work"). That card is a span.

Cards inside other cards stack. If Mum times "Cook dinner" and, inside it, "Chop onions", the
onion card hangs under the dinner card, and the tree tells you the onions were one minute of
the hour. A **trace** is the whole tree for one errand - one call, one checkout - and every
card carries the same errand number plus its own card number, so a receipt can say "card 7 of
errand 551" and you can find it. Two things make that useful for a shop: the notes are
searchable ("errands where shop = Acme and result = declined"), and the cards are made by
everyone who did work, including code you never wrote - the web server, the database driver,
the HTTP client. You only add cards for the steps nobody else can see, like "charge the card".

## 2. Real name

A **span** is a name plus start and end timestamps in unix nanoseconds, with a **span
context** (`trace_id`, 128 bit / 32 hex, shared by every span of the trace; `span_id`, 64 bit
/ 16 hex; a **flags** byte whose bit 0 means "sampled"), a **parent span id** (what makes the
tree; a span with no parent present is the root), a **kind** (`SERVER`/`CLIENT` for a network
boundary, `INTERNAL` otherwise), **attributes** (typed key-values - `tenant.id`, `http.route`,
`payment.status`, `db.query.text` - the things you search on), **events**
(`recordException(err)` adds an `exception` event carrying the stack), a **status** (unset,
`SpanStatusCode.OK`, or `ERROR` with a message), a **resource** (per-process attributes shared
by all its spans: `service.name`, `deployment.environment`, `process.pid`) and an
**instrumentation scope** naming the library that emitted it - verifiable, since the trace in
section 4 has scopes `@opentelemetry/instrumentation-http`, `-pg`, `-router`, `-undici` plus
the two tracers our own code creates (`shop-api`, `payment-gateway`).

Around it: a **tracer** (`trace.getTracer(name)`) makes spans; **context** holds the active
span, so a new span becomes its child; **instrumentation** wraps `http`, `pg`, `fetch` and
creates spans you did not write; the **OTLP exporter** pushes finished spans to a
**collector**; **Tempo** stores them by `trace_id`. Every log line here also carries
`trace_id` and `span_id`, because `app/src/lib/logger.ts`'s `mixin()` reads
`trace.getSpan(context.active())` - [13b](13b-context-propagation.md) makes that useful.

## 3. Example

**(a) How the process starts** - `docker-compose.yml`, service `shop-api`:

```yaml
    command: ["sh", "-c", "./docker-entry.sh && ./node_modules/.bin/tsx --import ./src/instrumentation.ts src/server.ts"]
```

`--import` loads `src/instrumentation.ts` **before** `src/server.ts`, and that order is the
point: patching `http` or `pg` means replacing those modules before anyone holds a reference to
them. Load the SDK late - inside `server.ts`, or with a plain `import './instrumentation'`,
which ESM hoists and evaluates after the graph is wired - and two things break: modules
imported earlier stay unpatched, so the first spans of the process are never created, and a
request arriving before `sdk.start()` resolves produces no root span, so it is missing from
Tempo *and* its log lines carry no `trace_id`. Traces that only vanish at boot are this bug.
`--import` with a top-level `await sdk.start()` removes the race: Node will not evaluate the
entry module until the SDK is up.

**(b) Config the deployment owns** - `x-app-env` in `docker-compose.yml`:

```yaml
x-app-env: &app-env
  OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
  OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
  OTEL_TRACES_EXPORTER: otlp
  OTEL_METRICS_EXPORTER: "none"   # prom-client owns metrics on /metrics (docs/08a)
  OTEL_LOGS_EXPORTER: "none"      # Pino writes stdout -> Alloy -> Loki (docs/06a)
  OTEL_RESOURCE_ATTRIBUTES: deployment.environment=local,service.namespace=shop
```

Metrics and logs exported over OTLP as well would create a second set of differently-named
series - double storage, two dashboards that disagree, cardinality nobody queries - so both are
switched off deliberately, not by default: `prom-client` owns `/metrics`
([08a](08a-prometheus-scraping.md): one owner per signal) and Pino owns stdout. Traces are the
signal nothing else here owns.

**(c) The bootstrap** - `app/src/instrumentation.ts`:

```ts
process.env.OTEL_METRICS_EXPORTER ??= 'none';   // `??=`: a compose value wins
process.env.OTEL_LOGS_EXPORTER ??= 'none';
process.env.OTEL_TRACES_EXPORTER ??= 'otlp';

const sdk = new NodeSDK({ instrumentations: [getNodeAutoInstrumentations({
  // Filesystem, DNS and raw-socket spans drown the interesting ones in noise;
  // pg and http stay enabled, because those are the dependencies we care about.
  '@opentelemetry/instrumentation-fs': { enabled: false },
  '@opentelemetry/instrumentation-dns': { enabled: false },
  '@opentelemetry/instrumentation-net': { enabled: false },
})] });
await sdk.start();
process.on('SIGTERM', () => { void sdk.shutdown().finally(() => process.exit(0)); });
```

`sdk.shutdown()` is not decoration: exporting is batched, so a SIGTERM without a flush loses the
last seconds of spans - always mistaken for "the failing requests were never traced".

**(d) Manual spans** - `app/src/lib/trace.ts`, because instrumentation cannot know what "price
the basket" means:

```ts
const tracer = trace.getTracer(config.serviceName);   // the name you search in Tempo

export async function withSpan<T>(name, attrs, fn): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
      throw err;
    } finally { span.end(); }   // never leak an unended span down the throwing path
  });
}

export function startSpan(name, attrs = {}): SpanHandle {   // deliberately NOT active
  const span = tracer.startSpan(name, { attributes: attrs });  // ...setAttribute/error/end
}
```

The difference is the word **active**: `startActiveSpan` puts the span in context, so every HTTP
call, `pg` query and nested `withSpan` inside `fn` becomes its child - right for a business
step. `startSpan` deliberately does not activate, because a child span for a fire-and-forget,
metric-ish operation must not capture the rest of the request. `errorHandler()` uses it that way
(`startSpan('app.error', { 'error.code': code, 'http.status_code': statusCode })` then
immediately `.end()`): a zero-duration sibling you can search for without distorting the tree.
`checkout.ts` mirrors its in-flight gauge as `checkout.in_flight` the same way, which is why
that span is a *sibling* in section 4. The third export, `outboundTraceHeaders()`, is the manual
`propagation.inject` for hops no instrumentation covers - [13b](13b-context-propagation.md).

**(e) Spanning the call that leaves the process** - `app/src/lib/payments.ts`; since the span is
active, the `fetch` is wrapped as its child and carries the trace to the gateway:

```ts
return await withSpan(
  'payment.charge',
  { 'tenant.id': req.tenantId, 'order.id': req.orderId, 'payment.amount_cents': req.amountCents },
  async (span) => {
    const response = await fetch(config.paymentUrl, { method: 'POST' /* ... */ });
    span.setAttribute('payment.status', body.status);
```

**(f) Where spans go** - `otel/config.yaml`. The collector **buys** one routing point per signal,
one place to redact `db.query.text` or a stray card attribute before it leaves the network, one
place for tail sampling later, and a stable endpoint so the app never learns Tempo's address; it
**costs** a hop, a container with a memory limit, and another thing that can quietly drop spans -
`memory_limiter` makes that survivable, since dropping spans beats an OOM kill that takes the
pipeline with it. Note `9464`, not `8888`: binding 8888 failed here with
`bind: address already in use` (the collector's internal telemetry owns it), so Prometheus
scrapes 9464 for the exporter and 8888 for the internals.

```yaml
receivers:  { otlp: { protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4318" } } } }
processors: { memory_limiter: { check_interval: 2s, limit_percentage: 80, spike_limit_percentage: 20 },
              batch: { send_batch_size: 512, timeout: 2s } }
exporters:  { otlp/tempo: { endpoint: tempo:4317, tls: { insecure: true } },
              prometheus: { endpoint: 0.0.0.0:9464, namespace: otelcol, send_native_histograms: false },
              debug: { verbosity: basic } }
extensions: { health_check: { endpoint: 0.0.0.0:13133 } }
service:
  pipelines:
    traces: { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlp/tempo, debug] }
```

## 4. What you should see

A checkout for `tenant_acme`, forced to decline (fake card, fake tenant, local only) -
`curl -s -X POST http://localhost:8000/api/checkout -H 'content-type: application/json' -H
'x-tenant-id: tenant_acme' -H 'x-request-id: ch13a-demo-002' -H 'x-chaos: decline' -d
'{"customer":{"email":"fake.buyer@example.com","name":"Fake Buyer"},"card":{"number":"4242 4242 4242 4242","exp":"11/29","cvv":"123"},"items":[{"sku":"tenant_acme-SKU0002","quantity":1}]}'`

```json
{"order_id":"17012","status":"failed","reason":"card_declined"}
```

Its Loki line, carrying the `trace_id` promised back in 02b/04a (query
`{service_name=~".+"} |= "ch13a-demo-002"` over the last 15 minutes):

```json
{"level":"info","time":"2026-10-29T08:19:45.821Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"ch13a-demo-002","tenant_id":"tenant_acme","trace_id":"592cca726913ed0ef726558efb89aacb","span_id":"6237afaa45878dcf","payment.status":"declined","payment.decline_reason":"card_declined","duration_ms":95,"msg":"payment gateway responded"}
```

Tempo search. The selector that works is `{name="POST"}`, because the auto-instrumented HTTP
span name is the method alone, not `POST /api/checkout` - `curl -sG localhost:3201/api/search
--data-urlencode 'q={name="POST"}' --data-urlencode 'limit=2'` begins:

```json
{"traces":[{"traceID":"2871d90d72b4b4742016d2fb4e38843","rootServiceName":"shop-api","rootTraceName":"POST","startTimeUnixNano":"1793261272789000000","durationMs":107,"spanSet":{"spans":[{"spanID":"fd5c4546903dc4da","name":"POST","startTimeUnixNano":"1793261272794000000","durationNanos":"99636581"}],"matched":3}}
```

The v1 search response keys the list as `traces`, not `matches` - my first `jq '.matches[]'`
printed null. `curl -s localhost:3201/api/v2/traces/592cca726913ed0ef726558efb89aacb` returns
19,836 bytes of OTLP JSON (base64 ids, nanosecond times); passed through a short python read of
`resource.service.name`, `parentSpanId` and duration, ten of its 28 spans - the spine, minus
the 18 `middleware - *`, `pg-pool.connect` and sibling `pg.query` inserts, all 0.0-0.9ms:

```
total spans 28
[shop-api] POST 101.7ms id=1xYjCrc4xIk=  {"http.response.status_code": "402", "http.request.method": "POST"}
  [shop-api] request handler - /api/checkout 101.3ms id=q+HDSRkx1/Y=  {"http.route": "/api/checkout"}
    [shop-api] checkout.price_basket 1.6ms id=pNtUwr9zvxo= STATUS_CODE_OK {"tenant.id": "tenant_acme"}
    [shop-api] checkout.in_flight 101.0ms id=U3Ddw5bnj7k=  {"tenant.id": "tenant_acme"}
    [shop-api] payment.charge 95.4ms id=YjevqkWHjc8= STATUS_CODE_OK {"tenant.id": "tenant_acme", "payment.amount_cents": "3888", "payment.status": "declined", "payment.decline_reason": "card_declined"}
      [shop-api] POST 94.7ms id=JUjEBYF+UcM=  {"http.response.status_code": "200", "http.request.method": "POST"}
        [payment-gateway] POST 93.8ms id=rwJlCO7u4jA=  {"http.response.status_code": "200", "http.request.method": "POST"}
          [payment-gateway] request handler - /charge 93.5ms id=miUT3o6WfSM=  {"http.route": "/charge"}
            [payment-gateway] gateway.charge 93.4ms id=2PFLmLLf38k= STATUS_CODE_OK {"tenant.id": "tenant_acme", "payment.amount_cents": "3888"}
    [shop-api] pg.query:UPDATE shop 0.7ms id=tKnf5wX2kPI=  {"db.query.text": "UPDATE orders SET status = 'failed' WHERE id = $1"}
```

Four things stand out: `payment.charge` is 95.4ms of a 101.7ms request and the tree says so
without you asking; `checkout.in_flight` is a **sibling**, not a parent, because `startSpan`
does not activate; two services sit under one trace id, with the gateway's own manual span under
our client span; and base64 `YjevqkWHjc8=` *is* hex `6237afaa45878dcf` from the log line - same
bytes, different encoding - so an id copied out of Loki lands on the exact span.

Collector health and its metrics port:

```bash
curl -s http://localhost:13133/   # {"status":"Server available","upSince":"2026-10-29T06:19:17.615593675Z","uptime":"2h1m57.850647646s"}
curl -s -w 'HTTP=%{http_code} bytes=%{size_download}\n' http://localhost:9464/metrics
```
```
HTTP=200 bytes=0
```

An empty body is correct and is the cleanest proof of (b): no OTLP metrics reach the collector,
so the exporter has nothing to serve - while the target itself is `up` in Prometheus'
`/api/v1/targets` as job `otel-collector` on `http://otel-collector:9464/metrics`.

## 5. In a real multi-tenant e-commerce platform

Four tenants here: `tenant_acme`, `tenant_globex`, `tenant_initech`, `tenant_umbrella`. Acme's
ticket says "checkout took 30 seconds last night", and spans answer from the tree instead of
guesses: which service held the time, whether it was `payment.charge` or a `pg.query`, and
whether it was ever only Acme. `tenant_initech` is the planted noisy neighbour - the fake gateway
adds 260ms and declines 25% for it, against 2% and no extra latency for Acme and Globex - and the
captured trace in `.artifacts/traces/checkout-trace-tree.txt` is exactly that story:
`POST 352.7ms` -> `payment.charge 346.3ms` (99% of it, declined) -> `gateway.charge 344.2ms`.
Metrics say p99 rose; only the trace says it was the gateway's sleep, not your database, not the
basket size. What makes it per-tenant is the attributes: `tenant.id` on `checkout.price_basket`,
`payment.charge` and `gateway.charge`, plus `http.route` and `payment.status`. Add
`deployment.environment` per release, and keep card fields off spans entirely (mistake 5).

## 6. When to use it, when not to

Use spans for "where did *this request's* time go" and "what did this particular checkout do":
metrics answer aggregates, logs answer "what happened", only a trace says which of five calls
inside one request was slow. Instrument once, search forever.

Do not use them where a counter suffices, and price it honestly - this checkout is 28 spans for
101ms (root, five middleware, handler, four business steps, ten `pg` spans, six in the gateway).
`scripts/loadgen.sh` pushes shop-api to about 14 log lines per second, so a busy day is tens of
thousands of spans an hour for detail nobody opens, and the trace pipeline's largest metric here,
`traces_spanmetrics_latency_bucket`, already holds 750 series
([07b](07b-labels-cardinality.md) in metric form). Attributes carry the same trap: an `order.id`
on every span makes each one unique and breaks group-by-name queries, so put identifiers on log
lines and keep attributes enumerable. Skip manual spans where instrumentation already covers the
step (HTTP, `pg`); add them where business meaning lives (price basket, charge card, reserve
stock, apply discount), and never span a loop over 200 basket lines - span the loop once and set
`basket.line_count`. Sampling, so you can turn the volume down without losing the interesting
traces, is [13b](13b-context-propagation.md).

## 7. Common mistakes

1. **Loading the SDK after the app.** `--import` or nothing; symptom is missing traces and
   `trace_id`-less log lines only at boot. Section 3(a).
2. **`startSpan` where you meant `withSpan`.** The span still appears in the tree, but the HTTP
   and DB calls inside it attach to the *grandparent* and your waterfall blames the wrong step.
3. **Reading status unset as success.** It is not: `withSpan` sets `OK` on the happy path,
   `errorHandler()` sets `ERROR` and records the exception.
4. **Searching for `POST /api/checkout`.** The span name is `POST`; the route lives on the
   `request handler - /api/checkout` child and in the `http.route` attribute.
5. **Card data or emails in attributes.** Pino's `redact` and the 03a scrubber do **not** run on
   spans - the exporter serialises attributes past your logger. `payments.ts` sends a `cardToken`
   and attributes only `payment.amount_cents`; at scale, redaction belongs in a collector
   processor, where it covers every service at once.
6. **No `sdk.shutdown()` on SIGTERM**, so the tail of every deploy loses spans.
7. **Tracing everything forever.** Section 6; the answer is sampling, not turning tracing off.
8. **The wrong Tempo URL.** On Tempo 3.1.1 here `/api/trace/<id>`, `/api/v1/traces?traceID=` and
   `/api/services` answer 404; `/api/v2/traces/<id>` and `/api/search` work. A "missing" trace is
   often a stale path.

## 8. Try it yourself

Make one trace where the payment step is the whole request, then compute the numbers instead of
borrowing mine. Take `trace_id` from that request's log line (Loki filter
`{service_name="shop-api"} |= "payment gateway responded"`, last two minutes):

```bash
curl -s -X POST http://localhost:8000/api/checkout -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_initech' \
  -d '{"customer":{"email":"fake.buyer@example.com","name":"Fake Buyer"},"card":{"number":"4242 4242 4242 4242","exp":"11/29","cvv":"123"},"items":[{"sku":"tenant_initech-SKU0001","quantity":1}]}'
curl -s http://localhost:3201/api/v2/traces/<traceid> | python3 -c "
import json,sys
d=json.load(sys.stdin)['trace']
for rs in d['resourceSpans']:
    svc=[a['value']['stringValue'] for a in rs['resource']['attributes'] if a['key']=='service.name'][0]
    for ss in rs['scopeSpans']:
        for s in ss['spans']:
            ms=(int(s['endTimeUnixNano'])-int(s['startTimeUnixNano']))/1e6
            print(f\"{svc}\t{s['name']}\t{ms:.1f}ms\")" | sort
```

**Hint:** `tenant_initech` carries a planted 260ms of gateway latency, so a correct run puts
`payment.charge` as the widest span by a mile, `gateway.charge` nearly as wide inside it, and
every `pg.query` under 2ms. Compare your ratio with the captured tree in
`.artifacts/traces/checkout-trace-tree.txt`.

**Cleanup:** nothing to delete and nothing to restart. The orders are fake and the spans expire by
themselves - Tempo's `block_retention: 72h` matches Loki's window - so stop `scripts/loadgen.sh`
if you want quiet and confirm the stack is as you left it with `docker compose ps`.

## 9. Next

[13b - Context propagation](13b-context-propagation.md): how the `trace_id` survives the hop from
shop-api to the payment gateway, what `traceparent` looks like on the wire, and why sampling
decides whether the request you needed is in the database at all.
