# 20b - The golden-signals dashboard, from scratch

This chapter builds the dashboard you would open first every morning: four
signals, per tenant, with no vanity panels. The provisioned example is
`grafana/dashboards/stack-health.json` ("00 - Stack health"); the point is to
understand every query in it well enough to rebuild it.

## 1. Simple explanation

A car dashboard has four things that matter while driving: how fast, how much
fuel, how hot the engine, and whether a warning light is on. It does not show
the radio's playlist or the passenger's heart rate. A service dashboard is the
same: four numbers that tell you whether the car can keep driving, and one
obvious place to look when the warning light comes on.

## 2. Real name

The **four golden signals** (Google SRE book, "Monitoring Distributed Systems"):

- **Latency**: how long requests take, split into successful and failed.
- **Traffic**: how many requests per second.
- **Errors**: what fraction fail, by status class.
- **Saturation**: how full the constrained resource is - here the Postgres pool,
  event loop lag and container memory.

For request/response services the **RED** method is the same idea with a
different mnemonic: Rate, Errors, Duration. Use RED for the API panels and USE
(Utilisation, Saturation, Errors) for the resources underneath.

## 3. Example

The dashboard is a JSON file provisioned from disk, so it is code. The parts
that matter are the variables and the queries.

```json
"templating": {
  "list": [
    {
      "name": "tenant",
      "type": "query",
      "query": "label_values(shop_http_request_duration_seconds_count, tenant_id)",
      "includeAll": true,
      "multi": true
    },
    {
      "name": "route",
      "type": "query",
      "query": "label_values(shop_http_request_duration_seconds_count{tenant_id=~\"$tenant\"}, route)",
      "includeAll": true
    }
  ]
}
```

A dependent variable (`route`) is filtered by the first, so the dashboard does
not offer routes that the selected tenant never called. The golden-signal row,
one panel each:

```promql
# Traffic: requests per second, per tenant.
sum by (tenant_id) (rate(shop_http_request_duration_seconds_count{tenant_id=~"$tenant"}[5m]))

# Errors: 5xx ratio. clamp_min prevents NaN on a quiet tenant; that NaN would
# render as "no data", which looks like health.
shop:http_5xx_ratio:5m{tenant_id=~"$tenant"}

# Latency: three lines, never an average.
histogram_quantile(0.50, sum by (le) (rate(shop_http_request_duration_seconds_bucket{tenant_id=~"$tenant"}[5m])))
histogram_quantile(0.95, sum by (le) (rate(shop_http_request_duration_seconds_bucket{tenant_id=~"$tenant"}[5m])))
histogram_quantile(0.99, sum by (le) (rate(shop_http_request_duration_seconds_bucket{tenant_id=~"$tenant"}[5m])))

# Saturation: pool waiting plus event-loop lag. A pool with waiters is full
# even if every query is fast right now.
max by (instance) (shop_db_pool_connections{state="waiting"})
shop_nodejs_eventloop_lag_p99_seconds
```

Panel conventions that prevent arguments later:

- **Unit `seconds (s)`** for every latency query. A panel with no unit is a
  number without meaning; someone will read 0.4 as 0.4 milliseconds.
- **A 5-minute window** for the headline, and a shorter `[1m]` window only on
  a dedicated "right now" row. Windows are part of the label of the panel.
- **Rate, not total**, for traffic. An increasing counter is a line that only
  goes up and answers "since when?" rather than "now".
- **Explicit no-data handling.** `null` must not be rendered as zero; "no
  traffic" and "zero errors" are different facts.

## 4. What you should see

Grafana is healthy and the dashboard is provisioned in the `learning` folder:

```bash
$ curl -s localhost:3001/api/health | jq -c .
{"database":"ok","version":"13.3.0","commit":"6f8ce3c693b493043ebcd4787566d2b6b118b0f0"}

$ curl -s -u admin:admin 'localhost:3001/api/search?query=' | jq -c '.[] | {title,uid,type}'
{"title":"learning","uid":"eg2nxr3q3lvy8f","type":"dash-folder"}
{"title":"00 - Stack health","uid":"stack-health","type":"dash-db"}
```

The headline numbers, queried exactly as the panels query them, after a load
generator run:

```bash
$ # traffic: requests/second
1.411

$ # errors: 5xx ratio
0.003        # 0.3%

$ # latency
p50 0.005 s
p95 0.392 s
p99 0.483 s
```

The per-tenant split is where the dashboard earns its place:

```bash
$ # p95 by tenant
tenant_acme      0.235 s
tenant_umbrella  0.242 s
tenant_globex    0.219 s
tenant_initech   0.477 s
```

