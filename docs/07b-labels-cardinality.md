# 07b - Labels, and the cardinality trap

Labels are what make a metric useful, and they are the one thing that can take Prometheus down. This chapter
measures the damage on purpose, on a machine you own, with fake data, because the work version of this mistake
is discovered by an out-of-memory kill at 3am.

> Two queries below use `rate(x[5m])`; 08b explains exactly what that means. "How fast is this climbing" is
> enough for now.

## 1. Simple explanation

A metric name is a pile of paper. A **label** is a question you write on every sheet before filing it: "which
shop?", "which page?", "which code?"

Now the part that bites. The cupboard keeps **one drawer per different combination of answers**: four tenants
is four drawers, four tenants times twelve pages is forty-eight, and adding one page splits every existing
drawer again. You do not pay per label, you pay per *combination*. So if the question is "which exact web
address, in full, including the stuff after the question mark", the cupboard needs one drawer per web address
on the internet. It does not run out of paper. It runs out of cupboard, and the cupboard is your memory.

## 2. Real name

- A **label** is a key-value pair on a sample (`tenant_id="tenant_acme"`); the **label   set** is the whole
list of them.
- A **time series** is identified by metric name plus label set, so a new label set is a   new series, not a
new value in an old one. **Cardinality** counts those series under   one metric name, and with independent
labels it is roughly the *product*.
- **Bounded possible values** is the test that decides whether a label is safe. `method`   has about six values
platform-wide, so it is safe; a URL has no ceiling, and it does   not matter that today's traffic uses twelve
of the infinite possibilities.
- Prometheus adds labels of its own: `job` and `instance` from the scrape config,   `service` and `tier` from
`prometheus/prometheus.yml`, and the metric name itself as the   pseudo-label `__name__`.
- **`prometheus_tsdb_head_series`** is how many series Prometheus holds in memory - the   dial this chapter is
about. The stack guards it with the alert `SeriesCountHigh`,   expression `sum(prometheus_tsdb_head_series) >
60000`, `for: 5m`. How alerts work is   10a; here, just read the number.

## 3. Example

The safe labels and one deliberate disaster, side by side.

```ts
// app/src/lib/metrics.ts - four bounded labels. tenant_id is safe: this platform serves
// four tenants, not four million.
labelNames: ['method', 'route', 'status_code', 'tenant_id'] as const,

// app/src/middleware/latency.ts - WHY the fallback is not req.url:
const route = req.route?.path ?? (req.baseUrl || '/unmatched');
// req.route.path is the mounted TEMPLATE ("/api/orders/:id"): one series per endpoint,
// however many ids fly past. For a request that matched nothing req.url would hand a bot
// squad a new series per scan; '/unmatched' is one fixed value, so every 404 costs one.

// app/src/lib/metrics.ts - DANGER DEMO: the trap, built on purpose.
export const demoRegistry = new client.Registry();   // a DIFFERENT registry
export const badRequestPathTotal = new client.Counter({
  name: 'shop_demo_cardinality_total',
  help: 'Deliberately bad example: an unbounded label value.',
  labelNames: ['path', 'client_ip'] as const,       // both unbounded
  registers: [demoRegistry],                        // never on /metrics
});

// app/src/routes/debug.ts - and the endpoint that fills it from user input.
badRequestPathTotal.inc({ path: req.originalUrl, client_ip: req.ip ?? 'unknown' });
```

```yaml
# prometheus/prometheus.yml - quarantine it on the scraping side too: separate
# job, separate path, and a label that lets any query exclude the mess.
  - job_name: shop-api-demo
    metrics_path: /metrics/demo
    static_configs:
      - targets: ["shop-api:8000"]
        labels:
          service: shop-api
          tier: demo
```

## 4. What you should see

**A. The explosion, counted.** Baseline first:

```
### count({__name__=~"shop_demo.*"})    -> {} = 120
### prometheus_tsdb_head_series         -> {} = 22718
```

