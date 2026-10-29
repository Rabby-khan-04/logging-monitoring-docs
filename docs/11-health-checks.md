# 11 - Health checks: liveness, readiness, startup, and uptime monitoring

Everything before this chapter measured the service from outside. A health check is the
one signal a service volunteers: a tiny endpoint answering "should I still exist?" and
"may I have traffic?". Mix those two questions up and you build an outage that restarts
itself.

## 1. Simple explanation

Think of a food truck, and three people asking three different questions.

The mechanic asks: "is the engine running at all?" If the driver is asleep at the wheel,
the mechanic takes the truck away and sends a fresh one. That is **liveness**.

The customer asks: "can I order right now?" Maybe the engine is fine but the chef is still
unpacking boxes, or the ice machine is broken. The truck is alive but should not take
orders. That is **readiness**. Nobody fixes readiness by scrapping the truck - and if the
ice machine is broken at the whole depot, restarting every truck just turns a quiet
problem into a loud one.

The owner, on day one, asks: "has the truck even been built yet?" Building takes an hour;
you do not want the mechanic calling it dead at minute two. That is the **startup**
question.

Then a fourth question, which does not come from the truck at all. A neighbour across the
road looks over and says "that truck has not moved in twenty minutes". Because they are
not the truck, they can still notice it is gone. That is **uptime monitoring**, and it is
the only check that survives the thing it checks.

## 2. Real name

| Question | Endpoint here | Who asks it | What failure does |
|---|---|---|---|
| Able to answer at all? | `/healthz` | liveness probe, supervisor | **restart** the process |
| May I serve traffic now? | `/readyz` | readiness probe, load balancer | **remove from rotation**, no restart |
| Still booting? | not present here | `startupProbe` (k8s only) | suspends the other two |
| Are you there, from outside? | Prometheus `up`, synthetic checker | uptime monitor | **page a human**, change nothing |

- **Liveness probe**: "can this process make progress?" Failing it is a *restart*
  decision, so it must have **no dependencies** - your database being down is not a reason
  to kill your own process.
- **Readiness probe**: "is it safe to route a request here right now?" Failing it is a
  *traffic-removal* decision: cheap, reversible, restarts nothing.
- **Startup probe**: a gate that holds off liveness and readiness until boot finishes (warm
  cache, migrations, cold JIT). Kubernetes has `startupProbe`; Docker Compose has no
  equivalent, which is why this stack has no answer to the owner's question.
- **Probe knobs** (k8s): `initialDelaySeconds`, `periodSeconds`, `timeoutSeconds`,
  `failureThreshold`, `successThreshold`. On a readiness probe that touches a dependency,
  `timeoutSeconds` is the setting that saves you.
- **Flapping**: alternating pass/fail, so an instance is added and removed repeatedly.
  Usually a threshold at the edge of normal, or a readiness check that touches something
  slow.
- **Docker `healthcheck:`**: compose's version, with `test` / `interval` / `timeout` /
  `retries`, producing a container status of `starting`, `healthy` or `unhealthy`. In
  compose its real job is to gate `depends_on`.
- **`depends_on: condition: service_healthy`**: "do not create me until the dependency
  reports healthy". Startup ordering, nothing more.
- **`up`**: 1 if the last scrape of a target succeeded, 0 if not. Here `up` *is* the
  liveness signal for all 11 targets, because Prometheus scrapes every service anyway.
- **Uptime / synthetic monitoring**: a prober on another machine, in a different failure
  domain. Necessary because `up == 0` cannot help when the prober is inside the dead system.
- **Dead-man's switch**: an alert that must keep firing to prove the pipeline is alive -
  chapter 10's `Watchdog`. Missing heartbeats are the alarm, so you cannot alert on
  "TargetDown did not fire".

## 3. Example

`app/src/routes/health.ts`: three endpoints, three questions.

