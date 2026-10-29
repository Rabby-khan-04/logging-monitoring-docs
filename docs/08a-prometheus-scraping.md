# 08a - Scraping and job design

Prometheus does not receive metrics. It goes and takes them. This chapter is about
how often it walks round, which doors it knocks on, and what a `job` is for. The
client library question is here too, because the library decides what a scrape costs.

## 1. Simple explanation

Picture a librarian who visits every shop on the street once every fifteen
seconds and copies down the number on the counter by the door. The librarian is
Prometheus, the shop is your service, and the number by the door is `/metrics`.
Nobody phones her with updates: she turns up, looks, writes, leaves.

Wonderful property: the shops never need to know she exists, and you can hire a new
librarian without touching a shop. Awful property: if a shop changes its number and
changes it back between two visits, she never saw it. The picture is only as sharp
as the gap between visits.

A `job` is a set of doors visited with the same rules: same path, same interval, same
word written on the notebook page.

## 2. Real name

- **Scrape**: one HTTP GET of a target's metrics endpoint, plus the samples found
  in the response. Nothing is pushed to Prometheus in this design.
- **Target**: one `host:port` plus the path to read: `shop-api:8000/metrics`.
- **Job**: a named group of targets sharing scrape settings. The name becomes the
  `job` label on every sample, so renaming a job is a real change, not cosmetic.
- **Instance**: the `host:port` string, exposed as the `instance` label.
- **Scrape interval / scrape timeout**: how often to knock, and how long to wait
  before a scrape counts as failed. 15s and 10s in this stack's `global` block.
- **`up`**: a series Prometheus writes per target: 1 when the scrape worked, 0
  when it did not. The cheapest health check there is.
- **`static_configs`**: a hand-written target list, and all this repo uses for
  metrics: compose resolves `shop-api` already, and there is no orchestrator to ask.
- **Service discovery (SD)**: asking Kubernetes, Consul, EC2 or Docker "who is
  here?" and building the target list from the answer. Docker-native SD *is*
  running here for logs, as Alloy's `discovery.docker`; chapter 17 covers it.
- **Exposition format**: the text a client library prints at `/metrics`: `# HELP`,
  `# TYPE`, one line per sample. Here: `prom-client` 15.1.3.

## 3. Example

Two jobs from `prometheus/prometheus.yml`, because the difference between them is
the whole point of job design:

```yaml
global:
  scrape_interval: 15s     # one visit every 15s; going lower multiplies storage, not insight
  scrape_timeout: 10s      # a target slower than this is "down", not "slow"

scrape_configs:
  - job_name: shop-api
    metrics_path: /metrics          # path, not port: one port can serve several endpoints
    static_configs:
      - targets: ["shop-api:8000"]  # compose DNS name, resolved on the shared network
        labels:
          service: shop-api         # added to every series from this target

  # The quarantined cardinality demo from 07b: same container, same port, other path.
  - job_name: shop-api-demo
    metrics_path: /metrics/demo
    static_configs:
      - targets: ["shop-api:8000"]  # identical target string to the job above
        labels:
          service: shop-api         # deliberately the same, so panels group by service
          tier: demo                # ...and this is what tells them apart
```

The app side, `app/src/lib/metrics.ts`:

```ts
import client from 'prom-client';

// `register` is what /metrics serves; a second registry is how /metrics/demo
// stays separate from /metrics. Process metrics come free with a prefix.
export const register = client.register;
client.collectDefaultMetrics({ register, prefix: 'shop_' });

// 07b's rule: `route` is the mounted template, never the concrete URL.
export const httpRequestDurationSeconds = new client.Histogram({
  name: 'shop_http_request_duration_seconds',
  labelNames: ['method', 'route', 'status_code', 'tenant_id'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});
```