Then 140 requests, each with a different query string - the designed experiment, kept inside the demo registry:

```bash
for i in $(seq 200 339); do
  curl -s -o /dev/null -H "x-tenant-id: tenant_acme" "localhost:8000/api/cardinality?x=$i"
done
```

One scrape interval later, the same two queries:

```
### count({__name__=~"shop_demo.*"})    -> {} = 260
### prometheus_tsdb_head_series         -> {} = 23012
```

140 URLs, 140 new series, exactly. `count by (__name__) ({__name__=~"shop_demo.*"})` answers one row -
`{'__name__': 'shop_demo_cardinality_total'} = 260` - and the exported text grows the same way:

```
shop_demo_cardinality_total{path="/api/cardinality?x=200",client_ip="::ffff:172.25.0.1"} 1
shop_demo_cardinality_total{path="/api/cardinality?x=201",client_ip="::ffff:172.25.0.1"} 1
```

**B. The blast radius.** The healthy endpoint never saw it (a plain `grep -c`):

```
$ curl -s localhost:8000/metrics | grep -c 'shop_demo'
0
```

That zero is the design: the counter lives in `demoRegistry`, so `/metrics` does not export it and only job
`shop-api-demo` (`tier="demo"`) pulls it. The damage is one metric name plus a fatter payload: `curl -s
localhost:8000/metrics/demo | wc -c` = 23682 bytes, against 127798 for the healthy `/metrics`.

**C. Where series come from.** The six widest names on the server, at 24096 head series:

```
### topk(6, count by (__name__) ({__name__=~".+"}))
    traces_spanmetrics_latency_bucket = 735
    shop_http_request_duration_seconds_bucket = 624
    container_tasks_state = 580
    loki_request_duration_seconds_bucket = 495
    grafana_apiserver_request_duration_seconds_bucket = 480
    container_memory_failures_total = 464
```

Four of six are bucket sets, and the multiplication says why: 52 label combinations in our HTTP histogram times
12 buckets = the 624 you see.

**D. The fallback that works, and the one that does not.** Four requests to paths that exist nowhere
(`/wp-login.php`, `/api/products/ABC-9999?trace=1`, `/.env`, `/admin/console`):

```
### sum by (route) (shop_http_request_duration_seconds_count{route="/unmatched"})
    {'route': '/unmatched'} = 5
### count(shop_http_requests_total)      before = 19,  after = 23
```

The histogram kept its promise: five 404s, one series. The counter leaked because
`app/src/middleware/requestContext.ts` falls back to `req.path` instead of a fixed string: four permanent
series, one per scanned path - the demo bug, one size smaller, and in the *healthy* registry.

**E. The label that is not there.** `shop_http_requests_total` has no `tenant_id`:

```
### count by (tenant_id) (shop_http_requests_total)   -> {} = 23
### sum by (tenant_id) (rate(shop_http_requests_total[5m]))
    {} = 0.6089413614035087
### sum by (tenant_id) (rate(shop_http_request_duration_seconds_count[5m]))
    {'tenant_id': 'tenant_initech'} = 0.2912280701754386
    {'tenant_id': 'none'} = 0.17385084210526314
    {'tenant_id': 'tenant_acme'} = 0.059649122807017535
    {'tenant_id': 'tenant_globex'} = 0.04210526315789473
    {'tenant_id': 'tenant_umbrella'} = 0.04210526315789473
```

One row, labelled `{}`: everything, because nothing was grouped. The per-tenant rate has to come from the
histogram's `_count`. That is a flaw in this stack, not a rule of Prometheus, and it is why "requests per
tenant" panels often draw one flat line.

## 5. In a real multi-tenant e-commerce platform

`tenant_id` is four values here, so it costs almost nothing and buys the noisy-neighbour view: at measurement
time `tenant_initech` was doing 0.291 requests per second while acme, globex and umbrella sat at 0.042-0.060.
You cannot throttle a shop you cannot see.

