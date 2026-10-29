# 06a - LogQL: streams, selectors, filters and metrics from logs

All output was captured on the laptop stack from `docs/00-roadmap.md` (API 8000, Loki
3101) on 2026-10-29. Live commands are printed in full; output from the captures in
`.artifacts/logql/` is labelled. `[...]` marks a line shortened for the page, never a
changed character.

## 1. Simple explanation

A library does not read every book to answer "where are the dinosaur books?". It looks
at the shelf label first.

Loki does the same. When a log line arrives, the collector writes a few words on the
outside of a box: which program, how serious, which shop. That box is a **stream**. Loki
opens only the boxes whose outside matches what you asked for, then reads the sentences
inside them, one at a time.

So there are two very different questions. "Show me the box called shop-api plus error" is
cheap: it is on the label. "Show me every sentence containing payment declined" is expensive:
Loki has to read the sentences. Learn which is which and fast queries become a reflex.

## 2. Real name

- **LogQL**: Loki's query language, in two families that look alike and return different
  shapes. *Log queries* give `resultType: "streams"` with a `stream` object; *metric
  queries* give `resultType: "vector"` with a `metric` object.
- **Stream**: one box of lines, identified by its label set and by nothing else. Two
  lines with the same label set share a stream; change one label value and you have
  started a new stream. There is no stream id.
- **Label selector** (`{service="shop-api", level="error"}`): an index lookup, priced by
  streams matched rather than lines stored. Matchers: `=`, `!=`, `=~`, `!~` (RE2,
  implicitly anchored, so `service=~"shop"` also matches `shop-api`).
- **Line filter** (`|=`, `!=`, `|~`, `!~`): applied to the raw line after the selector.
  Always a scan, and case-sensitive: `|= "Payment"` misses `payment`, so reach for
  `|~ "(?i)payment"` (documented RE2 behaviour, not measured on this machine).
- **Parser** (`| json`, `| logfmt`, `| regexp "(?P<x>...)"`, `| line_format`): turns text
  into comparable fields (`| json | duration_ms > 50`). Query-time only: costs CPU per
  line, adds nothing to the index.
- **Bounded label rule**: a label may only hold values from a small fixed set. This stack
  indexes `service`, `level`, `tenant_id`, `container`, plus Loki's own `detected_level`
  and `structured`: 14 services, 3 levels, 4 tenants. `request_id`, `trace_id`,
  `customer_hash` and `order_id` are unbounded, so they stay inside the line and are
  found with `|=`. Break the rule and you build a stream per request; the guard rail is
  `max_global_streams_per_user: 10000` in `loki/config.yaml`.
- **Metric queries from logs**, defined here because you have not met Prometheus yet:
  `count_over_time({...}[15m])` counts matching lines in a window; `rate({...}[15m])` is that
  count divided by the window - lines per second, so windows of different length stay
  comparable; `bytes_over_time` and `bytes_rate` count bytes instead of lines and are the
  honest cost signal (06b is built on them); `sum by (tenant_id) (...)` folds per-stream
  results together; `| unwrap duration_ms` inside a metric query averages a parsed number.
- **`level` vs `detected_level`**: `level` is what Alloy lifted out of the Pino JSON,
  `detected_level` is Loki's guess from the text. On this Loki 3.7.9 single binary neither
  appears in `/labels` and neither can be used as a selector: they ride along on the
  stream object without being index labels (section 4).

## 3. Example

The label set is built by the pipeline, not by Loki. `alloy/config.alloy`, abridged to
what decides your streams:

```hcl
discovery.docker "containers" { host = "unix:///var/run/docker.sock" }

discovery.relabel "project_only" {
  targets = discovery.docker.containers.targets
  rule {                                                       // keep only our stack
    source_labels = ["__meta_docker_container_label_com_docker_compose_project"]
    regex  = "observability-learn"
    action = "keep"
  }
  rule { source_labels = ["__meta_docker_container_label_com_docker_compose_service"],
         target_label = "service" }                             // -> the service label
}
// discovery.docker -> discovery.relabel -> loki.source.docker -> loki.process -> loki.write

loki.process "app" {
  stage.json   { expressions = { level = "level", tenant_id = "tenant_id" } }
  stage.labels { values     = { level = "", tenant_id = "" } }   // bounded -> labels
}
```

A shell helper, because Loki wants nanosecond bounds. The queries are in cost order,
cheapest first:

