# 21 - Checklists

A checklist is how a good decision survives a bad night. These are the ones
this course builds up to, written so that each item can be answered yes or no
about a real system, not admired.

Use them for reviews, for onboarding, and for the ten minutes before you trust
a new service in production.

## 1. Simple explanation

A pilot does not decide from memory whether the landing gear is down. She reads
the checklist, out loud, even after twenty years. Not because she forgot, but
because being tired, rushed or interrupted is normal, and the checklist is what
makes normal safe.

Observability needs the same: a short list you can run against a service before
an incident, and against an incident after it.

## 2. Real name

- **Definition of done** for instrumentation: the conditions under which a
  service is considered observable at all.
- **Audit**: running a checklist against the running system and recording the
  gaps, rather than assuming.
- **Runbook item**: a checklist entry that is a command, not an opinion.
- **Exception**: a deliberate "no" with an owner and a reason; every unchecked
  box is either a task or an accepted risk, never silence.

## 3. Example

### Logging

- [ ] One JSON object per line on stdout; no multi-line stack traces outside
      the `err` field.
- [ ] Levels are meaningful: `error` for failed requests, `warn` for something
      a human should read today, `info` for lifecycle events.
- [ ] Every request logs exactly once on completion, and error paths do not
      log the same failure twice (chapter 05b).
- [ ] `request_id` and `tenant_id` are on every request-scoped line.
- [ ] No secrets, tokens, card data, emails or addresses in any line (chapter
      03a); redaction is tested, not assumed.
- [ ] Log volume per tenant is known, and the noisiest tenant is not the
      majority of the bill by accident.
- [ ] Scrape and health endpoints are excluded from access logs.

### Privacy and retention

- [ ] Data minimisation: the log line contains what you need to debug, not the
      whole request.
- [ ] Identifier values are hashed with a keyed hash, not a plain digest.
- [ ] Retention is configured and tested (chapter 06b), including the Loki
      per-stream overrides.
- [ ] Deletion works, or its failure is documented; the delete API here returns
      404 and that is written down rather than assumed.
- [ ] Logs are not the system of record for money or identity; the database is.

### Correlation

- [ ] Incoming `x-request-id` is validated and reused; otherwise a new one is
      minted.
- [ ] `trace_id`/`span_id` appear on log lines when a span is active.
- [ ] The trace context survives every service hop, including queues
      (chapter 13b).
- [ ] A request id from a customer support ticket finds the log line, the
      trace, the metric, and the database row.

### Errors

- [ ] Errors have a stable code, a human message, and a stack where useful.
- [ ] Client errors (4xx) are not counted as availability failures.
- [ ] A failed request returns a correlation id to the caller.
- [ ] The error handler logs once and the access log does not duplicate it.
- [ ] Unhandled rejections and process-level errors are logged before exit.

### Log aggregation (Loki)

- [ ] Labels are bounded: service, tenant, level; not `path`, `user_id`,
      `order_id`.
- [ ] The pipeline is checked on recent data only; old streams are frozen
      (chapter 06a).
- [ ] A query for one tenant returns only that tenant's lines.
- [ ] Retention/compaction is running and the volume is not growing without a
      bound.
- [ ] The observability pipeline itself has a health signal (Alloy, Loki up).

### Metrics

- [ ] Counters end in `_total`, gauges are things that go up and down,
      histograms are used for latency.
- [ ] No unbounded label values; the cardinality demo is quarantined in a
      separate registry.
- [ ] Every metric is used by a dashboard or an alert, or it is deleted.
- [ ] Metric names on the wire match the names in the docs (prefix included).
- [ ] Counter resets after deploys are handled with `rate`/`increase`.

### Prometheus

- [ ] Every target has an owner and a `TargetDown` path.
- [ ] Scrape interval and evaluation interval agree with the `for:` windows.
- [ ] Recording rules exist for expensive queries used by dashboards/alerts.
- [ ] `promtool check rules` passes in CI.
- [ ] Retention is explicit; long-window alerts do not exceed it.

### Grafana

