# 00 - Roadmap: logging and monitoring a multi-tenant e-commerce platform

This is the map for the whole course. Read it once, then work top to bottom.
Every chapter is a file in `docs/`. Every number and log line quoted in these
docs came out of the stack you can start with one command - with two named
exceptions: **chapter 12 (Sentry)** and **chapter 15 (the Next.js frontend)**
describe systems this stack does not run. Nothing in those two chapters was
executed here; everything reasoned from documentation is labelled as such in
the chapter itself, and everything they do claim to have run was run through
the running `shop-api`.

---

## 1. Versions, observed on 2026-10-29

These are not the versions I guessed from a blog post. They are what the
containers report about themselves on this machine, which is why the table
below includes the command that produced each row.

| Component | Version pinned | Reported by |
|---|---|---|
| Node.js (host) | v24.19.0 | `node --version` |
| npm (host) | 11.17.0 | `npm --version` |
| Docker Engine | 29.9.2 (build a82e528) | `docker --version` |
| Docker Compose | v5.6.1 | `docker compose version` |
| OS / kernel | Ubuntu 26.04.1 LTS / 7.0.0-38-generic | `/etc/os-release`, `uname -r` |
| Node.js (containers) | `node:24.22.2-slim` | pinned in `docker-compose.yml` |
| PostgreSQL | 18.6 (Debian 18.6-1.pgdg13+2) | `select version()` |
| Prometheus | v3.15.1 (revision bae3eced0a, go1.27.3) | `/api/v1/status/buildinfo` |
| Grafana | 13.3.0 (commit 6f8ce3c6) | `/api/health` |
| Loki | 3.7.9 (release-3.7.x) | `loki_build_info` in `/metrics` |
| Tempo | v3.1.1 (revision 9db7df79d) | `tempo_build_info` in `/metrics` |
| Alertmanager | 0.34.1 (revision 73c6bfe7) | `alertmanager_build_info` |
| OpenTelemetry Collector (contrib) | 0.164.0 | collector startup log |
| Grafana Alloy | v1.19.2 | `/ -/healthy` |
| node_exporter | v1.12.1 | pinned image tag |
| cAdvisor | v0.55.1 (revision f5bec374) | `cadvisor_version_info` |
| Pino | 10.4.0 | `app/node_modules/pino/package.json` |
| pino-http | 11.0.0 | same |
| pino-pretty | 13.2.0 | same |
| prom-client | 15.1.3 (**deprecated**, see below) | same |
| Express | 5.3.0 | same |
| pg (node-postgres) | 8.23.1 | same |
| zod | 4.6.7 | same |
| OpenTelemetry JS: `@opentelemetry/sdk-node` | 0.300.0 | same |
| `@opentelemetry/auto-instrumentations-node` | 0.82.0 | same |
| `@sentry/node` | 11.10.0 | same (optional, off by default) |
| TypeScript | 5.9.3 (`typescript@7.0.2` is now `latest`) | same |
| tsx | 4.23.15 | same |

### Deprecations and version traps found while building this stack

These all happened here, to me, on the first try. Each one has a chapter.

1. **`prom-client` is deprecated.** npm prints it during install:
   `npm warn deprecated prom-client@15.1.3: prom-client has been replaced by
   @prometheus-io/client`. The app in this repo still uses prom-client, because
   that is what most codebases you will inherit run, and because the
   replacement is still pre-1.0 (0.16.1). Chapter 08a shows both and explains
   which to pick in 2026.
2. **PostgreSQL 18+ Docker images moved PGDATA.** Mounting the classic
   `/var/lib/postgresql/data` path makes the container refuse to start with a
   long explanation about `pg_ctlcluster`. The volume goes on
   `/var/lib/postgresql` now. Most tutorials you find are written for <= 17.
3. **Tempo 3.x rejected a Tempo 2.x config.** `traces:`, `ingester:`,
   `compactor:` and `block.v2_encoding` are gone; 3.1 wants
   `distributor.receivers`, `storage.trace.block.version: vParquet4`,
   `backend_worker.compaction` and `overrides.defaults.metrics_generator`.
   You can validate without starting anything: `tempo -config.file=x
   -config.verify`.
4. **Loki 3.7 rejected three keys I copied from older examples**:
   `limits_config.retention_stream[].retention` (does not exist),
   `compactor.retention_enabled_check_interval` (does not exist), and
   `ruler.storage.filesystem` (the key is not `filesystem`). Chapter 06b uses
   only the levers that this build accepts, verified.
