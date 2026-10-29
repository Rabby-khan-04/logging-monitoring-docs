# 07c - RED, USE and the four golden signals

Three checklists, three heights: is the *service* healthy (RED), is the *machine* healthy (USE), and
which four numbers deserve the top row of the dashboard (the golden signals). All three are wired up
here, and every number below was measured on this stack between 13:48 and 14:06.

> Two forward links, needed only to read a number one of the stack's own rules produced:
> `rate(x[5m])` means "how fast is this climbing, per second" and is explained exactly in 08b;
> `histogram_quantile` is the ballpark the jar shelf implies, and is 08c.

## 1. Simple explanation

Same market stall as 07a. Now there are two clipboards and a board above the door.

The clipboard **by the till** is about the customer: how many people came this minute, how many left
without buying, how long they stood in the queue. That is RED. You can read it without going outside.

The clipboard **in the back room** is about the equipment: is the fridge compressor running non-stop,
is milk queuing on the step because the fridge is full, is the door seal broken. That is USE. No
customer sees it - but when the fridge dies, the till clipboard goes bad a few minutes later.

The board **above the door** has four numbers, written hourly so a stranger can judge the shop at a
glance: wait time, people in, people turned away, how full it is. That is the four golden signals:
the till clipboard plus the one back-room number that leaks outside.

Why four and not three? An empty shop and a closed shop look identical from the window. If you only
count complaints, silence looks like success.

## 2. Real name

- **RED** - Rate, Errors, Duration, per *service*: requests per second, the failed share of them, and
  the *distribution* of time per request. A method for anything that answers requests.
- **USE** - Utilisation, Saturation, Errors, per *resource* (CPU, memory, disk, a connection pool, a
  queue). Utilisation is the fraction of time the resource is busy; saturation is work waiting for it.
  Brendan Gregg's point: utilisation stays under 100% while saturation climbs, and saturation is the
  one that predicts pain. (The U stands for US "Utilization".)
- **The four golden signals** - latency, traffic, errors, saturation, from Google's SRE book: RED plus
  saturation, the extra dial existing to catch the quiet outage an error dial reads as calm.
- The split worth holding: **RED and the golden signals describe the service a user reaches; USE
  describes the resource that carries it.** You page on the first, plan capacity on the second.
- **Measure at the user's edge.** The latency the server measures is the honest lower bound of the one
  the customer feels: 0.25s here excludes DNS, TLS, the phone and the network.
- **Errors needs a written definition.** Here 5xx is "our fault" and 402 is "the customer's card was
  declined", and both land in `shop_http_errors_total` - so each dial below is sliced by `tenant_id`.
- A **recording rule** names a checklist expression once (`shop:http_5xx_ratio:5m`) so panels and
  alerts read the same number; `:5m` is the convention for "computed over a 5 minute window".

## 3. Example

The till clipboard, named once, from `prometheus/alert_rules.yml`:

```yaml
  - name: shop-recorded
    interval: 15s
    rules:
      - record: shop:http_request_rate:5m        # Rate
        expr: sum by (service, tenant_id) (rate(shop_http_request_duration_seconds_count[5m]))
      - record: shop:http_5xx_rate:5m            # Errors, numerator
        expr: sum by (service, tenant_id) (rate(shop_http_request_duration_seconds_count{status_code=~"5.."}[5m]))
      - record: shop:http_5xx_ratio:5m           # Errors, as a ratio
        # clamp_min stops a division by zero on a quiet tenant: without it the ratio goes
        # NaN and the alert silently never fires.
        expr: |
          shop:http_5xx_rate:5m
          /
          clamp_min(shop:http_request_rate:5m, 0.01)
```

Duration is the same histogram's `_count` and `_sum` (07a), and the `golden-signals` group in the same
file turns the dials into symptoms: `ApiHighErrorRatio` (`shop:http_5xx_ratio:5m > 0.01`, `for: 2m`),
`ApiLatencyP95High`, `ApiLatencyP99Severe`, `TrafficSurge`, `TrafficCollapse`. How alerts travel is 10a.

