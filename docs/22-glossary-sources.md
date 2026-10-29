# 22 - Glossary and sources

The last file is the map's legend: the words this course uses, the versions it
was written against, and an honest note about what was run here and what was
only read.

## 1. Simple explanation

A dictionary is useful only if it tells you which edition it describes. A word
can mean one thing in a 2019 blog post and something else in the software you
have installed today. This chapter pins both: the vocabulary and the versions.

It also keeps a list of disagreements. When a manual says one thing and the
machine does another, the machine wins - but the difference gets written down,
so the next person does not have to rediscover it at 3am.

## 2. Real name

- **Glossary**: agreed definitions, so "latency" in a meeting means one thing.
- **Pinned version**: an exact tag, not `latest`. The stack here pins every
  image and records what each container reports about itself.
- **Source of truth**: the running system first, the official documentation
  second, blog posts last.
- **Disagreement log**: a dated note that a tool behaved differently from its
  documentation or from common advice.
- **Verified / not verified**: a claim that was executed on this machine versus
  one reasoned from documentation and labelled as such.

## 3. Example

### Glossary

| Term | Meaning in this course |
|---|---|
| Alert fatigue | People stop trusting pages because most are noise; a reliability problem, not a comfort problem. |
| Alertmanager | Routes, groups, inhibits and silences alerts produced by Prometheus. |
| Annotation | Metadata on an alert (summary, description, runbook), not a label used for routing. |
| Burn rate | Error ratio divided by the error budget; 1.0 spends the budget exactly over the SLO window. |
| Cardinality | Number of distinct label combinations; the main driver of metric cost. |
| cgroup v2 | Kernel mechanism that accounts for and limits container CPU/memory/IO. |
| Correlation id | `request_id`: one identifier copied onto every log line for a request. |
| Counter | Monotonic total; query with `rate()`/`increase()`, never as a current value. |
| cAdvisor | Exporter of per-container cgroup metrics. |
| Dead-man's switch | An alert that always fires (`Watchdog`) so its absence proves the pipeline is dead. |
| Error budget | `1 - SLO` expressed as allowed failures or time; 43.2 minutes at 99.9% over 30 days. |
| Exemplar | A trace id attached to a metric sample, linking a graph point to a trace. |
| Gauge | A value that goes up and down (pool size, temperature). |
| Golden signals | Latency, traffic, errors, saturation. |
| Histogram | Bucketed observations; the source of percentiles, not averages. |
| Inhibition | Suppressing a target alert while a causal source alert fires. |
| Label | Key/value dimension on a metric or log stream; must be bounded. |
| Liveness | Is the process alive? Restart it if not. |
| LogQL | Loki's query language: stream selectors, line filters, metric queries. |
| Loki | Log aggregation store indexed by labels, not full text. |
| OOMKilled | Kernel killed a container for exceeding its memory limit; often exit 137. |
| OpenTelemetry | Vendor-neutral SDK/protocol for traces, metrics and logs. |
| Percentile | p95/p99: the value below which that fraction of requests fall. |
| PII | Personally identifiable information; belongs in the database, not in logs. |
| PromQL | Prometheus query language. |
| Readiness | Can the process serve traffic right now? Remove it from the balancer if not. |
| Recording rule | A named PromQL expression evaluated ahead of time and stored as a series. |
| RED | Rate, Errors, Duration - for request-driven services. |
| Retention | How long data is kept; a cost and compliance decision. |
| Sampling | Keeping a fraction of traces; cheap, but rare errors can vanish. |
| SLA | A contract with penalties; an SLO is the stricter internal target. |
| SLI | The measured ratio, e.g. successful requests / valid requests. |
| SLO | The target for an SLI over a window, e.g. 99.9% over 30 days. |
| Span | One timed operation in a trace. |
| Structured logging | Machine-parseable fields (JSON), not prose. |
| Tempo | Trace store; queried by trace id, TraceQL, or via Grafana. |
| Tenant isolation | Every read/write scoped to one tenant in code, SQL and cache keys. |
| Trace | A tree of spans for one request, with a shared trace id. |
| TraceQL | Tempo's trace query language. |
| USE | Utilisation, Saturation, Errors - for resources. |
| W3C traceparent | The HTTP header carrying trace id and parent span id between services. |
| Webhook | HTTP callback used here as the paging receiver. |

### Sources, pinned to what this stack runs

