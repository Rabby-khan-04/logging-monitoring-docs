# 10c - SLIs, SLOs and error budgets

Chapter 10a picked symptoms; chapter 10b delivered them. This chapter answers a
harder question: how much failure is allowed before somebody must act?

## 1. Simple explanation

You promise a friend you will be home by six. That promise is the goal. The
clock in your car tells you whether you are keeping it. If traffic costs you
ten minutes, you have used ten minutes of the slack built into the promise;
if the trip goes badly enough that you cannot arrive by six, the promise is
broken and you call ahead.

Software needs the same three things: a way to measure success (the clock), a
promise (home by six), and a budget for lateness (the slack). Without the
budget, every tiny failure is either ignored or treated as a crisis. With it,
you can say "we have plenty of slack, ship it" or "we have burned the slack,
freeze changes".

## 2. Real name

- **SLI** (service level indicator): a measured ratio, e.g. the fraction of
  valid HTTP requests that did not return 5xx in the last hour.
- **SLO** (service level objective): the target for that SLI, e.g. 99.9% of
  requests succeed over 30 days.
- **SLA** (service level agreement): a contract with money or credits attached.
  An SLO is an internal engineering target; an SLA is a legal promise. Keep the
  SLO stricter than the SLA.
- **Error budget**: `1 - SLO`, expressed in failures or in time. At 99.9% over
  30 days the budget is 0.1% of the time: **43.2 minutes**.
- **Burn rate**: how fast the budget is being spent. Burn rate 1 spends the
  whole 30-day budget exactly over 30 days. Burn rate 14.4 spends 2% of it in
  one hour.
- **Multi-window alert**: require both a long window (is this real?) and a
  short window (is it still happening?) before paging.
- **Error budget policy**: the pre-agreed rule for what happens when the budget
  is exhausted, usually "feature work stops until reliability is restored".

## 3. Example

The arithmetic first, because every threshold below comes from it:

```
SLO 99.9% over 30 days
error budget = 0.1% of 30 days
             = 0.001 x 30 x 24 x 60 minutes
             = 43.2 minutes

Allowed error ratio r = 0.001
Burn rate = observed_error_ratio / r
```

Stop and check the units, because burn-rate tables are easy to repeat without
understanding. A burn rate of 14.4 means the observed error ratio is
`14.4 x 0.001 = 1.44%`, and 1.44% of one hour is 51.84 seconds of failed
requests. The whole 30-day budget is 2592 seconds, so:

```
51.84 s / 2592 s = 2.0% of the budget spent in that hour
```

Now the PromQL. The SLI for the shop, as a ratio over one hour:

```promql
# Availability SLI: successful / total, both from the request histogram.
1 - (
  sum(rate(shop_http_request_duration_seconds_count{status_code=~"5.."}[1h]))
  /
  clamp_min(sum(rate(shop_http_request_duration_seconds_count[1h])), 0.01)
)
```

Burn rate against a 99.9% SLO, and the budget left:

```promql
# Burn rate: 1.0 means "on track to use exactly the budget".
(
  sum(rate(shop_http_request_duration_seconds_count{status_code=~"5.."}[1h]))
  /
  clamp_min(sum(rate(shop_http_request_duration_seconds_count[1h])), 0.01)
) / 0.001

# Budget remaining as a fraction. Negative means you have spent more budget
# than the whole month allows. clamp_min keeps a quiet hour from dividing by 0.
1 - (
  (
    sum(increase(shop_http_request_duration_seconds_count{status_code=~"5.."}[1h]))
    /
    clamp_min(sum(increase(shop_http_request_duration_seconds_count[1h])), 0.01)
  ) / 0.001
)
```

The alert rule uses the same arithmetic with two windows. Note `0.001`, not
`0.02`: the divisor is `1 - SLO`, so changing the promise changes this number.
The version in `prometheus/alert_rules.yml` now says so in a comment.

```yaml
      - alert: ErrorBudgetBurnFast
        expr: |
          (
            sum(rate(shop_http_request_duration_seconds_count{status_code=~"5.."}[5m]))
            /
            clamp_min(sum(rate(shop_http_request_duration_seconds_count[5m])), 0.01)
          ) / 0.001 > 14.4
          and
          (
            sum(rate(shop_http_request_duration_seconds_count{status_code=~"5.."}[1h]))
            /
            clamp_min(sum(rate(shop_http_request_duration_seconds_count[1h])), 0.01)
          ) / 0.001 > 14.4
        for: 5m
        labels: { severity: page }
```

A production rule uses 28d/1h and 5m/30m windows from the SRE Workbook. This
stack keeps metrics for six hours, so the long window is one hour. That is a
deliberate simplification: short windows react faster but are noisier, and a
one-hour window cannot see a slow leak that a 28-day window would.

## 4. What you should see

During the 90-second timeout exercise against tenant_initech, the platform-wide
ratios and burn rates were:

```bash
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=
  sum(rate(shop_http_request_duration_seconds_count{status_code=~"5.."}[5m]))
  / clamp_min(sum(rate(shop_http_request_duration_seconds_count[5m])), 0.01)' \
  | jq -r '.data.result[0].value[1]'
0.5454545454545454

$ # same expression with [1h]
0.14
```

That is 54.5% failures in the short window and 14% over the hour. Divided by
the 0.1% budget, the burn rates are about **545x** and **140x** - the "one hour
of pain per four minutes of budget" order of magnitude. The budget-remaining
query is already deeply negative:

```bash
$ # 1 - (error_ratio / 0.001) over 1h
-139.0
```

In words: the month's allowed failures were spent 139 times over by that hour
of fake traffic. The rule was `pending` while the five-minute condition
matured:

