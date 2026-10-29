# 13c - Find the slow part

Chapters 13a and 13b gave you spans and a trace ID. This chapter answers the
question you actually get asked: "checkout is slow - where?" One trace on this
machine answers it in one sentence, and the answer is not the database.

## 1. Simple explanation

Your friend says "getting lunch took an hour". You do not guess: you ask for
every step written down. Walk in 2 minutes, stand in the queue 55 minutes, pay 2
minutes, sit down 1 minute. The answer is now obvious, because you look for the
longest line and ignore the door and the chairs.

Two more questions about that long line. Were they **working** the whole time, or
**waiting**? Standing in a queue is not chewing slowly. And is that queue long
every day, or only today? One drawing is a story; a count over a week is a fact.
So: draw every step, find the biggest bar, ask work or waiting, then check
whether it is always that big.

## 2. Real name

- **Waterfall** - the trace as nested bars, each starting after its parent. The
  nesting is what makes it readable: a child's time is *inside* the parent's,
  never beside it. The **critical path** is the chain of children that adds up to
  the parent, so finding the biggest child finds it.
- **Work vs waiting** - a span's wall-clock time includes time blocked on a lock,
  a queue, a pool, a round trip. The waterfall cannot tell which; it tells you
  where to look next, which is its whole value.
- **Service graph** - the dependency map built *from* traces: every client span
  calling a server span becomes an edge with rate, errors and latency. Here it
  lives in Prometheus, not Tempo: the **metrics generator**, the Tempo component
  that computes it, writes the series out.
- **Span metrics** - the same idea per span name: rate, p95 and error ratio for
  `payment.charge` or `pg.query:SELECT shop` without searching traces. Traces
  answer "this request"; span metrics answer "every request", and because they
  are ordinary Prometheus data, chapter 08b's PromQL is what reads them.
- **Virtual node** - an edge whose client is unknown: the generator invents a
  stand-in caller (here `user`) and tags it `connection_type="virtual_node"`.
- **Exemplar** - a trace ID attached to one point on a metric curve, so a spike
  can be clicked into a real trace.

## 3. Example

Tempo 3.1's read API is `/api/v2/traces/<traceid>`; `/api/trace/<id>` and
`/api/v1/traces?traceID=` are 404 here. Search first, then fetch. Span names on
this build are just the HTTP method (`POST`), because auto-instrumentation does
not put the route in the name, and `duration` is an *inner* selector - the pipe
form `{name="POST"} | duration > 100ms` fails with `unexpected duration`.

```bash
curl -sG localhost:3201/api/search --data-urlencode 'q={name="POST"}' --data-urlencode 'limit=1'
curl -sG localhost:3201/api/search --data-urlencode 'q={name="POST" && duration > 100ms}' --data-urlencode 'limit=3'
```

The JSON is verbose, so flatten it into a text waterfall: duration in ms,
service, span name, biggest first.

```bash
curl -s localhost:3201/api/v2/traces/<traceid> | jq -r '.trace.resourceSpans[] as $r
  | ([$r.resource.attributes[]? | select(.key=="service.name") | .value.stringValue][0] // "unknown") as $svc
  | $r.scopeSpans[].spans[]
  | [ (((.endTimeUnixNano|tonumber) - (.startTimeUnixNano|tonumber))/1000000 | .*1000 | round/1000), $svc, .name ] | @tsv' \
  | sort -rn | head -15
```

Grafana (Explore -> Tempo) draws the same tree in colour; nobody can see a browser
here, so this chapter quotes API output. The graph and span metrics are queried
from **Prometheus**, not Tempo:

```bash
# Edges, requests per second. Labels on THIS build are client / server.
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum by (client, server) (rate(traces_service_graph_request_total[5m]))'
# Error ratio per edge: failed calls are their own series.
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum by (client, server) (rate(traces_service_graph_request_failed_total[5m])) / sum by (client, server) (rate(traces_service_graph_request_total[5m]))'
# p95 per service, from the trace latency buckets.
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=histogram_quantile(0.95, sum by (le, service) (rate(traces_spanmetrics_latency_bucket[5m])))'
# Busiest span names. Labels: service, span_name, span_kind, status_code.
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=topk(5, sum by (span_name) (rate(traces_spanmetrics_calls_total[5m])))'
```

The wiring that makes those series exist, from `tempo/config.yaml` (Prometheus is
started with `--web.enable-remote-write-receiver`, which this requires):

```yaml
metrics_generator:
  storage:
    remote_write:
      - url: http://prometheus:9090/api/v1/write   # the only egress for graph data
        send_exemplars: true
overrides:
  defaults:
    metrics_generator:
      processors: ["span-metrics", "service-graphs"]
```

Tempo 3.1 rejected the 2.x shape (`traces:`, `ingester:`, `compactor:`, `search:`,
`block.v2_encoding`, `distributor.log_accepted_traces`). Validate a config without
starting anything; `=true` matters because `-config.verify` is a boolean flag:

