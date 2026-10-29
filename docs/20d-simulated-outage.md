# 20d - Simulated outage, investigated

This is the exam. A page arrives, and the only tools allowed are the ones built
in the previous chapters. The fault is fake and local, the investigation is
real: every number below came out of this stack during one six-minute run.

## 1. Simple explanation

A smoke alarm goes off in an office. You do not start by reading the wiring
diagram of the whole building. You check which floor, whether there is actual
smoke, whether anyone is inside, and whether the fire door is open. Only then do
you look for the cause.

An outage investigation is that sequence. First impact, then blast radius, then
the failing dependency, then the cause. The order matters more than the speed.

## 2. Real name

- **Detection**: the alert that told you, and how long after the first customer
  failure it fired.
- **Blast radius**: which tenants, routes and dependencies are affected.
- **Symptom vs cause**: the 500s are the symptom; the gateway timeout is the
  cause; the chaos header is the trigger.
- **Mitigation**: the smallest change that stops customer harm (disable the
  fault, roll back, fail over). Not the same as the fix.
- **Root cause**: the condition that made the failure possible, including the
  missing guardrail.
- **Timeline**: UTC timestamps from alerts, logs, traces and the script, not
  from memory.

## 3. Example

The run, exactly as executed:

```bash
./scripts/outage.sh 360 timeout tenant_initech
```

The script sends three checkouts per second with `x-tenant-id: tenant_initech`
and `x-chaos: timeout`, plus healthy traffic for tenant_acme. The app's chaos
header makes the fake gateway delay past the checkout's 2.5-second deadline.
Nothing is installed, nothing outside the project is touched, and stopping the
script ends the fault.

The investigation order, as commands:

```bash
# 1. Is it real, and who is affected? (metrics, 5m)
sum by (tenant_id) (rate(shop_checkout_outcome_total{outcome="error"}[5m]))
/
clamp_min(sum by (tenant_id) (rate(shop_checkout_step_total{step="payment_attempted"}[5m])), 0.01)

# 2. What are customers seeing? (logs)
{service_name="shop-api", tenant_id="tenant_initech"} | json | level="error"

# 3. Where did the time go? (traces)
#    Tempo search: {status=error} | sort desc, open the longest trace

# 4. Which dependency?
histogram_quantile(0.95,
  sum by (le, outcome) (rate(shop_payment_provider_duration_seconds_bucket[5m])))

# 5. Did anything else change? (containers, deploy)
changes(container_start_time_seconds{name=~"observability-learn-.*"}[1h])
```

## 4. What you should see

The timeline, from the alert sink and the script's own start/stop lines:

```text
10:17:40  outage.sh starts 360s of mode=timeout for tenant_initech
10:19:50  ApiHighErrorRatio firing        tenant_initech  page
10:20:36  CheckoutFailureBurst firing     tenant_initech  page
10:22:35  ApiLatencyP99Severe firing      -               page
10:22:35  ApiLatencyP95High firing        tenant_initech  warn
10:22:36  PaymentGatewaySlow firing       -               warn
10:22:39  ErrorBudgetBurnFast firing      -               page
10:23:40  outage.sh stops; alerts resolve on their own
```

The sink's own lines, shortened to the fields that matter:

```bash
$ docker compose logs --since 15m alert-sink | grep '"channel":"oncall"'
{"alert.status":"firing","alert.channel":"oncall","alerts":[{"name":"ApiHighErrorRatio","severity":"page","tenant_id":"tenant_initech","startsAt":"2026-10-29T10:19:50.418Z","summary":"tenant_initech: more than 1% of requests are 5xx"}]}
{"alert.status":"firing","alert.channel":"oncall","alerts":[{"name":"CheckoutFailureBurst","severity":"page","tenant_id":"tenant_initech","startsAt":"2026-10-29T10:20:36.117Z","summary":"tenant_initech: more than 5% of checkouts are failing"}]}
{"alert.status":"firing","alert.channel":"oncall","alerts":[{"name":"ApiLatencyP99Severe","severity":"page","tenant_id":null,"startsAt":"2026-10-29T10:22:35.418Z","summary":"p99 latency above 2s"}]}
{"alert.status":"firing","alert.channel":"oncall","alerts":[{"name":"ErrorBudgetBurnFast","severity":"page","tenant_id":null,"startsAt":"2026-10-29T10:22:39.891Z","summary":"SLO burn rate above 14.4x (2% budget in one hour)"}]}
```

Detection was not instant, and that is correct: the error alert needed two
minutes of sustained failure, checkout failure three, the latency alerts five.
A responder reading only the first page sees an error problem; the full set
says it is also a latency problem at the payment gateway.

The blast radius is one tenant. At the end of the run:

```bash
$ # checkout error ratio per tenant, 15m
tenant_initech   0.978
tenant_acme      0
tenant_globex    0
```

```bash
$ # outcomes for tenant_initech, 15m
captured   26.312
declined    7.084
error    1215.423
```

97.8% of that tenant's checkouts failed while the other three stayed at zero.
That single sentence is the status page: "one merchant, checkout failing,
others unaffected".

Logs confirm the failure mode and give the correlation id:

```bash
$ ./scripts/... (Loki query, last 10m)
internal_error  1062

$ # one line
{"time":"2026-10-29T10:23:19.196Z","request_id":"546bff7d-1f44-48e0-bac3-ad97195bc9e6",
 "trace_id":"d359e2f56a2187e8ddb4e2c93df71914","error_code":"internal_error",
 "error_name":"TimeoutError","route":"/api/checkout","msg":"request failed"}
```