One more detail about that file: prom-client 15 has no `Info` metric type, so
`shop_build_info` is a Gauge pinned to 1 with `release` and `environment` as labels -
pasting an `Info` example from an old post is a TypeScript error here. Only traces
are pushed: `app/src/instrumentation.ts` sets `OTEL_METRICS_EXPORTER ??= 'none'`,
matching `OTEL_METRICS_EXPORTER: "none"` in `docker-compose.yml`'s `x-app-env`. The
deployment owns the exporter, the code only defaults it.

**prom-client or the modern client?** `prom-client` 15.1.3 is deprecated upstream,
and npm says so at install: `prom-client has been replaced by @prometheus-io/client`.
That is the official successor, still pre-1.0 (0.16.1). This repo stays on prom-client
on purpose: it is what you will inherit, and the 07a vocabulary transfers unchanged.
Names, labels and buckets do not change in the migration, so it is a code change and
not a dashboard change.

## 4. What you should see

One line per target, and the two counts that turn that list into a health check:

```
$ curl -s localhost:9090/api/v1/targets | jq -r '.data.activeTargets[] | [.labels.job, .scrapeUrl, .health] | @tsv'
alertmanager	http://alertmanager:9093/metrics	up
cadvisor	http://cadvisor:8080/metrics	up
grafana	http://grafana:3000/metrics	up
loki	http://loki:3100/metrics	up
node-exporter	http://node-exporter:9100/metrics	up
otel-collector	http://otel-collector:9464/metrics	up
payment-gateway	http://payment-gateway:8020/metrics	up
prometheus	http://localhost:9090/metrics	up
shop-api	http://shop-api:8000/metrics	up
shop-api-demo	http://shop-api:8000/metrics/demo	up
tempo	http://tempo:3200/metrics	up
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=count(up == 1)' | jq -r '.data.result[].value[1]'
11
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=count(up == 0)' | jq -r '.data.result'
[]
```

Every scrape records how many samples it found, which makes cost a query and not
an opinion (six of the eleven jobs, biggest first):

```
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sort_desc(sum by (job) (scrape_samples_scraped{job=~"cadvisor|grafana|shop-api|shop-api-demo|payment-gateway|otel-collector"}))' | jq -r '.data.result[] | [.metric.job, .value[1]] | @tsv'
cadvisor	6662
grafana	5288
shop-api	1072
shop-api-demo	260
payment-gateway	107
otel-collector	0
```

cAdvisor, not your app, is the expensive neighbour: 6662 samples a visit, because it
reports every container on the host. And `otel-collector` is 0 on purpose: that
exporter serves metrics travelling through the collector's pipeline, and the app sends
none, so `curl -s localhost:9464/metrics | wc -c` prints `0`.

Two last checks, read from stored data rather than trusted from config:
`count_over_time(up{job="shop-api"}[5m])` answers `shop-api 20`, which is the configured
15s, and `sum(scrape_samples_scraped)` answered `21366`. If the first drops below 20,
scrapes are failing rather than your query being wrong. Validate config *inside* the
container: on the host `promtool check config` fails on `rule_files`.

## 5. In a real multi-tenant e-commerce platform

Four tenants - `tenant_acme`, `tenant_globex`, `tenant_initech`, `tenant_umbrella` -
share one `shop-api` process, so one target serves them all. You cannot scrape initech
faster than acme: the job is the unit of scheduling, the label is the unit of splitting,
and chapter 19 leans on that when initech behaves as the noisy neighbour. What you can
do is give a spiky thing its own job and label:
`count by (job) ({__name__=~"shop_demo.*"})` answers `shop-api-demo 260`, all carrying
`tier="demo"` because of one line of YAML. Panels filter them out, and a runaway
endpoint is contained by commenting out a job.

Cost is `samples x visits x retention`. This stack takes 21366 samples per round, one
round every 15s: about 1424 samples a second, roughly 123 million a day. Putting
shop-api on 30s halves its share, 5s triples it, and retention multiplies again -
`--storage.tsdb.retention.time=6h` here because this is a learning laptop, 15d in
production. Prometheus also carries `--web.enable-remote-write-receiver` because Tempo's
metrics generator pushes span-derived series in (chapter 13c): a pull system with a hole.