```bash
docker run --rm -v "$PWD/tempo/config.yaml:/c.yaml:ro" --entrypoint /tempo \
  grafana/tempo:3.1.1 -config.file=/c.yaml -config.verify=true
```

## 4. What you should see

Old read endpoints, and any metrics API inside Tempo, verified by HTTP code:
`/api/trace/x` 404, `/api/v1/traces?traceID=x` 404, `/api/metrics/querier` 404,
`/api/services` 404.

Search returns the bare method as the root trace name (`"rootTraceName":"POST"`,
`"durationMs":82` for the trace below), and the flattener prints it:

```text
81.843	shop-api	POST
81.425	shop-api	request handler - /api/checkout
76.111	shop-api	payment.charge
74.517	payment-gateway	gateway.charge
0.847	shop-api	pg.query:UPDATE shop
0.636	shop-api	pg.query:SELECT shop
```

`.artifacts/traces/checkout-trace-tree.txt` is the same 28-span shape, 4x bigger,
and it is the lesson of this chapter:

```text
[shop-api] POST  352.7ms  code=
  [shop-api] request handler - /api/checkout  352.2ms  code=
    [shop-api] payment.charge  346.3ms  code=STATUS_CODE_OK
        attrs={"tenant.id": "tenant_initech", "payment.status": "declined", "payment.decline_reason": "card_declined"}
    [shop-api] pg.query:INSERT shop  1.6ms  code=
    [shop-api] pg.query:SELECT shop  0.4ms  code=
```

346.3 of 352.7 ms - 99% - is `payment.charge`; the five `pg.query` spans are
0.2-1.6 ms each. The database was nowhere near the problem, and "the DB is slow"
was the first guess. Find the biggest child, then ask whether it is work or
waiting: the attributes show a gateway *answer* (`card_declined`) after 344 ms
downstream, not local arithmetic.

Edges during the load run, and the error ratio per edge, both verbatim from
`.artifacts/traces/service-graph.txt`:

```text
   shop-api -> postgres = 7.684 req/s
   user -> shop-api = 1.632 req/s
   shop-api -> payment-gateway = 0.435 req/s
   user -> payment-gateway = 0.065 req/s
=== graph error ratio per edge ===
   shop-api -> payment-gateway = 0.2126
   user -> shop-api = 0.085
   shop-api -> postgres = 0.0
```

That 21.26% failed edge is the payment outage from the chapter 18 drill: one
number on one edge, before anyone opened a trace. The same query minutes later,
load stopped, returns the same four edges at 0.281 / 0.067 / 0.144 / 0.007 req/s
and p95 `shop-api = 0.097 ms`, `payment-gateway = 0.082 ms` - a snapshot is not a
baseline. `user -> shop-api` has no client service behind it: every root server
span with no parent gets a synthetic edge from a stand-in caller named `user`,
flagged `connection_type: "virtual_node"`. The graph must start somewhere, so it
invents a start - it means "an external caller we cannot name", and it hides who
really called, which is chapter 13b's whole point.

Label names matter: grouping by the names from the docs returns one meaningless
series, `None -> None = 0.498 req/s`, because these series carry `client` and
`server` (graph: `traces_service_graph_request_total`, `..._failed_total`,
`..._client_seconds_*`) and `service`, `span_name`, `span_kind`, `status_code`
(span metrics: `traces_spanmetrics_calls_total`, `..._latency_bucket`). Cost,
measured live on the quiet stack: `count(traces_spanmetrics_latency_bucket)` =
660, `count(traces_service_graph_request_total)` = 4,
`count({__name__=~"traces_.*"})` = 929 - and 750 for the latency histogram during
the heavier capture, the largest single metric on this box.

One honest gap: `send_exemplars: true` is set, but this Prometheus has no
`--enable-feature=exemplar-storage` (its flags API has no such entry), so
exemplars arrive and are dropped - a range query returns `series: 1 | exemplars
present: False`. Metrics-to-trace links here are describable, not clickable:
`histogram_quantile` finds the bad window, `{name="POST" && duration > 100ms}`
finds a trace inside it. Config verify, both directions: the project file prints
nothing and exits 0 (silent = valid), while a 2.x file with a `traces:` block
fails with `yaml: unmarshal errors: line 3: field traces not found in type
app.Config`. The image is distroless (no `ls`, no `sh`, entrypoint `/tempo`), so
`docker compose exec tempo sh` is not an option: verify out-of-band and read
`docker compose logs tempo`.

## 5. In a real multi-tenant e-commerce platform