The trace for an error request shows where the time went:

```bash
$ curl -s localhost:3201/api/v2/traces/1158db5c77eac7a6922735eebcdd08b | ...
shop-api        checkout.price_basket    1ms   STATUS_CODE_OK
shop-api        payment.charge           2500ms STATUS_CODE_ERROR
shop-api        checkout.in_flight       2507ms
shop-api        request handler - /api/checkout  2507ms
payment-gateway POST                     2499ms
```

The database spans are 1-3 ms, so this is not the database. The gateway p95
tells the same story at population scale:

```bash
$ # p95 of the payment provider, by outcome, 15m
outcome=error     4.85 s
outcome=captured  0.445 s
outcome=declined  0.488 s
```

Errors take ten times longer than successes. The app's deadline is 2.5 s, so
the caller cancels and returns 500; the provider is still working when the
parent span ends. The cause is upstream slowness, made visible by the trace and
the dependency histogram; the trigger is the `x-chaos: timeout` header from the
fake script.

Two findings belong in the postmortem rather than in the immediate fix:

1. The app returns a generic `internal_error` for a timeout. A distinct code
   (`upstream_timeout`) would let the alert and the runbook skip a step.
2. `ErrorBudgetBurnFast` is platform-wide and fired only when enough of the
   platform was failing. For one tenant at 98%, that took the whole outage to
   accumulate; a per-tenant SLO would have burned visibly sooner.

## 5. In a real multi-tenant e-commerce platform

The mitigation differs by cause, and the trace decides it:

- **Provider slow, our deadline too tight for its current latency:** fail fast
  is already happening (2.5 s). The question is whether to queue the order and
  retry later with the same idempotency key, or to extend the deadline and
  accept slower checkout. Extending silently would move the failure into the
  customer's browser.
- **Provider down:** stop retrying in a tight loop. `PaymentGatewayTimeouts`
  exists so the retry storm does not become a second incident.
- **Our bug:** roll back the release; the container start times and
  `shop_build_info` release answer "did we deploy?" in one query.

Communication follows the blast radius: one merchant gets a support message
and a status-page note; all merchants get an incident and a commander. The
request id from the customer's error is what support uses to confirm their
order, and the `order_id` is what finance uses to reconcile a charge that may
have succeeded after the customer saw a failure. That is the most dangerous
case in this whole chapter: the gateway finished at 4.3 s, after our timeout.
A retry without idempotency would charge twice.

## 6. When to use it, when not to

Use this drill to practise detection, triage and communication; it is safe,
repeatable and leaves no state. Use the real version when a dependency
degrades and you need to decide between failing fast, queueing and rolling
back.

Do not investigate a page for a test route (`/api/boom`) as if it were a
customer incident. Do not run a chaos script during someone else's demo, and do
not leave one running: the alerts will keep firing for the `for:` window after
it stops, and the next person will think the problem is real.

Cost: the drill produces thousands of log lines and a few hundred traces in
minutes. That is the point - it exercises retention and cardinality too - but
on a metered backend it is also a bill. The local stack has retention limits
for exactly this reason.

## 7. Common mistakes

1. **Starting with the cause.** Opening Postgres because "it is usually the
   database" wastes the first five minutes; the blast-radius query took one.
2. **Ignoring the pending state.** At t+45 s every rule was `pending`; a
   responder who refreshes once and sees "no firing alerts" concludes wrongly.
3. **Reading the parent span only.** The parent says 2.5 s; the provider took
   4.85 s at p95. The deadline is the story.
4. **Retrying without idempotency.** The failure was a timeout, not a refusal;
   the charge may have succeeded. The idempotency key is not optional.
5. **Restarting the gateway or the app.** It clears evidence and does not fix
   an upstream delay; it can also drop the in-memory idempotency cache.
6. **A status update with no tenant.** "Checkout is failing" panics all four
   merchants; "checkout is failing for tenant_initech" is actionable.
7. **Closing without a timeline.** The alert startsAt values are the only
   reliable clock; memory will compress a six-minute outage into "a while".

## 8. Try it yourself

Run a different fault and investigate it with the same order.

```bash
# Error mode: the gateway returns a hard failure instead of timing out.
./scripts/outage.sh 240 error tenant_globex

# While it runs, answer these in order:
# 1. blast radius: sum by (tenant_id) (rate(shop_checkout_outcome_total{outcome="error"}[5m]))
# 2. logs: {tenant_id="tenant_globex"} | json | level="error"
# 3. trace: Tempo {status=error}, open the longest
# 4. dependency: payment provider p95 by outcome
```

**Hint:** `error` mode fails fast, so latency alerts may stay quiet while the
error alerts fire; `slow` mode does the opposite. The shape of the alerts is a
fingerprint of the fault. Compare the `startsAt` of `CheckoutFailureBurst` with
the first error log line to measure detection time.

**Cleanup:** the script stops after the duration. Confirm nothing is left
firing for the wrong reason:

```bash
curl -s localhost:9093/api/v2/alerts \
  | jq -c '.[] | {name:.labels.alertname, tenant:(.labels.tenant_id//"-"), state:.status.state}'
```

Wait for the `for:` windows to expire; `Watchdog` is the only alert that
should remain active.

## 9. Next

The investigation is over; the lessons are not. [20e - What each signal gets
wrong](20e-pitfalls.md) collects the ways this evidence could have misled you.