Never label anything that names a *request* or a *person*: `request_id` is a fresh UUID per call (04a) and
`customer_hash` grows with the customer base, so both belong in the log line (06a, 04b) and the trace (13a).
The safe ones are fixed vocabularies - `tenant_id` (4), `method` (6), `state` (total, idle, waiting) - plus, in
`app/src/lib/payments.ts`, an outcome chosen in code rather than copied from a message:

```ts
paymentProviderDurationSeconds.observe({ outcome: err instanceof UpstreamTimeoutError ? 'timeout' : 'error' }, seconds);
```

## 6. When to use it, when not to

- Add a label when a chart or an alert must split by it, and only when the values come   from a list that fits
on one page.
- Never add one "to make filtering easier later": you cannot remove a label without   breaking every query on
the metric, and each value shipped lives until the restart.
- Cost, measured: those 260 demo series make `/metrics/demo` 23682 bytes, re-pulled every   15 seconds - about
5.5 MB per hour of HTTP for a metric no dashboard reads. Prometheus   holds 24096 head series in 338 MB
resident, so the burst was a rounding error here;   multiply both figures by a real platform and the trap
explains itself.
- Noise: an accidental `path` label turns a legend into 4000 rows and hides the one line you   needed. For
per-request detail use a log (06a) or a trace (13a); exemplars (08c) link a   metric point back to one.

## 7. Common mistakes

1. **`req.url`, `req.originalUrl` or `path` as a label.** The demo counter, plus the    `req.path` fallback in
the request counter - both measured above.
2. **`client_ip`, `user_agent`, `request_id`, `customer_hash`, `order_id`** as labels:    all unbounded, and
one bot scan adds more series than real traffic does in a month.
3. **A label copied from an error message.** `reason: err.message` puts exception text,    ids and timestamps
included, into the label set; keep a fixed vocabulary.
4. **Assuming `status_code` is free.** Bounded, yes, but it multiplies: `method x route x    status_code x
tenant_id` is how one histogram reached 624 series. If you only chart 5xx,    `status_class` is the cheaper
twin.
5. **Grouping by a label that metric does not have** (4E): the query succeeds and answers    "everything" with
`{}`.
6. **Quarantining in only one place.** The demo counter is harmless thanks to two guards -    a separate
registry in the app and a separate `tier="demo"` job. Either alone leaks.

## 8. Try it yourself

Reproduce measurement A at a tenth the size:

```bash
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=count({__name__=~"shop_demo.*"})'
for i in $(seq 500 509); do
  curl -s -o /dev/null -H "x-tenant-id: tenant_globex" "localhost:8000/api/cardinality?exercise=$i"
done
sleep 20 && curl -sG localhost:9090/api/v1/query --data-urlencode 'query=count({__name__=~"shop_demo.*"})'
```

**Hint:** the count rises by exactly 10, not by the number of requests, because the ten URLs differ. Then run
the loop ten times with the *same* `exercise=` value and watch it not move: that is a bounded label, and it is
the test to apply before any label ships.

**Cleanup:** the series live only in the quarantined registry (`/metrics/demo`, job `shop-api-demo`,
`tier="demo"`), so no healthy metric or dashboard is touched. Nothing can be deleted from a running process -
prom-client never forgets a label set - so the restore is `docker compose restart shop-api`: the registry
resets, the series leave the scrape, `count({__name__=~"shop_demo.*"})` returns no series, and the old samples
age out of the TSDB by themselves. That restart also zeroes every `shop_*` counter, so funnel totals climb from
nothing again - harmless here, and worth mentioning to anyone watching a chart dip.

## 9. Next

Labels give you the slices; which slices are worth watching is 07c, with three named checklists: RED, USE and
the four golden signals.

**Next:** [07c - RED, USE and the four golden signals](07c-red-use-golden-signals.md)