- [ ] Units on every axis; seconds are seconds.
- [ ] Percentiles, not averages, for latency.
- [ ] `NaN`/no-data is visible and not rendered as zero.
- [ ] Variables cascade (tenant -> route).
- [ ] The dashboard is provisioned as code, not hand-edited on the server.
- [ ] Annotations mark deploys and incidents.

### Alerting

- [ ] Every alert is a symptom a customer can feel, or an explicitly justified
      cause (`TargetDown`, `Watchdog`).
- [ ] Every rule has `for:` and a runbook annotation with a real query.
- [ ] Ratios have `clamp_min` and, where traffic is low, a volume guard.
- [ ] Synthetic/test routes are excluded from customer SLIs.
- [ ] Routing splits `page`, `warn`, `none`; grouping includes `tenant_id`.
- [ ] Inhibition covers the known causal pairs; silences expire.
- [ ] Someone tested a page end to end in the last month (`Watchdog` proves the
      pipe, not the route).

### Health checks

- [ ] Liveness checks the process, readiness checks dependencies, and neither
      page on a dependency that is allowed to be slow.
- [ ] Startup is handled separately from steady state (chapter 11).
- [ ] Health endpoints are excluded from access logs and SLIs.

### Tracing

- [ ] HTTP and SQL are auto-instrumented; the money path has explicit spans.
- [ ] Sampling is deliberate; a 100% trace bill is not a surprise.
- [ ] Span attributes never contain PII or card data.
- [ ] The trace backend can be queried by trace id, service, and duration.
- [ ] A timeout is visible as a parent/child duration mismatch, not hidden.

### Database

- [ ] Slow query log is on with a threshold tied to the latency promise.
- [ ] `pg_stat_statements` is enabled and someone reads the top by total time.
- [ ] The pool has a max, a queue, and a metric; waiting connections alert.
- [ ] Indexes are justified by EXPLAIN, not by folklore (chapter 14).
- [ ] Query parameters are not logged by the application; the server log is
      reviewed for PII.

### Frontend (chapter 15)

- [ ] Server-side rendering errors reach the same correlation ids as the API.
- [ ] Client errors are captured with release and route, not just a message.
- [ ] Web Vitals are recorded; p75 is the target, not the average.
- [ ] Source maps are uploaded for the exact release that is running.

### Business metrics

- [ ] Checkout funnel has a counter per step, all with `tenant_id`.
- [ ] Money is an integer counter, not a float gauge.
- [ ] Conversion is monitored per tenant, with a baseline for the same hour
      last week.
- [ ] A drop in orders with green technical dashboards is still an incident.

### Containers

- [ ] Every service has a memory limit and a measured peak.
- [ ] Restarts and OOM kills are visible; exit code 137 is investigated.
- [ ] Container series are joined on `id` or filtered by freshness, not `name`.
- [ ] Disk usage on the host is alerted before it is full.
- [ ] The container metrics exporter is maintained and cgroup-v2 aware.

### Incidents

- [ ] There is an incident commander and a status update cadence.
- [ ] The triage order is known: real, blast radius, money, recent change,
      dependencies, act small.
- [ ] Timestamps are captured as you go, not reconstructed.
- [ ] Every postmortem action has an owner, a date, and a verification.
- [ ] "Human error" is the start of the analysis, not the end.

### Multi-tenant

- [ ] Tenant comes from the authenticated edge, never the request body.
- [ ] Every tenant-scoped query has `WHERE tenant_id`; RLS is the second fence.
- [ ] Cache keys include the tenant.
- [ ] Logs never contain another tenant's rows.
- [ ] There is a per-tenant view for support and a per-tenant SLO where sold.
- [ ] Unknown tenants are rejected at the edge.

## 4. What you should see

Running the alerting checklist against this stack found real gaps, not
hypothetical ones. The first pass reported eleven alerts without a `runbook`
annotation; after adding them, `promtool` still only validates syntax:

```bash
$ docker compose exec -T prometheus /bin/promtool check rules /etc/prometheus/alert_rules.yml
Checking /etc/prometheus/alert_rules.yml
  SUCCESS: 18 rules found
```

"SUCCESS" means the YAML parses, not that the alerts are useful. The checklist
is what found the missing runbooks. The same audit found:

```bash
$ curl -s 'localhost:9090/api/v1/rules?type=alert' \
  | jq '[.data.groups[].rules[] | select(.annotations.runbook != null)] | length'
15
```

and the routing table, checked against the checklist's "page/warn/none" item:

```bash
$ curl -s localhost:9093/api/v2/alerts | jq -c '.[] | {name:.labels.alertname, receivers:.receivers}'
{"name":"Watchdog","receivers":[{"name":"heartbeat"}]}
{"name":"TrafficCollapse","receivers":[{"name":"default"}]}
```

`Watchdog` goes to `heartbeat`, which is the "none" route; the warning goes to
`default`, not to the pager. The checklist item is satisfied, and the evidence
is one command rather than a belief.

## 5. In a real multi-tenant e-commerce platform

Run the whole list as a **production readiness review** before a service takes
customer traffic, and again after every major incident. Assign each unchecked
box to a person and a date; an unchecked box with no owner is how leaks and
blind spots survive.

For a marketplace, add two items the generic list misses: a per-tenant kill
switch (disable checkout for one tenant without deploys) and a data-residency
check (which tenant data is allowed in which log store). For a payment path,
add a reconciliation item: the order counter and the ledger must agree at the
end of the day.

The review is not a gate that blocks shipping forever. It is a conversation
with a written outcome: "we ship without distributed tracing for now; the
owner is X; we revisit on date Y". That is an accepted risk, which is different
from an unnoticed one.

## 6. When to use it, when not to

Use the full list for a new service, a new tenant tier, a payment path, or
after an incident whose cause was "we did not know". Use single sections when
you change one layer: a Loki pipeline change gets the logging, privacy and
aggregation lists.

Do not turn the list into a 200-item compliance form nobody reads. Each box
must be answerable with a command or a link to code. If a box cannot be
answered that way, it is a value statement, and it belongs in a design review,
not a checklist.

Do not use checklists to avoid thinking. A box can be checked and still wrong:
the alert has a runbook, and the runbook is obsolete. Checklists catch
omissions, not incorrectness; review the content too.

## 7. Common mistakes

1. **Checking boxes from memory.** Run the command; "we have retention" is not
   evidence, `curl` output is.
2. **No owner for exceptions.** Every "no" needs a name, a date and a reason,
   or it becomes permanent.
3. **A checklist longer than the change.** If the list is not usable in ten
   minutes, it will be skipped on the day it matters.
4. **Confusing tool success with system health.** `promtool` success, a green
   Grafana, and a healthy cluster can coexist with unreadable or missing data.
5. **Skipping the tenant items.** They are the ones with legal and commercial
   consequences, and the easiest to leave out of a generic template.
6. **Never re-running it.** A stack that passed last year may have lost its
   runbooks, its retention or its owner since.
7. **Treating the checklist as the postmortem.** It finds gaps; it does not
   explain the incident. The timeline still has to be written.

## 8. Try it yourself

Audit one section against the live stack and write down the result, including
the command that proved it.

```bash
# Alerting section, items 1-3:
curl -s 'localhost:9090/api/v1/rules?type=alert' \
  | jq -r '.data.groups[].rules[] | select(.type=="alerting") | [.name, (.annotations.runbook != null), (.for // "-")] | @tsv'

# Aggregation section, item 2:
curl -sG localhost:3101/loki/api/v1/labels | jq -r '.data[]'

# Containers section, item 3:
curl -sG localhost:9090/api/v1/query --data-urlencode \
  'query=count by (name) (container_last_seen{name=~"observability-learn-.*"}) > 1' \
  | jq -r '.data.result[]? | "\(.metric.name) \(.value[1]) series"'
```

**Hint:** the third command returns `observability-learn-prometheus-1 2` on
this machine, because of a container recreation. That is a checklist failure
in the making: any query joining on `name` will double-count. The fix is the
`id`/freshness filter from chapter 17, not deleting the series.

**Cleanup:** none; you are only reading. Save the output in the place where
your team keeps production readiness notes, not in a chat message.

## 9. Next

The last file is the reference: [22 - Glossary and sources](22-glossary-sources.md),
including what was verified on this machine and what was not.
