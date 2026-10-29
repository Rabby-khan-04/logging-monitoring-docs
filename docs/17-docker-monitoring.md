# 17 - Docker and container monitoring

The last chapter looked at the shop. This one looks at the boxes the shop runs
in: CPU, memory, restarts, disk. In Compose these are cgroups; in Kubernetes
they are requests and limits; the metrics and the failure modes are the same.

## 1. Simple explanation

A restaurant kitchen has a gas meter, a fridge thermometer and a smoke alarm.
None of them tells you whether customers like the food, but if the gas runs out
or the fridge warms up, no amount of good cooking helps.

A container is a kitchen with a fixed budget: this much CPU, this much memory,
this much disk. Docker's bookkeeping (cgroups) records what each kitchen used.
If a kitchen exceeds its memory budget, the system does not ask it to tidy up;
it locks the door and turns off the lights. That event has a name, and finding
it is the point of this chapter.

## 2. Real name

- **cgroup v2**: the kernel mechanism that accounts for and limits CPU, memory
  and I/O per container. Modern distributions, including this kernel 7.0, use
  v2.
- **cAdvisor**: Google's container advisor, scraping cgroup numbers from the
  Docker daemon and exposing them as Prometheus metrics.
- **node_exporter**: the same idea for the host itself: CPU, memory, disk,
  filesystem, network.
- **Working set**: memory a container is actively using; unlike total cgroup
  usage it excludes inactive page cache, which the kernel can reclaim. This is
  the number to alert on.
- **Limit** (`mem_limit` in Compose, `resources.limits` in Kubernetes): the
  ceiling. Exceeding it means OOM kill. A **request** is the reservation used
  for scheduling, not a ceiling.
- **OOMKilled**: the container's exit reason when the kernel killed it for
  exceeding the memory limit. Docker often reports exit code 137.
- **Throttling**: a container that hits its CPU quota is paused for the rest of
  the period. Invisible in average CPU, visible in latency.

## 3. Example

Each service in `docker-compose.yml` gets a memory ceiling, and cAdvisor is a
service like any other:

```yaml
  tempo:
    image: grafana/tempo:3.1.1
    # 512 MiB is enough for this trace volume. Without a limit, one queried
    # trace with a huge attribute can take the laptop down with it.
    mem_limit: 512m

  cadvisor:
    # google/cadvisor is stale (v0.33.0, 2021) and does not understand cgroup
    # v2 on this kernel; the maintained images are on gcr.io.
    image: gcr.io/cadvisor/cadvisor:v0.55.1
    command:
      - --docker_only=true          # do not inventory every cgroup on the host
      - --housekeeping_interval=15s # how often the numbers are refreshed
    privileged: true
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
      - /dev/disk/:/dev/disk:ro
    mem_limit: 256m
```

Memory as a percentage of the limit, correctly:

```promql
# Working set / limit, only for series cAdvisor has seen in the last minute.
# The age filter is not optional; see section 4 for why.
(
  container_memory_working_set_bytes{name=~"observability-learn-.*"}
  / on(id) group_left
  container_spec_memory_limit_bytes{name=~"observability-learn-.*"}
) * 100
and on(id)
(time() - container_last_seen{name=~"observability-learn-.*"} < 60)
```

CPU rate, and restarts detected as a change in start time:

```promql
# CPU cores used. 1.0 means one full core, not 100% of the host.
sum by (name) (rate(container_cpu_usage_seconds_total{name=~"observability-learn-.*"}[5m]))

# A container restart makes container_start_time_seconds jump. changes()
# counts that jump within the window.
changes(container_start_time_seconds{name=~"observability-learn-.*"}[1h])
```

Host disk, from node_exporter:

```promql
1 - (
  node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay"}
  /
  node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"}
)
```

## 4. What you should see

`docker stats` is the quickest sanity check, and it immediately shows a risky
container (Tempo at 94.5% of its 512 MiB limit):

```bash
$ docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' | sort -k4 -r | head -5
observability-learn-tempo-1       0.73%   484MiB / 512MiB    94.53%
observability-learn-grafana-1     0.83%   253.2MiB / 384MiB   65.93%
observability-learn-prometheus-1  1.46%   224.4MiB / 512MiB   43.82%
observability-learn-loki-1        0.49%   118.6MiB / 640MiB   18.53%
observability-learn-postgres-1    0.00%   18.16MiB / 384MiB    4.73%
```

The naive PromQL version gave a very different answer for Prometheus: 59%,
while the same container was clearly using 43.8% of its limit. Adding the two
per-series percentages from below (74.3% for the dead container, 43.8% for the
live one) gives 118%, which is impossible and therefore useful: the number is
not merely imprecise. The cause is a real trap, not a rounding error. Prometheus had just
been recreated, and cAdvisor kept reporting **both** the old container and the
new one under the same `name` label:

```bash
$ curl -sG localhost:9090/api/v1/query --data-urlencode \
  'query=container_memory_working_set_bytes{name="observability-learn-prometheus-1"}' \
  | jq -r '.data.result[] | [.metric.id, .value[1]] | @tsv'
/system.slice/docker-d1f7eca2a15da83adf839f5c359135162b23dc9ce563e86e084f1039b9f31c6e.scope  398745600
/system.slice/docker-b31164ac902abfb9f376a29819f00475bfcfcca3698d868ebefc763a2b17ac4d.scope  234971136
```

