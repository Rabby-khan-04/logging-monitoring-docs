# 06b - Retention, rotation and the bill

Everything here was measured on the laptop stack (Loki 3101, Alloy 12345, API 8000) on
2026-10-29. The volume table is from the capture `.artifacts/loki-volume-retention.txt`, taken
while `./scripts/loadgen.sh` was running; the live numbers are smaller because traffic had
stopped when I re-ran them, which is itself the lesson: measure, do not guess.

## 1. Simple explanation

Your family buys milk every day. Three things stop the fridge from bursting, and none of them
is the same as the others: buy less milk (decided in the shop, before anything comes home),
throw away cartons whose date has passed (later, at home, and only if someone remembers), and
swap the bin bag under the sink (a full bag makes a mess however fresh the contents are). Log
systems have exactly these three problems, and nobody warns you until the disk fills at 3 a.m.

## 2. Real name

Three levers, and the classic mistake is treating them as one:

- **Ingestion-rate limiting** ("buy less"): never let a line in. Cheapest, because you pay no
  disk, no index entry and no later query scan. Levers: the app not writing it
  (`autoLogging.ignore`, 02c), the pipeline dropping it before `loki.write`, Loki's guards
  `ingestion_rate_mb`, `max_global_streams_per_user`, `reject_old_samples`.
- **Retention** ("throw out old cartons"): expiry applied *after* storage, by Loki's
  **compactor**. Set by `limits_config.retention_period`, per stream by
  `limits_config.retention_stream`, executed only if `compactor.retention_enabled: true`.
  Without that line your retention is a comment. It also fixes how far back a query may read,
  so longer retention means a slower dashboard, permanently.
- **Rotation** ("swap the bag"): the size cap on the log file Docker keeps on the host for
  every container, owned by the **log driver**, not by Loki. A log driver decides where a
  container's stdout goes: `json-file` (the default), `local` (TLogs, smaller), `syslog`,
  `journald`, `none`, `loki` (pushes straight to Loki - the legacy path this stack replaced
  with Alloy, which tails those files instead) and `fluentd` (an extra agent in between).
  `json-file` grows forever unless given `max-size` and `max-file`.
- **Tombstone / delete request**: the documented early-removal path (`DELETE
  /loki/api/v1/delete`, stored per `compactor.delete_request_store`) - the tool you reach for
  after a PII incident. It does not work on this install.
- **`bytes_over_time` / `bytes_rate`**: the queries reporting what a window costs, so retention
  arguments are numbers and not feelings.

## 3. Example

`loki/config.yaml`, as shipped:

```yaml
limits_config:
  retention_period: 72h            # global default; /config prints it as "3d"
  # Per-stream expiry. The ONLY accepted fields on Loki 3.7.9 are priority,
  # priority_label, selector and period - there is no `retention` field, and `period`
  # has a floor of 24h: setting 6h stopped the container (section 4).
  retention_stream:
    - priority: 1
      selector: '{service="shop-api", tenant_id="tenant_umbrella"}'
      period: 24h                  # the trial shop's lines expire after a day
  ingestion_rate_mb: 16
  max_global_streams_per_user: 10000
  reject_old_samples: true         # a line older than 168h is refused at push time

compactor:
  working_directory: /loki/compactor
  retention_enabled: true          # this line is what makes retention_period real
  delete_request_store: filesystem # the tombstone store; the API still 404s here
```

The cheapest lever is in the app (`app/src/middleware/requestContext.ts:38-43`):

```ts
autoLogging: {
  ignore: (req) => {
    const url = (req as Request).url ?? '';
    // never become lines at all. startsWith, not ===: `url === '/metrics'`
    // missed `/metrics/demo`, which was logged every 15s.
    return url.startsWith('/healthz') || url.startsWith('/readyz') || url.startsWith('/metrics');
  },
},
```

The second-cheapest is one Alloy stage before `loki.write`: `stage.match` on a selector with a
`stage.drop` inside keeps the line out of the push, and so out of the bill. That pair is from
the Alloy docs and was not exercised on this stack - test it on your own copy first.

This repo uses `json-file` with **no options at all**, so the difference is measurable:

```yaml
  shop-api:                            # what you would add, per service
    logging:
      driver: json-file
      options:
        max-size: "10m"                # per file
        max-file: "3"                  # three files: the on-host window is ~30m
```

Applying it takes a recreate (`docker compose up -d`), not a restart; and `max-file` too small
shrinks the window Alloy can tail, so lines are lost before they are ever shipped.

