# 20e - What each signal gets wrong on its own

Logs, metrics, traces and alerts are witnesses, not judges. Each one can be
truthful and still mislead you: missing, aggregated, sampled or simply measuring
the wrong thing. This chapter collects the failure modes this stack actually
demonstrated, so you can recognise them under pressure.

## 1. Simple explanation

Three people watch a football match. One listens on the radio, one watches the
scoreboard, one follows a friend's live text. The radio goes silent during a
goal, the scoreboard updates a minute late, and the text is only sent for
exciting moments. All three are honest. None is the match.

You need all three, and you need to know how each one fails, or you will argue
about the score while the game is still running.

## 2. Real name

- **Observability blind spot**: a failure mode that produces no signal, or a
  signal that looks healthy.
- **Aggregation trap**: a summary that hides the distribution (mean, global
  ratio, average latency).
- **Sampling bias**: traces are often sampled, so rare errors may be absent
  from the sample.
- **Window mismatch**: the same system measured over 1m, 5m and 1h gives three
  different stories; an alert's `for:` and the query window are part of its
  meaning.
- **Cardinality and label traps**: two labels holding the same value, or a
  high-cardinality label that makes the metric unusable.
- **Instrumentation gap**: work that happens without a span, a log line or a
  metric; it is invisible by construction.
- **False positive / false negative**: an alert for a non-problem / no alert
  for a real problem. The second is worse.

## 3. Example

A checklist to run against any new signal. Each item is a question, and each
question has bitten this stack.

```text
Logs
  [ ] Does every error path log exactly once, with request_id and tenant_id?
  [ ] Is the field structured, or is the message a sentence a human must parse?
  [ ] What is the level? Is `debug` off in production, and did that remove
      the only evidence?
  [ ] What happens if Loki is down? The app still works; the evidence does not.
  [ ] Is the line small enough to read, or does it dump an entire result set?

Metrics
  [ ] What label did I aggregate away? tenant_id is the usual victim.
  [ ] Is the window long enough to contain traffic?
  [ ] Can the value be NaN, and what does the dashboard do with NaN?
  [ ] Does a counter reset on deploy, and did I use rate()/increase()?
  [ ] Is the metric cardinality bounded?

Traces
  [ ] Is this trace sampled, and at what rate?
  [ ] Are there spans for the slow dependency, or only for HTTP?
  [ ] Do parent and child timings agree? (Timeouts make them disagree.)
  [ ] Do span names identify the operation, or just the HTTP method?

Alerts
  [ ] Is the condition big enough and long enough (`for:`)?
  [ ] Is synthetic traffic included?
  [ ] Is it grouped and routed, or does it page everyone?
  [ ] If it stops working, who notices? (Watchdog.)
```

The point is not to answer "yes" to everything; it is to know which "no" you
are living with before an incident, not during one.

## 4. What you should see

The lies this stack told, with the commands that exposed them.

**A too-short window reads as an outage.** After traffic stopped, the same
metric said 0 over five minutes and 6.3 over ten:

```bash
$ # shortly after the load generator stopped
sum(rate(shop_checkout_step_total[5m]))   -> 0
sum(rate(shop_checkout_step_total[10m]))  -> 6.30
```

Zero is not "the shop is down"; it is "no requests in this window". Check
traffic before you check errors.

**A quantile with no samples is NaN, not zero.** On a quiet tenant:

```bash
$ # p95 latency for two tenants, one idle
tenant_globex  0.02275
tenant_acme    NaN
```

A dashboard that renders `NaN` as 0 says the idle tenant is infinitely fast; a
dashboard that renders it as "no data" is honest. The `clamp_min` in the ratio
alerts exists for the same reason.

**A test route page.** `/api/boom` produced five real 500s, tenant_acme crossed
1%, and `ApiHighErrorRatio` fired while no customer was affected:

```bash
$ /api/boom 500 5.053716931216932
```

The metric was correct. The meaning was wrong. Exclude synthetic routes or add
a volume guard (chapter 20c).

**A timeout makes parent and child disagree.** The parent span ends when the
client gives up; the child keeps working:

```bash
shop-api        checkout.in_flight   2511ms
shop-api        payment.charge       2501ms  STATUS_CODE_ERROR
payment-gateway gateway.charge       4340ms  STATUS_CODE_OK
```

If you read only the parent, the gateway "took 2.5s". It did not; it took 4.3s
and the caller stopped listening. Retrying without idempotency would charge the
customer twice.

**The same label twice.** Alloy gives every stream both `service` and
`service_name`, because two components set them. Queries that pick one miss
half the data after a pipeline change; chapter 06a documents the attempts to
remove one and why they failed.

**An error line that is technically complete and practically unreadable.** The
timeout error serialised the browser `DOMException`, including every numeric
enum constant:

```bash
{"err":{"type":"DOMException","message":"The operation was aborted due to timeout",
 "code":23,"INDEX_SIZE_ERR":1,"DOMSTRING_SIZE_ERR":2, ... "DATA_CLONE_ERR":25},
 "error.code":"internal_error","msg":"request failed"}
```

The important facts (`TimeoutError`, `internal_error`, the route) are there,
buried in 4 KB of constants. Structured logging guarantees fields; it does not
guarantee that someone chose the right ones.

**A dead target explains every other missing signal.** When shop-api stopped
answering scrapes, `TargetDown` was the only alert that meant anything; error
ratio and latency alerts had no fresh data to evaluate. An observability stack
that monitors only the application cannot distinguish "healthy" from "not
reporting".

## 5. In a real multi-tenant e-commerce platform

The multi-tenant version of every trap is the same: **one tenant hides inside
an aggregate**. A platform-wide p95 of 392 ms looked fine while tenant_initech
sat at 477 ms and checkpoint failures were 89% for that tenant alone. A global
error ratio under 1% can still mean one merchant cannot sell.

The second version is **one bad signal hides the others**. During the outage,
the hardest failure produced no errors at all for customers who could not
reach the site (TrafficCollapse), and the noisiest failure produced 500s for
a test route (`/api/boom`). Neither is visible in the other's dashboard.

The professional habit is to state the doubt out loud in the incident channel:
"the error ratio is zero, but traffic also went to zero, so I do not trust it
yet", "the trace is sampled at 10%, so absence here is weak evidence". That
sentence is worth more than another dashboard.

Mitigations also have blind spots. Rolling back fixes the symptom and destroys
the evidence; restarting a container clears the counters and the logs in the
container itself. Capture the trace id and a `docker inspect` before you
restart, or accept that the postmortem will be thinner.

## 6. When to use it, when not to

Use this checklist when adding a signal, when an alert behaves strangely, and
when two tools disagree. The disagreement is the most valuable observation you
will get; do not average it away.

Do not turn every caveat into a new dashboard. The response to "aggregation
hides tenants" is a `by (tenant_id)` query, not ten new panels. The response to
"sampling hides rare errors" is to sample the tail or log the error, not to
trace 100% of traffic.

Do not use "the metric is noisy" as a reason to delete it. Investigate once;
either the metric is wrong (fix the instrumentation), the threshold is wrong
(fix the query), or the signal is real and the alert should exist (fix the
policy). Deleting it removes the witness.

Cost: each additional dimension multiplies series; each longer window multiplies
query cost; each extra panel multiplies attention. The cheapest observability
improvement is usually deleting a misleading signal, not adding another one.

## 7. Common mistakes

1. **Trusting one tool.** Starting in Loki because it is familiar, and missing
   that the gateway, not the app, is slow.
2. **Reading a five-minute window after traffic stopped.** Zero requests looks
   like zero errors; check `rate(total)` first.
3. **Rendering NaN as zero.** It turns "no data" into "perfectly healthy".
4. **Believing a parent span's duration.** The child may outlive the deadline;
   the timeout is the story.
5. **Forgetting instrumentation gaps.** An uninstrumented background job or
   queue consumer is invisible; no error in Loki does not mean no failure.
6. **Restarting before capturing.** Counters reset, containers lose local logs,
   and the trace ids in memory disappear. Copy the evidence first.
7. **Alerting on the wrong traffic.** Synthetic routes, health checks and
   scraper requests are not customers; exclude them or they will page you
   during a deploy.

## 8. Try it yourself

Make two signals disagree and explain why, without changing the application.

```bash
# 1. A real error on a test route.
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-tenant-id: tenant_acme' localhost:8000/api/boom

# 2. The error ratio and the business outcome, last 5 minutes.
curl -sG localhost:9090/api/v1/query --data-urlencode \
  'query=shop:http_5xx_ratio:5m{tenant_id="tenant_acme"}' | jq -r '.data.result[].value[1]'
curl -sG localhost:9090/api/v1/query --data-urlencode \
  'query=sum by (outcome) (increase(shop_checkout_outcome_total{tenant_id="tenant_acme"}[5m]))' \
  | jq -r '.data.result[] | "\(.metric.outcome) \(.value[1])"'

# 3. The trace for the request, if you kept the response headers:
#    curl -s localhost:3201/api/search?q=%7Bstatus%3Derror%7D
```

**Hint:** the error ratio moves, the checkout outcomes may not move at all,
because `/api/boom` is not a checkout. That disagreement is the lesson: a
signal is only meaningful next to the question it is supposed to answer. If
you want a second disagreement, stop shop-api for a minute and compare the
error ratio (stale, not zero) with `up == 0` and the missing logs.

**Cleanup:** `/api/boom` is fake and self-clearing. If you stopped shop-api:

```bash
docker compose start shop-api
curl -s localhost:8000/healthz
```

## 9. Next

The capstone closes with the reference material: [21 - Checklists](21-checklists.md)
and [22 - Glossary and sources](22-glossary-sources.md).
