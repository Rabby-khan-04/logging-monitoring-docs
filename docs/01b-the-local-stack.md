# 01b - The local stack: containers, ports, where data lands, and the footprint

## 1. Simple explanation

Think of the whole thing as a small town that lives inside your laptop. Each
building does exactly one job and has one door number so the other buildings
can find it.

- The **shop** is where the customers come in and ask for things. It writes a
  note in its own notebook every time someone does something.
- The **teller** (a pretend bank) hands out fake yes/no answers for payments.
  There because one building would be too easy; two buildings show what happens
  when a note has to cross a street.
- The **archive clerk** walks the street once a minute, copies down the shop's
  current numbers and files them. That is why the shop never has to phone
  anyone; it just leaves its numbers on a wall for the clerk to read.
- The **note collector** picks up the notes the shop drops on the pavement and
  takes them to a big bin you can search later.
- The **trip photographer** keeps a picture of each customer's route through
  town.
- The **siren** sits on the filed numbers; when they look bad it rings, and a
  **pager** decides who hears it.
- The **wall of pictures** shows everything at once so you can stand in front
  of it and see the town breathing.

Every building is closed off: one catches fire, the others keep running. You
can tear the town down and rebuild it with one command, and none of the notes
ever leave your laptop.

## 2. Real name

Each "building" is a Docker container managed by one `docker compose` project
named `observability-learn`. Thirteen services, one command. The precise terms:

- **Service** - a named entry in `docker-compose.yml`. Compose runs one or more
  containers per service; here it is exactly one each.
- **Published port** - the left-hand number in a mapping like `8000:8000`, the
  port on your laptop; the right-hand number is inside the container.
- **Named volume** - a folder Docker manages for you (e.g. `loki_data`). It is
  where a service's data actually lands and survives container restarts. The
  storeless services write to stdout or read-only host paths, so own no volume.
- **Pulled vs pushed** - the archive clerk (Prometheus) *pulls* numbers by
  scraping each service's `/metrics`; the note collector (Alloy) and the trip
  SDK *push* data to the bin (Loki) and the photographer's inbox (Tempo, via
  the collector). Different failure modes: a failed pull you only notice when a
  target goes down; a failed push you almost never notice.

## 3. Example

The whole town in one table, read from `docker-compose.yml`. Ports are the
**host** ports (what you type into a browser or curl); data column is the named
volume the service writes into.

```yaml
# docker-compose.yml, one service shown in full so you see the shape.
shop-api:
  image: node:24.22.2-slim            # the app itself; no build step, tsx runs the TS
  working_dir: /app
  volumes:
    - ./app:/app                       # bind-mount the source; edit on host, hot reload
    - app_modules:/app/node_modules    # node_modules lives in a volume, not copied per build
  command: ["sh", "-c", "./docker-entry.sh && ./node_modules/.bin/tsx --import ./src/instrumentation.ts src/server.ts"]
  environment:
    <<: *app-env                       # shared env block (LOG_PRETTY, LOG_REDACT, etc.)
    PORT: "8000"
    OTEL_SERVICE_NAME: shop-api        # this name becomes the Loki `service` label
    LOG_LEVEL: "info"                  # the dial from 02a
    LOG_DANGER: "1"                    # unlocks the /danger/* routes (chapter 03a)
  ports:
    - "8000:8000"
  depends_on:
    postgres: { condition: service_healthy }   # do not start the shop before the DB answers
  mem_limit: 320m                      # the "cannot take the laptop down" cap
```

And the full port-to-where-it-lands map:

| Service | Host port | Job | Where its data lands |
|---|---|---|---|
| shop-api | 8000 | the app | stdout -> Alloy -> Loki; metrics on `/metrics` |
| payment-gateway | 8020 | fake acquirer | stdout -> Loki |
| postgres | 5433 | the database | volume `postgres_data` (`/var/lib/postgresql`) |
| prometheus | 9090 | scrapes metrics | volume `prometheus_data` (`/prometheus`, 6h retention) |
| alertmanager | 9093 | routes alerts | volume `alertmanager_data` |
| alert-sink | 8090 | fake pager (console.log) | stdout -> Loki |
| loki | 3101 | log store | volume `loki_data` |
| tempo | 3201 | trace store | volume `tempo_data` |
| otel-collector | 4318 (grpc 4317) | receives spans | in-memory -> pushes to Tempo |
| alloy | 12345 | reads docker logs -> Loki | ephemeral (`/var/lib/alloy/data`, no named volume) |
| node-exporter | 9100 | host CPU/RAM/disk | exposes only, stores nothing |
| cadvisor | 8081 | per-container metrics | exposes only, stores nothing |
| grafana | 3001 | the wall of pictures | volume `grafana_data` |

## 4. What you should see

Everything below is from this running machine, just now.

**Thirteen services, all up.**

