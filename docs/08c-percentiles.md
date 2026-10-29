# 08c - Percentiles: p50, p95, p99, and why averages lie

[07a](07a-metric-types.md) gave you the histogram, [08b](08b-promql-intro.md) gave you
`rate`. This is what a histogram is for: asking "how slow were the slow requests?" and
knowing how far to trust the answer.

## 1. Simple explanation

Twenty kids queue for the slide. Most go down in a few seconds. One kid's shoe gets stuck and
he waits two whole minutes.

Ask "how long did the queue take?" and you add it up and divide by twenty: about twenty
seconds. Not a lie, but not any kid's wait either - the stuck kid never waited twenty seconds.
So ask about the unlucky ones: the kid in the middle has the middle wait, the kid who waited
longer than nineteen out of twenty has the bad-day wait, and the one who waited longer than
ninety-nine out of a hundred tells the story at dinner.

One catch remains. You never used a stopwatch: you dropped each kid into a jar marked "under
half a minute", "under a minute", "over a minute". Ask for the exact middle wait and all you
can say is which jar the middle kid landed in. Anything sharper than "somewhere between those
two jar marks" is a guess.

## 2. Real name

- **Quantile / percentile**: the value below which a fraction of observations falls; p50 is the
  median, and `histogram_quantile(φ, ...)` takes `φ` in 0..1. **Tail latency** (p95, p99) is
  where complaints, timeouts and abandoned checkouts live.
- **Bucket and `le`**: each `_bucket` series counts observations with duration `<= le`, so
  buckets are cumulative and never decrease, and `le="+Inf"` is the total. `le` is a *string*
  label, which is why aggregation has to keep it. `_sum` and `_count` are the two extra series
  per label combination, and `rate(_sum) / rate(_count)` is the mean - the only number here
  computed from exact durations.
- **Linear interpolation inside a bucket**: what `histogram_quantile` does between two bounds -
  the jar-guess as maths. **A percentile is never more precise than the bucket it lands in.**
- **`NaN`**: what you get when that series had no traffic in the window. `NaN` means "no data",
  never "fast", and `NaN > 0.5` is never true, so an alert on it silently cannot fire.
- **Cardinality multiplier**: one series per label combination per bucket.

## 3. Example

Buckets are chosen in code, at metric-definition time: you can never compute what you did not
measure. From `app/src/lib/metrics.ts`:

```ts
export const httpRequestDurationSeconds = new client.Histogram({
  name: 'shop_http_request_duration_seconds',
  help: 'Latency of HTTP requests in seconds, by route, status and tenant.',
  labelNames: ['method', 'route', 'status_code', 'tenant_id'] as const,
  // 11 buckets + the implicit +Inf = 12 series per label combination. Two clusters on
  // purpose: 0.005..0.1 resolve normal traffic, 0.25..10 straddle the alert thresholds
  // (0.5 s, 2 s), so a threshold never sits mid-gap.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});
```

`app/src/middleware/latency.ts` observes it with `req.route?.path ?? (req.baseUrl ||
'/unmatched')` - the route *template*, so a bot scanning `/orders/99999` cannot mint one series
per URL. The four queries that matter, all runnable now:

```bash
# platform p95: aggregate the BUCKETS by le first, take the quantile ONCE
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=histogram_quantile(0.95, sum by (le) (rate(shop_http_request_duration_seconds_bucket[5m])))'
# the average: exact, and useless for the tail
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(rate(shop_http_request_duration_seconds_sum[5m])) / sum(rate(shop_http_request_duration_seconds_count[5m]))'
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum by (le) (rate(shop_http_request_duration_seconds_bucket[5m]))'
# per tenant: add tenant_id to the by clause, and keep le
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=histogram_quantile(0.95, sum by (le, tenant_id) (rate(shop_http_request_duration_seconds_bucket[5m])))'
```

`prometheus/alert_rules.yml` uses those two shapes: `ApiLatencyP95High` quantiles
`sum by (le, service, tenant_id)` against `> 0.5` for `5m` (`warn`, per tenant), and
`ApiLatencyP99Severe` quantiles `sum by (le, service)` against `> 2` (`page`, platform wide).
Two quantiles, two scopes, two severities.

**How the guess is made.** From section 4's staircase: total `+Inf` = 0.22456 req/s, cumulative
0.17544 at `le="0.25"` and 0.22456 at `le="0.5"`, and p99 wants 0.99 x 0.22456 = 0.22232, which
falls between those rows:

```text
0.25 + 0.25 * (0.22232 - 0.17544) / (0.22456 - 0.17544) = 0.48857 s   # = measured p99
0.00 + 0.005 * (0.11228 - 0)      / (0.12982 - 0)       = 0.00432 s   # = measured p50
```

