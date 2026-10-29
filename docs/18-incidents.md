# 18 - Incidents: runbooks, triage and postmortems

Everything so far was preparation. This chapter is the ten minutes after
somebody is woken up, and the hour after the service is back.

## 1. Simple explanation

A fire drill is not the fire. When the alarm goes off, nobody redesigns the
building; they follow the drill: check the alarm is real, see where the smoke
is, get people out, call the brigade, and only later ask how the fire started.

An incident is the same. The goal in the first minutes is not to understand
everything. It is to make the smallest safe change that reduces customer harm,
tell the right people what is happening, and write down the times. Understanding
is the job of the postmortem, with a calm cup of tea and the logs.

## 2. Real name

- **Incident**: an unplanned event that degrades a service enough to matter to
  customers. Severity is about customer impact, not about how interesting the
  bug is.
- **Runbook**: the next commands to type, written before the incident, by
  someone who was not panicking.
- **Triage**: deciding real or not, blast radius, customer impact, recent
  change, dependency.
- **Incident commander (IC)**: the person who coordinates and communicates, not
  necessarily the person typing. On a small team one person can do both, but
  the roles are different and must not be forgotten.
- **Status page / stakeholder update**: short, factual, timestamped. "Checkout
  failing for one tenant since 10:09 UTC; investigating; next update 10:25."
- **Blameless postmortem**: a written timeline and analysis that assumes people
  acted reasonably given the information they had, and looks for system
  changes rather than a person to punish.

## 3. Example

A runbook that is actually usable. This is the shape every alert's `runbook`
annotation should take: a first check, a second check, and a safe action.

```markdown
# Runbook: CheckoutFailureBurst (tenant_id)

1. Confirm it is real, not a single client:
   curl -sG localhost:9090/api/v1/query --data-urlencode \
     'query=sum by (tenant_id) (rate(shop_checkout_outcome_total{outcome="error"}[5m]))'
2. What are customers seeing?
   - Loki: {service_name="shop-api", tenant_id="<id>"} | json | level="error"
   - Tempo: {status=error} | sort desc   (open the longest trace)
3. Which dependency failed?
   - PaymentGatewaySlow / PaymentGatewayTimeouts alert state
   - histogram_quantile(0.95, sum by (le) (rate(shop_payment_provider_duration_seconds_bucket[5m])))
4. Did we just deploy?
   shop_build_info{release=...} and container start times
5. Safe actions, in order of blast radius:
   a. roll back the last release (if release changed)
   b. disable the failing feature flag for that tenant
   c. if the gateway is slow: contact the provider, do not retry harder
6. Communicate: status page update, then every 15 minutes.
```

The same runbook exists as alert annotations in `prometheus/alert_rules.yml`.
An alert without one is incomplete; chapter 10a found eleven and added them.

The postmortem template is deliberately short enough to finish:

```markdown
## Incident: <one sentence, customer impact>
- Severity / duration / detection
- Customer impact: which tenants, how many failed checkouts, money
- Timeline (UTC, one line per fact, from logs and alerts)
- What went well / what went badly
- Root causes (plural; at least one technical, one organisational)
- Action items: what, owner, date, and how we will know it worked
```

## 4. What you should see

A real 90-second timeout exercise, reconstructed from what the stack recorded.
No invented timestamps.

```bash
$ ./scripts/outage.sh 90 timeout tenant_initech
outage: 90s of mode=timeout for tenant_initech
```

A single checkout during the same chaos mode, from the customer's side:

```bash
$ curl -s -o /tmp/chaos.out -w 'status=%{http_code} time=%{time_total}\n' \
  -X POST localhost:8000/api/checkout -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_initech' -H 'x-chaos: timeout' \
  -H 'x-request-id: chap18-timeout-001' -d '...'
status=500 time=2.522047

$ cat /tmp/chaos.out
{"error":{"code":"internal_error","message":"Internal error","request_id":"chap18-timeout-001"}}
```

2.5 seconds is the checkout's own deadline, not the gateway's latency. The log
line and the trace tell different halves of that story:

```bash
$ # Loki, same request id
{"level":"error","msg":"request failed","error_code":"internal_error"}
{"level":"info","msg":"order created"}
```

```bash
$ # Tempo, trace of an error checkout during the outage
shop-api       request handler - /api/checkout   2511ms
shop-api       checkout.in_flight                2511ms
shop-api       payment.charge                    2501ms  STATUS_CODE_ERROR
payment-gateway gateway.charge                   4340ms  STATUS_CODE_OK
payment-gateway POST                              2500ms
```

The parent gave up at 2.5s and returned 500; the child kept working for 4.3s
and would have succeeded. This is a timeout, not a crash: the customer sees a
failure while the provider's work continues. A retry without an idempotency key
would charge twice. That single trace changes the safe action from "retry
harder" to "check idempotency and shorten or lengthen the deadline".

The alert pipeline during the same run: at t+45s every symptom alert was
`pending`, and none had reached the pager yet, because `for:` had not elapsed.
At t+105s the picture was:

```bash
$ curl -s 'localhost:9090/api/v1/rules?type=alert' | jq -r '...'
CheckoutFailureBurst  firing   tenant_initech   page
ApiHighErrorRatio     firing   tenant_initech   page
ApiLatencyP95High     pending  tenant_initech   warn
ApiLatencyP99Severe   pending  -                page
TrafficSurge          pending  tenant_acme      warn
Watchdog              firing   -                none
```