```bash
run(){                                                     # run "<logql>" [limit]
  local now=$(date +%s) start=$(( now - 900 ))
  curl -sG localhost:3101/loki/api/v1/query_range \
    --data-urlencode "query=$1" --data-urlencode "limit=${2:-3}" \
    --data-urlencode "start=${start}000000000" --data-urlencode "end=${now}000000000"
}
run '{service="shop-api", level="error"}'                 # 1 selectors only: index
run '{service="shop-api"} |= "payment declined"'          # 2 selector, then scan
run '{service="shop-api"} !~ "request completed"'         # 3 but the boring access line
run '{service="shop-api"} |= "capB-err-03"'               # 4 one request_id, in the line
run '{service="shop-api"} | json | res_statusCode="404"'  # 5 parser + field compare
run '{service="shop-api"} | json | duration_ms > 50'      # 6 numbers need no quotes
```

## 4. What you should see

The label API. The first call does not exist on this build, whatever the tutorials say:

```bash
$ curl -s -w '\nHTTP %{http_code}\n' localhost:3101/loki/api/v1/label_names
404 page not found

HTTP 404
$ curl -s localhost:3101/loki/api/v1/labels
{"status":"success","data":["compose_version","container","level","service","service_name","tenant_id"]}
$ curl -s "localhost:3101/loki/api/v1/label/service/values?start=$(( $(date +%s) - 900 ))000000000&end=$(date +%s)000000000"
{"status":"success","data":["alert-sink","grafana","otel-collector","payment-gateway","postgres","shop-api","tempo"]}
$ curl -s "localhost:3101/loki/api/v1/label/structured/values?start=$(($(date +%s)-1800))000000000&end=$(date +%s)000000000"
{"status":"success"}
```

The same `service` call with no time window (capture `.artifacts/logql/service-values.json`)
lists fourteen values, including one that should be gone:

```json
{"status":"success","data":["alert-sink","alertmanager","alloy","api","cadvisor","grafana","loki","node-exporter","otel-collector","payment-gateway","postgres","prometheus","shop-api","tempo"]}
```

`"api"` is the compose service name from before the rename to `shop-api`. Loki freezes a
stream's labels at ingestion and never rewrites them, so an obsolete value stays listed until
the 72h retention ages that stream out: judge a pipeline change on the last 1-2 minutes, never
on a default 15m window. `level` values are a closed set (`["error","info","warn"]`), while
`structured` and `detected_level` have nothing to report and cannot be selected, even though
they appear on stream objects in results:

```bash
$ run '{service="grafana"}' 1 | jq -c '.data.result | length, .[0].stream'
1
{"container":"observability-learn-grafana-1","detected_level":"warn","service":"grafana","service_name":"grafana"}
$ run '{service="grafana", detected_level="warn"}' 1 | jq -c '.data.result | length'
0
```

A log query returns `streams`: labels in `stream`, then `[nanoseconds, line]` pairs.

```bash
$ run '{service="shop-api", level="error"}' 2 | head -c 400
{"status":"success","data":{"resultType":"streams","result":[{"stream":{"container":"observability-learn-shop-api-1","detected_level":"error","level":"error","service":"shop-api","service_name":"shop-api","tenant_id":"tenant_acme"},"values":[["1793261985971313672","{\"level\":\"error\",\"time\":\"2026-10-29T08:19:45.970Z\",\"service.name\":\"shop-api\",[...]"}}
```

A metric query over the same lines returns a `vector` with `metric` and a
`[seconds, "value"]` pair. Read the first series: `{"metric":{}}` is the lines with no
`tenant_id` at all - the startup line, and requests from an unknown tenant.

```bash
$ curl -sG localhost:3101/loki/api/v1/query --data-urlencode 'query=sum by (tenant_id) (count_over_time({service="shop-api"} [15m]))' | head -c 430
{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1793261998.007,"4"]},{"metric":{"tenant_id":"tenant_acme"},"value":[1793261998.007,"482"]},{"metric":{"tenant_id":"tenant_globex"},"value":[1793261998.007,"507"]},{"metric":{"tenant_id":"tenant_initech"},"value":[1793261998.007,"490"]},{"metric":{"tenant_id":"tenant_umbrella"},"value":[1793261998.007,"475"]}],[...]
```

One error you will hit: there is no bare `count()` over a log selector, so use
`count_over_time`, `rate` or `bytes_over_time` instead.

```bash
$ curl -sG localhost:3101/loki/api/v1/query --data-urlencode 'query=count({service=~".+"})'
parse error at line 1, col 22: syntax error: unexpected )
```