| Topic | Source | Version here |
|---|---|---|
| Structured logging | Pino documentation, getpino.io | 10.4.0 |
| Request logging | pino-http README | 11.0.0 |
| Metrics in Node | prom-client README (deprecated, see below) | 15.1.3 |
| Scraping, PromQL, rules | prometheus.io/docs | 3.15.1 |
| Dashboards as code | Grafana provisioning docs | 13.3.0 |
| Log queries, retention | grafana.com/docs/loki | 3.7.9 |
| Log shipping | grafana.com/docs/alloy | 1.19.2 |
| Traces, TraceQL | grafana.com/docs/tempo | 3.1.1 |
| Instrumentation | opentelemetry.io/docs/languages/js | 0.300.0 |
| Error tracking | docs.sentry.io/platforms/javascript/guides/node | 11.10.0 (not run) |
| Alert routing | prometheus.io/docs/alerting | 0.34.1 |
| Slow queries, stats | postgresql.org/docs/18/pgstatstatements.html | 18.6 |
| Container limits | docs.docker.com/engine/containers/resource_constraints | Engine 29.9.2 |
| SRE practice | Google SRE Book: Monitoring Distributed Systems, Practical Alerting, Being On-Call, Postmortem Culture | - |
| SLO alerting | SRE Workbook: Alerting on SLOs, Implementing SLOs | - |

Canonical URLs for the main ones:

- https://getpino.io/
- https://prometheus.io/docs/
- https://grafana.com/docs/loki/latest/
- https://grafana.com/docs/alloy/latest/
- https://grafana.com/docs/tempo/latest/
- https://opentelemetry.io/docs/languages/js/
- https://sre.google/sre-book/monitoring-distributed-systems/
- https://sre.google/workbook/alerting-on-slos/
- https://www.postgresql.org/docs/18/pgstatstatements.html

### Deprecation and replacement

`prom-client` 15.1.3 prints a deprecation warning on install and is replaced by
`@prometheus-io/client`. This course keeps prom-client because most codebases
you inherit use it; chapter 08a shows both. `google/cadvisor` on Docker Hub is
also stale (v0.33.0, no cgroup v2); use `gcr.io/cadvisor/cadvisor` v0.55.1.

### Disagreement log

Each of these was observed on this machine, with the version above, and
contradicted documentation or common advice:

| Claim | What happened here |
|---|---|
| Pino `redact` supports `**` recursive wildcards | Accepted silently, matched nothing. The real defence is the deep-scrub serializer (chapter 03a). |
| `pino-http` `autoLogging.ignore(req, res)` | Takes one argument; the two-argument version threw and returned 500 for every request. Suppress duplicates in `customLogLevel` instead (chapter 05b). |
| Loki has `/loki/api/v1/label_names` | 404 on 3.7.9. Use `/labels` and `/label/<name>/values`. |
| `retention_stream[].period` can be short | Refused to start below 24h: `retention period must be >= 24h was 6h`. |
| The Loki delete API always works | Returned 404 on this install, with and without `dry_run`; the request list is empty (chapter 06b). |
| Tempo read API is `/api/trace/<id>` | 404 on 3.1.1. Use `/api/v2/traces/<id>`. |
| Tempo serves its service graph | The graph is remote-written to Prometheus; Tempo's `/api/metrics/querier` is 404 (chapter 13c). |
| Alloy can drop the duplicate `service_name` | Three approaches failed; the label is added after relabel and before the Loki pipeline (chapter 06a). |
| Editing a bind-mounted rule file then reloading Prometheus | The container kept the old inode and the old rule. `up -d --force-recreate prometheus` fixed it. |
| `docker compose restart` applies a changed `command` | It does not; recreate the container. |
| `pg_stat_statements` has `total_exec_calls` | It has `calls`, `total_exec_time`, `mean_exec_time`, `max_exec_time` on 1.12/PG 18. |

## 4. What you should see

The versions are not a table copied from a release page; each one is what the
running container reports. One command per family:

```bash
$ curl -s localhost:9090/api/v1/status/buildinfo | jq -c .data
{"version":"3.15.1","revision":"bae3eced0a5369e050e83ea73bc381d7c4b1a719","branch":"HEAD","buildDate":"20261021-13:31:17","goVersion":"go1.27.3"}

$ curl -s localhost:3001/api/health | jq -c .
{"database":"ok","version":"13.3.0","commit":"6f8ce3c693b493043ebcd4787566d2b6b118b0f0"}

$ curl -s localhost:9093/api/v2/status | jq -c '{version:.versionInfo.version, cluster:.cluster.status}'
{"version":"0.34.1","cluster":"ready"}

$ curl -s localhost:8081/metrics | grep '^cadvisor_version_info'
cadvisor_version_info{cadvisorRevision="f5bec374",cadvisorVersion="v0.55.1",kernelVersion="7.0.0-38-generic",osVersion="Alpine Linux v3.22"} 1

$ curl -s localhost:3101/metrics | grep '^loki_build_info'
loki_build_info{branch="release-3.7.x",version="3.7.9",goversion="go1.26.10"} 1

$ curl -s localhost:3201/metrics | grep '^tempo_build_info'
tempo_build_info{branch="HEAD",version="v3.1.1",goversion="go1.27.3"} 1
```