```ts
// Liveness: "is this process able to answer at all?" No dependencies here.
// If this fails, the orchestrator restarts the container.
let ready = false;
export function markReady(): void { ready = true; }

healthRouter.get('/healthz', (_req, res) => {
  // No await, no database: two statements. If THIS fails the process is genuinely
  // sick - deadlocked, event loop blocked, OOM thrashing.
  res.json({ status: 'alive', service: 'shop-api' });
});

// Readiness: "can this instance serve real traffic right now?" Includes the
// database, because a pod without a database is a pod that returns 500s.
healthRouter.get('/readyz', async (_req, res) => {
  const db = await checkDatabase();
  const healthy = ready && db.ok;          // warmed up AND dependency OK
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ready' : 'not_ready',
    warmup_complete: ready,
    database: { ok: db.ok, latency_ms: Math.round(db.latencyMs * 100) / 100 },
  });
});

// Deep diagnostics for humans, never used by probes (it can be slow).
healthRouter.get('/healthz/detail', async (_req, res) => {
  const db = await checkDatabase();
  logger.debug({ db }, 'health detail requested');
  res.json({ service: 'shop-api', uptime_seconds: Math.round(process.uptime()),
             database_latency_ms: Math.round(db.latencyMs * 100) / 100,
             memory: process.memoryUsage().rss });
});
```

The dependency check, from `app/src/lib/db.ts` - one `SELECT 1` that can never throw,
because the point is to report and not to fail:

```ts
export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = process.hrtime.bigint();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Number(process.hrtime.bigint() - start) / 1e6 };
  } catch {
    // Still return a number: "down, and it took 2000ms to notice" beats "threw".
    return { ok: false, latencyMs: Number(process.hrtime.bigint() - start) / 1e6 };
  }
}
```

Readiness is a dependency check with a hard budget, not a free pass. The pool it borrows
from is small on purpose (`max: config.dbPoolMax` - 8 per process - and
`connectionTimeoutMillis: 2_000`), so a `SELECT 1` behind a saturated pool waits at most
two seconds and then lands in the `catch` with `ok: false`. That ceiling is this stack's
stand-in for `timeoutSeconds`.

`ready` is false when the process starts and flips in the listen callback
(`app/src/server.ts`) - the earliest moment anything can actually be served:

```ts
const server = app.listen(config.port, () => {
  markReady();                     // only now may /readyz say "ready"
  logger.info({ 'network.port': config.port /* ... */ }, 'shop-api listening');
});
```

Compose is not Kubernetes: there are no `livenessProbe`, `readinessProbe` or `startupProbe`
objects here. What does exist is one `healthcheck:` block in the whole file, and one
`depends_on` that consumes it:

```yaml
  postgres:
    image: postgres:18.6
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shop -d shop"]   # a COMMAND, not an HTTP call
      interval: 5s
      timeout: 3s
      retries: 20            # 20 x 5s = up to 100s of "starting" before unhealthy

  shop-api:
    # no healthcheck: the node:24.22.2-slim image has no curl, so the obvious
    #   test: ["CMD", "curl", "-f", "http://localhost:8000/healthz"]
    # cannot run inside this container. Its liveness signal is the Prometheus scrape.
    depends_on:
      postgres:
        condition: service_healthy   # what the healthcheck above is FOR
```

That gate is ordering at `docker compose up` time only. If postgres dies an hour later,
compose does nothing at all - which is exactly the case `/readyz` exists to report. And the
alert that functions as this stack's uptime monitor (`prometheus/alert_rules.yml`):

```yaml
- alert: TargetDown
  expr: up == 0
  for: 1m
  labels: { severity: page }
  annotations:
    summary: "{{ $labels.service }} stopped answering scrapes"
```

## 4. What you should see

```bash
curl -s -i localhost:8000/healthz
curl -s localhost:8000/readyz
curl -s localhost:8000/healthz/detail
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=count(up == 1)'
docker inspect --format '{{.Name}} {{.State.Health.Status}}' $(docker compose ps -q postgres)
docker inspect --format '{{.Name}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck-defined{{end}} restarted={{.RestartCount}}' $(docker compose ps -q shop-api)
```

`/healthz`: 39 bytes, and `x-request-id` proves it went through the normal pipeline (so it
is traceable when you look for it) while nothing in it waited for anything.

```text
HTTP/1.1 200 OK
x-request-id: 355c6fe6-fab6-4590-88ac-e3f2d4faeaa1
Content-Type: application/json; charset=utf-8
Content-Length: 39
Date: Thu, 29 Oct 2026 08:21:13 GMT

{"status":"alive","service":"shop-api"}
```

`/readyz` a second later, and `/healthz/detail` just after that:

```json
{"status":"ready","warmup_complete":true,"database":{"ok":true,"latency_ms":0.39}}
{"service":"shop-api","uptime_seconds":5578,"database_latency_ms":0.35,"memory":119619584}
```