The back-room clipboard, from the `cadvisor` and `node-exporter` jobs (their `service` and `tier`
labels are added by the scrape config, not by the app):

```text
# Utilisation: whole cores this container is burning
sum by (name) (rate(container_cpu_usage_seconds_total{name="observability-learn-shop-api-1"}[5m]))
# Saturation, memory flavour: percent of the container's own limit. on(name) group_left () is
# not decoration - after sum by (name) the two sides have unequal label sets and a plain
# / answers with nothing at all (08b).
100 * sum by (name) (container_memory_working_set_bytes{name=~"observability-learn-.*"})
    / on(name) group_left () sum by (name) (container_spec_memory_limit_bytes{name=~"observability-learn-.*"} > 0)
# Errors, machine version: a restart, not a status code
changes(container_start_time_seconds{name=~"observability-learn-.*"}[30m])
```

The app's own queue dial is `shop_db_pool_connections{state="waiting"}`, next to
`shop_nodejs_eventloop_lag_seconds`; both are scraped, both are free.

## 4. What you should see

**A. RED on a healthy stall (14:06).**

```
### sum by (route) (rate(shop_http_request_duration_seconds_count{route=~"/api/.*"}[5m])) > 0
    {'route': '/api/checkout'} = 0.716   {'route': '/api/products'} = 0.537   {'route': '/api/slow'} = 0.175
### sum by (route) (rate(..._sum[5m])) / sum by (route) (rate(..._count[5m]))
    {'route': '/api/products'} = 0.00147   {'route': '/api/checkout'} = 0.1544   {'route': '/api/slow'} = 0.2484
### shop:http_5xx_ratio:5m
    {'tenant_id': 'tenant_acme'} = 0  {'tenant_id': 'tenant_globex'} = 0  {'tenant_id': 'tenant_initech'} = 0
```

**B. Why Duration is a distribution, not that average.** Eight 1.5-second requests joined
`GET /api/slow` for `tenant_umbrella`, whose usual waits are fast. Its shelf at 13:49, empty low
buckets dropped, label sets abbreviated:

```
..._bucket{le="0.05",method="GET",route="/api/slow",status_code="200",tenant_id="tenant_umbrella"} 1
..._bucket{le="0.5",...} 70     ..._bucket{le="1",...} 70     ..._bucket{le="2.5",...} 78
..._bucket{le="+Inf",...} 78    ..._sum{...} 28.677152828     ..._count{...} 78
```

`_sum` over `_count` is 0.368s. The jars say: 70 of 78 waited 0.5s or less, 8 waited over a second.
One number says "a bit slow", the other says "fine, except eight". Both are true; only one is fixable.

**C. The errors dial, silent during a real loss.** `./scripts/outage.sh 210 decline` pushed three
declined checkouts per second for `tenant_initech` from 13:48 to 13:52. At 13:49:58:

```
### sum by (status_code) (rate(shop_http_request_duration_seconds_count{route="/api/checkout",tenant_id="tenant_initech"}[5m]))
    {'status_code': '402'} = 0.7649122807017543   {'status_code': '201'} = 0.24912280701754383
### shop:http_5xx_ratio:5m
    {'tenant_id': 'tenant_acme'} = 0  {'tenant_id': 'tenant_globex'} = 0  {'tenant_id': 'tenant_initech'} = 0
### sum by (tenant_id) (rate(shop_payment_failures_total[5m]))
    {'tenant_id': 'tenant_initech'} = 0.7649122807017543   {'tenant_id': 'tenant_acme'} = 0.007017543859649122
```

A shop lost 0.765 orders a second against 0.249 captured and every error dial read zero, because a
declined card is not our fault. The failures counter matched the 402s exactly: the incident lived in
the funnel, not in RED.