Say line one as a sentence: *"I do not know your p99; I know it is somewhere in the 0.25-0.5 s
bucket, and I picked a spot proportional to how full the bucket looks."* A p99 landing in the
1-2.5 s bucket can only be answered to within 1.5 seconds.

## 4. What you should see

**Recorded idle values** (`.artifacts/promql/promql-core.txt`, quiet stack):

```text
p50 {} = 0.0025617411      p95 {} = 0.0048673191
p99 {} = 0.0187774882      average = 0.0015954907
```

The average sits *below* the median, which looks impossible - the mean of a right-skewed set
should be above it. It is a bucket artefact: p50 lands inside the first bucket, so the
interpolation puts the median partway up a 5 ms gap while the real requests cluster near its
bottom. Only the average comes from exact durations, so when they disagree, believe that one.

**A mixed burst I generated here** - 15 fast requests interleaved with 15 slow ones, one tenant
- then the four queries above (`jq -c '.data.result[] | .value[1]'`), before and after:

```text
"0.002878787878787879"  "0.004324324324324324"   # p50, before then after
"0.008099999999999996"  "0.4428571428571427"     # p95
"0.009620000000000004"  "0.48857142857142855"    # p99
"0.0027995482105263167" "0.09116372407812512"    # average
```

Median 4.3 ms, p95 443 ms, p99 489 ms, average 91 ms. The average rose 33x and *still* reports
4.9x less than what 5% of customers felt and 5.4x less than the tail. On an "avg latency"
dashboard, this burst looks fine.

**The staircase you actually measured** (cumulative, so it never decreases):

```text
0.005   0.12982456140350876
0.01    0.16140350877192983
0.025   0.16491228070175437
0.05    0.16491228070175437
0.1     0.16491228070175437
0.25    0.17543859649122806
0.5     0.2245614035087719
1.0     0.2245614035087719
2.5     0.2245614035087719
5.0     0.2245614035087719
10.0    0.2245614035087719
+Inf    0.2245614035087719
```

`0.025`, `0.05` and `0.1` are identical because **nothing** happened in those ranges: a
quantile landing there is interpolated across a gap with no information in it. `+Inf` equals the
total request rate - your sanity check against `_count`.

**Per-tenant p95, and the `NaN` you must not misread.** `tenant_acme` is my burst; the other two
had no traffic in the window. Earlier today the same query returned `tenant_acme` `NaN` while
`tenant_globex` was `0.02275` - the roles swap with traffic. A panel that paints `NaN` green
turns "we have no idea" into "best latency ever".

```text
none            0.008656249999999997
tenant_acme     0.4803571428571428
tenant_umbrella NaN
tenant_initech  NaN
tenant_globex   0.00475
```

**The most common mistake.** Dropping `le` from the `by` clause does not error: the query
returns an empty vector plus a warning nobody reads, which is worse - verified on this machine
with `histogram_quantile(0.95, sum by (tenant_id) (rate(..._bucket[5m])))`, which gave
`"result":[]` and the warning `bucket label "le" is missing or has a malformed value of ""`.

**The window trap**, also recorded earlier today: `sum(rate(shop_checkout_step_total[5m]))`
returned `0` while `[10m]` returned `6.30`, because traffic had stopped about six minutes
earlier. A window shorter than the gap since the last request reads exactly like an outage.

## 5. In a real multi-tenant e-commerce platform

`tenant_acme` runs a nightly price-sync job, `tenant_initech` is the configured noisy neighbour,
`tenant_globex` and `tenant_umbrella` are small and quiet.

Sunday, 21:40. The platform average-latency panel reads 90 ms and the deploy goes ahead. What
actually happened: initech hammered `/api/reports/tenant-summary` - the query owning 91.7% of
all database time on this machine - and *its* p95 went to 1.4 s. Those requests are a few
percent of platform traffic, so `sum by (le)` buries them: platform p95 moves a few
milliseconds, the average twitches less. One tenant is on fire and the aggregate panel is green.
That is why `ApiLatencyP95High` keeps `tenant_id` in the `by` clause.

The accuracy twist is that buckets are configured once for everyone. `tenant_acme` mixes a 3 ms
scrape with a 300 ms catalog fetch; initech is a wall of 20 ms queries. Both share the
0.25-0.5 s bucket, so two tenants with different problems can be reported as the same
interpolated number. Per-tenant is the right *scope*; the bucket layout is a compromise you
design against the tenants you actually have.

## 6. When to use it, when not to

Use percentiles when a human waits, when you write an SLO, when you compare deploys, when you
size a timeout (p99 489 ms against a 500 ms client deadline means that deadline fires). Use the
mean for total-cost arithmetic, because only the mean is additive: total server-seconds is
`mean x count`, never `p95 x count`.