`latency_ms` is a real measurement of `SELECT 1` through the pool and it moves: 0.39 ms
just now, 21.25 ms when this stack was captured earlier today under load. Both are
"ready". I did **not** exercise the `not_ready` / 503 branch - stopping postgres on a stack
shared by other writers is not mine to do - so read that branch from the code above, not
from an output I did not produce.

Container health, showing the asymmetry in section 3:

```text
/observability-learn-postgres-1 healthy
/observability-learn-shop-api-1 health=no-healthcheck-defined restarted=0
```

`up`, which is honest about which question it answers:

```text
count(up == 1)  -> 11
count(up == 0)  -> []        # an empty result, not a zero: no target is down
```

The health endpoints are deliberately absent from the access logs
(`app/src/middleware/requestContext.ts`):

```ts
autoLogging: {
  ignore: (req) => {
    const url = (req as Request).url ?? '';
    return url.startsWith('/healthz') || url.startsWith('/readyz') || url.startsWith('/metrics');
  },
},
```

Verified in Loki - the three machine-only paths against 30 minutes of real traffic:

```bash
for f in healthz readyz /metrics; do printf '%s -> ' "$f"; curl -sG localhost:3101/loki/api/v1/query \
  --data-urlencode "query=sum(count_over_time({service=\"shop-api\"} |= \"$f\" [30m]))" \
  | jq -c '.data.result[0].value[1] // "no series"'; done
```

```text
healthz -> "no series"
readyz -> "no series"
/metrics -> "no series"
total shop-api lines 30m -> "9221"
```

Three things live in that block. `startsWith`, not `===` - the equality version missed
`/metrics/demo` and logged it every 15 seconds. The rule filters **logs**, not metrics: the
histogram still counts probe traffic, which is why the platform p50 in
[08c](08c-percentiles.md) is a few milliseconds. And `sum by (route)` makes the machine
share visible:

```text
sum by (route) (rate(shop_http_request_duration_seconds_count[30m]))
  /metrics          0.07787114845938374
  /metrics/demo     0.06666666666666667
  /readyz           0.06274741960730652
  /healthz          0.0011204481792717086
sum(rate(shop_http_request_duration_seconds_count[30m]))
  0.9833444739161697
```

About a fifth of counted traffic (0.208 of 0.983 req/s) is scrapes and health checks: the
two scrape jobs run at `scrape_interval: 15s`, and `/metrics/demo` at 0.0667 is 1/15 to the
digit. Machines, not customers. Note too that `/healthz` is `no series` in the logs *and*
0.0011/s in the metrics: a missing log line means the pipeline filtered it, a missing
metric means nobody called it. Do not conflate them at 3am.

`TargetDown` is not hypothetical here. Renaming the compose service `api` to `shop-api`
today knocked targets over twice, and `.artifacts/alerts-sink.txt` holds the webhook
payloads the alert-sink really received:

```json
{"level":"warn","alert.status":"firing","alert.channel":"oncall","alert.count":3,"alerts":[{"name":"TargetDown","severity":"page","tenant_id":null,"state":"firing","startsAt":"2026-10-29T06:20:46.682Z","summary":"cadvisor stopped answering scrapes"},{"name":"TargetDown","severity":"page","tenant_id":null,"state":"firing","startsAt":"2026-10-29T06:20:31.682Z","summary":"grafana stopped answering scrapes"},{"name":"TargetDown","severity":"page","tenant_id":null,"state":"firing","startsAt":"2026-10-29T06:20:46.682Z","summary":"node-exporter stopped answering scrapes"}]}
{"level":"info","alert.status":"resolved","alert.channel":"oncall","alert.count":3,"alerts":[{"name":"TargetDown","severity":"page","tenant_id":null,"state":"resolved","startsAt":"2026-10-29T06:20:46.682Z","summary":"cadvisor stopped answering scrapes"},{"name":"TargetDown","severity":"page","tenant_id":null,"state":"resolved","startsAt":"2026-10-29T06:20:31.682Z","summary":"grafana stopped answering scrapes"},{"name":"TargetDown","severity":"page","tenant_id":null,"state":"resolved","startsAt":"2026-10-29T06:20:46.682Z","summary":"node-exporter stopped answering scrapes"}]}
{"level":"warn","alert.status":"firing","alert.channel":"oncall","alert.count":2,"alerts":[{"name":"TargetDown","severity":"page","tenant_id":null,"state":"firing","startsAt":"2026-10-29T06:28:16.682Z","summary":"shop-api stopped answering scrapes"},{"name":"TargetDown","severity":"page","tenant_id":null,"state":"firing","startsAt":"2026-10-29T06:28:16.682Z","summary":"shop-api stopped answering scrapes"}]}
```

