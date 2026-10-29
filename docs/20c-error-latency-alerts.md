# 20c - Error and latency alerts without crying wolf

Chapter 10a argued about which alerts deserve to exist. This chapter writes the
two hardest ones properly - error rate and latency - using the numbers this
stack actually produced, including the false positive it produced on purpose.

## 1. Simple explanation

A guard dog that barks at every leaf is useless: you stop looking. A guard dog
that barks at a person climbing the fence is valuable, and it must not sleep
through the fence.

Alerting is a trade: too sensitive and people mute you, too quiet and customers
tell you first. The trick is to require a problem to be **big enough** and
**long enough** before barking, and to ignore the leaves - the health checks,
the test endpoints, the one-off client retry.

## 2. Real name

- **Error ratio**: failed requests divided by total requests, over a window.
  A ratio is comparable across tenants and traffic levels; a count is not.
- **Latency percentile**: p95/p99 from a histogram. The tail, not the average.
- **`for:`**: how long the condition must hold. Paired with the query window,
  it is the main noise filter.
- **Volume guard**: a minimum request rate (or count) below which a ratio is
  meaningless. One failure out of two is not a 50% outage.
- **Route exclusion**: do not let synthetic endpoints (`/api/boom`, `/unmatched`,
  scrape endpoints) count as customer traffic.
- **Pending vs firing**: pending means "true but not long enough"; the page
  only happens on firing.

## 3. Example

The error alert. The recording rule keeps the query readable and makes the
alert cheap to evaluate:

```yaml
  - record: shop:http_request_rate:5m
    expr: sum by (service, tenant_id) (rate(shop_http_request_duration_seconds_count[5m]))

  - record: shop:http_5xx_rate:5m
    expr: sum by (service, tenant_id) (rate(shop_http_request_duration_seconds_count{status_code=~"5.."}[5m]))

  # clamp_min stops division by zero; without it the ratio is NaN and the alert
  # silently never fires.
  - record: shop:http_5xx_ratio:5m
    expr: shop:http_5xx_rate:5m / clamp_min(shop:http_request_rate:5m, 0.01)
```

```yaml
      - alert: ApiHighErrorRatio
        expr: shop:http_5xx_ratio:5m > 0.01     # 1% is a promise, not a guess
        for: 2m
        labels: { severity: page, product: shop }
        annotations:
          summary: "{{ $labels.tenant_id }}: more than 1% of requests are 5xx"
          runbook: "Loki: {service=\"{{ $labels.service }}\", level=\"error\"}"
```

The latency alerts. Two levels, because tail latency and widespread slowness
are different incidents:

```yaml
      - alert: ApiLatencyP95High
        expr: |
          histogram_quantile(0.95,
            sum by (le, service, tenant_id) (rate(shop_http_request_duration_seconds_bucket[5m]))
          ) > 0.5
        for: 5m
        labels: { severity: warn }

      - alert: ApiLatencyP99Severe
        expr: |
          histogram_quantile(0.99,
            sum by (le, service) (rate(shop_http_request_duration_seconds_bucket{route!~"/unmatched"}[5m]))
          ) > 2
        for: 5m
        labels: { severity: page }
```

The volume floor for a low-traffic tenant can be added without changing the
ratio:

```promql
# Same alert, but only when the tenant is actually serving traffic.
(
  shop:http_5xx_ratio:5m > 0.01
)
and
(
  shop:http_request_rate:5m > 0.2
)
```

Why the histogram buckets matter: the app's buckets are
`0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` seconds. A p99 of
"4.9 s" is an interpolation inside the 2.5-5 bucket, not a measured value; a
p99 above 10 s is reported as `+Inf` and the number is a lower bound. Do not
pretend the graph has precision it does not have.

## 4. What you should see

During the timeout drill, the latency and error conditions were unmistakable:

```bash
$ # during a 90s outage, 5m windows
p95 latency                   4.869 s
p99 latency                   4.949 s
5xx ratio (tenant_initech)    0.956
checkout error ratio          0.978
```

The alerts were `pending` while the windows filled, and the short drill ended
before the five-minute `for:` matured:

```bash
$ curl -s 'localhost:9090/api/v1/rules?type=alert' | jq -r '...'
CheckoutFailureBurst  pending  tenant_initech  page
ApiHighErrorRatio     pending  tenant_initech  page
ApiLatencyP95High     pending  tenant_initech  warn
ApiLatencyP99Severe   pending  -               page
```

That is the correct behaviour, not a failure: a 90-second blip should not wake
anyone. A sustained version of the same fault reaches `firing` at three to five
minutes, depending on the rule.

The false positive is more instructive. Tenant_acme's error ratio crossed 1%
after a handful of calls to the deliberate 500 endpoint:

```bash
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=
  sum by (route, status_code)
  (increase(shop_http_request_duration_seconds_count{tenant_id="tenant_acme", status_code=~"5.."}[1h]))' \
  | jq -r '.data.result[] | select((.value[1]|tonumber) > 0) | "\(.metric.route) \(.metric.status_code) \(.value[1])"'
/api/boom 500 5.053716931216932
```

Five test failures in an hour, on a quiet tenant, were enough to page
`ApiHighErrorRatio`. The ratio was mathematically correct and operationally
wrong: no customer was affected. The fix is to exclude the synthetic route from
customer SLI queries:

```promql
shop:http_5xx_ratio:5m{route!~"/api/boom|/unmatched"}
```

