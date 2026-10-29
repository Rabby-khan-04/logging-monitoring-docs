# Verified facts of this machine (internal reference, not a chapter)

Every claim below was observed on this machine on 2026-10-29 by running it, not
read from documentation. Chapter writers: build section 4 ("What you should see")
from the captured files in `.artifacts/` and these facts. Run a live command only
when the artifact does not contain what you need, and budget about ten commands per
chapter file: the live stack answers slowly and a chapter is not worth a hundred
calls.

## Ports and services

shop-api 8000 (`/metrics`, `/metrics/demo`), payment-gateway 8020, postgres 5433 on
the host (user/pass/db `shop`/`shop`/`shop`), prometheus 9090, alertmanager 9093,
alert-sink 8090 (webhook printer), loki 3101, tempo 3201, grafana 3001 (admin/admin),
node-exporter 9100, cadvisor 8081, alloy 12345, otel-collector 4317/4318/9464/13133.
13 compose services, all running. `count(up == 1)` = 11 targets, `count(up == 0)` = no
series.

## Versions that matter

Pino 10.4.0, pino-http 11.0.0, Express 5.3.0, Node 24.22.2, TypeScript 5.9.3, tsx
4.23.15 (no build step), zod 4.6.7, pg 8.23.1, prom-client 15.1.3,
@opentelemetry/* 0.300.0, @sentry/node 11.10.0, Prometheus v3.15.1, Alertmanager
v0.34.1, Loki 3.7.9, Tempo 3.1.1, Grafana Alloy v1.19.2, Grafana 13.3.0, OTel
Collector contrib 0.164.0, cAdvisor v0.55.1, Postgres 18.6.

## Traps found by running this stack (each one is real, most cost me an outage)

1. **pino-http 11 `autoLogging.ignore` receives ONE argument.** `index.d.ts` line 50
   says `ignore?: ((req: IM) => boolean)` and `logger.js` line ~183 calls
   `autoLoggingIgnore(req)`. Writing `ignore: (req, res) => res.locals.x` makes `res`
   `undefined` and threw a `TypeError: Cannot read properties of undefined (reading
   'locals')` that returned 500 for EVERY request. Also: `ignore` is evaluated when the
   request ARRIVES, so it can never see whether the handler later logged the error.
2. **The double-error-logging fix belongs in `customLogLevel`, not `ignore`.**
   `customLogLevel(req, res)` runs at response-finish time and may return the string
   `silent`; `logger.js` has `if (level === 'silent') return`. errorHandler() sets
   `res.locals.errorLogged = true` for >=500 and customLogLevel drops pino-http's copy.
3. **Pino redact has no recursive wildcard.** `**.cvv` and `**` are accepted with no
   error and match NOTHING. Paths are anchored at the root of the logged object and `*`
   matches exactly ONE level, so `card.cvv` does not catch `{ body: { card: { cvv } } }`.
   Measured in this container. The project's real defence is the deep-scrub serializer
   in `app/src/lib/logger.ts` (SENSITIVE_KEYS, CARD_CHILD_KEYS, PAN-shaped regex).
4. **node-postgres returns `bigint` as a STRING.** `orders.id` is bigint, so
   `RETURNING id` gives `"12005"`. The gateway schema declared `z.number().int()` and
   rejected every charge with `{"code":"validation_failed","issues":["order_id"]}`,
   surfacing as a 502 from checkout. Fix: ids are strings across the wire.
5. **`bigserial`/`int8` must never be typed `number` in app code.** `query<{ id: number }>`
   typechecked and was a runtime lie.
6. **Loki 3.7.9: `/loki/api/v1/label_names` does not exist** ("404 page not found").
   Use `/loki/api/v1/labels` for names and `/loki/api/v1/label/<name>/values`.
   `/labels` returns `compose_version, container, level, service, service_name,
   tenant_id`; `detected_level` and `structured` appear on stream objects in query
   results but not in that name list.
7. **LogQL has no bare `count()` over a log selector.** `count({service=~".+"})` fails
   with `parse error at line 1, col 22: syntax error: unexpected )`. Use
   `count_over_time`, `sum`, `rate`, `bytes_over_time`, `bytes_rate`. Metric queries
   return `metric`, log queries return `stream`.
8. **Loki `-config-all` does not exist** (Loki is Mimir-based: use
   `-print-config-stderr`, and `-verify-config`). Beware: `loki -print-config-stderr
   -config.file=/dev/null` STARTS the server and hangs.
9. **`limits_config.retention_stream` accepts `priority`, `priority_label`, `selector`,
   `period`** — there is no `retention` field, and `period` has a floor: `period: 6h`
   stopped the container with `CONFIG ERROR: invalid limits_config config: retention
   period must be >= 24h was 6h`. Cheapest legal per-stream expiry is 24h.
10. **The Loki delete API does not work on this install.** `DELETE
    /loki/api/v1/delete?query=...&start=...&end=...` returns 404 `could not find delete
    request with given id`, with and without `dry_run=true`, even though
    `compactor.delete_request_store: filesystem` is set; `GET /loki/api/v1/delete`
    returns 200 `[]`. Say this plainly; do not invent output.
11. **Ruler API for delete rules: 405 `GetRuleGroup unsupported in rule local store`.**
    The local rule store cannot serve the API.
12. **`ruler.storage.local.path` does not exist in Loki 3.7.9**; omitting `storage`
    makes the ruler inherit `common.storage.filesystem`.
13. **Alloy: the duplicate `service_name` label cannot be removed.** Three attempts, all
    verified ineffective: (a) `rule { source_labels=[...] action="labeldrop" regex=".+" }`
    -> Alloy refuses to start, `labeldrop action requires only 'regex', and no other
    fields`; (b) `rule { action="labeldrop" regex="service_name" }` -> accepted, still
    present, because `loki.source.docker` adds the label AFTER `discovery.relabel`;
    (c) `stage.labeldrop { values=["service_name"] }` both after `stage.labels` and as
    the first stage -> accepted, still present, because Loki's labeldrop only removes
    labels that LATER pipeline stages add, never labels the entry arrived with.
14. **Loki stream labels are frozen at ingestion.** A pipeline change never rewrites old
    streams, so after a change you see two label schemes at once; judge changes on the
    last 1-2 minutes only. `compose_version` vanished from new streams after
    `docker compose restart alloy` while old streams kept it. The obsolete `service="api"`
    value from before the compose service rename is still listed by
    `/label/service/values` and ages out with retention.
15. **Postgres 18 volume path moved**: mount `/var/lib/postgresql`, not
    `/var/lib/postgresql/data`, or the container refuses to start.
16. **A YAML comment between `- -c` and its value silently creates two `-c` args**:
    `FATAL: -c -c requires a value`. Keep each pair adjacent.
17. **`log_line_prefix=%m [%p %u] %d` glued the db name to the level** ("shopLOG:").
    The fix needs a quoted trailing space, `- "log_line_prefix=%m [%p %u] %d "`, because
    YAML strips an unquoted one. Also: `docker compose restart` does NOT re-read the
    compose file; only `up -d` (recreate) applies a changed `command`.
18. **`pg_stat_statements` 1.12 on PG 18 columns are `calls`, `total_exec_time`,
    `mean_exec_time`, `max_exec_time`** — `total_exec_calls` does not exist.
19. **cAdvisor**: `google/cadvisor` stops at v0.33.0 (no cgroup v2); use
    `gcr.io/cadvisor/cadvisor:v0.55.1`. cAdvisor reports EVERY container on the host,
    including other projects (`infra-redis-1`, `proxy-learn-nginx`), so filter with
    `name=~"observability-learn-.*"`. The `name` label is REUSED across container
    recreations: after recreating postgres, `container_last_seen{name="observability-learn-postgres-1"}`
    had TWO series (one stale); disambiguate with `id` or
    `container_label_com_docker_compose_config_hash`. `container_fs_usage_bytes` has 65
    series but none matching our `name`s, and `container_cpu_cfs_throttled_periods_total`
    returned no series at all.
20. **Prometheus vector matching**: `container_memory_working_set_bytes /
    container_spec_memory_limit_bytes` works when label sets match, but
    `/ on(name) container_spec_memory_limit_bytes` fails with `multiple matches for
    labels: many-to-one matching must be explicit (group_left/group_right)`.
21. **`histogram_quantile` returns NaN with no traffic in the window** (verified:
    tenant_acme NaN while tenant_globex 0.02275). NaN means "no data", not "fast".
    A too-short window reads as an outage: `sum(rate(shop_checkout_step_total[5m]))` = 0
    while `[10m]` = 6.30, because traffic had stopped ~6 minutes earlier.
22. **`shop_http_requests_total` has no `tenant_id` label** (method/route/status_class
    only), so `sum by (tenant_id) (rate(shop_http_requests_total[5m]))` collapses to one
    `{}` series. Per-tenant rate must use `shop_http_request_duration_seconds_count`.
23. **prom-client 15.1.3 is deprecated upstream** (replacement: `@prometheus-io/client`),
    and has NO `Info` class; the idiom is a Gauge set to 1 (`shop_build_info`).
24. **OTel collector cannot bind 8888** inside the container (`bind: address already in
    use` — internal telemetry owns it). The prometheus exporter runs on 0.0.0.0:9464 and
    Prometheus scrapes both 9464 (`otel-collector`) and 8888 (`otel-collector-internal`).
25. **`OTEL_METRICS_EXPORTER=none`** (and logs=none) is set deliberately: app metrics
    come from prom-client on `/metrics`, not the OTel SDK, so nothing is duplicated.
26. **Tempo 3.1 rejected the 2.x config shape** (`traces`, `ingester`, `compactor`,
    `search`, `block.v2_encoding`, `distributor.log_accepted_traces`,
    `metrics_generator.enable_adaptive_algebra`). Verify a config without starting:
    `docker run --rm -v "$PWD/tempo/config.yaml:/c.yaml:ro" --entrypoint /tempo
    grafana/tempo:3.1.1 -config.file=/c.yaml -config.verify` (silent = valid). The image
    is distroless: no `ls`, no shell, entrypoint `/tempo`.
27. **Tempo read API moved**: `/api/trace/<id>` and `/api/v1/traces?traceID=` are 404;
    use **`/api/v2/traces/<traceid>`** (OTLP JSON). Search works at `/api/search`
    (v1) and `/api/search/tags`; `/api/services` is 404 on this build. Auto-instrumented
    HTTP span names are just the method (`POST`, `GET`), not `POST /api/checkout`, so
    `{name="POST"}` is the working TraceQL selector.
28. **Tempo's service graph and span metrics are read from PROMETHEUS, not Tempo**: the
    metrics generator remote-writes to `http://prometheus:9090/api/v1/write` (needs
    `--web.enable-remote-write-receiver`, which we set). `/api/metrics/querier` on 3201
    is 404. Real edges measured: shop-api -> postgres 7.684 req/s, user -> shop-api 1.632,
    shop-api -> payment-gateway 0.435 (21.26% failed during the outage). Series:
    `traces_service_graph_request_total`, `..._failed_total`,
    `traces_service_graph_request_client_seconds_*`, `traces_spanmetrics_calls_total`,
    `traces_spanmetrics_latency_bucket` (750 series, the largest metric on the box).
29. **Metric names are prefixed `shop_`** (prom-client `prefix: 'shop_'`). The JS
    variable `httpRequestsTotal` is not the wire name.
30. **Compose rename trap**: renaming service `api` to `shop-api` left an orphan holding
    port 8000 (`port is already allocated`) and Prometheus kept scraping the dead name
    until `POST /-/reload`. Use `docker compose up -d --remove-orphans`; a recreated
    container that shows `Ports {}` and empty logs needs `--force-recreate`.
31. **`NODE_ENV=production` + `npm ci` skips devDependencies**, and tsx is one, so the
    container could not start its own server. `app/docker-entry.sh` tests for
    `node_modules/.bin/tsx` and installs with `--include=dev`. `npx tsx` also hits the
    network on every start; call `./node_modules/.bin/tsx` instead.
32. **The node:24.22.2-slim image has no curl.** Drive HTTP requests from the host.
33. **`docker compose logs` takes a SERVICE name, not a `--name` from `compose run`** —
    use `docker logs <container-id>` for run containers.
34. **Scrape endpoints pollute access logs**: an ignore rule of `url === '/metrics'`
    missed `/metrics/demo`, which was logged every 15s. Use `startsWith('/metrics')`.
35. **Alerts without a runbook**: 11 of 18 rules shipped with no `runbook` annotation;
    I added them and `promtool check rules` then reported `SUCCESS: 18 rules found`.
    Validate rules inside the container: `docker compose exec -T prometheus sh -c
    '/bin/promtool check rules /etc/prometheus/alert_rules.yml'` (host paths break the
    rule_files check).
36. **Grafana has no alerting configured here** — all alerting is Prometheus rules ->
    Alertmanager. Do not send the reader looking for Grafana alert rules.

## Measured numbers (re-measure when a chapter needs a live-looking value)

- Cardinality demo: `count({__name__=~"shop_demo.*"})` 0 -> **120** after 120 distinct
  `/api/cardinality?x=N` calls. `prometheus_tsdb_head_series` ~20,700-21,300.
  Top metrics by series: traces_spanmetrics_latency_bucket 750, container_tasks_state
  585, grafana_apiserver_request_duration_seconds_bucket 480,
  container_memory_failures_total 468, shop_http_request_duration_seconds_bucket 432.
  SeriesCountHigh thresholds at 60,000.
- Percentiles while idle: p50 0.00256s, p95 0.00487s, p99 0.01878s, average 0.00160s —
  note the average is BELOW the median.
- Log volume, last 15m by service: shop-api 3720.7 KiB, payment-gateway 408.5 KiB,
  otel-collector 83.2 KiB, alloy 23.8 KiB, tempo 18.0 KiB, grafana 15.2 KiB,
  postgres 5.4 KiB, alert-sink 0.6 KiB. shop-api ~14.26 lines/s.
  Lines per tenant in 15m: tenant_initech 2000, acme 1482, globex 1356, umbrella 1284.
- Checkout funnel instant totals: cart_received 1157, validated 1157, basket_priced 1157,
  order_created 1157, payment_attempted 1157, payment_captured 735, confirmed 735
  (63.5% completion).
- Postgres: cache hit 99.80%, xact_commit 7055, xact_rollback 1, deadlocks 0,
  temp_files 4; `max_connections` 100, 10 used; pool max 8 per process.
  Table sizes: order_items 16 MB (168,953 rows), orders 3968 kB (12,470),
  payments 2320 kB, products 104 kB (160), tenants 32 kB (4).
- `pg_stat_statements` top by total time: the tenant-summary report 87 calls, mean
  21.96 ms, max 296.28 ms, **91.7% of all database time**; INSERTs ~0.1 ms;
  `SELECT set_config($1,$2,$3)` 2186 calls at 0.01 ms.
- EXPLAIN on the tenant-summary report, tenant_initech (37% of orders):
  WITHOUT `idx_order_items_order_id`: Parallel Seq Scan + Hash Join, 2488 buffers,
  **27.569 ms**. WITH the index: Nested Loop + Index Only Scan, 9,684 buffers,
  **34.070 ms** — the index made this query SLOWER. But the point query
  `WHERE oi.order_id = 4321` went 9.103 ms -> **0.302 ms** (30x). Lesson: measure,
  do not assume; the missing index is right for the point lookup and wrong for the
  aggregate that reads most of the table.
- Postgres slow log (log_min_duration_statement=100): `LOG:  duration: 187.780 ms
  statement: CREATE INDEX ...`, plus `DETAIL:  Parameters: $1 = '0.3'` — parameters
  appear in the SERVER log, which is a privacy consideration the app never exposes.
- Alerts firing during `./scripts/outage.sh 120 timeout tenant_initech` at t+105s:
  CheckoutFailureBurst {severity=page, tenant_id=tenant_initech}, ApiHighErrorRatio
  {product=shop, service=shop-api, severity=page, tenant_id=tenant_initech},
  ApiLatencyP95High {warn, tenant_initech}, ApiLatencyP99Severe {page},
  PaymentGatewaySlow {warn, outcome=error}, TrafficSurge {warn} x4 tenants,
  Watchdog {none}. Many were `state=pending` at t+45s — `for:` is what separates them.
  Prometheus rule groups loaded: checkout 3, dependencies 5, golden-signals 5,
  shop-recorded 3, slo 2.
- alert-sink really received pages, e.g. `{"level":"warn","alert.status":"firing",
  "alert.channel":"oncall","alert.count":3,"alerts":[{"name":"TargetDown",
  "severity":"page",...}]}` and matching `"alert.status":"resolved"` lines.
- Node box: disk 45.26% used on `/dev/sda2` (ext4, mountpoint `/`), memory 71.89%,
  cpu 17.32%, `node_netstat_Tcp_CurrEstab` 1, network errs 0.
  Container mem vs limit: cadvisor 91.1%, grafana 76.1%, prometheus 63.9%, tempo 59.9%,
  alloy 43.2%, postgres 29.5%.
- Live RSS of the 13 stack containers is about 1.5 GiB; the `mem_limit` settings sum to
  about 3.8 GiB.
- `/healthz` body is exactly `{"status":"alive","service":"shop-api"}`. `/readyz`
  returns `{"status":"ready","warmup_complete":true,"database":{"ok":true,
  "latency_ms":21.25}}` style JSON.

## What is NOT verified on this machine (say so honestly in the chapter)

- **Sentry**: no DSN, no service in compose, nothing installed or run. `@sentry/node`
  11.10.0 is a dependency and `initSentry()` only runs when `SENTRY_DSN` is set. Any
  Sentry screenshot, release page or grouping claim in chapter 12 must be labelled as
  not executed here.
- **Next.js / frontend**: there is no frontend in this stack. Chapter 15 must say which
  parts are reasoned from documentation and which were tested (the app's own server logs,
  `/healthz/detail`, and Web Vitals only as a described exercise).
- **Grafana UI screenshots**: nobody can see a browser here. Describe panels by their
  provisioned title and the query they run, and use the HTTP API output as evidence.
- LogQL/TraceQL queries: only paste what you ran. If a query errored, paste the error —
  it is often the most useful part of a chapter.

## House rules for every chapter

Nine sections, exact headings, in order. Fake data only. Anything sensitive is labelled
"DANGER DEMO" and immediately followed by the safe version. Everything local, nothing
installed on a production system. No concept before it is explained (link forward
instead). No deprecated API taught without naming the modern replacement. No emoji.
British-neutral spelling. Section 4 output is verbatim or absent. Real behaviour always
beats documentation, and a disagreement belongs in the chapter.