Read the last line twice: two `TargetDown` entries for one `shop-api`, because the two
scrape jobs are two targets - one dead process pages twice unless Alertmanager groups them
([10b](10b-alertmanager-oncall.md)). And the `resolved` line matters as much as the firing
one: a probe that recovers is information.

What this stack does **not** have, plainly: no external uptime monitor. Prometheus,
Alertmanager, the rules and the sink live in the same 13 containers on one laptop. If that
laptop loses power, `up` goes stale rather than zero and `TargetDown` never fires, because
the machine that would fire it is the machine that is down. That single fact is the whole
argument for a second machine, and for chapter 10's `Watchdog` heartbeat that must keep
arriving.

## 5. In a real multi-tenant e-commerce platform

Black Friday, 02:14. `tenant_initech` - the configured noisy neighbour - starts its annual
reconciliation export, using the report query that owns 91.7% of all database time on this
stack. Each export holds a pool connection for a long time; the pool is 8 per process, so
eight concurrent exports empty it, and `connectionTimeoutMillis: 2000` means the ninth
waiter queues for two seconds rather than failing fast.

Now suppose `/readyz` were allowed to borrow a connection the way checkout does. Every
10 seconds, each of six replicas runs `SELECT 1`, which now waits behind initech's export,
times out at 2 s and answers 503. The balancer removes that replica. Inside a minute all
six are out of rotation, and `tenant_acme`, `tenant_globex` and `tenant_umbrella` - who did
nothing wrong and whose requests would have succeeded - get connection refused. Initech
caused a slow export; the readiness probe converted it into a platform-wide outage. Wire
the same endpoint as the *liveness* probe and the orchestrator restarts all six pods at
once, each paying cold-start again against a database that is still busy: a restart storm
triggered by your own health check.

The same shape, four guards:

1. Readiness checks a dependency with a short hard budget - a dedicated pool, or a timeout
   below the probe's `timeoutSeconds` - so "DB is slow" degrades to "one replica leaves
   rotation", never to "all leave at once". Liveness never touches the dependency.
2. Signal the exhaustion before the eviction: `DatabasePoolWaiting`
   (`max by (instance) (shop_db_pool_connections{state="waiting"}) > 2`) is a `page`
   precisely because it fires while customers can still check out. The gauge is collected
   at scrape time, so it costs nothing per request.
3. Cap how much the balancer may remove at once - a real platform refuses to evict more
   than ~20% of replicas on readiness. Without it, readiness is a self-inflicted outage
   with excellent logs.
4. Aggregate for the tenant-facing question. Synthetic `GET /healthz` on each tenant's own
   domain is what tells you `tenant_acme`'s storefront is unreachable while every pod
   claims `ready` - no in-cluster probe can see a broken CDN or a bad DNS record.

## 6. When to use it, when not to

Use `/healthz` for anything that restarts: a supervisor, an image `HEALTHCHECK`, a
Kubernetes liveness probe. Use `/readyz` for anything that routes: a load balancer, an
ingress controller, a service mesh, a deploy that must not receive requests before caches
are warm. Use a startup probe when boot legitimately takes minutes, instead of inflating
`initialDelaySeconds` and creating a window where nothing is checked. Use
`depends_on: condition: service_healthy` for ordering at `up -d`, and know it says nothing
about afterwards.

Not here:

- **No dependencies in a liveness probe.** Ever. That is section 5's outage.
- **Never alert on `/healthz/detail`.** It is for a human in a browser; it does real work
  (a database round trip, a debug log line, memory reads) and its latency is not a symptom.
  The RED histogram already carries the latency alert; a diagnostic endpoint fires during
  the incident *and* every time someone is curious.
- **Do not make a probe a test suite.** Card-network reachability plus cache warmup plus
  queue depth means one of eleven things makes you "not ready", including things that
  should not stop traffic. Two questions, two endpoints.
- **Do not treat a probe as a metric.** Probes answer yes/no; put numbers on `/metrics`
  instead. `shop_db_pool_connections` already does that for pool state, and the default
  collector's `shop_process_start_time_seconds` is a far better restart detector than any
  probe.