...or to keep the route in the numerator but add the volume floor above. Either
is defensible; silently accepting the page is not. Note that `/api/boom` is a
real endpoint returning a real 500; what makes it noise is that it is not
customer traffic.

## 5. In a real multi-tenant e-commerce platform

The error budget decides the threshold. A premium tenant with a 99.9% SLO
should page at a burn rate, not at a fixed 1% forever; a free tenant may only
get a ticket. The same expression, two policies. Here both use 1% because the
fake platform has one promise, but the label `tenant_id` is what lets you split
the policy later without rewriting the query.

Latency needs two numbers because one hides the other. p95 above 500 ms means
a twentieth of customers are waiting; p99 above 2 s means the slowest requests
are effectively broken (checkout has a 2.5 s deadline). A page on p99 and a
ticket on p95 is a deliberate choice: p95 catches a broad slowdown, p99 catches
the tail that a broad average would dilute.

The noisy neighbour changes the interpretation. tenant_initech's p95 is twice
the others even when healthy (chapter 20b: 477 ms vs ~230 ms), because its fake
cards decline slowly and its chaos runs add latency. A platform-wide p95 alert
would fire on initech's normal behaviour; a per-tenant alert warns its owner
without waking everyone else.

Two exclusions keep the signal clean: health/scrape endpoints (already excluded
from the dashboard queries) and synthetic failure routes. Add `/metrics`,
`/readyz`, `/healthz` to the alert expression only if they are not already
excluded by the recording rule; a scrape every 15 s is not customer traffic.

## 6. When to use it, when not to

Page on error ratio when failures mean a customer cannot complete a task and
the condition survives `for:`. Page on p99 when the promise is a deadline
(checkout, payment). Warn on p95. Use a ratio for errors, never a raw count.

Do not alert on a single 5xx, a single slow request, or a route that exists to
produce failures. Do not set `for: 0m` on a ratio; one scrape of bad luck pages.
Do not set the threshold to "whatever the graph shows today"; derive it from
the SLO or the customer deadline. Do not alert on p50; it is the number that
moves last.

Cost: latency alerting needs a histogram, and histograms are bigger than
counters. This one has 11 buckets and four labels; at 432 series it is the
largest app metric and still cheap. At a much larger scale, sample the tail or
use native histograms rather than adding labels to compensate.

## 7. Common mistakes

1. **A ratio without a volume guard.** One failure on a quiet tenant becomes a
   page; the `and shop:http_request_rate:5m > 0.2` clause prevents it.
2. **Counting synthetic routes.** The `/api/boom` page above. Exclude test and
   scrape endpoints from the SLI.
3. **`for: 0m`.** Every scrape jitter becomes a page; the drill in section 4
   stays quiet precisely because `for:` is longer than the fault.
4. **Averaging latency.** The mean hides the tail; the tail is what times out.
5. **One threshold for every tenant.** A noisy enterprise tenant pages
   constantly at a threshold that suits the quiet ones; split the policy or the
   series.
6. **Ignoring the histogram ceiling.** p99 above the largest finite bucket is a
   lower bound; the graph should say so.
7. **No runbook.** "Error rate high" is a symptom with no next step; the
   annotation must name the query to run.

## 8. Try it yourself

Produce a false positive, then make it stop without silencing the real alert.

```bash
# 1. Deliberate 500s for one tenant, spread over two minutes. Do NOT send them
#    as one burst: a counter that jumps 0 -> 10 between two scrapes is a single
#    visible sample, and increase() over a window starting at that sample
#    returns 0. Spacing them means every scrape sees a few more.
for i in $(seq 1 10); do
  curl -s -o /dev/null -H 'x-tenant-id: tenant_globex' localhost:8000/api/boom
  sleep 12
done

# 2. Watch the alert state while it runs.
curl -s 'localhost:9090/api/v1/rules?type=alert' \
  | jq -r '.data.groups[] | .rules[] | select(.name=="ApiHighErrorRatio") | .alerts[]? | "\(.state) \(.labels.tenant_id) \(.value)"'

# 3. Prove where the errors came from, after the loop finishes.
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=
  sum by (route, status_code)
  (increase(shop_http_request_duration_seconds_count{tenant_id="tenant_globex", status_code=~"5.."}[15m]))' \
  | jq -r '.data.result[] | "\(.metric.route) \(.metric.status_code) \(.value[1])"'
```

The last query answers with `/api/boom 500 10.736...` in this stack. A smaller
number means some failures happened before the first scrape in the window, which
is the same reason `increase` can under-report a burst - see
[20e](20e-pitfalls.md).

**Hint:** on a quiet tenant, ten failures may not reach 1% for two minutes;
increase the count or use a tenant with less traffic. The point is to see the
state change to `pending` and then resolve on its own. If it never leaves
`inactive`, the ratio is below 1% - which is the volume guard doing its job
informally.

**Cleanup:** nothing to undo; `/api/boom` is fake. If you changed the rule file
to exclude the route, reload and confirm the alert is gone:

```bash
curl -s -X POST localhost:9090/-/reload -o /dev/null -w '%{http_code}\n'
curl -s 'localhost:9090/api/v1/rules?type=alert' \
  | jq -r '.data.groups[] | .rules[] | select(.name=="ApiHighErrorRatio") | .health'
```

## 9. Next

The alerts are written. [20d - Simulated outage](20d-simulated-outage.md) puts
them to work: one fault, three signals, and an investigation from page to root
cause.