- **Not under a few hundred requests in the window.** p99 of 40 requests is the second-slowest
  one, jittered. The `and sum(...) > 0.2` volume guard on `CheckoutFailureBurst` is the same
  idea for a ratio: it stops a quiet tenant paging at 04:00.
- **Not when you need the cause.** A percentile cannot tell you which request, route or span;
  [13c](13c-find-the-slow-part.md) is how you find which.
- **Not on a window shorter than two scrapes.** With `scrape_interval: 15s`,
  `histogram_quantile(0.95, sum by (le) (rate(...[15s])))` returns `[]` - I ran it. Mind window
  memory too: my burst was still inside `[5m]` five minutes later, so a rule with `for: 5m`
  needs a tail that lasts about ten.

**Cost.** Buckets multiply series: `series ~= label combinations x (buckets + 1)`. `/metrics`
currently exposes 71 combinations x 12 `le` values = **852** bucket series for this one
histogram; captures earlier today recorded 432 for the same metric and 750 for
`traces_spanmetrics_latency_bucket`, the largest on the box, against a `SeriesCountHigh`
threshold of 60,000 total. An extra label value multiplies by 12, an extra bucket by the number
of combinations.

**Noise.** A percentile is a step function: when the cumulative rate crosses a bucket boundary,
the reported p99 jumps a whole bucket width with nothing changing in reality, so a threshold
inside a wide bucket flaps - and `NaN` matches no comparison, so a latency alert on a quiet
tenant never fires. The same trap is written into the recorded ratio:

```yaml
- record: shop:http_5xx_ratio:5m
  expr: |
    shop:http_5xx_rate:5m / clamp_min(shop:http_request_rate:5m, 0.01)
```

`clamp_min(..., 0.01)` means "pretend at least 0.01 req/s", so a zero denominator cannot make
the ratio `NaN` or infinite. Without the guard I measured `tenant_initech` `NaN` (no traffic)
and `tenant_globex` `0` (traffic, no errors): both true, neither alertable. A ratio on a handful
of requests pages you at 3am for nothing - one failure out of three is 33%.

## 7. Common mistakes

1. **Reporting the average as "latency".** Exact, and the least informative number a histogram
   gives: section 4's mean rose 33x while the p95 customers felt rose 55x.
2. **Averaging percentiles.** Pod A p95 = 10 ms and pod B p95 = 400 ms do not make a fleet p95 of
   205 ms: quantiles are not additive and cannot be combined afterwards, weighted or not.
   Aggregate the *buckets* across instances and quantile once - `sum by (le) (...)` drops
   `instance`, which is what makes it correct. Never record a percentile and `avg()` it later
   either: record the bucket rates, or record the quantile only for the exact label set you will
   graph.
3. **Quantiling raw buckets with no `sum`**: one "p95" per `(method, route, status_code,
   tenant_id)` series. Mine came back mostly `NaN`, with values like 0.0093 for `/metrics`, none
   of them the platform p95 of 0.443 s.
4. **Reading `NaN` as healthy**, or letting Grafana render it as 0.
5. **A window shorter than the traffic gap**, then paging on a tenant that merely napped.
6. **Copying someone else's buckets.** Put a boundary at each threshold you will alert on.
7. **Comparing p95 across services with different bucket layouts** and concluding one is faster:
   the guess is bounded by the jars, not by the requests.

## 8. Try it yourself

Make a tenant's tail appear, and prove the platform average does not care.

1. Forty requests, slow tail for one tenant:
   ```bash
   for i in $(seq 1 20); do
     curl -s -o /dev/null localhost:8000/api/products -H 'x-tenant-id: tenant_globex'
     curl -s -o /dev/null "localhost:8000/api/slow?ms=$((300+i*10))" -H 'x-tenant-id: tenant_globex'
   done
   ```
2. Run platform p95, `tenant_globex` p95 and the average (section 3); note which two moved. Then
   work out by hand, from the staircase, which bucket your p99 landed in and whether the
   interpolation could possibly be right.

Hint: count the rows before trusting them - the per-tenant query returns one entry per tenant
*with traffic*, so three rows when four tenants exist is not a good report card for the missing
one, and `count(sum by (tenant_id) (rate(shop_http_request_duration_seconds_count[5m])))` says
how many tenants the window covers.

Cleanup: nothing to delete - you sent HTTP requests and changed no files. Wait about six minutes
for the burst to leave the 5-minute window, re-run step 2, and confirm `tenant_globex` is back to
a normal value or `NaN` and the staircase has the idle shape again.

## 9. Next

[09a - Grafana dashboards](09a-grafana-dashboards.md) puts these queries on panels with
variables, so per-tenant p95 is one dropdown away instead of one `curl` away.
