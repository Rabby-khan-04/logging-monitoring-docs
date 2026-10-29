# 07a - Counters, gauges, histograms

Metrics are numbers with names: cheap enough to keep for years, fast enough to alert on.
The decision that matters is *which kind of number* a measurement becomes, because you
cannot change it later without redeploying. Logs (01-06) explain one request; metrics
explain a million.

> Forward link needed before section 4: some queries use `rate(x[5m])`, which 08b
> explains exactly. Here it answers "how fast is this climbing, per second".

## 1. Simple explanation

Picture a market stall.

A **counter** is the clicker the stallholder holds by the door. Every customer makes it
go up by one, never down. To know how busy the morning was you ignore the number on the
display and watch how fast it climbs.

A **gauge** is the whiteboard saying "people in the shop right now". Up when someone
walks in, down when they leave. Only the number at this second means anything, and
adding yesterday's board to today's is nonsense.

A **histogram** is a shelf of labelled jars: "under 0.05 seconds", "under 0.1",
"anything at all". Each departing customer drops one pebble into the jar that fits their
wait; the actual time is never written down. Ask "how long did the slow ones wait?" and
you pour pebbles out of the biggest jar until you have removed a hundred. Honest
ballpark, almost free to fill.

## 2. Real name

The proper term is **metric type**, and Prometheus declares it inside the scrape, on a
`# TYPE` line, so nobody has to guess it from a name.

- **Counter**: increases only, and resets to zero when the process restarts. Prometheus
  notices a restart for you; you never set one back by hand. Names end in `_total`.
- **Gauge**: moves up and down with `set()`, `inc()` or `dec()`, and only the latest
  sample is meaningful. Queue depth, memory bytes, in-flight work.
- **Histogram**: observations sorted into **buckets**. Each bucket is a counter and each
  is **cumulative**: `le="0.5"` counts every request of *0.5 seconds or less*, smaller
  ones included. `le` means "less than or equal", the last bucket is always `le="+Inf"`,
  and `+Inf` therefore equals the total. One histogram exports three things under one
  name: `..._bucket`, `..._sum` (sum of observed values) and `..._count` (observations).
  Edges are fixed in code, so a bad shelf costs a redeploy.
- **Summary** also exists in prom-client (quantiles computed in your process), but a
  Summary cannot be re-aggregated across tenants or replicas, so this project uses none.
- A **time series** is one metric name plus one exact set of label values - the cost
  unit of the whole system.

## 3. Example

Three types from `app/src/lib/metrics.ts`, comments on the lines that matter:

```ts
// COUNTER: only ever goes up. Three labels, all from bounded value sets.
export const httpRequestsTotal = new client.Counter({
  name: 'shop_http_requests_total',
  labelNames: ['method', 'route', 'status_class'] as const,
});

// GAUGE: goes both ways. inc() when a checkout starts, dec() when it finishes.
export const ordersInFlight = new client.Gauge({
  name: 'shop_orders_in_flight',
  help: 'Checkouts currently being processed.',
  labelNames: ['tenant_id'] as const,
});

// HISTOGRAM: the jars. Eleven edges plus the automatic +Inf, in seconds.
export const httpRequestDurationSeconds = new client.Histogram({
  name: 'shop_http_request_duration_seconds',
  labelNames: ['method', 'route', 'status_code', 'tenant_id'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// GAUGE PINNED AT 1, METADATA IN LABELS: prom-client 15 has no `Info` metric type,
// so this is how "which build is running?" gets answered.
buildInfo.set({ release: config.release, environment: process.env.NODE_ENV ?? 'development' }, 1);
// Each real definition also ends with `registers: [register]`, which picks the
// registry it is exported on - the whole story of 07b.
```

The calls that feed them, one per request:

```ts
// app/src/middleware/latency.ts - observe() drops one pebble on the shelf.
httpRequestDurationSeconds.observe(
  { method: req.method, route, status_code: String(res.statusCode),
    tenant_id: currentContext().tenantId ?? 'none' },
  seconds,
);
// app/src/routes/checkout.ts - inc() on the way in, dec() in the `finally` block.
// Only ever inc()? Then you built a counter by accident.
ordersInFlight.inc({ tenant_id: tenantId }); ordersInFlight.dec({ tenant_id: tenantId });
```

`shop_db_pool_connections` adds a fourth trick: a gauge with an `async collect()` reading
`pool.totalCount / idleCount / waitingCount` **at scrape time**. prom-client 15.1.3, by the
way, is **deprecated upstream** (replacement: `@prometheus-io/client`, 0.16.x); 08a shows
both.

## 4. What you should see

Captured on this machine with the stack running. Type is declared, not guessed:

```
$ curl -s localhost:8000/metrics | grep '^# TYPE shop_' | awk '{print $4}' | sort | uniq -c | sort -rn
     30 gauge
      9 counter
      4 histogram
```

Thirty gauges, nine counters, four histograms - most of the gauges came free from
`client.collectDefaultMetrics` (memory, event loop lag, handles).

COUNTER - one series, one number, ever climbing:

```
$ curl -s localhost:8000/metrics | grep -E '^shop_http_requests_total\{method="GET",route="/api/products"'
shop_http_requests_total{method="GET",route="/api/products",status_class="20xx"} 1086
```

GAUGE - nine tenant_initech checkouts were in progress at this instant; a scrape four
minutes later read 0 for all four tenants. A counter cannot do that:

```
$ curl -s localhost:8000/metrics | grep '^shop_orders_in_flight'
shop_orders_in_flight{tenant_id="tenant_acme"} 0
shop_orders_in_flight{tenant_id="tenant_umbrella"} 0
shop_orders_in_flight{tenant_id="tenant_initech"} 9
shop_orders_in_flight{tenant_id="tenant_globex"} 0
```

HISTOGRAM for one label set (`GET /api/slow`, tenant_initech, status 200). The shelf is 12
bucket lines; `le="0.01"` through `le="10"` are left out for space - they read 0, 0, 22 and
then a 103 plateau, which is exactly what `+Inf` reports:

```
$ curl -s localhost:8000/metrics | grep 'route="/api/slow",status_code="200",tenant_id="tenant_initech"'
shop_http_request_duration_seconds_bucket{le="0.005",method="GET",route="/api/slow",status_code="200",tenant_id="tenant_initech"} 0
shop_http_request_duration_seconds_bucket{le="0.05",method="GET",route="/api/slow",status_code="200",tenant_id="tenant_initech"} 5
shop_http_request_duration_seconds_bucket{le="0.25",method="GET",route="/api/slow",status_code="200",tenant_id="tenant_initech"} 68
shop_http_request_duration_seconds_bucket{le="0.5",method="GET",route="/api/slow",status_code="200",tenant_id="tenant_initech"} 103
shop_http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/api/slow",status_code="200",tenant_id="tenant_initech"} 103
shop_http_request_duration_seconds_sum{method="GET",route="/api/slow",status_code="200",tenant_id="tenant_initech"} 21.137463731000004
shop_http_request_duration_seconds_count{method="GET",route="/api/slow",status_code="200",tenant_id="tenant_initech"} 103
```

103 requests: 68 took 0.25s or less, 35 landed between 0.25s and 0.5s, none above it.
`_sum` over `_count` is 0.205s - and 08c shows why that average is the least interesting
number in the block.

Cost of the shelf, from the HTTP API (the same call with `_count` returned `"50"`):

```
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=count(shop_http_request_duration_seconds_bucket)'
{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1793258911.275,"600"]}]}}
```

50 label combinations times 12 buckets = 600 bucket series, and 700 for the whole
histogram with `_sum` and `_count`. All six app counters together are 82 series - hold
that ratio in mind before you add a label. `shop_build_info` reads `1`, labelled
`release="1.0.0", environment="production"`, exactly as section 3 sets it.