Two series, one dead container. Summing by `name` adds them; joining on `name`
fails with `multiple matches for labels: many-to-one matching must be explicit`.
Filtering on the freshness of `container_last_seen`, or aggregating by `id`,
gives the truthful number:

```bash
$ # ... * 100 and on(id) (time() - container_last_seen{...} < 60)
/system.slice/docker-b31164ac902abfb9f376a29819f00475bfcfcca3698d868ebefc763a2b17ac4d.scope  43.81256103515625
```

43.81% is what `docker stats` showed. The stale series ages out on its own, but
any alert built on the naive query would have paged during the recreation.

Host view, same moment:

```bash
$ # disk used on /, memory used, 1h restarts
0.4541627792179772      # 45.4% of /dev/sda2 used
77.26695145202879       # 77.3% of host memory used
(empty)                 # no changes(container_start_time_seconds[1h]) > 0
```

No container restarted in the last hour, which is the expected state of a
healthy learning stack. An OOM kill would show up here as a restart and in
`docker inspect` as a non-zero exit:

```bash
$ docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}' observability-learn-tempo-1
false 0
```

## 5. In a real multi-tenant e-commerce platform

At the container level the noisy neighbour is literal. tenant_initech's chaos
traffic goes through the same shop-api process, but the resource that runs out
is shared: the Postgres container's memory, the host disk that Loki writes to,
the CPU that Tempo needs to answer a trace query. A per-tenant dashboard will
not show that; per-container metrics will.

Two production habits come from this:

- **Set limits everywhere.** A container without a limit can consume the host
  and take down its neighbours; a container with a limit that is too low gets
  OOM-killed under load. The right number is measured (peak working set plus
  headroom), not copied from a blog.
- **Watch disk as a first-class resource.** Logs and trace storage grow; this
  stack has 6h of Prometheus retention and a Loki volume. `DiskFillingUp` is a
  page because a full disk silently stops ingestion, and then the alerts that
  would have told you are the first thing to disappear.

Container restarts are also a deployment signal. A crash loop after a release
looks like "errors everywhere" in the application dashboards; in cAdvisor it
is one series with a start time two minutes old and a restart count above zero.
That is the fastest way to answer "did we just deploy something broken?".

## 6. When to use it, when not to

Use container metrics for capacity planning, OOM investigations, restart
detection and "which component is eating the box". Use host metrics for disk,
network and anything the kernel owns. Together they answer the layer below the
application.

Do not page on CPU usage alone. A busy container is not a broken one; the page
should be a user symptom, with CPU as evidence. Do not alert on
`container_memory_usage_bytes` when you mean working set: page cache is
reclaimable and the resulting alert is both noisy and wrong. Do not run
cAdvisor with its default inventory on a busy host: it reports every container
from every project (here it also sees `infra-redis-1` and `proxy-learn-nginx`),
which inflates cardinality and confuses queries. `--docker_only=true` and a
`name=~"observability-learn-.*"` filter keep this stack's metrics to this stack.

Cost: cAdvisor itself used about 8% of one core while scraping this small host,
which is not free. On a large node, sample less often and keep only the series
you alert on. `container_fs_usage_bytes` looked attractive but had 65 series
and none matching our container names on this install; do not build a dashboard
on a metric you have not seen return data. `container_cpu_cfs_throttled_periods_total`
returned no series at all. The absence of a metric is itself a finding.

## 7. Common mistakes

1. **`google/cadvisor` from Docker Hub.** It stops at v0.33.0 and does not
   understand cgroup v2; the container starts and reports almost nothing. Use
   the `gcr.io/cadvisor/cadvisor` image, pinned.
2. **Joining on `name`.** Container names are reused when a container is
   recreated, and stale series coexist with fresh ones. Join on `id`, or filter
   by `container_last_seen` freshness.
3. **Assuming a deleted container's series disappear at once.** They linger
   until cAdvisor's housekeeping catches up; alerts must be robust to that.
4. **Alerting on total memory usage instead of working set.** Reclaimable cache
   makes a healthy container look minutes from death; then it never dies and
   the alert loses credibility.
5. **Forgetting the host.** A container can be within its limit while the host
   disk is at 99%; both layers need a metric.
6. **Reading exit code 137 as "SIGKILL by a person".** It usually means the
   kernel's OOM killer; confirm with `.State.OOMKilled`.
7. **Building on metrics that do not exist here.** Filesystem usage per
   container and CFS throttling were empty on this cgroup v2 setup; check
   before you promise a panel.

## 8. Try it yourself

Find the container closest to its memory limit, then check whether it has been
restarted or OOM-killed.

```bash
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' \
  | sort -k3 -r | head -5

# For the top container, e.g. tempo:
docker inspect --format '{{.State.OOMKilled}} exit={{.State.ExitCode}} started={{.State.StartedAt}}' \
  observability-learn-tempo-1
```

**Hint:** Tempo sits near 94% of a 512 MiB limit after a few hours of trace
storage. Working set is 475 MiB; the rest is reclaimable cache. If you want to
see the difference between the two numbers, compare
`container_memory_working_set_bytes` with `container_memory_usage_bytes` for
the same container.

**Cleanup:** do not raise the limit just to make the graph comfortable. Either
lower Tempo's `mem_limit` pressure by shortening trace retention, or raise the
limit deliberately and note it. `docker compose up -d --force-recreate tempo`
applies a changed limit, and creates the duplicate-series situation from
section 4 - good practice for the freshness filter.

## 9. Next

You now know how to see a container dying. [18 - Incidents](18-incidents.md)
is about what humans do in the first ten minutes after they are told.
