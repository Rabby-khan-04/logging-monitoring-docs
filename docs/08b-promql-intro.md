# 08b - PromQL: rate, increase, vector matching, recording rules

Chapter 07a gave you counters and histograms, 07b gave you labels. This chapter is
the query language: turning a number that only ever grows into "requests per
second", dividing one bundle of series by another, naming an expensive question.

## 1. Simple explanation

A counter is an odometer. "The car has driven 4,360 km" tells you nothing about how
fast you are going now. To get speed you take two moments and divide: 10 km in 5
seconds is 2 m/s. That is what `rate` does, and the strip of history between now and
five minutes ago is the window.

Every number also carries a name tag: which job, which tenant, which route. A query
returns a bundle of tagged numbers, not one lonely number, and `sum by (tenant_id)` adds
everything that shares a tenant and forgets the rest of the tag. Dividing two bundles is
where beginners cry, because the tags have to line up: "10 km" and "2 litres" only mean
something together if they are about the same car.

## 2. Real name

- **Instant vector**: the result at one timestamp: series, each with one sample. `up`
  is one; so is `rate(x[5m])`.
- **Range vector**: one series with all its samples inside a window
  (`shop_http_requests_total[5m]`). You cannot graph it: it is input to a function.
- **Selector**: metric name plus label matchers, e.g.
  `shop_http_requests_total{route="/api/products",status_code=~"4..|5.."}`.
- **`rate(v range-vector)`**: per-second average growth over the window, reset
  aware. Needs two samples in the window or it returns nothing.
- **`increase(v range-vector)`**: `rate` times the window length - "how many
  events". Extrapolated, so 12 events can read back as 12.63.
- **`sum by (l)` / `sum without (l)`**: aggregate, keeping or dropping labels.
- **`offset`**: evaluate at a time other than now: `... offset 5m`.
- **Vector matching**: the labels used to pair the left and right sides of a binary
  operation. The default is "identical label sets"; `on(...)` narrows the pairing,
  `ignoring(...)` excludes labels, `group_left` / `group_right` declare a one-to-many join.
- **Recording rule**: a named, stored result of an expression, evaluated on a schedule
  instead of at panel time. Rules live in `rule_files` groups - here
  `prometheus/alert_rules.yml`, whose alerting half is chapter 10a. A group runs its
  rules once per `interval`; `shop-recorded` runs every 15s.

## 3. Example

The rules in `prometheus/alert_rules.yml` are the repo's best worked example of `rate`:

```yaml
groups:
  - name: shop-recorded
    interval: 15s        # every rule in this group runs every 15s
    rules:
      - record: shop:http_request_rate:5m
        expr: sum by (service, tenant_id) (rate(shop_http_request_duration_seconds_count[5m]))
        # ^ _count is the "Rate" half of RED; the 5m window is baked into the name
      - record: shop:http_5xx_rate:5m
        expr: sum by (service, tenant_id) (rate(shop_http_request_duration_seconds_count{status_code=~"5.."}[5m]))
      # clamp_min stops a division by zero on a quiet night. Without it the
      # ratio goes NaN and the alert silently never fires.
      - record: shop:http_5xx_ratio:5m
        expr: |
          shop:http_5xx_rate:5m
          /
          clamp_min(shop:http_request_rate:5m, 0.01)
```

`shop:http_request_rate:5m` follows the convention `level:metric:operations`: a `/` is
illegal in a metric name and a `:` is legal, which is why recorded names look strange.
`sum by (service, tenant_id)` drops route, status_code, instance and job: the 53 raw
`_count` series become 5. Below, the memory form chapter 17 uses (100 is a scalar):

```promql
100 * sum by (name) (container_memory_working_set_bytes{name=~"observability-learn-.*"})
  / on(name) group_left ()
sum by (name) (container_spec_memory_limit_bytes{name=~"observability-learn-.*"} > 0)
```

`sum by (name)` first, so each side is one series per container; `on(name)` pairs on
the container name; `group_left ()` allows extra left rows; `> 0` drops unlimited ones.

## 4. What you should see

A raw counter, queried twice 30 seconds apart, then the same series as a rate:

```
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(shop_http_requests_total)' | jq -r '.data.result[].value[1]'   # first call
4350
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(shop_http_requests_total)' | jq -r '.data.result[].value[1]'   # 30s later
4360
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(rate(shop_http_requests_total[5m]))' | jq -r '.data.result[].value[1]'
0.7520290994152046
```