tenant_initech's p95 is roughly twice everyone else's. That is the noisy
neighbour from chapter 16, visible in one panel. A platform-wide p95 of 392 ms
looks acceptable; the per-tenant panel shows that "acceptable" is an average
over one slow tenant and three healthy ones.

The funnel and dependency panels complete the story:

```promql
# Checkout steps per second, per tenant: the business version of traffic.
sum by (step) (rate(shop_checkout_step_total{tenant_id=~"$tenant"}[5m]))

# Payment gateway p95 by outcome: slow declines look like a healthy gateway
# if you only look at captured payments.
histogram_quantile(0.95, sum by (le, outcome) (rate(shop_payment_provider_duration_seconds_bucket[5m])))
```

## 5. In a real multi-tenant e-commerce platform

The morning routine is: open the dashboard, check four numbers, then look at
the tenant row. If traffic is normal, errors are under the SLO, latency is
inside the promise, and no pool is waiting, the shop is healthy and nobody
needs to read a log line. This is the ten-second answer that replaces "let me
grep".

When something is wrong, the dashboard narrows the search: a single tenant row
turns red, or one route's p95 climbs while the rest stay flat. That is the
signal to open Loki with the tenant filter or Tempo with the route, not to
start from the beginning. The dashboard is an index, not the book.

Saturation is the panel people forget. At 09:00 on a sale day, latency can be
fine while the pool has two waiters; five minutes later checkout times out. The
pool panel is what buys you those five minutes. `DatabasePoolWaiting` alerts on
it (chapter 10a), but the graph is what lets you see it coming.

## 6. When to use it, when not to

Build this dashboard for every service with an HTTP interface. Keep it to one
screen: four signals on top, per-tenant and per-route rows below, dependencies
and business funnel at the bottom. If a panel does not change a decision, it
belongs on a different, deeper dashboard.

Do not put every metric on the front page. A wall of 40 graphs trains people to
scan for green, not to think. Do not use an average latency line as the
headline; averages hide the tail that customers experience. Do not set the
refresh interval to one second; it costs CPU and makes people watch the graph
instead of the incident.

Cost: each panel is a query against Prometheus every refresh. Ten panels at
30-second refresh is nothing; a dashboard open on a wall screen all day is a
small constant load. Long-range queries (`[30d]`) over a high-cardinality
metric are the expensive ones; recording rules exist for those (chapter 08b).

## 7. Common mistakes

1. **No unit on the Y axis.** The most common dashboard bug. Latency in seconds
   must say seconds.
2. **Average instead of percentiles.** The mean of a bimodal distribution sits
   in the valley where no request lives.
3. **A ratio without `clamp_min`.** On a quiet tenant it is `NaN`, the panel
   shows "no data", and the on-call believes the shop is fine.
4. **Five panels for one signal.** Three latency lines and two error lines is
   fine; eight variations of traffic is a hobby, not monitoring.
5. **Variables that do not cascade.** A route list unfiltered by tenant offers
   routes that produce empty panels and erodes trust in the dashboard.
6. **No annotations for deploys and incidents.** A vertical line at the deploy
   time turns "the graph changed" into "the deploy changed it" (chapter 09a).
7. **Building only the success path.** The error ratio and the failed-checkout
   rate deserve top-row space, not a tab at the bottom.

## 8. Try it yourself

Add a per-tenant p95 panel and a dependent route filter to the provisioned
dashboard, then use it to compare tenants.

```bash
# 1. Open http://localhost:3001 (admin/admin), folder "learning",
#    dashboard "00 - Stack health".
# 2. Add a panel with:
#    histogram_quantile(0.95, sum by (le, tenant_id)
#      (rate(shop_http_request_duration_seconds_bucket{tenant_id=~"$tenant"}[5m])))
#    Unit: seconds. Legend: {{tenant_id}}.
# 3. Set the tenant variable to All, then to tenant_initech, and compare.
```

**Hint:** if the panel is empty for a tenant, that tenant had no traffic in the
window - `histogram_quantile` returns `NaN`, not zero. Widen the window to
`[15m]` or check the traffic panel first. If the legend shows `{{tenant_id}}`
literally, the panel is using the wrong legend format.

**Cleanup:** the dashboard is provisioned from JSON, so UI edits are lost on
the next Grafana restart. Export the JSON if you want to keep the panel, or
edit `grafana/dashboards/stack-health.json` and let provisioning apply it.

## 9. Next

The dashboard shows the problem. [20c - Error and latency alerts](20c-error-latency-alerts.md)
makes the problem find you, without crying wolf.