What was **not** executed on this machine, and is therefore reasoned from
documentation rather than observed:

- **Sentry.** No DSN and no service in Compose; `@sentry/node` is installed but
  `initSentry()` does nothing without `SENTRY_DSN`. Chapter 12 labels every
  Sentry UI or grouping claim as not run here.
- **Next.js / frontend.** There is no frontend in this stack. Chapter 15
  separates what was tested (the API's own server logs, `/healthz/detail`,
  described Web Vitals) from what is documentation.
- **Grafana screenshots.** No browser is available here. Dashboards are
  described by their provisioned titles and queries, with API output as
  evidence.
- **A 28-day SLO window.** Metrics retention is six hours; the production
  window is described, the local rule uses one hour.

## 5. In a real multi-tenant e-commerce platform

A living glossary is an operational tool. When support says "the dashboard is
red", the glossary says which dashboard; when legal asks "what is retained",
the retention table answers with a number and an owner; when a new engineer
joins, the disagreement log saves them a week of rediscovering that the
vendor's example is wrong for this version.

Keep the version table in the repository, next to the compose file, and update
it in the same change that bumps an image. Keep the disagreement log especially
for workarounds: a comment explaining why the obvious approach does not work is
worth more than a clean-looking config that nobody understands.

The multi-tenant additions to the glossary are the ones people argue about:
what counts as a "tenant", what a "customer" is, whether a hashed id is
personal data, and which retention applies to which tenant tier. Write the
answers down before the audit, not during it.

## 6. When to use it, when not to

Use the glossary when a term appears in an alert, a dashboard or a contract and
people might mean different things. Use the version table whenever behaviour
matters: an API shape, a default, a removed flag. Use the disagreement log for
anything that cost more than ten minutes to discover.

Do not maintain a glossary as a wiki that nobody reads. Link the terms from the
docs and alerts that use them. Do not pin versions in prose only; pin the image
tags and generate the table where possible. Do not record a disagreement
without the version and the observed error; "it did not work" is not
reproducible.

Cost: a stale glossary is worse than none, because it is trusted. Assign an
owner and review it when a component is upgraded, not on a calendar.

## 7. Common mistakes

1. **`latest` tags.** The stack would silently change under the docs; every
   image here is pinned.
2. **Undated claims.** "Loki does not support X" is true only for a version;
   record it.
3. **Confusing SLI, SLO and SLA in a meeting.** They lead to different
   decisions and different people.
4. **Copying a blog's PromQL without running it.** The result may be `NaN`, a
   parse error, or a number in the wrong unit.
5. **Recording a workaround without the error message.** The next person cannot
   tell whether the constraint still applies.
6. **Documenting an unverified feature as if it ran.** Chapter 12 and 15 are
   explicit about the gap; that honesty is part of the deliverable.
7. **Letting the version table drift from the compose file.** The table is
   generated from the running system, not from memory.

## 8. Try it yourself

Add one term or one disagreement to this file, with evidence.

```bash
# Pick a claim from a README or a blog, then test it here. Example:
# does this Loki build list labels through /labels or /label_names?
curl -s -o /dev/null -w 'labels %{http_code}\n' localhost:3101/loki/api/v1/labels
curl -s -o /dev/null -w 'label_names %{http_code}\n' localhost:3101/loki/api/v1/label_names

# And what does the label list actually contain?
curl -s localhost:3101/loki/api/v1/labels | jq -r '.data[]'
```

**Hint:** `labels` returns 200 and `label_names` returns 404 on Loki 3.7.9.
Add a row to the disagreement log with the version and the status codes; that
row is now evidence a future reader can trust. Do the same for a PromQL
function whose unit surprised you.

**Cleanup:** none; you are editing documentation. If you add a term, link it
from the chapter that uses it, or it will not be found.

## 9. Next

There is no next chapter. Go back to [00 - Roadmap](00-roadmap.md), pick an
exercise you skipped, and run it against the live stack. Then change one thing
in this repo - an alert threshold, a retention window, a dashboard panel - and
watch the effect. That is the only way the map becomes yours.