`4360 of what, over what period?` is the question a counter cannot answer; the rate
answers it. A range query plays the same expression back over history:

```
$ curl -sG localhost:9090/api/v1/query_range --data-urlencode 'query=sum(increase(shop_http_requests_total[2m]))' --data-urlencode "start=1793258527" --data-urlencode "end=1793259127" --data-urlencode 'step=120s' | jq -r '.data.result[0].values[] | "\(.[0])\t\(.[1])"'
1793258527	477.71428571428567
1793258647	24
1793258767	25.966819047619047
1793258887	324.57142857142856
1793259007	21.714285714285715
1793259127	21.714285714285715
```

`increase` extrapolates to the window edges, so whole events read as fractions, and the
324 in the middle is a load run that started and stopped. At or below the 15s scrape
interval a window holds fewer than two samples, so `rate` returns nothing at all:

```
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(rate(shop_http_requests_total[10s]))' | jq -r '.data.result'
[]
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(increase(shop_checkout_step_total[5m]))' | jq -r '.data.result[] | [(.metric|tostring), .value[1]] | @tsv'
{}	390.52631578947364
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(increase(shop_checkout_step_total[10m]))' | jq -r '.data.result[] | [(.metric|tostring), .value[1]] | @tsv'
{}	767.1794871794871
```

Same data, twice the window, nearly double the answer: traffic was sliding out of the
short window as I queried it. Matching labels that line up gives a percentage of limit:

```
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=100 * sum by (name) (container_memory_working_set_bytes{name=~"observability-learn-(prometheus|shop-api|cadvisor)-1"}) / on(name) sum by (name) (container_spec_memory_limit_bytes{name=~"observability-learn-(prometheus|shop-api|cadvisor)-1"} > 0)' | jq -r '.data.result[] | [.metric.name, .value[1]] | @tsv'
observability-learn-cadvisor-1	93.28409830729167
observability-learn-prometheus-1	77.227783203125
observability-learn-shop-api-1	25.8837890625
```

Matching without saying how is an error:

```
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=node_filesystem_avail_bytes / on(instance) node_uname_info' | jq -r .error
multiple matches for labels: many-to-one matching must be explicit (group_left/group_right)
```

The recorded rules are queryable like any metric - one series per tenant, read via the CLI:

```
$ docker compose exec -T prometheus sh -c "/bin/promtool query instant http://localhost:9090 'shop:http_request_rate:5m'"
shop:http_request_rate:5m{service="shop-api", tenant_id="none"} => 0.25614035087719295 @[1793259127.773]
shop:http_request_rate:5m{service="shop-api", tenant_id="tenant_acme"} => 0.287719298245614 @[1793259127.773]
shop:http_request_rate:5m{service="shop-api", tenant_id="tenant_globex"} => 0.22105263157894736 @[1793259127.773]
shop:http_request_rate:5m{service="shop-api", tenant_id="tenant_initech"} => 0.32631578947368417 @[1793259127.773]
shop:http_request_rate:5m{service="shop-api", tenant_id="tenant_umbrella"} => 0.24210526315789468 @[1793259127.773]

$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=count({__name__=~"shop:.*"})' | jq -r '.data.result[].value[1]'
11
```

Eleven series, not three rules: each rule fans out over the label combinations with recent
traffic. `offset` on a recorded rule then costs nothing, the work was done once already:

```
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(shop:http_request_rate:5m)' | jq -r '.data.result[].value[1]'
1.333333333333333
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(shop:http_request_rate:5m offset 5m)' | jq -r '.data.result[].value[1]'
0.43218593684210527
```

## 5. In a real multi-tenant e-commerce platform

Those five lines are the tenant comparison behind chapter 19: one process, one target,
per-tenant request rate. When `tenant_initech` sits far above acme and umbrella, the
question stops being "is Prometheus slow" and becomes "who is spending our capacity" -
answered with a label, not a new scrape job. `shop:http_5xx_ratio:5m` is the honest way
to compare a big shop with a small one: 50 errors for acme and 500 for initech are not
the same incident. With `clamp_min` in the denominator the number means the same at
03:00 as at 15:00.

## 6. When to use it, when not to