**D. The same dials, working.** `./scripts/outage.sh 240 timeout`, same tenant, 13:52-13:56:

```
$ curl -sG localhost:9090/api/v1/alerts | jq -c '.data.alerts[] | {name:.labels.alertname,state:.state,tenant:.labels.tenant_id,value:.value}'
{"name":"ApiHighErrorRatio","state":"firing","tenant":"tenant_initech","value":"4.914950760966876e-01"}
{"name":"ApiLatencyP95High","state":"pending","tenant":"tenant_initech","value":"4.745673952641166e+00"}
{"name":"ApiLatencyP99Severe","state":"pending","tenant":null,"value":"4.87832422586521e+00"}
{"name":"CheckoutFailureBurst","state":"pending","tenant":"tenant_initech","value":"6.120401337792643e-01"}
{"name":"PaymentGatewaySlow","state":"pending","tenant":null,"value":"4.85e+00"}
```

13:56:16: errors 49%, latency 4.7s, the payment upstream saturated, the funnel failing at 61% - four
dials, one tenant; twelve seconds later the recorded ratio was 0.5366 for initech and 0 for acme and
globex. The page went out once and named the shop (sink stamps are UTC, so 07:55:05Z is 13:55:05):

```
alert-sink-1 | {"alert.status":"firing","alert.channel":"oncall","alerts":[{"name":"ApiHighErrorRatio","severity":"page",
  "tenant_id":"tenant_initech","startsAt":"2026-10-29T07:55:05.418Z","summary":"tenant_initech: more than 1% are 5xx"}]}
```

2m5s after the ratio passed 1% is the rule's `for: 2m` doing its job.

**E. USE, both clipboards side by side** (13:57, under that load; 8 cores on this host):

```
### sum by (name) (rate(container_cpu_usage_seconds_total{name=~"...(cadvisor|postgres|shop-api)-1"}[5m]))
    cadvisor-1 = 0.07036   postgres-1 = 0.03799   shop-api-1 = 0.03669        # cores
### 100 * working set / limit, by container
    grafana-1 = 81.015   cadvisor-1 = 76.516   prometheus-1 = 74.985   shop-api-1 = 26.356
### 1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) = 0.1863     ### node_load1 = 0.84
### shop_nodejs_eventloop_lag_p99_seconds = 0.010723327
```

Honestly: shop-api burned 0.037 of one core, so CPU utilisation is not the story, and memory
percent-of-limit (grafana at 81%) is. Two real gaps: `rate(container_cpu_cfs_throttled_periods_total[5m])`
returns **no series**, because no container in `docker-compose.yml` sets a CPU limit, so there is no
ceiling to be throttled against; and container USE has no panel yet - `stack-health.json` does RED per
tenant plus the app's pool and event loop, and the rest is 09a's job.

**F. Saturation the scrape missed, and where it landed instead.** `app/src/lib/db.ts` sets `max: 8`
with `connectionTimeoutMillis: 2_000`. Twelve concurrent `/api/pool-hog?seconds=20` ran for two minutes:

```
$ curl -s localhost:8000/metrics | grep 'state="waiting"'
shop_db_pool_connections{state="waiting"} 4
### max_over_time(shop_db_pool_connections{state="waiting"}[5m]) = 1   ### avg_over_time(...[5m]) = 0.05
### ALERTS{alertname="DatabasePoolWaiting"} -> (no series)
### sum by (tenant_id, route, status_code) (rate(shop_http_request_duration_seconds_count{status_code=~"5.."}[5m])) > 0
    tenant_initech /api/checkout 500 = 0.5614035087719298
    tenant_globex  /api/pool-hog 500 = 0.07251851851851851
    tenant_globex  /readyz       503 = 0.0036259259259259257
```

