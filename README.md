# observability-learn

A runnable logging-and-monitoring course for a fake multi-tenant e-commerce
platform. Everything here is local: one `docker compose up` gives you the API,
a Postgres, Prometheus, Grafana, Loki, Tempo, Alertmanager and the exporters,
and every number quoted in the docs came out of that stack.

Start here: **[docs/00-roadmap.md](docs/00-roadmap.md)**.

## Run it

```bash
docker compose up -d
docker compose ps
./scripts/loadgen.sh 60 5        # 60 seconds of fake traffic
```

| URL | What |
|---|---|
| http://localhost:3001 | Grafana (admin / admin) |
| http://localhost:9090 | Prometheus |
| http://localhost:3101 | Loki API |
| http://localhost:3201 | Tempo API |
| http://localhost:9093 | Alertmanager |
| http://localhost:8081 | cAdvisor |
| http://localhost:12345 | Alloy |
| http://localhost:8000 | the API (`GET /` lists endpoints) |
| http://localhost:8020 | fake payment gateway |

Postgres is on host port **5433**.

## Practise an incident safely

```bash
./scripts/outage.sh 180 timeout   # or: decline | error | slow
```

This only sends the app's own `x-chaos` header against fake data for one
tenant. Stop the script and the "incident" ends. Nothing is installed anywhere
outside this directory and no real customer data exists in it.

## What is where

| Path | Contents |
|---|---|
| `app/` | Node.js/TypeScript API, Pino logging, prom-client metrics, OTel traces |
| `db/init/` | schema and seed data (four fake tenants) |
| `prometheus/` | scrape config, alert rules, recording rules |
| `alertmanager/` | routing, grouping, inhibition |
| `grafana/` | provisioned datasources and dashboards |
| `loki/`, `alloy/` | log store and the Docker log pipeline |
| `tempo/`, `otel/` | tracing backend and collector |
| `scripts/` | `loadgen.sh`, `outage.sh` |
| `docs/` | the course, 43 files, read in order |
| `.artifacts/` | raw command output captured while writing the docs |

## The two chapters that are not running here

Chapter **12 (Sentry)** and chapter **15 (Next.js frontend)** describe systems
this stack does not run. Both say so at the top, and both label which claims
were executed and which were reasoned from documentation.

## House rules the docs follow

- Everything runs locally; no agents or SDKs on production systems, ever.
- Only fake data. Sensitive examples are labelled **DANGER DEMO** and always
  followed by the safe version.
- No deprecated APIs without a note and the modern replacement.
- No concept is used before it is explained.
- Where a tool behaved differently from its documentation, the running stack
  won and the disagreement is recorded in the roadmap and in chapter 22.