Use `rate` for event-shaped things (counters), `increase` when a human wants "about 400
checkouts an hour", `delta` for gauges that can go down. Never put a raw counter on a
panel: the line is a ramp whose meaning depends on when the process last restarted.
Choose a window at least four times the scrape interval - four or five samples inside it
is what makes extrapolation behave - so 1m minimum, 5m default at 15s scrapes. Longer
windows smooth short incidents away; shorter ones are noisy and, as section 4 showed, empty.

Recording rules pay for themselves when one expensive expression feeds many panels, when
the window is long (1h or more), or when the raw metric may be scraped away before the
panel renders. This stack's `shop-recorded` group takes 0.0007s to evaluate every 15s and
rewrites 11 series. Do not use them to cut cardinality by dropping a label you still
need: `sum by (tenant_id)` over a histogram loses `le` and kills `histogram_quantile`.

## 7. Common mistakes

**A window shorter than the scrape interval.** The answer is `[]`, which looks identical
to "no traffic". Check `count_over_time(<metric>[1m])` first: if it says 4, a 10s window
can never hold two samples. `increase` reading 390.526 is the same lesson: it extrapolates.

**Matching bundles without declaring the shape.** The error in section 4 is the friendly
version. The trap is the query that works today and breaks the week a container is
recreated, because the right side suddenly has two series per key:

```
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum by (tenant_id) (rate(shop_http_requests_total[5m])) / on(tenant_id) shop_http_requests_total' | jq -r .error | cut -c1-200
found duplicate series for the match group {} on the right hand-side of the operation: [{__name__="shop_http_requests_total", instance="shop-api:8000", job="shop-api", method="GET", route="/metrics", service="shop-api", status
```

Two ways out: aggregate both sides to one series per key, or declare the join with
`group_left` - which, on a many-to-many surprise, silently keeps one arbitrary series.

**`rate` on a gauge.** It does not error; it returns nonsense:

```
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(rate(shop_db_pool_connections[5m]))' | jq -r '.data.result[].value[1]'
0.007017543859649122
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(delta(shop_db_pool_connections[5m]))' | jq -r '.data.result[].value[1]'
-2.1052631578947367
```

The pool did not grow by 0.007 per second; it shrank by two. `delta` is for gauges.

**Averaging the wrong way.** `avg(rate(x_sum[5m]) / rate(x_count[5m]))` is an average of
averages: every series counts the same regardless of its traffic. Use
`sum(rate(x_sum[5m])) / sum(rate(x_count[5m]))` - and know that even that correct average
is the number chapter 08c exists to warn you about.

**Expecting a new rule to have data immediately.** A recording rule runs when its group
runs: created at 10:00:05 in a 15s group, it has nothing until 10:00:20 and no history
before that, so a brand-new panel opens empty. That is lag, not failure; `/api/v1/rules`
reports `health`, `lastEvaluation` and `evaluationTime` per rule if you doubt it.

**Two `offset` spellings.** `metric offset 5m` is postfix and moves the whole evaluation;
`rate(metric[5m] offset 5m)` moves the window inside the selector. A recorded rule's
window is already baked into its name, so postfix is the correct spelling there.

## 8. Try it yourself

Add a recording rule and watch it come alive one interval later.

1. In `prometheus/alert_rules.yml`, inside the `shop-recorded` group, append these two
   lines, matching the indentation of the rules above it exactly - YAML is picky:
   ```yaml
      - record: shop:http_4xx_rate:5m
        expr: sum by (service, tenant_id) (rate(shop_http_request_duration_seconds_count{status_code=~"4.."}[5m]))
   ```
2. Validate and load: `docker compose exec -T prometheus sh -c '/bin/promtool check rules
   /etc/prometheus/alert_rules.yml'`, then `curl -s -X POST localhost:9090/-/reload`.
3. Query `shop:http_4xx_rate:5m` at once, then again after 30s, and watch
   `count({__name__=~"shop:.*"})` grow.

Hint: an empty first result is section 7's lag, not a broken rule; `/api/v1/rules` lists
the new rule with `health: "ok"` as soon as the group has run it.

Cleanup that restores the machine: delete the two lines you added, reload again, and
confirm `shop:http_4xx_rate:5m` returns `[]`. The samples the test rule wrote age out
inside the 6h retention window.

## 9. Next

[08c - Percentiles: p50, p95, p99, and why averages lie](08c-percentiles.md)