The app saw a queue of four; Prometheus never caught a sample above 1, because the queue drained
between scrapes and `collect()` (07a) only tells the truth at the instant it is asked, and
`DatabasePoolWaiting` wants `> 2` for 2m. Saturation reached the till as *other* tenants' errors: by
14:02 `ApiHighErrorRatio` was firing for `tenant_globex` at 0.2857 and `tenant_acme` at 0.0303, with
`ApiLatencyP95High` for globex reading `1e+01` seconds - the p95 pinned at the histogram's top edge,
since nothing above `le="10"` is distinguishable.

**G. Traffic, and what a window does to it.** Loadgen stopped at 13:58; 60 requests were fired in one
second at 14:01:11 and nothing touched the shop afterwards.

```
### sum(rate(shop_http_request_duration_seconds_count[1m]))  14:01:12 = 0.1333   ### [5m] = 2.5193
### sum(rate(...[1m]))  14:02:51 = 0.1333   ### [5m] = 0.5895   ### TrafficCollapse pending: acme 0.108, globex 0.165, initech 0, umbrella 0
### increase(shop_http_request_duration_seconds_count{route="/api/products",tenant_id="tenant_acme"}[5m]) = 63.1578947368421
```

Three lessons. The 60 requests were not in the answer yet - the newest sample was up to 15s old, so a
`[1m]` window can miss an event that already happened. The 0.133 that never moved is not customers: it
is exactly the two `shop-api` jobs being scraped, 8 scrapes a minute. And 60 requests read as 63.16
because `increase` extrapolates to the window edges. `TrafficCollapse` cleared itself once its
`offset 5m` baseline caught up, which is why it is `for: 10m` and routed to `default`, not `oncall`.

## 5. In a real multi-tenant e-commerce platform

Slice RED by `tenant_id` and D becomes legible. At 13:56 `tenant_initech` ran 3.88 requests per second
at 53.7% 5xx while acme, globex and umbrella sat at 1.3-2.3 requests per second at exactly 0. The same
instant platform-wide is `0.5366 x 3.884 / 9.4 = 0.22`: twenty-two per cent reads as "bad afternoon for
everyone" and hides the one shop on fire - at the cost of three outage reports for shops that were fine.
That arithmetic is why the rule records per tenant and the summary names the tenant.

`tenant_initech` is this stack's configured noisy neighbour, and F is the same lesson with the signs
reversed: it hogged the shared pool and `tenant_globex` took the 500s, the 503 readiness check and the
page. A shared resource has one USE clipboard and many tenants, so a multi-tenant incident needs both
clipboards open at once - saturation, attributed by log and trace; errors, suffered by someone else.

What a shop owner asks ("how much did we sell this hour") is neither RED nor USE: it is the funnel and
`shop_order_value_cents_total` from 07a. The thing that turns golden signals into a contract, the error
budget, is `ErrorBudgetBurnFast` in that same rule file - 10a and 12a.

## 6. When to use it, when not to

- **RED** for anything that answers requests: the API, a webhook receiver, a queue consumer. It costs
  1247 samples per scrape (`sum by (job) (scrape_samples_scraped)`) for `shop-api`, and it is the only
  view that compares shops. USE for `cadvisor` plus `node-exporter` is 7453 samples, and
  `prometheus_tsdb_head_series` sits at 24357: six times the noise for the half nobody pages on.
- **USE** for every resource with a hard ceiling - the 8-connection pool, memory percent-of-limit, the
  disk behind `DiskFillingUp`. It does not know which tenant it is serving, so it cannot be a paging
  dial alone (F paged two innocent shops).
- **Golden signals** as the top row of every service dashboard: four numbers is what on-call can read
  at 3am, and traffic is the dial that tells you a silence is real. Keeping them cheap is the point of
  recording rules: 11 stored series (`count({__name__=~"shop:.*"})`) and 7.8ms of evaluation per 15
  seconds for the whole golden-signals group.
- **Not RED** for batch and cron: nothing arrives per second, so watch a duration histogram plus a
  "last successful run" gauge. **Not USE** where there is no ceiling: with no CPU limits set, the
  throttling metric is empty. **Neither** for "why did order 4421 fail" - that is a log (06a) or a
  trace (13a).