## 4. What you should see

The bill, measured under load (`.artifacts/loki-volume-retention.txt`):

```
=== bytes ingested per stream, last 15m (real cost signal) ===
   shop-api = 3720.7 KiB
   payment-gateway = 408.5 KiB
   otel-collector = 83.2 KiB
   [...]
=== per-tenant log volume (checkout funnel) ===
   tenant_initech = 2000 lines
   tenant_acme = 1482 lines
   tenant_globex = 1356 lines
   tenant_umbrella = 1284 lines
```

Re-run live with the generator stopped, shop-api was 969 KiB per 15 minutes instead of
3720.7 KiB: traffic moves the bill more than config does. Under load it ran at 14.26 lines/s
and payment-gateway at 2.98, and every other container together was smaller than shop-api
alone. Which part of it is worth keeping? The access lines are most of it:

```bash
$ curl -sG localhost:3101/loki/api/v1/query --data-urlencode 'query=sum(bytes_over_time({service="shop-api"} |= "request completed" [15m])) / sum(bytes_over_time({service="shop-api"} [15m]))' | jq -r '.data.result[0].value[1]'
0.6074853715978342
```

Retention as the running process reports it - `72h` printed as `3d`, and the last line is
another component's default, not ours:

```bash
$ curl -s localhost:3101/config | grep -E "^  (retention_enabled|delete_request_store|retention_period):"
  retention_enabled: true
  delete_request_store: filesystem
  retention_period: 3d
  retention_period: 0s
```

`grep -A5 retention_stream:` prints the per-stream rule as `period: 1d` with our selector
unchanged. The floor, hit for real: this is what the container printed when `period` was set to
`6h`, and it exited on it.

```
CONFIG ERROR: invalid limits_config config: retention period must be >= 24h was 6h
```

The cheapest legal per-stream expiry is therefore one day, because deletes can only happen on
wall boundaries; how much extra a rule holds because of that is my reading of the message, not
something I measured. The delete API, which does not work on this install:

```bash
$ curl -s -w '\nHTTP %{http_code}\n' -X DELETE "localhost:3101/loki/api/v1/delete?query=%7Bservice%3D%22shop-api%22%7D&start=$(( $(date +%s) - 600 ))000000000&end=$(date +%s)000000000"
could not find delete request with given id

HTTP 404
$ curl -s -w '\nHTTP %{http_code}\n' localhost:3101/loki/api/v1/delete
[]

HTTP 200
```

`dry_run=true` gives the identical 404 and the listing answers `[]`, so the request was never
stored. The ruler path is closed too (capture `.artifacts/business-and-delete.txt`): `GET
/loki/api/v1/rules` returns `{"status":"success","data":{"groups":[]},"errorType":"","error":""}`
and reading one rule group returns `HTTP 405` with `GetRuleGroup unsupported in rule local
store`. A probe line pushed earlier was still readable afterwards, so the honest summary is
that **nothing here can be deleted early**: the working alternatives are a shorter
`retention_period`, a filter in Alloy, and never ingesting the field.

And the store Loki does not own - the file on the host that Alloy tails:

```bash
$ docker inspect observability-learn-shop-api-1 -f '{{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}} {{.LogPath}}'
json-file {} {} /var/lib/docker/containers/cd01c8d52232[...]-json.log
$ docker logs --since 15m observability-learn-shop-api-1 | wc -c
920498
```

`LogConfig.Config` is `{}`: no `max-size`, no `max-file`, so that file grows for the life of the
container and Loki's 72h retention will not shrink it by one byte. I could not measure its total
size: `/var/lib/docker/` is root-owned (`du` returned `Permission denied`) and the Loki image
has no shell (`exec: "sh": executable file not found in $PATH`), so on-disk volume is the one
number this chapter did not get.

## 5. In a real multi-tenant e-commerce platform

`tenant_umbrella` is on a 30-day trial and runs its own load tester around the clock. Under the
generator shop-api pushed 3720.7 KiB into Loki in 15 minutes, 60.7% of it plain access lines,
and umbrella's share of the tenancy split was 1284 lines against initech's 2000.

The noisy neighbour shows in log volume before it shows in latency: a tenant that triples its
traffic triples `bytes_over_time` for `service="shop-api"` today, from one query, with no
percentiles and no alert rule involved (08b is where latency numbers are even introduced). If
per-tenant latency is your only per-tenant signal, you meet umbrella when the checkout is
already slow and the money already spent. Umbrella's logs are also worth less than initech's,
which is what `retention_stream` is for: that shop expires in 24h while everyone else keeps
72h, and the rule is only possible because `tenant_id` is a bounded stream label - four shops,
in every query support runs, therefore priceable per customer. It is coarse: the 24h floor
makes this "one day versus three days", never "one hour".