5. **`cadvisor` on Docker Hub is stale.** `google/cadvisor` stops at v0.33.0
   (2021), which does not understand cgroup v2 on this kernel. The maintained
   images are on `gcr.io/cadvisor/cadvisor`; `:latest` there resolved to
   v0.55.1, so the compose file pins that digest-by-tag instead.
6. **`npx tsx` silently reached the network on every container start.** Because
   compose sets `NODE_ENV=production`, `npm ci` skipped devDependencies, and
   `tsx` lives there. Chapter 17 has the fix: test for the binary, not for
   a marker file.
7. **Renaming a compose service does not stop the old container.** The orphan
   held port 8000 and the new service failed with "port is already allocated".
   `docker compose up -d --remove-orphans` is the fix.
8. **pino `redact` has no recursive wildcard.** The `**.cvv` and `**` paths
   that many blog posts use are accepted without an error and match **nothing**
   in Pino 10.4.0 - a silent leak. Only anchored paths such as
   `body.card.cvv` work, which is why chapter 03a pairs paths with a
   deep-scrub serializer and shows the leak in the output.
9. **pino-http 11 calls `autoLogging.ignore` with one argument.** A
   `(req, res)` signature borrowed from older examples throws and returns 500
   for every request. Decide from the response later in `customLogLevel`
   instead - chapter 02c, and chapter 05b for suppressing duplicate error
   lines.
10. **node-postgres returns `bigint` as a string.** `SELECT id` on the `orders`
    table yields `"17405"`, not `17405`. Typing the row as `number` typechecks
    and is a lie at runtime; chapter 20a hits it on purpose and keeps `id:
    string`.
11. **Loki's `retention_stream` has a 24-hour floor.** A 6h period stops the
    container at startup with `retention period must be >= 24h was 6h`. Chapter
    06b therefore keeps the per-stream rule at 24h and the global
    `limits_config.retention_period` at 72h.
12. **A single-file bind mount survives a reload.** `POST /-/reload` returns
    200, but if the editor replaced the file, the container still holds the old
    inode and serves stale content. `docker compose up -d --force-recreate
    <service>` is the fix. This bit the SLO alert rule in chapter 10c.
13. **The OTel Collector listens on 8888 only if you ask it to.** 0.164.0 no
    longer exposes its own metrics by default, so a scrape target pointed at
    8888 stays `down` and pages forever. `service.telemetry.metrics.readers`
    must be set explicitly - chapter 20a's stack health check.
14. **A renamed or duplicated label cannot be dropped by Alloy.** When Docker
    discovery already supplies `service_name`, `loki.process` cannot relabel it
    to something else; the second label wins on collision. Chapter 06a keeps the
    Alloy-supplied value and reads it as the service label instead of fighting
    it.

If a chapter ever disagrees with your running stack, **your stack wins**. Tell
me which line disagrees and I will re-run it and correct the doc.

---

## 2. Start everything

```bash
cd observability-learn
docker compose up -d          # first boot installs npm deps inside the volume (~30s)
docker compose ps             # 13 services, all "Up"
./scripts/loadgen.sh 60 5     # 60 seconds of fake traffic so the dashboards have data
```

Open:

| URL | What | Login |
|---|---|---|
| http://localhost:3001 | Grafana (dashboards in the `learning` folder) | admin / admin |
| http://localhost:9090 | Prometheus (targets, graphs, alerts) | none |
| http://localhost:3101 | Loki (query API; use Grafana's Explore for UI) | none |
| http://localhost:3201 | Tempo query API | none |
| http://localhost:9093 | Alertmanager | none |
| http://localhost:8081 | cAdvisor (container metrics UI) | none |
| http://localhost:12345 | Alloy (pipeline UI, useful when logs go missing) | none |
| http://localhost:8000 | The API itself (`GET /` lists endpoints) | none |
| http://localhost:8020 | The fake payment gateway | none |

Ports were chosen to avoid what was already listening on this machine
(80, 443, 3000, 6380, 8080, 8443). Postgres is on host port **5433**.

Memory: the whole stack runs inside about 2.5-3 GiB. Every container has a
`mem_limit` in `docker-compose.yml` so that one greedy component cannot take
the laptop with it; if you see an OOM kill, raise that limit and re-read
chapter 07b on cardinality, because that is usually the real cause.

---

## 3. What is running, and why