Four shops share this platform: `tenant_acme`, `tenant_globex`,
`tenant_initech`, `tenant_umbrella`. Initech is the configured noisy neighbour:
4,500 of the 12,000 seeded orders (37%) and the most log lines per 15 minutes
(2,000 against Umbrella's 1,284). Black Friday, 14:05, "checkout is slow for some
shops":

1. The graph: `shop-api -> postgres` at 7.684 req/s while `user -> shop-api` is
   1.632 req/s. Four or five DB calls per user request means something fans out -
   and it began when Initech's ops team left a dashboard open on
   `GET /api/reports/tenant-summary` (chapter 14).
2. `topk(5, sum by (span_name) (rate(traces_spanmetrics_calls_total[5m])))` names
   the span: `pg.query:SELECT shop`. A statement to look at, not a vibe.
3. One trace decides whether Initech waits on the pool, on a lock, or genuinely
   makes Postgres work - the split chapter 14 measures with
   `EXPLAIN (ANALYZE, BUFFERS)`.
4. Same window, `shop-api -> payment-gateway` failing 21.26%: a *different*
   incident. Edges separate them; one blended "API p95" panel would hide both.
   `user -> payment-gateway` is real too, and also a finding: the load generator
   hits the gateway directly, bypassing `shop-api`. In production an edge from
   `user` into a private service is an access-control question, not noise.

## 6. When to use it, when not to

Use the waterfall when a request is slow and you do not know why, and when you
want proof that a suspect is innocent (today's was the database). Use the graph
and span metrics for trend: they are Prometheus series, so they are alertable
(10a), cheap to keep, and they survive tail sampling - a sampled trace cannot
give a p95, span metrics can. Not as your only source, and not for free:

- **Cardinality is the bill.** `traces_spanmetrics_latency_bucket` is a histogram
  over `service x span_name x status_code x le` and is the largest metric here at
  750 series; adding `tenant_id` or `db.statement` multiplies it. Chapter 07b's
  trap verbatim, with `SeriesCountHigh` (60,000) as the guard.
- **Edges count calls, not effort, over small denominators.** An N+1 loop reads as
  "the database is busy 5x per request" - right number, wrong conclusion - and at
  0.007 req/s one retry swings an error ratio, so never alert on an edge without
  `for:`. Traces are the expensive signal (72h `block_retention`, 6h for the
  derived series): months of trend means recording rules, not more trace storage.
- **Blind spots stay blind.** A pool wait is inside a span only if something
  spanned it; `pg-pool.connect` here reads 0.0 ms, so chapter 14's pool gauge is
  the signal that trends.

## 7. Common mistakes

1. **Reading the parent and guessing.** `POST 352.7ms` says nothing; the child at
   346.3 ms does. Then ask work or waiting - 346 ms of waiting on an acquirer and
   346 ms of local CPU look identical in the tree.
2. **Assuming the database is the suspect because there is a database.** Those
   five `pg.query` spans were 0.2-1.6 ms. Measure before tuning.
3. **Using an old read URL** (`/api/trace/<id>`, `/api/v1/traces?traceID=`,
   `/api/services`, `/api/metrics/querier`: all 404 on 3.1.1), or being confused
   when the graph goes blank while traces keep working - that is Prometheus or
   the remote-write receiver, not Tempo.
4. **Copying label names from documentation** (`client_service_name` gives one
   `None -> None` series and false confidence), and **believing `user` is a
   service** or a span name is an endpoint: `{name="POST"}` matches three spans
   in this trace, so use `http.route` when you mean a route.
5. **Expecting exemplars because you enabled them** (the receiver must store
   them), and **judging a config change on old data** - after editing the metrics
   generator, read the last minute or two only, as with Loki in 06b.

## 8. Try it yourself

Generate load, then read the waterfall and the graph for the same window.

```bash
./scripts/loadgen.sh 30 5           # 30 seconds, 5 requests per second
curl -sG localhost:3201/api/search --data-urlencode 'q={name="POST" && duration > 100ms}' --data-urlencode 'limit=3'
# flatten the slowest traceID with the jq one-liner in section 3, then:
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=topk(5, sum by (span_name) (rate(traces_spanmetrics_calls_total[5m])))'
```

**Hint:** ignore the middleware spans (`jsonParser`, `observeLatency`,
`requestCount`) - 0.0-0.1 ms, counting the walk to the canteen. Divide the biggest
child by its parent: above ~90% everything else is decoration, so follow that
child or the cross-service hop under it. Then ask whether it was busy:
`payment.charge` at 346.3 ms with `payment.status: "declined"` is an upstream
*answer*, so the fix is a deadline (10a); a slow `pg.query` is chapter 14's
problem.

**Cleanup, restoring the machine:** nothing to undo - load and reads are harmless,
traces expire after 72h, derived series with Prometheus's 6h retention. Do **not**
add a Postgres index while practising: chapter 14 depends on a deliberately
missing one, so this must still print only ` order_items_pkey`:

```bash
docker compose exec -T postgres psql -U shop -d shop -tc \
  "SELECT indexname FROM pg_indexes WHERE tablename='order_items';"
```

## 9. Next

The waterfall cleared the database this time - and named the spans you now need to
read properly. [14 - Database monitoring](14-database-monitoring.md) opens those
`pg.query` spans: the slow query log, `pg_stat_statements`, pool counts and
`EXPLAIN` built from zero, including a missing index that makes one query 30x
faster and another one slower.