**Cost.** Health checks are cheap per call and expensive per second. This service already
serves about 0.078 + 0.067 req/s of scrape traffic alone. Scale it to 40 replicas with a
10-second liveness probe, a 5-second readiness probe and an external checker hitting four
tenants' domains, and machine traffic stops being a rounding error: every probe response is
CPU, a pool checkout if the probe touches the database, and a log line if you forgot the
`ignore` rule. That last one is money - at this stack's 14.26 lines/s, one logged line per
probe per second per replica is the difference between a few KiB and hundreds of MiB a day
for Postgres and API logs (chapter 06b's volume table).

**Noise.** Probes produce the specific noise that wakes people for nothing: flapping. A
probe timeout at the edge of normal (`timeoutSeconds: 1` against a `SELECT 1` measured at
21.25 ms here and 1.5 s during a vacuum) makes an instance alternate ready/not-ready each
cycle, which changes which replica serves which request, which changes latency, which
changes the probe. Symptom: a sawtooth in ready-endpoint count and a page that resolves
itself before anyone reads it. Fix with `for:` on the alert, a generous probe timeout, and
never alerting on a single failed probe response.

## 7. Common mistakes

1. **One endpoint for both questions.** A `/health` that checks the database and is wired to
   liveness: a slow dependency restarts every pod, and the restarts make it slower.
2. **Liveness that only proves the socket is open.** A wedged worker inside a healthy
   listener answers `/healthz` forever. If you have a thread pool, prove you can do work.
3. **503 for "alive but degraded".** Usually leaves the balancer with no backends. Reserve
   readiness for things that genuinely must not be retried here; report the rest as a metric.
4. **No warmup gate.** `markReady()` before the listen callback - or never - gives either
   traffic to an unready process or a readiness probe that lies. The `warmup_complete`
   field exists so "not warmed" and "database down" are distinguishable in one response.
5. **Alerting on the absence of an alert.** If `TargetDown` is your only uptime signal, a
   dead Prometheus produces silence and silence looks like health. Hence `Watchdog`.
6. **A health check that cannot run where it is called.** No curl in this image means a
   `test: ["CMD", "curl", ...]` would sit permanently `unhealthy` and block `depends_on`
   forever. Docker reports that as health, not as "your app is broken": check
   `docker inspect` before blaming the code.
7. **A check heavier than the request it protects.** Readiness running `EXPLAIN`, a count or
   a real query turns every probe cycle into database load, multiplied by every replica you
   add. `SELECT 1` is the whole job.
8. **Assuming compose acts on `unhealthy` after startup.** It does not: `service_healthy`
   gates creation only.
9. **Alerting per instance instead of per service.** Two scrape jobs on one container means
   one crash pages twice (section 4). Group by `service`, or write
   `count by (service) (up == 0)`.
10. **No external check at all.** Your monitoring shares a failure domain with your app.

## 8. Try it yourself

Measure what your probes cost, and confirm the log pipeline drops them.

1. Simulate two probe loops for about a minute - 60 liveness calls, 60 readiness pairs:
   ```bash
   for i in $(seq 1 60); do curl -s -o /dev/null localhost:8000/healthz; sleep 1; done &
   for i in $(seq 1 60); do curl -s -o /dev/null localhost:8000/readyz; \
     curl -s -o /dev/null localhost:8000/readyz; sleep 4; done &
   wait
   ```
2. Answer three questions with queries, not feelings: how many log lines did those 180
   requests produce (`count_over_time({service="shop-api"} |~ "healthz|readyz" [5m])` in
   Loki, see the command in section 4); what rate did they add
   (`sum by (route) (rate(shop_http_request_duration_seconds_count[5m]))`); and did the
   platform median move (`histogram_quantile(0.50, sum by (le)
   (rate(shop_http_request_duration_seconds_bucket[5m])))`).

Hint: one of those three signals will show all 180 requests and one will show none, and the
reason is `autoLogging.ignore`. If you also poll `/healthz/detail` you will see the
opposite of the log side - a diagnostic endpoint logged every cycle, which is exactly the
volume this section warns about.

Cleanup: nothing to delete. The loops exit on their own after ~60 seconds, and the rate and
percentile effects roll out of the 5-minute window - wait five minutes, re-run step 2 and
confirm `/healthz` and `/readyz` are back to their scrape-only baseline.

## 9. Next

Health checks say a process is alive and may take traffic. They do not say a line of code
threw. [12 - Sentry: error tracking](12-sentry.md) covers the signal that catches the
exception itself, and why Loki and Sentry are not each other's duplicate.