```
                       ┌───────────────┐
  curl / loadgen ─────▶│   shop-api    │──┐
                       │  (Express 5)  │  │ HTTP   ┌────────────────────┐
                       │  Pino logs    │  └───────▶│ payment-gateway    │
                       │  prom-client  │           │ (fake acquirer)    │
                       └──┬─────┬───┬──┘           └─────────┬──────────┘
                          │     │   │                        │
              SQL         │     │   │ OTLP traces            │ SQL
                       ┌──▼──┐  │   ▼                        ▼
                       │pg   │  │ ┌──────────────┐   (same DB)
                       │18.6 │  │ │otel-collector│
                       └─────┘  │ └──────┬───────┘
                                │        │ OTLP gRPC
                                │        ▼
                                │   ┌────────┐        ┌─────────────┐
                                │   │ Tempo  │        │ Prometheus  │◀── scrapes
                                │   └────────┘        └──────┬──────┘
                                │                            │ rules
                                │ logs (stdout)              ▼
                                ▼                      ┌──────────────┐   ┌───────────┐
                        ┌──────────────┐               │ Alertmanager │──▶│alert-sink │
                        │    Alloy     │               └──────────────┘   └───────────┘
                        │ (docker logs)│
                        └──────┬───────┘                ┌─────────────┐
                               │ push                   │  Grafana    │ reads all three
                               ▼                        └─────────────┘
                          ┌──────────────┐
                          │     Loki     │
                          └──────────────┘
   plus node_exporter (host CPU/RAM/disk) and cAdvisor (per-container)
```

Four things worth noticing in that picture:

- **Logs leave the container through Alloy, not the app.** Your code writes
  JSON to stdout and forgets about it. That is the design that survives a
  log-store change.
- **Metrics are pulled, traces are pushed.** Prometheus scrapes `/metrics`;
  the SDK pushes spans to the collector. Different failure modes: a scrape
  that fails is invisible until `up` goes to 0; a push that fails logs a
  warning you will never read.
- **Two services, one repo.** Correlation and context propagation need a
  second hop, so the fake payment gateway exists purely for that.
- **The alert sink is a `console.log`.** Alerts land as log lines in Loki, so
  "what did we get paged for this week?" is a query, not a ticket search.

---

## 4. Table of contents

Ordered beginner to advanced. Nothing later assumes a concept that has not
been explained earlier.

### Foundations

| # | File | Chapter |
|---|---|---|
| 00 | this file | Roadmap, versions, stack map |
| 01a | `01a-what-is-observability.md` | Logs, metrics, traces, and why one of the three is never enough |
| 01b | `01b-the-local-stack.md` | Container tour: ports, where data lands, the footprint, first dashboard |

### Logging

| # | File | Chapter |
|---|---|---|
| 02a | `02a-log-levels.md` | Levels, when each one actually fires, tuning them |
| 02b | `02b-pino-structured-json.md` | Structured JSON with Pino, serializers, child loggers |
| 02c | `02c-request-logging-dev.md` | pino-http, request logging, pretty output in development |

### What to log, and what must never be logged

| # | File | Chapter |
|---|---|---|
| 03a | `03a-redaction.md` | Danger demo first: a real leak, then the redaction that stops it |
| 03b | `03b-privacy-retention.md` | PII, card data, retention windows, minimisation |

### Correlation

| # | File | Chapter |
|---|---|---|
| 04a | `04a-request-ids.md` | Generating, trusting and propagating request IDs |
| 04b | `04b-tenant-context.md` | `tenant_id` on every line, and hashing instead of logging people |

### Errors

| # | File | Chapter |
|---|---|---|
| 05a | `05a-error-types-stacks.md` | Typed errors, stack traces, what a good error line looks like |
| 05b | `05b-no-double-logging.md` | One error, one log line (with the bug I actually shipped) |

### Log aggregation

| # | File | Chapter |
|---|---|---|
| 06a | `06a-loki-logql.md` | LogQL: streams, label selectors, line filters, metrics from logs |
| 06b | `06b-retention-rotation-cost.md` | Retention, rotation, Docker log drivers, and the bill |

### Metrics

| # | File | Chapter |
|---|---|---|
| 07a | `07a-metric-types.md` | Counters, gauges, histograms: pick the right one |
| 07b | `07b-labels-cardinality.md` | Labels, and the cardinality trap measured on purpose |
| 07c | `07c-red-use-golden-signals.md` | RED, USE, the four golden signals |

### Prometheus

| # | File | Chapter |
|---|---|---|
| 08a | `08a-prometheus-scraping.md` | Scraping, service discovery, job design, prom-client vs the modern client |
| 08b | `08b-promql-intro.md` | `rate`, `increase`, vector matching, recording rules |
| 08c | `08c-percentiles.md` | p50/p95/p99, `histogram_quantile`, and why averages lie |

### Grafana