## 5. In a real multi-tenant e-commerce platform

`tenant_globex` asks monthly: "how much did we sell?" The tempting answer is a gauge called
`shop_revenue`, wrong twice: a gauge is a snapshot, so it must be *set* from a running total
(a database read per request), and summing snapshots of a running total counts the same money
over and over. So this ships a counter of integer cents:

```ts
export const orderValueCentsTotal = new client.Counter({
  name: 'shop_order_value_cents_total',
  labelNames: ['tenant_id', 'currency'] as const,
});
// app/src/routes/checkout.ts, after the capture succeeds. The second argument matters:
// a counter adds "this much", not just "one". Cents, because a counter of
// floating-point pounds drifts.
orderValueCentsTotal.inc({ tenant_id: tenantId, currency }, totalCents);
```

Lifetime revenue, from `sum by (tenant_id) (shop_order_value_cents_total) / 100`: acme
$5562.16, globex $5453.88, umbrella $4806.40, initech $4029.68 - summed since the process
started, with no database query and no history lost.

The two types then sit side by side in one funnel: `shop_checkout_step_total` (counter)
gives volume, `shop_orders_in_flight` (gauge) says whether checkouts are *stuck right now* -
"busy" versus "on fire".

## 6. When to use it, when not to

- Something that happens: **counter** (requests, orders, declines). One series per label
  combination, one integer per scrape: 82 series for all six app counters.
- A level, depth or capacity: **gauge** (pool size, memory, in-flight work). One series
  too, but with no history recoverable from it.
- A duration or size *distribution*: **histogram**. Multiply label combinations by
  (buckets + 2), because every bucket is a series and `_sum` plus `_count` come along:
  700 against 82. Twelve edges is already generous - each extra edge is another series,
  and edges more than about 2x apart blur the middle.
- Not a histogram for a value that is not an observation of time or size (a price, a
  version): gauge or log field. And not metrics for what a log is for: "why did order 4421
  fail?" is a Loki query with a `request_id` (04a, 06a).

## 7. Common mistakes

1. **A gauge for something that only goes up.** The moment someone asks "orders between
   09:00 and 10:00" you are differencing snapshots, which break on every restart.
2. **A counter for something that goes down.** An "active sessions" counter can only lie -
   `dec()` exists, so use a gauge.
3. **Trusting the `_total` suffix.** Three metrics here end in `_total` and are gauges:
   `shop_nodejs_active_resources_total`, `..._handles_total`, `..._requests_total`.
   `# TYPE` is the truth, the name is a habit.
4. **Reading buckets as ranges.** `le="0.5"` is not "between 0.25 and 0.5", it is "0.5 or
   less"; the range needs the bucket below subtracted, which is what
   `histogram_quantile` does for you (08c).
5. **Bad edges, or a hand reset.** Copy the usual Express example capped at 1s and every
   30-second payment timeout vanishes into `+Inf`, untellable from 300s; setting a counter
   back to zero destroys every rate over the current window, and Prometheus cannot tell
   that from a real restart.

## 8. Try it yourself

Sort everything this app exports by declared type, then find the lies:

```bash
curl -s localhost:8000/metrics | grep '^# TYPE' | awk '{print $4}' | sort | uniq -c
curl -s localhost:8000/metrics | grep '^# TYPE' | awk '$4=="gauge" && $3 ~ /_total$/ {print $3}'
```

**Hint:** the second command is mistake 3. Predict how many lines it prints, then work out
what each one really counts - those names come from prom-client's defaults, not this repo.

**Cleanup:** both are plain `GET /metrics` reads, and `/metrics` is a path the app
deliberately does not log (`app/src/middleware/requestContext.ts`). Nothing to undo.

## 9. Next

What a metric costs is not the number, it is the labels written beside it - and 07b blows
that up on purpose and measures the pieces.

**Next:** [07b - Labels and cardinality](07b-labels-cardinality.md)