## 6. When to use it, when not to

Pull plus `static_configs` when the target list only changes on deploy, when you want
a wedged process to show as `up == 0`, and when the app should not know where its
metrics go. Service discovery when containers come and go faster than you edit YAML.
Push - remote write, or a pushgateway for short batch jobs - when a target is
unreachable for minutes or lives less than one interval.

Intervals: 15s or 30s almost always; 5s only for spikes that live ten seconds and
are worth 3x storage; never 1s, because nothing in an HTTP service changes per
second in a way you can act on. Separate jobs for a second endpoint on one port, for
a tier you might drop during an incident, and for anything experimental. Keep the
service name identical in `docker-compose.yml`, in the `service` label and in Loki,
or log-to-metric jumping breaks silently.

## 7. Common mistakes

**The file is ahead of the process.** Live on this machine as I write: the YAML
on disk has twelve jobs, the running Prometheus has eleven loaded, because
`otel-collector-internal` (port 8888, `tier: internal`) was added after the last
successful reload.

```
$ curl -s localhost:9090/api/v1/status/config | jq -r '.data.yaml' | grep -c 'job_name'
11
$ grep -c 'job_name' prometheus/prometheus.yml
12
```

Nothing errors, the target simply never appears. The fix is
`curl -s -X POST localhost:9090/-/reload`, which works because Prometheus was
started with `--web.enable-lifecycle`; then make the two greps agree. `/-/config`
looks like the obvious check and returns `404 page not found` on v3.15.1 - the
loaded config comes from `/api/v1/status/config`, under the key `yaml`, not `yml`.

**Renaming a compose service leaves an orphan on the port.** When `api` became
`shop-api`, `docker compose up` did not stop the old container: it held port 8000, the
new service failed with "port is already allocated", and Prometheus kept scraping the
old identity. `docker compose up -d --remove-orphans` fixes the container and
`POST /-/reload` fixes Prometheus. A rename also splits history, because `job` and
`instance` are labels on every series.

**Scraping the same numbers twice.** If the app exported over OTLP as well as serving
`/metrics`, you would have two names for one counter: prom-client's
`shop_http_requests_total` and a collector-shaped variant with `_total` moved and units
scaled. Two dashboards that disagree, double storage, and any `sum` across both
counting twice.

**Believing 8888 is free.** The collector's internal telemetry owns 8888 inside the
container, so pointing the exporter at `0.0.0.0:8888` failed with
`listen tcp 0.0.0.0:8888: bind: address already in use`. The exporter moved to the
conventional OpenTelemetry port 9464, and the internal metrics need their own job
on 8888: two jobs, one container.

**Counting your own scrapes as traffic.** Every route is instrumented, metrics
endpoints included.
`sum by (route) (rate(shop_http_request_duration_seconds_count{route=~"/metrics.*"}[5m]))`
answered `{"route":"/metrics"} 0.09473684210526315` and
`{"route":"/metrics/demo"} 0.06666666666666667`: exactly one scrape per 15s, plus this
chapter's curl commands on top.

## 8. Try it yourself

Make one job expensive on purpose, then measure it.

1. In `prometheus/prometheus.yml`, add `scrape_interval: 5s` to the `shop-api`
   job (level with `job_name`, not inside `static_configs`), then
   `curl -s -X POST localhost:9090/-/reload`.
2. Wait two minutes and compare `count_over_time(up{job="shop-api"}[1m])` with
   the same for `job="payment-gateway"`, which you did not touch.

Hint: if step 2 still says 4, either the indentation put the setting where Prometheus
ignores it, or the reload never happened - count `job_name` in
`/api/v1/status/config` to tell the two apart.

Cleanup that restores the machine: delete the `scrape_interval: 5s` line, reload again,
confirm `count_over_time(up{job="shop-api"}[1m])` is back to 4. The extra samples you
stored age out inside the 6h retention window, so nothing has to be deleted.

## 9. Next

[08b - PromQL: rate, increase, vector matching, recording rules](08b-promql-intro.md)