| # | File | Chapter |
|---|---|---|
| 09a | `09a-grafana-dashboards.md` | Panels, variables, annotations, provisioning as code |
| 09b | `09b-api-dashboard.md` | A useful API dashboard, panel by panel |

### Alerting

| # | File | Chapter |
|---|---|---|
| 10a | `10a-good-bad-alerts.md` | Symptoms not causes, thresholds, fatigue, what to delete |
| 10b | `10b-alertmanager-oncall.md` | Routing, grouping, inhibition, silences, on-call basics |
| 10c | `10c-sli-slo-error-budget.md` | SLIs, SLOs, error budgets, burn-rate alerts |

### Health checks

| # | File | Chapter |
|---|---|---|
| 11 | `11-health-checks.md` | Liveness vs readiness, startup probes, uptime monitoring |

### Error tracking

| # | File | Chapter |
|---|---|---|
| 12 | `12-sentry.md` | Setup, releases, source maps, grouping, what Sentry sees that Loki does not |

> Not running in this stack: there is no `SENTRY_DSN` and no Sentry container, so
> Sentry's UI, grouping and billing behaviour are documented, not demonstrated.
> The failure path is still real: the exception a Sentry event would carry is in
> this stack's own logs, and section 4 of the chapter proves it.

### Distributed tracing

| # | File | Chapter |
|---|---|---|
| 13a | `13a-spans.md` | Spans, the OTel SDK, auto-instrumentation |
| 13b | `13b-context-propagation.md` | W3C trace context, crossing service and queue boundaries, sampling |
| 13c | `13c-find-the-slow-part.md` | Reading a waterfall, service graph, span metrics |

### Database

| # | File | Chapter |
|---|---|---|
| 14 | `14-database-monitoring.md` | Slow query log, `pg_stat_statements`, pool counts, EXPLAIN, the missing index exercise |

### Frontend

| # | File | Chapter |
|---|---|---|
| 15 | `15-nextjs-frontend.md` | Server logs, instrumentation hooks, client errors, Web Vitals |

> Not running in this stack: there is no Next.js app, no browser and no HTML
> page here. The Next-specific parts are reasoned from documentation and say so.
> The parts it does demonstrate - the startup hook, request context, and JSON
> server logs - run against `shop-api`, because a Next server is a Node process.

### Business metrics

| # | File | Chapter |
|---|---|---|
| 16 | `16-business-metrics.md` | Orders per minute, failed payments, checkout drop-off, per-tenant usage |

### Containers

| # | File | Chapter |
|---|---|---|
| 17 | `17-docker-monitoring.md` | CPU, memory, restarts, disk, OOM kills, cgroup v2 |

### Incidents

| # | File | Chapter |
|---|---|---|
| 18 | `18-incidents.md` | Runbooks, triage order, status communication, blameless postmortem + template |

### Multi-tenant

| # | File | Chapter |
|---|---|---|
| 19 | `19-multi-tenant.md` | Per-tenant dashboards, noisy neighbour, and the leak that gets you fired |

### Real-world patterns (the capstone)

| # | File | Chapter |
|---|---|---|
| 20a | `20a-checkout-end-to-end.md` | Instrument one endpoint: log + metric + trace + alert, all four |
| 20b | `20b-golden-signals-dashboard.md` | The golden-signals dashboard, built from scratch |
| 20c | `20c-error-latency-alerts.md` | Alerting on error rate and latency without crying wolf |
| 20d | `20d-simulated-outage.md` | Investigate a fake outage using only logs, metrics and traces |
| 20e | `20e-pitfalls.md` | What each signal gets wrong when you trust it alone |

### Reference

| # | File | Chapter |
|---|---|---|
| 21 | `21-checklists.md` | One checkbox checklist per topic |
| 22 | `22-glossary-sources.md` | Terms, the SRE book chapters behind this, pinned sources |

---

## 5. How to read these chapters

Every chapter has the same nine sections:

1. **Simple explanation** - like you are seven. Analogy, no jargon.
2. **Real name** - the proper term, in technical words.
3. **Example** - complete runnable code or config, commented on the lines that matter.
4. **What you should see** - actual output from this machine. If it does not
   match yours, the version table above is the first thing to check.
5. **In a real multi-tenant e-commerce platform** - one concrete example.
6. **When to use it, when not to** - including cost and noise.
7. **Common mistakes.**
8. **Try it yourself** - one exercise, with a hint and a cleanup step.
9. **Next** - the following chapter.

House rules that apply everywhere:

- Everything is local. Nothing in this repo installs an agent on a production
  system or sends customer data anywhere.