- Noise, measured: one 4-minute incident on one tenant produced five alerts and one page - five dials
  in one message is 10a's grouping job. Self-scrape traffic also held a `TrafficSurge` pending for
  `tenant_id="none"` (values 3.34, 5.06) because that rule lacks the `route!~"/metrics|..."` filter
  the dashboard panels use.

## 7. Common mistakes

1. **Reading the average as the service.** B: 0.368s mean, 70 of 78 under 0.5s, 8 over 1s. Averages
   both flatter and condemn; the jars, and 08c's percentiles, are the answer.
2. **Counting 4xx as errors, or refusing to count them at all.** C is the second failure: a 5xx-only
   dial read three lost orders a second as calm. F is the first: `shop_http_errors_total` logged
   41-74 `not_found` per tenant next to 669 `internal_error` for initech in the same 5 minutes. Define
   the error set per dial and keep customer decisions in the funnel.
3. **One platform-wide dial for a shared platform.** 22% against 53.7% (section 5).
4. **Trusting a ratio to mention everyone.** In C, `shop:http_5xx_ratio:5m` had no row at all for
   `tenant_umbrella`: binary division keeps only label sets present on both sides, so a tenant with
   zero errors vanishes instead of showing 0. `clamp_min` prevents NaN but does not resurrect a row,
   and `count(shop:http_5xx_ratio:5m)` undercounts tenants.
5. **A window shorter than the scrape interval.** G: 60 requests read as 0.13/s for 15 seconds, and
   `[1m]` against `[5m]` differed 19x on identical traffic.
6. **Believing a gauge caught the queue.** F: `waiting` peaked at 4 in the process, at 1 in Prometheus
   over 5 minutes, and the `> 2 for 2m` alert never saw it. Scrape faster, or count the *time spent
   waiting* as a counter, which cannot slip between scrapes.
7. **Alerting on a label nothing writes.** `PaymentGatewayTimeouts` watches
   `shop_payment_provider_duration_seconds_count{outcome="timeout"}`, and no `timeout` series exists:
   the gateway deadline surfaces as an un-typed abort, so D's chaos recorded `outcome="error"` and
   answered 500 `internal_error`, not 504. `errors.ts` defines `UpstreamTimeoutError`; nothing in
   `payments.ts` throws it. The alert is dead, and the 5xx dial carries its load.

## 8. Try it yourself

Make an incident the two checklists disagree about:

```bash
./scripts/outage.sh 120 decline
sleep 30
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=shop:http_5xx_ratio:5m' | jq -r '.data.result'
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum by (tenant_id) (rate(shop_checkout_outcome_total{outcome="declined"}[5m]))' | jq -r '.data.result'
```

**Hint:** one of those two answers "everything is fine" and the other does not - that gap is the whole
chapter. Then re-run the same two queries after `./scripts/outage.sh 120 timeout` and note which extra
dials move (latency should join errors) and that `tenant_acme` stays clean, because only one tenant
carried the chaos header.

**Cleanup:** `outage.sh` ends by itself and nothing persists; the alerts resolve inside their own `for`
windows. Confirm with `curl -s localhost:9090/api/v1/alerts | jq -r '.data.alerts[] | .labels.alertname
+ " " + .state'` - only `Watchdog firing` should remain. Nothing is deleted, so the counters keep the
incident in their totals; if you want them back at zero, `docker compose restart shop-api` (that also
clears the 07b demo series, and `up` dips for one scrape, which is normal).

## 9. Next

The checklists decide *what* to watch; the scrape decides whether Prometheus even has those numbers -
the 15s interval behind F and G, the `service` and `tier` labels in every query above, and why
`up == 0` is the highest-value alert in the stack. 08a follows one scrape from target to TSDB.

**Next:** [08a - Prometheus scraping](08a-prometheus-scraping.md)