The invoice comes unprompted, in `stats`: the count above reported
`"totalBytesProcessed":1825591,"totalLinesProcessed":2932,"execTime":0.010184319` - 1.8 MB
and 2932 lines opened for one number. Add `| json` and those same bytes are read *and*
parsed line by line.

## 5. In a real multi-tenant e-commerce platform

`tenant_initech` runs a nightly import that retries failed basket rows, so it emits 1.5x
the lines of the quietest shop (one 15-minute window, capture
`.artifacts/loki-volume-retention.txt`: initech 2000, acme 1482, globex 1356, umbrella
1284). Support gets a complaint: "some of our checkouts say the card was declined".

```bash
run '{service="shop-api", tenant_id="tenant_initech"} |= "payment declined"' 50
run '{service="shop-api", level="warn"} |= "payment declined" | json | payment_status="declined"' 50
```

The first is an index lookup on a bounded label: it touches initech's streams and nobody
else's. If `tenant_id` lived only inside the line, the same question would scan all four
shops. The second adds `| json`, parsing every line the filter left - fine for one shop
over 15 minutes, not fine as a panel refreshing every 5 seconds over 90 days. When the
answer needs *this* request rather than this shop, you go back to the line, which is
query 4 of section 3.

## 6. When to use it, when not to

Use LogQL when the answer is bounded first: which service, which level, which tenant, which
window. Selector, then filter, then parser, in that order, stopping as early as you can. Do
not use it as a metrics store: `sum by (tenant_id) (count_over_time(...))` over 7 days
re-scans 7 days of chunks on every refresh, where a counter answers the same question from an
index (07a, 08b). LogQL metric queries are for investigation, not a panel you stare at.

The cost ladder: a selector-only query is an index lookup and stays cheap over long windows;
a line filter reads every byte of the selected streams (about 3.7 MiB per 15 minutes for
shop-api under load); a parser multiplies that by per-line CPU, which is what makes a laptop
querier crawl rather than the disk; and `limit=` matters, because `query_range` without it
hands over everything it read - hence the `head -c` above.

Noise is billed like volume. `{level="error"}` across the infrastructure containers returns
nothing here, because their only level is `detected_level`, which is not selectable: an empty
result means "I found no data", never "there is no problem", and on this stack it can also
mean "I used the other name for the same concept".

## 7. Common mistakes

1. **`count({service=~".+"})`** - no bare `count()` on a log selector. Use
   `count_over_time`, `rate`, `bytes_over_time`, `bytes_rate`.
2. **Asking `/loki/api/v1/label_names`** - it does not exist on Loki 3.7.9. Use `/labels`
   and `/label/<name>/values`.
3. **Trusting a label value that has already gone** - `service="api"` is still listed long
   after the rename, because stream labels are frozen at ingestion.
4. **Selecting on `detected_level` or `structured`** - they show on results and match
   nothing as selectors, so "no errors" becomes a lie your own query tells you.
5. **Making `request_id` a label** - unbounded, one stream per request; keep it in the
   line and use `|=`.
6. **Filtering at the wrong layer** - `|= "tenant_initech"` scans every line where
   `{tenant_id="tenant_initech"}` is a lookup, and `{level="error"}` can never tell you what
   the error *said*.
7. **Expecting a parser to be cheap** - `| json` on `{service=~".+"}` over a day is the most
   expensive shape here, and `unwrap` outside a metric query is a parse error, not a shortcut.

## 8. Try it yourself

Create one line whose identity you know, then find it three ways and compare each response's
`totalBytesProcessed`.

```bash
curl -s localhost:8000/api/boom -H 'x-tenant-id: tenant_umbrella' -H 'x-request-id: ch06a-probe-1'
sleep 10
run '{service="shop-api"} |= "ch06a-probe-1"'              # A line filter
run '{service="shop-api", level="error"}' 5                 # B selectors only
run '{service="shop-api"} | json | res_statusCode="500"'    # C parsed field
```

Hint: B never reads a sentence, so it should be the cheapest; if B shows your line, the
label `level` alone was enough to find it. In my run C returned the line with the `res`
object (`msg: "request errored"`) and not the TypeError line, because the error line has
no `res` to parse: each layer selects different lines.

Cleanup: nothing to revert, since you only sent a request and ran read-only queries. Your
probe line stays until the 72h retention pass drops it, so keep probe lines few and count
what you left with `run '{service="shop-api"} |= "ch06a-probe"' 10`; the delete API that
could have removed it does not work on this install, which is 06b's subject.

## 9. Next

[06b - Retention, rotation and the bill](06b-retention-rotation-cost.md): the measured
volume behind every query here, the three dials that control it, and the delete API that
does not work on this stack.