- All data is fake. Anything that logs something sensitive is labelled
  **DANGER DEMO** and is immediately followed by the safe version.
- The `/danger/*` routes are gated behind `LOG_DANGER=1` and 403 without it.
- Concepts are never used before they are explained. If a chapter needs one
  from later, it links forward and says so.

## 6. Sources of truth

Pino, Prometheus, Grafana, Loki, OpenTelemetry and Sentry documentation, plus
the Google SRE book (chapters on monitoring distributed systems, practical
alerting advice and ELI) and the SRE Workbook (SLO burn-rate alerting). Where
those disagreed with the containers on this machine, the machine won, and the
disagreement is recorded in section 1 above.

---

## 7. Your progress checklist

Tick a box when you can do the thing without re-reading the chapter, not when
you finished reading it. The right-hand column is the test: if you cannot
answer the question out loud, the box stays empty.

### Foundations and logging

- [ ] **01a** - I can name the three signals and give an outage that only one of them would explain
- [ ] **01b** - I started the stack and opened every UI in the port table
- [ ] **02a** - I know which level to use for "expected bad input" and why `error` there is noise
- [ ] **02b** - I can write a Pino child logger that carries `request_id` and `tenant_id`
- [ ] **02c** - I can explain why one request produces one line, and what `genReqId` changes
- [ ] **03a** - I can show the DANGER DEMO leak and the exact config that stops it
- [ ] **03b** - I can say what I am *not* allowed to log, and for how long logs are kept
- [ ] **04a** - I can trace one request from the client header through both services by id
- [ ] **04b** - I can add a tenant to every log line and hash a customer identity
- [ ] **05a** - I can tell a 4xx from a 5xx from a crash, and read a stack trace
- [ ] **05b** - I can explain why one error must produce exactly one log line
- [ ] **06a** - I can write a LogQL query that counts errors per tenant per minute
- [ ] **06b** - I can state the retention window, the rotation rule, and roughly the monthly cost

### Metrics and dashboards

- [ ] **07a** - I can choose counter vs gauge vs histogram for three given quantities
- [ ] **07b** - I can explain cardinality and why a URL must not be a label value
- [ ] **07c** - I can name the four golden signals and map each to a metric on this stack
- [ ] **08a** - I can explain pull vs push, and read `/targets` to find a broken scrape
- [ ] **08b** - I can write `rate()`, `increase()` and a recording rule that actually works
- [ ] **08c** - I can explain why the average hides the incident and compute p95
- [ ] **09a** - I can add a panel and a dashboard variable to a provisioned dashboard
- [ ] **09b** - I can build the API dashboard from its query, unit and threshold

### Alerting, health, error tracking

- [ ] **10a** - I can rewrite a cause-based alert as a symptom-based one and delete a useless alert
- [ ] **10b** - I can explain grouping, inhibition and a silence, and route by severity
- [ ] **10c** - I can define an SLI, an SLO, and compute the error budget and a burn rate
- [ ] **11** - I can tell liveness from readiness and say what each probe should check
- [ ] **12** - I can say what Sentry adds to Loki and what it costs per event (not running here)

### Tracing, database, frontend

- [ ] **13a** - I can read a waterfall and name the span that is slow
- [ ] **13b** - I can explain `traceparent` and how a trace crosses to the payment service
- [ ] **13c** - I can find the slow part using service graph and span metrics
- [ ] **14** - I can find the slow query with `pg_stat_statements` and read `EXPLAIN ANALYZE`
- [ ] **15** - I can list what a browser can tell you that a server cannot (no frontend here)

### Business, containers, incidents, tenants

- [ ] **16** - I can compute checkout drop-off and revenue per tenant from counters
- [ ] **17** - I can tell working set from usage and spot an OOM kill in metrics
- [ ] **18** - I can open an incident, follow a runbook, and write a blameless postmortem
- [ ] **19** - I can reproduce the cross-tenant leak and explain the fix
- [ ] **20a** - I can follow one request through logs, trace, metric and database row by id
- [ ] **20b** - I can rebuild the golden-signals dashboard from scratch
- [ ] **20c** - I can explain error-ratio and latency alerts and why volume guards matter
- [ ] **20d** - I can run the simulated outage and narrate the timeline from evidence alone
- [ ] **20e** - I can name what each signal gets wrong when trusted alone
- [ ] **21** - I have run the checklists against my own service
- [ ] **22** - I can look up a term, a pinned source, and a recorded disagreement

---

**Next:** [01a - What observability is, and why three signals](01a-what-is-observability.md)
