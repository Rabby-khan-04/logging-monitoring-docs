# 10a - Good alerts and bad alerts

The dashboard from chapter 09b tells you what is wrong when you are looking; an
alert tells you when you are not. This chapter is about which alerts deserve to exist.

## 1. Simple explanation

A smoke alarm is a good alarm. It rings when the house is on fire, which is the
thing you must know at three in the morning, and it does not ring when you are
making a cup of tea.

A bad alarm rings for the tea, and one night you unplug it - that is the night
the house burns. An alarm must not say "tell me about a problem"; it must say
"ring only for what I must act on right now, even asleep", and everything else
can wait for a coffee.

The last trick: a good alarm says "someone is failing to pay", not "the CPU is
high" - one tells you a person is hurt, the other only that something is interesting.

## 2. Real name

- **Symptom alert** fires on user-visible failure: errors, refused requests,
  latency above the promise. **Cause alert** fires on an internal condition
  (CPU, memory, queue depth) that may or may not hurt anyone; this repo alerts
  on symptoms, except the two named in section 6.
- **Severity as a routing class**, not a mood: `page` wakes someone, `warn` is
  looked at today, `none` is never read and only proves the pipe is alive.
- **Threshold**: the number the expression is compared against. A good one comes
  from a promise (1% of requests, 500 ms p95), never from a blog post.
- **`for:` clause and the `pending` state**: how long a condition must hold
  before the alert becomes `firing`; while it holds but not yet long enough it
  is `pending`. The cheapest noise filter in Prometheus.
- **Volume guard**: a term requiring enough traffic for a ratio to mean anything
  (`clamp_min(...)`, or a standalone `and sum(...) > 0.2`).
- **Alert fatigue**: people paged mostly for nothing stop trusting pages. A
  reliability problem, not a comfort problem.
- **Dead-man's switch**: an alert that always fires so its absence is the signal.
  `Watchdog` below is one.

## 3. Example

Real lines from `prometheus/alert_rules.yml` (`description:` blocks omitted for
space); the alerts read the recorded series (chapter 08b), so rules come first.

```yaml
  - name: shop-recorded
    interval: 15s
    rules:
      - record: shop:http_request_rate:5m
        expr: sum by (service, tenant_id) (rate(shop_http_request_duration_seconds_count[5m]))
      - record: shop:http_5xx_rate:5m
        expr: sum by (service, tenant_id) (rate(shop_http_request_duration_seconds_count{status_code=~"5.."}[5m]))
      # clamp_min stops a division by zero on a quiet night. Without it the ratio
      # goes NaN and the alert silently never fires: the worst failure mode.
      - record: shop:http_5xx_ratio:5m
        expr: |
          shop:http_5xx_rate:5m / clamp_min(shop:http_request_rate:5m, 0.01)

  - name: golden-signals
    rules:
      - alert: ApiHighErrorRatio
        expr: shop:http_5xx_ratio:5m > 0.01     # threshold: 1%, i.e. a promise
        for: 2m                                # 2 minutes of it, not one blip
        labels:
          severity: page                       # wakes a human
          product: shop
        annotations:
          summary: "{{ $labels.tenant_id }}: more than 1% of requests are 5xx"
          description: >
            {{ $value | humanizePercentage }} of requests on {{ $labels.service }}
            failed for the last 2 minutes.
          runbook: "Loki: {service=\"{{ $labels.service }}\", level=\"error\"} then group by error.code"
```

The `runbook` annotation is not decoration: it is the next command you type.
`CheckoutFailureBurst` is the volume guard - `clamp_min` makes the ratio
computable, the `and sum(...) > 0.2` term makes it worth reading, because without
it one failed checkout at 04:00 pages you:

```yaml
  - name: checkout
    rules:
      - alert: CheckoutFailureBurst
        expr: |
          (
            sum by (tenant_id) (rate(shop_checkout_outcome_total{outcome="error"}[5m]))
            /
            clamp_min(sum by (tenant_id) (rate(shop_checkout_step_total{step="payment_attempted"}[5m])), 0.01)
          ) > 0.05
          and
          sum by (tenant_id) (rate(shop_checkout_step_total{step="payment_attempted"}[5m])) > 0.2
        for: 3m
        labels: { severity: page }
        annotations:
          summary: "{{ $labels.tenant_id }}: more than 5% of checkouts are failing"
```

`TrafficCollapse` exists because a broken front door produces no errors at all,
and `Watchdog` is the heartbeat whose severity keeps it off the pager:

```yaml
      - alert: TrafficCollapse
        expr: |
          shop:http_request_rate:5m / clamp_min(shop:http_request_rate:5m offset 5m, 0.01) < 0.2
        for: 10m
        labels: { severity: warn }
        annotations:
          summary: "Traffic for {{ $labels.tenant_id }} fell below 20% of normal"

      # A dead-man's switch: always firing, so Alertmanager silence proves the
      # pipeline is alive. Route it to a channel nobody reads.
      - alert: Watchdog
        expr: vector(1) > 0
        labels: { severity: none }
        annotations:
          summary: "Heartbeat: alerting pipeline is alive"
          runbook: "If Watchdog has NOT fired in 10m the pipeline is dead: check alertmanager and prometheus containers"
```

## 4. What you should see

I ran `./scripts/outage.sh 90 timeout tenant_initech` ("outage: 90s of
mode=timeout for tenant_initech") and polled the rule API. The conditions were
true but no `for:` window had elapsed, so every symptom alert sat `pending`:

```bash
$ curl -s 'localhost:9090/api/v1/rules?type=alert' | jq -r '.data.groups[] | .name as $g | .rules[] | .name as $r | .alerts[]? | [$g, $r, .state, (.labels.tenant_id // "-"), (.labels.severity // "-"), .activeAt] | @tsv' | column -t -s $'\t'
checkout        CheckoutFailureBurst  pending  tenant_initech   page  2026-10-29T07:20:36.1176826Z
checkout        PaymentGatewaySlow    pending  -                warn  2026-10-29T07:20:21.1176826Z
golden-signals  ApiHighErrorRatio     pending  tenant_initech   page  2026-10-29T07:20:20.418041376Z
golden-signals  ApiHighErrorRatio     pending  tenant_acme      page  2026-10-29T07:20:05.418041376Z
golden-signals  ApiLatencyP95High     pending  tenant_initech   warn  2026-10-29T07:20:20.418041376Z
golden-signals  ApiLatencyP99Severe   pending  -                page  2026-10-29T07:20:20.418041376Z
golden-signals  TrafficSurge          pending  tenant_globex    warn  2026-10-29T07:18:50.418041376Z
slo             Watchdog              firing   -                none  2026-10-29T06:19:24.891769673Z
```

`Watchdog` is firing and always will be; that is the point. Ninety seconds later,
the same query with `.value`:

```bash
$ curl -s 'localhost:9090/api/v1/rules?type=alert' | jq -r '.data.groups[] | .name as $g | .rules[] | .name as $r | .alerts[]? | [$g,$r,(.labels.severity//"-"),(.labels.tenant_id//"-"),.state,.value//"-"] | @tsv' | column -t -s $'\t'
checkout        CheckoutFailureBurst  page  tenant_initech  firing   9.777777777777777e-01
checkout        PaymentGatewaySlow    warn  -               pending  4.85e+00
golden-signals  ApiHighErrorRatio     page  tenant_initech  firing   9.565217391304348e-01
golden-signals  ApiLatencyP95High     warn  tenant_initech  pending  4.869318181818182e+00
golden-signals  ApiLatencyP99Severe   page  -               pending  4.948672855050505e+00
golden-signals  TrafficSurge          warn  tenant_acme     pending  9.777777777777779e+00
golden-signals  TrafficSurge          warn  tenant_initech  pending  3.3253012048192767e+00
slo             Watchdog              none  -               firing   1e+00
```

97.8% of tenant_initech's checkouts and 95.7% of its requests were failing, the
correct shape for timeout chaos, and the `value` column is why `{{ $value }}`
belongs in a description. Both alerts became real notifications in the sink:

```bash
$ docker compose logs --since 5m alert-sink
alert-sink-1  | {"level":"warn","alert.status":"firing","alert.channel":"oncall","alert.count":1,"alerts":[{"name":"ApiHighErrorRatio","severity":"page","tenant_id":"tenant_initech","state":"firing","startsAt":"2026-10-29T07:22:20.418Z","summary":"tenant_initech: more than 1% of requests are 5xx"}]}
alert-sink-1  | {"level":"warn","alert.status":"firing","alert.channel":"oncall","alert.count":1,"alerts":[{"name":"CheckoutFailureBurst","severity":"page","tenant_id":"tenant_initech","state":"firing","startsAt":"2026-10-29T07:23:36.117Z","summary":"tenant_initech: more than 5% of checkouts are failing"}]}
```

The same command minutes later showed the event you never configure:
`"alert.status":"resolved"`. And all 15 alert rules now carry a runbook:

```bash
$ curl -s 'localhost:9090/api/v1/rules?type=alert' | jq '[.data.groups[].rules[] | select(.annotations.runbook != null)] | length'
15
```

## 5. In a real multi-tenant e-commerce platform

tenant_initech is our noisy neighbour: 25% declined payments, +260 ms at the
gateway. The `sum by (tenant_id)` in each rule stops one shop's outage becoming
a platform outage: `CheckoutFailureBurst` fired for tenant_initech alone and
named the tenant in the summary, so the triage question - "is this everyone or
just them?" - was answered before anyone opened a dashboard.

The honest part: at 07:28:05 the sink logged `ApiHighErrorRatio` **firing for
tenant_acme**, then resolving itself. The app's own test route caused it:

```bash
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum by (route, status_code) (increase(shop_http_request_duration_seconds_count{tenant_id="tenant_acme", status_code=~"5.."}[1h]))' | jq -r '.data.result[] | select((.value[1]|tonumber) > 0) | "\(.metric.route) \(.metric.status_code)  \(.value[1])"'
/api/boom 500  5.053716931216932
```

`/api/boom` exists to return 500. Someone poked it, tenant_acme crossed 1% of a
small volume, and the pipeline fired perfectly on a signal that meant nothing.

## 6. When to use it, when not to

Page on a symptom a customer can feel, that does not heal inside your `for:`
window, and where a human action shortens the outage. Everything else is a
ticket, a dashboard or a log query. Budget pages like money: past roughly two
real pages a night people start bargaining with the alarm and the dismissal rate
stays climbed - the cost is missed incidents, not comfort. Compute is cheap:
`evaluation_interval: 15s` runs these 18 rules four times a minute.

Two rules I would demote, from watching them mislead me today. `TrafficSurge`
went `pending` for all four tenants at once with values of 9.5x, 8.4x, 43.5x and
124.9x while the outage ran: `outage.sh` itself hammers one tenant, so the
"surge" described the incident generator, not customers. During
`./scripts/loadgen.sh 60 12` it was `pending` again at 22.1x and 24.2x for
tenants whose traffic had merely restarted. Neither page teaches me anything at
3am, so it belongs on a dashboard. `SeriesCountHigh` is a capacity warning about
Prometheus, not a product on-call page. The two deliberate exceptions to
"symptoms only" stay: `TargetDown` (a dead process means the symptom data does
not exist) and `Watchdog` (no action ever; it makes silence interpretable).

## 7. Common mistakes

1. **An alert with no runbook line.** Auditing this file found
   `PaymentGatewaySlow`, `TargetDown`, `Watchdog` and `ErrorBudgetBurnFast`
   without one; I added the 11 missing runbooks and reloaded. `promtool check
   rules` said `SUCCESS: 18 rules found` either way - it validates syntax, not
   usefulness. An alert without a runbook is a page you have not finished.
2. **A ratio with no volume guard.** Only the `and` clause prevents nonsense;
   `clamp_min` merely prevents `NaN`.
3. **Counting the wrong requests.** The `/api/boom` story in section 5.
4. **No `for:` clause.** Every scrape hiccup becomes a page; `for:` is what made
   those `pending` rows above worth having.
5. **Alerting on a cause** ("CPU above 80%"). If CPU is high and nobody is
   failing, the right action is a note, not a wake-up.
6. **A copied threshold, or absolute counts.** "500 ms" pasted onto a service
   whose p50 is already 900 ms is permanently on, and count thresholds break
   whenever traffic grows - and it grows in August.
7. **Paging on `warn`.** Severity is a routing decision (10b). If everything
   pages, nothing does.

## 8. Try it yourself

Create a symptom and watch the pipeline separate a blip from an incident.

```bash
./scripts/outage.sh 60 timeout tenant_initech        # ~1 minute of fake timeouts
# in another terminal, poll the rule API for two minutes and note the states
for i in $(seq 1 12); do
  curl -s 'localhost:9090/api/v1/rules?type=alert' \
    | jq -r '.data.groups[].rules[] | .name as $r | .alerts[]? | "\(.state)  \($r)  \(.labels.tenant_id // "-")  \(.value // "-")"'
  echo ---; sleep 10
done
```

**Hint:** the outage lasts 60 seconds, but `ApiLatencyP95High` needs `for: 5m`
and `CheckoutFailureBurst` needs 3 minutes, so which alerts reach `firing`
depends on how long the 5 m window keeps seeing failures after the script stops.
Watch `Watchdog` stay `firing` in `curl -s localhost:9093/api/v2/alerts`: if it
ever vanishes, the pipeline - not the shop - is your incident.

**Cleanup, restoring the machine:** stop the script and everything unwinds
itself. Confirm with
`curl -s localhost:9093/api/v2/alerts | jq -c '.[] | {name:.labels.alertname, tenant:.labels.tenant_id, state:.status.state}'`.
You want only `{"name":"Watchdog","tenant":null,"state":"active"}` left. If
another traffic script is still running you may see `TrafficSurge` pending: that
is section 6's noise problem, not a mistake you made.

## 9. Next

Ten alerts firing at once is not ten incidents. [10b - Alertmanager routing and
on-call](10b-alertmanager-oncall.md) covers grouping, inhibition and silences.