In the same ten minutes Loki counted 267 error lines for tenant_initech, all
`error_code=internal_error`; the sink had not sent an on-call page yet because
the 90-second outage ended before the three-minute `for:` window. That is a
finding for the postmortem, not a failure of the drill: a 90-second incident is
supposed to stay below a three-minute threshold.

## 5. In a real multi-tenant e-commerce platform

The first communication is not "the database is slow". It is:

> 10:12 UTC - Checkout is failing for one merchant (tenant_initech). Other
> merchants are unaffected. We are investigating. Next update 10:27.

That sentence is possible only because `tenant_id` is on the alert, the metric
and the log line. It answers the three questions every stakeholder asks, in
order: is it me, how bad, when will it be fixed. The engineering detail goes in
the incident channel; the status page gets the impact.

Triage order that works under pressure:

1. **Real?** Hit the endpoint from outside the platform. A broken dashboard
   alerting on itself is a different incident.
2. **Blast radius.** One tenant or all four? One route or every route? Check
   `sum by (tenant_id)`, `sum by (route)`.
3. **Money.** Failed checkouts and captured GMV for the last five minutes. A
   latency alert at 03:00 with no traffic is not a SEV1.
4. **Recent change.** `shop_build_info` release, container start times,
   deploy log. Most incidents are changes.
5. **Dependencies.** Payment gateway, Postgres, DNS. The trace's slowest span
   usually names the culprit.
6. **Act small.** Roll back, disable a flag, raise a timeout - in that order of
   blast radius. Do not restart everything to feel productive.
7. **Communicate and write times down as you go.** The timeline cannot be
   reconstructed from memory afterwards, and the logs may have rotated.

The postmortem for this drill would say: detection worked at the rule level,
notification lagged because the `for:` window was longer than the incident;
the customer-facing error was a generic 500 with a request id; the trace showed
the timeout asymmetry; the fake gateway is not idempotent across retries.

## 6. When to use it, when not to

Declare an incident when customers can feel it and it is not resolving itself:
failed payments, checkout unavailable, data loss, security exposure. Use
severity levels tied to impact (SEV1 all tenants cannot pay; SEV2 one large
tenant; SEV3 degraded but workaround exists). When in doubt, declare and
downgrade; a quiet incident channel costs less than a late one.

Do not declare for every page. A single 500 from a synthetic probe, a container
that restarted once and recovered, a warning that self-resolved inside the
`for:` window - these are notes, not incidents. Do not hold a postmortem for a
blameless non-event either; the goal is learning, not ritual.

Cost: an incident consumes the team's attention. Status updates every two
minutes for a 20-minute incident are noise; every 15 minutes, or on a material
change, is enough. A postmortem with twenty action items and no owners is
worse than three with dates.

## 7. Common mistakes

1. **No incident commander.** Everyone debugs, nobody communicates, and the
   status page goes quiet exactly when stakeholders need it.
2. **Debugging before checking blast radius.** Twenty minutes spent in the
   wrong service because nobody asked "is it all tenants?".
3. **A runbook that says "check the dashboard".** Which dashboard, which panel,
   which query? The annotation must be copy-pasteable.
4. **Restarting everything.** It destroys the evidence and often the incident
   comes back. Roll back the change first.
5. **No timestamps.** "Around lunchtime" is not a timeline. The alert's
   `startsAt`, the log's `time` and the trace's start are the record.
6. **Blaming a person.** "Human error" is where the analysis starts, not where
   it ends: which guardrail was missing, which alert was unclear, which default
   made the wrong action easy?
7. **Action items without owners or dates.** They become a wish list. Every
   item needs a name and a verification ("the alert fires in staging within
   5 minutes of the fault").

## 8. Try it yourself

Run a short incident and write the timeline from the data, not from memory.

```bash
# 1. Start the clock.
date -u
./scripts/outage.sh 180 timeout tenant_initech

# 2. While it runs, collect three facts (new terminal):
curl -sG localhost:9090/api/v1/query --data-urlencode \
  'query=sum by (tenant_id) (rate(shop_checkout_outcome_total{outcome="error"}[5m]))' \
  | jq -r '.data.result[] | "\(.metric.tenant_id) \(.value[1])"'
curl -s 'localhost:9090/api/v1/rules?type=alert' \
  | jq -r '.data.groups[] | .rules[] | .alerts[]? | "\(.state) \(.labels.alertname) \(.labels.tenant_id // "-")"'
curl -sG localhost:3101/loki/api/v1/query_range --data-urlencode \
  'query=sum by (error_code) (count_over_time({service_name="shop-api", tenant_id="tenant_initech"} | json | level="error" [5m]))' \
  --data-urlencode "start=$(( ($(date +%s)-300) * 1000000000 ))" \
  | jq -r '.data.result[] | "\(.metric.error_code) \(.values[-1][1])"'

# 3. After it ends, write the postmortem from section 3's template.
```

**Hint:** the most useful line in the timeline is usually the first one that
shows customer impact, not the first alert. Find the earliest `request failed`
line and compare it with the alert's `startsAt`; the gap is your detection
time. If the gap is larger than the `for:` window, look at evaluation, not at
the rule.

**Cleanup:** the script stops by itself. Confirm the incident is over:

```bash
curl -s localhost:9093/api/v2/alerts | jq -c '.[] | {name:.labels.alertname, tenant:(.labels.tenant_id//"-"), state:.status.state}'
```

Only `Watchdog` should remain active; `TrafficCollapse` may linger for another
few minutes because its window is longer than the drill.

## 9. Next

The drill above hit one tenant on purpose. [19 - Multi-tenant observability](19-multi-tenant.md)
is about the structures that make that isolation automatic rather than lucky.
