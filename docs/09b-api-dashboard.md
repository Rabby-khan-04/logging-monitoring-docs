# 09b - The API dashboard, panel by panel

This is the dashboard you keep open during a deploy and during an incident: the
file you already have, `grafana/dashboards/stack-health.json`, provisioned into
the `learning` folder as "00 - Stack health". Panels 1 to 5 shipped with it;
panels 6 to 12 were added for this chapter.

## 1. Simple explanation

Imagine a shop with four doors, and you want to know without walking around
whether customers are getting in and paying. So you put four small screens above
the counter: how many people came in, how many left without paying, how long the
queue at the till took, and which door has been shut all morning.

A good dashboard answers four questions only: are people arriving, are they
succeeding, are they waiting, is one single door broken? Everything else is
decoration, and you read the screens in a fixed order.

## 2. Real name

What you are building is a **RED dashboard for an HTTP service** (chapter 07c):
Rate, Errors, Duration, sliced by the labels that matter - `route`,
`tenant_id`, `status_code` - plus the two things RED cannot see: the **business
funnel** (checkout steps) and **saturation** (database pool, event loop). Each
panel is one PromQL query with a fixed unit, a fixed legend and a fixed window.
`sum by (...)` chooses the slice, `legendFormat` names the line.

Two terms added here. A **chained variable** is a template variable whose query
uses another variable (`route` filtered by `$tenant`), so the dropdown offers
only routes the selected tenants actually call. A **transformation** is
post-query reshaping in Grafana rather than PromQL: the table panel joins three
queries on `tenant_id` into one row per tenant.

## 3. Example

Two ways to build a panel. In the UI: **Dashboards > New > New panel**, choose
Prometheus, type the query, set the unit in the right-hand pane, save into the
`learning` folder - and because `allowUiUpdates: true`, that save writes the
JSON back to the file on disk. The second way is what I did for panels 6 to 12:
edit the JSON and wait 30 seconds for the provider to re-read it.

```json
{ "type": "timeseries", "title": "Request rate by route (Rate)", "id": 6,
  "gridPos": { "h": 8, "w": 12, "x": 0, "y": 16 },
  "fieldConfig": { "defaults": { "unit": "reqps" } },
  "targets": [ { "refId": "A", "legendFormat": "{{route}}",
    "expr": "sum by (route) (rate(shop_http_request_duration_seconds_count{tenant_id=~\"$tenant\", route=~\"$route\", route!~\"/metrics|/metrics/demo|/readyz|/healthz\"}[5m]))" } ] },

{ "type": "timeseries", "title": "5xx ratio by route (Errors)", "id": 7,
  "gridPos": { "h": 8, "w": 12, "x": 12, "y": 16 },
  "fieldConfig": { "defaults": { "unit": "percentunit", "max": 0.05, "min": 0 } },
  "targets": [ { "refId": "A", "legendFormat": "{{route}}",
    "expr": "sum by (route) (rate(shop_http_request_duration_seconds_count{status_code=~\"5..\", tenant_id=~\"$tenant\", route=~\"$route\"}[5m])) / clamp_min(sum by (route) (rate(shop_http_request_duration_seconds_count{tenant_id=~\"$tenant\", route=~\"$route\"}[5m])), 0.01)" } ] }
```

Two details carry the design. Panel 6 excludes `/metrics`, `/metrics/demo`,
`/readyz` and `/healthz`: that is scrape and probe traffic, and leaving it in
means a third of the legend is Prometheus asking Prometheus a question. Panel 7
divides by `clamp_min(..., 0.01)` for the reason `shop:http_5xx_ratio:5m` does
(chapter 08b): a route nobody called must not yield `NaN`, and one error in one
request must not vanish from the numerator.

The remaining panels, queries only (same shape, `unit` set to `s`,
`histogram_quantile` keeping `le` in `sum by` as chapter 08c insists):

```text
id 8   p95 by route        histogram_quantile(0.95, sum by (le, route) (rate(shop_http_request_duration_seconds_bucket{tenant_id=~"$tenant", route=~"$route", route!~"/metrics|/metrics/demo"}[5m])))
id 9   checkout funnel     sum by (step) (rate(shop_checkout_step_total{tenant_id=~"$tenant"}[5m]))  and  sum by (outcome) (rate(shop_checkout_outcome_total{tenant_id=~"$tenant"}[5m]))
id 10  gateway p95         histogram_quantile(0.95, sum by (le, outcome) (rate(shop_payment_provider_duration_seconds_bucket[5m])))
id 11  process health      shop_db_pool_connections{tenant_id=~"$tenant"}  and  shop_nodejs_eventloop_lag_p99_seconds
```

Panel 11 is the only frame sharing an axis between two units, so its JSON also
carries an override putting "event loop lag (s)" on the right axis. Panel 12 is
the one you read first when someone types "is it just us?" - three instant
queries joined on `tenant_id`, one row per shop:

```json
{ "type": "table", "title": "Per-tenant scorecard (last 5m)", "id": 12,
  "transformations": [
    { "id": "joinByField", "options": { "byField": "tenant_id", "mode": "outer" } },
    { "id": "organize", "options": { "excludeByName": { "Time 1": true, "Time 2": true, "Time 3": true },
      "renameByName": { "Value #A": "req/s", "Value #B": "5xx ratio", "Value #C": "p95 (s)" } } } ],
  "targets": [
    { "refId": "A", "instant": true, "expr": "sum by (tenant_id) (rate(shop_http_request_duration_seconds_count{tenant_id=~\"$tenant\"}[5m]))" },
    { "refId": "B", "instant": true, "expr": "shop:http_5xx_ratio:5m{tenant_id=~\"$tenant\"}" },
    { "refId": "C", "instant": true, "expr": "histogram_quantile(0.95, sum by (le, tenant_id) (rate(shop_http_request_duration_seconds_bucket{tenant_id=~\"$tenant\"}[5m])))" } ] }
```

## 4. What you should see

Captured while `./scripts/loadgen.sh 75 12` ran: 75 seconds at about 12 req/s
across the four tenants, 434 requests sent. These are the panel queries with the
variables substituted to "all" (top rows only, sorted by value).

```bash
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=count(up == 1)' | jq -r '.data.result[].value[1]'
11

$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum by (route) (rate(shop_http_request_duration_seconds_count{route!~"/metrics|/metrics/demo|/readyz|/healthz"}[5m]))' \
  | jq -r '.data.result[] | "\(.metric.route)  \(.value[1])"' | sort -k2 -gr | head -4
/api/checkout  0.49824561403508766
/api/products  0.3789473684210526
/api/reports/tenant-summary  0.12280701754385964
/api/error/:kind  0.12280701754385964

$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=histogram_quantile(0.95, sum by (le, route) (rate(shop_http_request_duration_seconds_bucket{route!~"/metrics|/metrics/demo"}[5m])))' \
  | jq -r '.data.result[] | select(.value[1] != "NaN") | "\(.metric.route)  \(.value[1])"' | sort -k2 -gr | head -4
/api/slow  0.47631578947368414
/api/checkout  0.4454545454545454
/api/reports/tenant-summary  0.02749999999999995
/api/products  0.004793577981651377

$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum by (step) (rate(shop_checkout_step_total[5m]))' | jq -r '.data.result[] | "\(.metric.step)  \(.value[1])"'
cart_received  0.5052631578947369
validated  0.5052631578947369
basket_priced  0.5052631578947369
order_created  0.5052631578947369
payment_attempted  0.5052631578947369
payment_captured  0.4631578947368421
confirmed  0.4631578947368421
```

Read the rate and duration panels together: `/api/slow` really is about a
hundred times slower than `/api/products`, and one blended p95 would describe
neither. In the funnel five steps hold at 0.505 then drop to 0.463 at
`payment_captured`: an 8.3% loss because the fake acquirer declines cards. The
upstream panel and the scorecard:

```bash
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=histogram_quantile(0.95, sum by (le, outcome) (rate(shop_payment_provider_duration_seconds_bucket[5m])))' | jq -r '.data.result[] | "\(.metric.outcome)  \(.value[1])"'
captured  0.43400000000000005
declined  0.48125
error  NaN

$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum by (tenant_id) (rate(shop_http_request_duration_seconds_count[5m]))' | jq -r '.data.result[] | "\(.metric.tenant_id)  \(.value[1])"'
none  0.2596491228070175
tenant_acme  0.34736842105263155
tenant_umbrella  0.32631578947368417
tenant_initech  0.3333333333333333
tenant_globex  0.3894736842105263
```

`error NaN` is not a bug: no errored payment in the window means there is no
distribution to take a quantile of. And `tenant_id="none"` earns its scorecard
row so you can watch it stay small: scrape and health-check traffic without a tenant.

`route` is chained to `tenant`; Grafana resolves it with a `series` query, and
for tenant_initech it returns `/api/checkout /api/error/:kind /api/orders/:id
/api/products /api/reports/tenant-summary /api/slow /danger/card`. The file as
loaded, after my edits and one 30-second `updateIntervalSeconds` wait:

```bash
$ curl -s -u admin:admin localhost:3001/api/dashboards/uid/stack-health | jq -r '.dashboard.panels[] | "\(.id)  \(.type)  \(.title)"'
1  stat  Scrape targets up
2  timeseries  Request rate (RED: Rate)
3  timeseries  5xx ratio (RED: Errors)
4  timeseries  p50 / p95 / p99 latency (RED: Duration)
5  logs  Latest errors (Loki)
6  timeseries  Request rate by route (Rate)
7  timeseries  5xx ratio by route (Errors)
8  timeseries  p95 by route (Duration)
9  timeseries  Checkout funnel (last 5m)
10  timeseries  Payment gateway p95 by outcome
11  timeseries  Process health: DB pool and event loop
12  table  Per-tenant scorecard (last 5m)
```