```
$ docker compose ps --format '{{.Service}}\t{{.Status}}'
alert-sink      Up About an hour
alertmanager    Up About an hour
alloy   Up 28 minutes
cadvisor        Up About an hour (healthy)
grafana Up About an hour
loki    Up 16 minutes
node-exporter   Up About an hour
otel-collector  Up About an hour
payment-gateway Up 40 minutes
postgres        Up 25 minutes (healthy)
prometheus      Up About an hour
shop-api        Up 35 minutes
tempo   Up About an hour
```

**Measured memory footprint.** RSS right now for exactly these thirteen, using
`docker stats` over the compose IDs only:

```
$ docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' $(docker compose ps -q)
observability-learn-alert-sink-1      12.56MiB / 48MiB
observability-learn-alertmanager-1    26.47MiB / 128MiB
observability-learn-alloy-1   81.19MiB / 192MiB
observability-learn-cadvisor-1        170.1MiB / 192MiB
observability-learn-grafana-1 291.9MiB / 384MiB
observability-learn-loki-1    116.1MiB / 640MiB
observability-learn-node-exporter-1   14.29MiB / 64MiB
observability-learn-otel-collector-1  57.31MiB / 256MiB
observability-learn-payment-gateway-1 63.83MiB / 256MiB
observability-learn-postgres-1        40.23MiB / 384MiB
observability-learn-prometheus-1      256.6MiB / 512MiB
observability-learn-shop-api-1        88MiB / 320MiB
observability-learn-tempo-1   315.8MiB / 512MiB
```

Add the RSS up and the live stack is using roughly **1.5 GiB**; the three
biggest are the stores (tempo, grafana, prometheus). The `mem_limit` numbers on
the right sum to a ceiling of about 3.8 GiB, which is the "raise this and it
will still not eat your laptop" budget the roadmap quotes as 2.5-3 GiB.

**First thing to open: Grafana.** Confirm it is alive and wired to the stores.

```
$ curl -s localhost:3001/api/health
{
  "database": "ok",
  "version": "13.3.0",
  "commit": "6f8ce3c693b493043ebcd4787566d2b6b118b0f0"
}
$ curl -s -u admin:admin localhost:3001/api/datasources | grep -oE '"name":"[^"]*"|"url":"[^"]*"'
"name":"Loki"
"url":"http://loki:3100"
"name":"Prometheus"
"url":"http://prometheus:9090"
"name":"Tempo"
"url":"http://tempo:3200"
```

Three datasources, already provisioned, pointing at the internal container DNS
names. Open `http://localhost:3001` (admin / admin) and the first dashboard in
the `learning` folder is **"00 - Stack health"**. On it, the "Scrape targets
up" panel answers the only question worth asking a stack you just started: are
the clerks actually reading the walls?

## 5. In a real multi-tenant e-commerce platform

In production you would not run thirteen containers on one laptop; each "box"
becomes a managed or scheduled service, and the app is one deployment per
region behind a load balancer, handling `tenant_acme`, `tenant_globex`,
`tenant_initech` and `tenant_umbrella` together. The topology in this town is
the same one you would recognise: the app still writes JSON to stdout, still
leaves metrics on a wall for a puller, still pushes spans to a collector. A
junior who can read `docker compose ps` and find "which port holds the logs"
can read a production topology diagram with no new theory - only scale, names,
and a far bigger Loki.

## 6. When to use it, when not to

Use the local stack for learning, reproducing, and rehearsing incidents against
fake data. Do not put real traffic or real customer data through it: admin/admin
with anonymous access on, `LOG_DANGER=1`, and a `dev-only-insecure-secret` hash
key are all deliberate training-wheel bugs, not something to copy. Cost here is
disk and a couple of gigabytes of RAM; on the same twelve containers with a real
tenant base it is money, and the levers that matter become retention (06b) and
label discipline (07b), not which port Grafana is on.

## 7. Common mistakes

- Editing `docker-compose.yml` and re-running `up` and wondering why a renamed
  service fails with "port is already allocated". The old container is an
  orphan; `docker compose up -d --remove-orphans` clears it (roadmap trap 7).
- Forgetting Postgres 18 moved its data path; mounting the old
  `/var/lib/postgresql/data` makes the container refuse to boot (roadmap trap
  2).
- Reading `docker stats` output and panicking at other rows (a stray
  `danger-redacted`, unrelated `proxy-learn` containers). Those belong to other
  projects on the host, not this stack; scope the command to
  `$(docker compose ps -q)` as above.
- Naming the app service anything other than what Prometheus calls it. Here
  `OTEL_SERVICE_NAME` and the compose service name are both `shop-api` on
  purpose, so the Loki `service` label and the Prometheus `service` label agree.

## 8. Try it yourself

Open `http://localhost:3001`, log in with admin / admin, and click the **"00 -
Stack health"** dashboard. Find the "Scrape targets up" panel and confirm every
target is green.

Hint: the same data is one API call away if a panel looks empty:
`curl -s localhost:9090/api/v1/targets`. The `shop-api` job should read
`"health":"up"`.

Cleanup: nothing to undo - opening a dashboard changes no state. Leave the stack
running; other chapters need it.

## 9. Next

The town is up and you can see it. Start with what it writes down:
[02a - Log levels](02a-log-levels.md).