## 6. When to use it, when not to

In order of preference: **never ingesting it** (a line the app does not write costs nothing at
any later stage; one `ignore` rule here removes a scrape line every 15 seconds); **short
retention** (72h is an honest laptop-sized investigation window - long enough to answer "what
paged us yesterday", short enough to keep a 15-minute count at 1.8 MB scanned); **per-stream
retention** when one bounded group of streams is worth less (a trial tenant, a chatty debug
service; mind the 24h floor); **rate limits** as a fuse and not a plan (`ingestion_rate_mb`
sheds data with a push error during a flood, protecting the store but saying nothing about what
to keep); and **rotation** on the Docker side always, since it is the only thing between a
chatty container and a full host disk and Loki cannot help you there.

Avoid: the delete API for PII (it 404s here, and even where it works a tombstone is an audit
event, not a privacy policy - 03a's redaction is the answer); retention as your cost control
when most of the volume is lines nobody reads (measured 60.7%); retention shorter than your
incident window, because there is no archive here and a 24h store makes "it happened on Sunday"
unanswerable; rotation so tight that Alloy's tail lag exceeds the on-host window, which loses
lines silently; and per-customer expiry keyed on anything unbounded, because retention selects
on stream labels only. Noise is billed like volume: plain-text infrastructure lines you never
parse still occupy chunks, and `{service=~".+"}` over a long window reads every one.

## 7. Common mistakes

1. **Writing `retention_period` without `retention_enabled: true`** - the compactor deletes.
2. **Treating the delete API as the escape hatch**: 404 `could not find delete request with
   given id`, with and without `dry_run`, while `GET` returns `[]`.
3. **Trying `period: 6h` and losing the container**, or copying a `retention` field name from an
   old tutorial: the fields are `priority`, `priority_label`, `selector`, `period`, and the
   floor is 24h. I verified those four names are accepted, not what `priority` changes.
4. **Believing Loki retention covers the host**, or adding a `logging:` block and running
   `docker compose restart`: `/var/lib/docker/containers/` is a separate store, and restart
   does not re-read the compose file.
5. **Counting lines when the bill is in bytes**, and paying for lines that should never have
   been written: 14.26 lines/s sounds trivial, 3720.7 KiB per 15 minutes is ~358 MiB a day for
   one service, 60.7% of it access lines. Volume is one LogQL query away; latency is not.

## 8. Try it yourself

Price your own stack, then decide which lever you would pull.

```bash
# A: who talks the most, in bytes, last 15m?
curl -sG localhost:3101/loki/api/v1/query \
  --data-urlencode 'query=sum by (service) (bytes_over_time({service=~".+"} [15m]))' | jq -r '.data.result[] | (.metric.service // "?") + " " + (.value[1])'
# B: the same money split by tenant, over a window wide enough to be honest
curl -sG localhost:3101/loki/api/v1/query \
  --data-urlencode 'query=sum by (tenant_id) (bytes_over_time({service="shop-api"} [1h]))' | jq -r '.data.result[] | (.metric.tenant_id // "(no tenant)") + " " + (.value[1])'
```

Multiply A's top number by 96 for a day, by 7 for a week, then by 30 for what a 90-day
retention would cost instead of 72h. B is the number for the meeting where someone asks why the
trial tenant costs as much as a paying one.

Hint: `bytes_over_time` counts bytes and `count_over_time` counts lines, and only the first
matches a disk bill. An empty answer is not an error - the same B query with `[15m]` returned
nothing here once the load generator had stopped, so widen the window or run
`./scripts/loadgen.sh 60 5` first. A series with no `tenant_id` is the startup line plus
requests from an unknown tenant: the `{"metric":{}}` series from 06a.

Cleanup: nothing to undo - you ran read-only queries and the shipped config stays as it is. If
you tried the `6h` experiment on your own copy, put `period` back before starting Loki, because
it exits at boot, and confirm with `curl -s localhost:3101/config | grep -A5 retention_stream:`.
Probe lines from 06a stay until the compactor's 72h pass removes them: there is no delete here,
so the correct cleanup is having made few of them.

## 9. Next

[07a - Metric types](07a-metric-types.md): the counter that answers the volume question without
reading a single log line.