```bash
$ curl -s 'localhost:9090/api/v1/rules?type=alert' \
  | jq -r '.data.groups[] | .name as $g | .rules[] | .name as $r | .alerts[]?
           | [$g,$r,.state,(.labels.tenant_id//"-"),(.value|tostring)] | @tsv' \
  | grep -E 'ErrorBudget|ApiHighError'
golden-signals  ApiHighErrorRatio    pending  tenant_initech  1
slo             ErrorBudgetBurnFast  pending  -               6.742424242424242e+02
```

The checkout funnel gives the same story in business terms: 267 failed
checkouts and exactly 267 `request failed` log lines in ten minutes, all with
`error_code=internal_error` and a `TimeoutError` from the gateway. Errors are
not an abstraction; each of those was a customer who could not pay.

One honest note about the local stack: the 1-hour window still contained an
earlier exercise, which is why it reads 14% rather than the 54% of the last
five minutes. In production the long window is 28 days and would be far less
sensitive to one test.

## 5. In a real multi-tenant e-commerce platform

The premium tenant buys 99.95% availability with a response-time objective;
the free tier is promised 99.5%. Those are two different error budgets, so the
same 30 minutes of 5xx is an emergency for one tenant and within budget for the
other. This is why the SLI must carry `tenant_id`, and why a single platform
SLO can hide a tenant being starved.

The error budget also settles arguments. When tenant_initech's declines pushed
the checkout success ratio down, the question was not "is this bad?" but "whose
budget is this spending?" A per-tenant SLO dashboard answers it. The budget is
not a stick for blaming people; it is a pre-agreed trigger for changing the
plan. If the budget is gone, releases pause and the team fixes reliability.
That rule must be agreed before the incident, not invented during it.

For a shop, choose SLIs customers feel: successful checkout, successful
product search, latency of the checkout page. CPU is not an SLI. "Uptime of the
process" is barely one: a process can be up and every payment failing.

## 6. When to use it, when not to

Use an SLO when a service has a user-visible promise and enough traffic for a
ratio to mean something. Below roughly a few hundred requests a day, a single
failure swings the percentage wildly and the budget becomes noise; use simpler
threshold alerts instead. Use burn-rate alerting when you have an on-call
rotation: it pages on the rate of budget consumption, not on one bad minute.

Do not set an SLO of 100%. It is impossible, it leaves no budget to deploy, and
it teaches the team to ignore the number. Do not alert on the SLI itself at a
fixed threshold when the real question is the speed of consumption; "99.8% for
one hour" may be fine, while "99.8% every hour" is an emergency. And do not
copy a 28-day window into a system that retains six hours of data - the query
returns empty and the alert silently never fires.

Cost is mostly human: every SLO needs an owner, a measurement definition and a
policy for exhaustion. That is more work than a threshold, and it is the only
version that survives a real on-call rotation.

## 7. Common mistakes

1. **Using the wrong divisor.** The rule originally shipped with `/ 0.02`
   (a 98% SLO) while its annotation talked about a 99.9% promise. Both numbers
   looked plausible; the alert was 20x less sensitive than the prose claimed.
   The fix is one character and a comment, but only if you do the arithmetic.
2. **Editing a bind-mounted file and expecting Prometheus to notice.** The
   container kept serving the old rule after `POST /-/reload`, because the edit
   replaced the file's inode and the single-file bind mount still pointed at
   the old one. `docker compose up -d --force-recreate prometheus` fixed it.
   Always read the loaded expression back from `/api/v1/rules` after a reload.
3. **An SLI that ignores the customer.** Server-side 200s can hide a frontend
   that never reaches the server, or a payment provider that returns 200 with
   `status: declined`.
4. **Counting 4xx as failures.** A 404 from a bad link is not an availability
   failure; a 503 is. Define "valid requests" explicitly.
5. **No volume floor.** At 04:00, one failed request out of two is 50% and
   burns the budget in minutes. `clamp_min` prevents `NaN`, not nonsense; add
   a minimum-traffic guard as chapter 10a did.
6. **A single window.** A one-minute spike can page; a long window alone is
   slow to react. The `and` of long and short is what makes burn-rate alerts
   usable.
7. **Treating the budget as permission to break things.** The budget exists to
   fund risk, not to excuse it; the policy says what happens when it is gone.

## 8. Try it yourself

Measure the budget cost of a two-minute outage, then check the arithmetic
against the alert.

```bash
# 1. Record the totals, run a short outage, record again.
./scripts/outage.sh 120 timeout tenant_initech
sleep 5

# 2. Total and failed requests over the last 15 minutes.
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=
  sum(increase(shop_http_request_duration_seconds_count[15m]))' \
  | jq -r '.data.result[0].value[1]'
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=
  sum(increase(shop_http_request_duration_seconds_count{status_code=~"5.."}[15m]))' \
  | jq -r '.data.result[0].value[1]'

# 3. Divide failures by total, then by 0.001: that is the burn rate.
```

**Hint:** the script only fails one tenant's checkouts, so platform-wide burn
is lower than the per-tenant burn. Query
`sum by (tenant_id) (...)` to see the difference; a per-tenant SLO is usually
the one that matters. If the alert does not fire, check whether the `for: 5m`
window outlived the outage - a two-minute incident is exactly the case a
five-minute window is meant to ignore.

**Cleanup:** the outage script stops by itself. Confirm the rule returned to
`inactive` or `pending`:

```bash
curl -s 'localhost:9090/api/v1/rules?type=alert' \
  | jq -r '.data.groups[] | .rules[] | select(.name=="ErrorBudgetBurnFast") | .state'
```

## 9. Next

An SLO tells you whether the service is healthy. It does not tell you whether
the process is alive. [11 - Health checks](11-health-checks.md) covers
liveness, readiness and the difference between "running" and "able to serve".