## 5. In a real multi-tenant e-commerce platform

tenant_initech is this stack's configured noisy neighbour: 25% of its payments
are declined and it adds 260 ms at the fake gateway. These panels separate
"initech is hurting itself" from "initech is hurting everyone" without anyone
guessing. Select `tenant_initech` and panels 2, 3, 4, 7, 8, 9 and 12 narrow
together; the funnel drops at `payment_captured` for initech while acme's line
stays flat, which is a tenant problem. When the platform-wide ratio in panel 3
moves *with* initech's line, you have a shared-resource problem instead, and
panel 11 tells you whether the bottleneck is your process or the database.
During the outage I ran for chapter 10a
(`./scripts/outage.sh 90 timeout tenant_initech`) the same query showed
`tenant_initech 0.3508771929824561` in `shop:http_5xx_ratio:5m` while
`tenant_acme` sat at `0.02527566482581191`: one tenant on fire, one slightly
smoky, distinguished at a glance.

## 6. When to use it, when not to

Build this dashboard when you deploy, when you are on call, and when someone asks
"are we OK". Do not build it as an investigation tool: investigation belongs in
Explore, where you can rewrite the query freely. A panel is for the question you
ask a hundred times; Explore is for the question you ask once.

Cost. Twelve panels, 17 Prometheus targets, 15-second refresh: roughly 68 queries
a minute for every open tab. Panels 6, 7 and 8 are the expensive ones because
they group by `route`, and every new route adds a series to every query forever -
chapter 07b's cardinality lesson applied to your own dashboard. Two guards sit in
the JSON: the `route!~` exclusions keep probe traffic off the graphs, and panel
12 uses `instant: true`, so the scorecard costs one evaluation instead of a
range. Noise: a panel nobody reads is not free - it costs refresh budget, and it
costs your attention every time it is red for a reason you do not care about.

## 7. Common mistakes

1. **Panicking, or alerting, on `/api/boom`.** That route exists to return 500.
   It sat at a 0.70 5xx ratio in the run above, and it is why `tenant_acme`
   briefly fired `ApiHighErrorRatio` at 07:28 while nothing was broken.
2. **Blending routes into one latency line** (see the 0.476 s against 0.0048 s
   pair above).
3. **Forgetting `le` in `sum by`.** `sum by (route) (rate(..._bucket[5m]))` fed to
   `histogram_quantile` returns nothing, because the bucket boundary label is
   gone. It fails silently: the panel goes empty and people assume no traffic.
4. **Reading `NaN` as zero, or as an outage.** A quantile with no observations in
   the window is undefined, not slow.
5. **Two units on one axis**, flattening one of them into a straight line.
6. **Table columns left as `Value #A`.** Without the `organize` transformation
   nobody reads the scorecard, so the panel dies, so the next incident starts
   with "is it just us?" unanswered.

## 8. Try it yourself

Add a panel you would actually use: the 4xx ratio per tenant, which tells you
when a tenant is sending bad requests rather than you failing them.

```bash
# backup first - this directory is not a git checkout on this machine
cp grafana/dashboards/stack-health.json /tmp/stack-health.backup.json
```

Append this element to the `panels` array, then wait 30 seconds and prove it
loaded:

```json
{ "type": "timeseries", "title": "4xx ratio by tenant", "id": 13,
  "gridPos": { "h": 8, "w": 12, "x": 0, "y": 40 },
  "fieldConfig": { "defaults": { "unit": "percentunit" } },
  "targets": [ { "refId": "A", "legendFormat": "{{tenant_id}}",
    "expr": "sum by (tenant_id) (rate(shop_http_request_duration_seconds_count{status_code=~\"4..\", tenant_id=~\"$tenant\"}[5m])) / clamp_min(sum by (tenant_id) (rate(shop_http_request_duration_seconds_count{tenant_id=~\"$tenant\"}[5m])), 0.01)" } ] }
```

```bash
curl -s -u admin:admin localhost:3001/api/dashboards/uid/stack-health | jq -r '.dashboard.version, ([.dashboard.panels[]]|length)'
```

**Hint:** if the count is still 12, your JSON is invalid - the provider quietly
keeps the last good version. Check with
`jq . grafana/dashboards/stack-health.json`, and remember a JSON array element
needs a comma after the previous `}`. Expect a 4xx spike on `/api/error/:kind`,
the fake "not found" route: this panel is also a lesson from mistake 1.

**Cleanup, restoring the machine:**

```bash
cp /tmp/stack-health.backup.json grafana/dashboards/stack-health.json
# wait ~30s, then confirm 12 panels again
curl -s -u admin:admin localhost:3001/api/dashboards/uid/stack-health | jq -r '.dashboard.version, ([.dashboard.panels[]]|length)'
```

## 9. Next

The dashboard shows a problem; it does not wake you up. [10a - Good alerts and
bad alerts](10a-good-bad-alerts.md) covers the rules that fired during the
outage I ran for it.
