# 14 - Database monitoring

Chapter 13c's waterfall let the database off the hook, once. This chapter does it
with numbers every time: what the server logged, what the statement statistics say,
how many connections you hold, and what a query plan means. `EXPLAIN` is built from
zero here; if you have my SQL notes, read their EXPLAIN chapter afterwards - this
chapter does not depend on them.

## 1. Simple explanation

Imagine a library desk. Every time someone asks for books, the librarian writes
down what *kind* of ask it was ("all the blue books on shelf 3"), how many times it
came today, and how long it took in total.

Three tricks make that useful. The *total* pile matters more than the slowest
single ask: a two-minute errand done once is nothing next to a one-second errand
done a thousand times. A card catalogue turns "find one book" into a walk to one
shelf instead of every shelf. And if every desk is busy and people are queuing to
speak to a librarian, the problem is not reading speed - nobody is free. So:
measure which asks eat the time, decide whether an ask is walking or reading, and
count the queue at the desk.

## 2. Real name

- **Slow query log** - Postgres logging statements over a threshold:
  `log_min_duration_statement=100` means "over 100 ms goes to the log". Targeted;
  `log_statement=all` logs everything and does not belong on a busy box. Its
  sampled twin is `log_min_duration_sample` + `log_statement_sample_rate`: log a
  fraction of statements above a *lower* threshold, to see the 10-100 ms band
  without logging all of it.
- **`pg_stat_statements`** - an extension with per-normalised-statement counters:
  `calls`, `total_exec_time`, `mean_exec_time`, `max_exec_time`, `rows`, `queryid`.
  Normalising means `WHERE tenant_id = 'tenant_acme'` and `= 'tenant_globex'` are
  the *same* statement with different parameters, so one row covers a whole code
  path. Needs `shared_preload_libraries` (fixed at server start) and
  `pg_stat_statements.track=top`, which counts the outer statement only.
- **Connections and the pool** - `max_connections` is the server's limit (100
  here); the app's `pg.Pool` has `max: 8` per process. `pg_stat_activity` gives one
  row per server-side connection with a `state`: `active` = running, `idle` = held
  but quiet, `idle in transaction` = holding a slot and often locks. Pool counters
  are `totalCount`, `idleCount`, `waitingCount`; `waiting` means requests that have
  not got a connection at all yet.
- **`EXPLAIN`** - asks the planner to print *how* it will run a statement.
  `EXPLAIN ANALYZE` runs it and prints real per-node timings and rows; `BUFFERS`
  adds pages touched, where I/O cost shows up.
- **Plan shapes** - `Seq Scan` reads the whole table (fine for "everything", bad
  for "one row"); `Index Scan` walks a btree then fetches heap rows; `Index Only
  Scan` skips the heap when the visibility map says a page is all-visible; `Nested
  Loop` runs the inner side once per outer row (great for few rows, terrible for
  many); `Hash Join` hashes both sides (great for many); `Parallel Seq Scan` splits
  a big scan over worker processes. `Rows Removed by Filter` is work thrown away;
  `shared hit` was in RAM, `read` came off disk.
- **`CREATE INDEX` vs `CONCURRENTLY`** - the plain form takes a lock that blocks
  writes for its whole duration (187.78 ms on this 16 MB table). The concurrent form
  does not block, costs more work, and cannot run in a transaction.

## 3. Example

Server flags from `docker-compose.yml`. A `command:` change applies only on
`docker compose up -d` (recreate): **`docker compose restart` does not re-read the
compose file**, a trap that cost me an hour.

```yaml
  postgres:
    command:
      - -c
      - shared_preload_libraries=pg_stat_statements   # must be loaded at server start
      - -c
      - pg_stat_statements.track=top
      - -c
      - log_min_duration_statement=100                # >100ms reaches the log
      - -c
      - log_statement_sample_rate=1.0
      - -c
      # quoted trailing space required: YAML strips an unquoted one, and without
      # it the db name glued itself to the level, producing "shopLOG:"
      - "log_line_prefix=%m [%p %u] %d "
```

The queries you run, all from the host with the pattern
`docker compose exec -T postgres psql -U shop -d shop -c "..."`:

```sql
-- What is in force, from the server itself.
SELECT name, setting, unit FROM pg_settings WHERE name LIKE 'log_%' OR name = 'max_connections';

-- TOP 8 by TOTAL time: the pile, not the slowest one-off.
SELECT calls, round(mean_exec_time::numeric,2) AS mean_ms, round(max_exec_time::numeric,2) AS max_ms,
       round((100*total_exec_time/sum(total_exec_time) OVER ())::numeric,1) AS pct_total, left(query,70) AS query
  FROM pg_stat_statements WHERE calls > 50 ORDER BY total_exec_time DESC LIMIT 8;

-- The queue at the desk, and the state of the library.
SELECT state, count(*) FROM pg_stat_activity GROUP BY state;
SELECT round((100.0*blks_hit/nullif(blks_hit+blks_read,0))::numeric,2) AS cache_hit_pct,
       xact_commit, xact_rollback, deadlocks, temp_files FROM pg_stat_database WHERE datname='shop';

-- The plan. ANALYZE RUNS the statement: never on a write you did not mean.
EXPLAIN (ANALYZE, BUFFERS) SELECT id, sku, quantity FROM order_items WHERE order_id = 4321;
```

The app side, `app/src/lib/db.ts` - one wrapper for every query. Read what it logs.

```ts
export const pool = new pg.Pool({
  max: config.dbPoolMax,          // 8 per process, deliberately
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000, // wait 2s for a connection, then error
});
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? '100');

async function query(name, text, params = []) {
  const client = await pool.connect();
  const start = process.hrtime.bigint();
  try {
    if (ctx.tenantId) {           // tag the session, every query: one extra roundtrip
      await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', ctx.tenantId]);
    }
    return await client.query(text, params);
  } finally {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    client.release();
    dbQueryDurationSeconds.observe({ query: name }, ms / 1000);
    if (ms > SLOW_QUERY_MS) {
      // Duration and query name only. NEVER the parameter values: they can
      // carry emails, addresses and card data.
      logger.warn({ query_name: name, duration_ms: Math.round(ms),
                    slow_query_threshold_ms: SLOW_QUERY_MS }, 'slow query');
    }
  }
}
```

`query` is the label, and it is the statement *shape*, not a per-parameter
identity: the same SQL with another `order_id` or tenant must land on the same
series or the histogram explodes (07b). Postgres' `queryid` normalisation does the
same thing server-side, which is why an app label and a `pg_stat_statements` row
describe one another. In `app/src/lib/metrics.ts` the pool gauge is *collected* at
scrape time - `collect()` sets `state="total"|"idle"|"waiting"` from
`pool.totalCount / idleCount / waitingCount` - so it costs nothing per request, and
`prometheus/alert_rules.yml` pages on the queue:

```yaml
      - alert: DatabasePoolWaiting
        expr: max by (instance) (shop_db_pool_connections{state="waiting"}) > 2
        for: 2m
        labels: { severity: page }
        annotations:
          runbook: "Postgres: SELECT state, count(*) FROM pg_stat_activity GROUP BY state; then /api/pool-hog is the usual cause"
```

`GET /api/pool-hog?seconds=8` is the intentional way to make connections wait: it
runs `SELECT pg_sleep($1)`, holding a connection while doing nothing.

## 4. What you should see

Live from `pg_settings`: `log_min_duration_statement = 100` ms,
`log_statement = none`, `log_min_duration_sample = -1`,
`log_statement_sample_rate = 1`, `log_parameter_max_length = -1` (unlimited),
`max_connections = 100`, `shared_preload_libraries = pg_stat_statements`,
`pg_stat_statements.track = top`. The mismatch the compose file ships: the sample
*rate* is set while the sample *threshold* is `-1`, so the sampling path logs
nothing.

Top 8 by total time, from `.artifacts/db/pg-stat-capture.txt`:

```text
 calls | mean_ms | max_ms | pct_total |                                 query                                  
-------+---------+--------+-----------+------------------------------------------------------------------------
    87 |   21.96 | 296.28 |      91.7 | SELECT o.status, count(*) AS orders, coalesce(sum(o.total_cents), $2) 
   354 |    0.15 |   5.92 |       2.5 | INSERT INTO orders (tenant_id, request_id, customer_hash, status, tota
   318 |    0.12 |   4.23 |       1.8 | INSERT INTO payments (order_id, tenant_id, provider, provider_charge_i
   354 |    0.08 |   1.46 |       1.4 | INSERT INTO order_items (order_id, sku, quantity, unit_price_cents) SE
   354 |    0.05 |   0.91 |       0.8 | SELECT p.sku, p.price_cents, i.quantity FROM unnest($1::text[], $2::in
  2186 |    0.01 |   0.31 |       0.6 | SELECT set_config($1, $2, $3)
   350 |    0.03 |   0.35 |       0.5 | UPDATE orders SET status = $2 WHERE id = $1
   281 |    0.03 |   1.93 |       0.4 | SELECT id, sku, title, price_cents FROM products WHERE tenant_id = $1 
```

One report is 91.7% of all database time. Re-running it after more traffic keeps the
shape and grows the counts: 710 calls, mean 20.08 ms, 88.4% of total, and
`SELECT set_config($1, $2, $3)` at 26,019 calls, 0.01 ms each. Sorted by mean, the
same view is dominated by one-off seed inserts at 1521.72 ms that never happen
again. And the column I invented on the first try, with the answer from
`pg_stat_statements` 1.12 on Postgres 18.6:

```text
ERROR:  column "total_exec_calls" does not exist
LINE 1: SELECT total_exec_calls FROM pg_stat_statements LIMIT 1;
               ^
```

Slow log, `log_min_duration_statement=100`. Line 1 is the index build from
`.artifacts/db/postgres-health.txt`; lines 2-3 are my `/api/pool-hog` burst, live
from `docker compose logs postgres`:

```text
postgres-1  | 2026-10-29 06:56:23.443 UTC [4653 shop] shopLOG:  duration: 187.780 ms  statement: CREATE INDEX idx_order_items_order_id ON order_items (order_id); ANALYZE order_items;
postgres-1  | 2026-10-29 08:22:05.353 UTC [8937 shop] shop LOG:  duration: 8007.458 ms  execute <unnamed>: SELECT pg_sleep($1)
postgres-1  | 2026-10-29 08:22:05.353 UTC [8937 shop] shop DETAIL:  Parameters: $1 = '8'
```

Line 1 shows the prefix bug (`shopLOG:`, no space, before the quoted trailing space
fixed it). Line 3 is the privacy lesson: **the server log carries the parameter
values** even though `db.ts` never logs them (03b), and Alloy scrapes container
stdout as plain text, so application redaction never touches it -
`log_parameter_max_length = 0` keeps durations and statement text without values.
The app's own line for the same event (Loki, `{service="shop-api"} |~ "slow query"`)
carries duration, name, request and trace ID, and no parameters:

```json
{"level":"warn","service.name":"shop-api","request_id":"fa0143a4-622a-48f5-bb0c-45aa367f1979","trace_id":"cabf66cc8457c8daeca001446798381e","span_id":"3a7b9c349be4e960","query_name":"demo.pg_sleep","duration_ms":8009,"slow_query_threshold_ms":100,"msg":"slow query"}
```

Pool exhaustion, live during a 24-request burst against a pool of 8
(`curl -s localhost:8000/metrics | grep '^shop_db_pool_connections'`):

```text
shop_db_pool_connections{state="total"} 8
shop_db_pool_connections{state="idle"} 0
shop_db_pool_connections{state="waiting"} 16
```

Ten seconds later: `total 8`, `idle 8`, `waiting 0`. `pg_stat_activity` agreed:
`active | 9` during the burst (8 pool connections plus my psql), `active 1 / idle 1`
when quiet, against `used=10 of max=100`.

Health, from `.artifacts/db/postgres-health.txt`:

```text
 cache_hit_pct | xact_commit | xact_rollback | deadlocks | temp_files 
---------------+-------------+---------------+-----------+------------
         99.80 |        7055 |             1 |         0 |          4
```

Nearly every page came from RAM; 1 rollback against 7,055 commits says nothing is
aborting; `deadlocks 0` says no lock cycles; `temp_files 4` says four sorts or
hashes did not fit in `work_mem` and spilled to disk - here the seed job, in
production a query to go and find. Sizes: `order_items 16 MB / 168,953 rows`,
`orders 3968 kB / 12,470`, `payments 2320 kB`, `products 104 kB / 160`,
`tenants 32 kB / 4`. Which is also why a 99.80% hit rate on a 16 MB table teaches
you *nothing* about a production database that does not fit in RAM, where `read`
shows up in plans and the hit ratio is a number you watch fall.

THE missing index, the honest centrepiece: `db/init/01_schema.sql` has no index on
`order_items(order_id)`, on purpose. The tenant-summary report for
`tenant_initech`, before (`explain-BEFORE-index.txt`, inner nodes elided):

```text
 Sort  (cost=5471.02..5471.02 rows=1 width=26) (actual time=24.713..27.451 rows=3.00 loops=1)
   Buffers: shared hit=2488
         ->  Parallel Seq Scan on order_items oi  (cost=0.00..2572.59 rows=99359 width=8) (actual time=0.005..4.248 rows=84430.50 loops=2)
               Buffers: shared hit=1579
 Execution Time: 27.569 ms
```

After `CREATE INDEX idx_order_items_order_id ON order_items (order_id);`
(`explain-AFTER-index.txt`):

```text
 Sort  (cost=5180.37..5180.38 rows=1 width=26) (actual time=33.989..33.991 rows=3.00 loops=1)
   Buffers: shared hit=9684 read=67
         ->  Nested Loop  (cost=448.91..4703.99 rows=63515 width=14) (actual time=2.994..21.992 rows=63164.00 loops=1)
               ->  Index Only Scan using idx_order_items_order_id on order_items oi  (cost=0.29..0.70 rows=14 width=8) (actual time=0.001..0.002 rows=13.73 loops=4599)
                     Index Searches: 4599
                     Buffers: shared hit=9231 read=67
 Execution Time: 34.070 ms
```

The index made this query **slower**: 27.569 ms to 34.070 ms, 2,488 buffers to
9,684. Same table, a point lookup, `point-query-BEFORE.txt` then
`point-query-AFTER.txt`:

```text
 Seq Scan on order_items oi  (cost=0.00..3690.00 rows=14 width=30) (actual time=3.141..9.068 rows=12.00 loops=1)
   Filter: (order_id = 4321)   Rows Removed by Filter: 168904
 Execution Time: 9.103 ms

 Index Scan using idx_order_items_order_id on order_items oi  (cost=0.29..8.54 rows=14 width=30) (actual time=0.269..0.272 rows=12.00 loops=1)
   Index Cond: (order_id = 4321)   Buffers: shared hit=5 read=1
 Execution Time: 0.302 ms
```

9.103 ms to 0.302 ms - 30x. So an index is not a speed dial, it is a bet on the
access pattern. Initech holds 37% of the table, so "sum this tenant's items" is
cheaper as one parallel sequential read of 1,579 pages than as 4,599 index descents
returning 63,164 rows over 9,684 pages - while "items of order 4321" touches 6
pages instead of 1,579. Only `EXPLAIN (ANALYZE, BUFFERS)` tells you which one you
have; the point query today, index dropped again, is back to
`Seq Scan ... Rows Removed by Filter: 173482 ... Execution Time: 8.152 ms`.

## 5. In a real multi-tenant e-commerce platform

Four shops, one Postgres: `tenant_acme`, `tenant_globex`, `tenant_initech`,
`tenant_umbrella`. Initech holds 4,500 of the 12,000 seeded orders - 37%, the
configured noisy neighbour (the load scripts pushed it to 7,346 of 17,012 when last
counted, still the largest by far). That 91.7%-of-database-time report is theirs:
87 calls, mean 21.96 ms, `max_exec_time` 296.28 ms, so one Initech dashboard
refresh occasionally eats half a second of a shared Postgres - and Acme, Globex and
Umbrella feel it as their own p95. The noisy neighbour is not a metaphor, it is one
tenant's plan inside everyone else's latency histogram.

Per-tenant attribution is what `set_config('app.tenant_id', ..., false)` buys:
because `db.ts` runs it before every statement, `pg_stat_activity` can name the
tenant without reading app code - useful at 3 a.m. with 8 active statements and no
idea whose they are. The price is one extra round trip per query, visible as those
2,186 `SELECT set_config($1, $2, $3)` calls at 0.01 ms: negligible here, worth
rethinking at 10,000 queries per second, where you would set it once per connection
checkout, or use `application_name`.

The production version is the same four measurements with rules: per-tenant
connection ceilings, or a pooler per tenant, so one shop cannot take all 100 slots;
`pg_stat_statements` scraped into Prometheus keyed on statement shape; the slow log
shipped to Loki with `log_parameter_max_length=0` or its `DETAIL` lines redacted
(03b); and `CREATE INDEX CONCURRENTLY` on a schedule, since the plain form blocked
writes for 187.78 ms even on this toy table.

## 6. When to use it, when not to

- **Slow query log**: on, with a threshold near your SLO. Not enough alone, twice
  over: it only fires *over* the threshold, so the 5 ms query called 500 times per
  request never appears (`pg_stat_statements`' job), and it is all-or-nothing where
  you want a sample - hence `log_min_duration_sample` + `log_statement_sample_rate`,
  which need *both* set. Never `log_min_duration_statement=0` or
  `log_statement=all` on a busy box: the log becomes the bottleneck.
- **`pg_stat_statements`**: the cheapest "where did the time go" there is.
  `track=top` for normal work; `track=all` also counts nested statements,
  double-counts and costs more. It is a fixed hash (`pg_stat_statements.max` =
  10,000) that evicts, so it is not an audit trail, and `pg_stat_statements_reset()`
  throws your baseline away.
- **Pool and connection counts**: check first when latency rises with no slow
  queries. Fix the holder (an `idle in transaction`, an upstream timeout, a
  `pg_sleep`) before raising `max`: a bigger pool turns a slow database into a dead
  one.
- **`EXPLAIN`**: plain to read a plan, `ANALYZE` to measure one, `BUFFERS` always.
  `ANALYZE` executes the statement - not on a write you did not mean, and on a busy
  primary prefer a replica.
- **Indexes**: each is a second table Postgres must keep sorted - slower inserts,
  more vacuum, more disk, and a planner that can now choose wrongly. Re-check when
  the distribution moves: Initech at 37% is a different problem from 5%.
- **Alerting**: `DatabasePoolWaiting` and `SlowQueryRegression` are symptoms and
  belong in the pager. Cache hit ratio and `xact_rollback` move for reasons nobody
  can act on at 3 a.m.: dashboards, not alerts.

## 7. Common mistakes

1. **Sorting by `mean_exec_time`.** The 1,521 ms seed insert tops the list and is
   the least interesting row in it; total is the pile, mean matters once `calls` is
   high.
2. **Inventing column names.** `total_exec_calls` does not exist; `calls`,
   `total_exec_time`, `mean_exec_time`, `max_exec_time` do.
3. **Thinking `docker compose restart` applied your flag change.** It does not
   re-read the file - a changed `command:` needs `up -d`, and
   `shared_preload_libraries` needs a restart regardless.
4. **The `log_line_prefix` trailing space.** Unquoted, YAML strips it, you get
   `shopLOG:`, and anything splitting lines on `LOG:` silently stops matching.
5. **Believing you have a sample.** `log_statement_sample_rate=1.0` with
   `log_min_duration_sample=-1` logs nothing extra; read a setting's `short_desc`
   before trusting a copied config line.
6. **Treating the server log like the app log.** `DETAIL: Parameters:` proves
   Postgres writes values your code refuses to log, and your redaction does not
   reach container stdout.
7. **Assuming an index is a speed dial.** 30x on the point query, and 27.569 ms to
   34.070 ms on the aggregate over 37% of the table. Measure both plans.
8. **`CREATE INDEX` during opening hours.** It blocks writes for its whole
   duration; the concurrent form does not, and cannot run in a transaction.
9. **Reading a plan on this box and predicting production.** 99.80% cache hit on a
   16 MB table means every plan here is a memory plan.
10. **Raising the pool to "fix" latency.** `waiting` is a queue in front of a
    limited resource; `db.ts` caps at 8 with a 2 s `connectionTimeoutMillis` so
    requests fail fast instead of piling up.

## 8. Try it yourself

The index is deliberately missing so you can measure it: baseline, add, re-measure,
put the box back.

```bash
# 1. Baseline both access patterns.
docker compose exec -T postgres psql -U shop -d shop -c \
  "EXPLAIN (ANALYZE, BUFFERS) SELECT o.status, count(*), sum(o.total_cents)
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE o.tenant_id = 'tenant_initech' GROUP BY o.status;"
docker compose exec -T postgres psql -U shop -d shop -c \
  "EXPLAIN (ANALYZE, BUFFERS) SELECT id, sku, quantity FROM order_items WHERE order_id = 4321;"

# 2. Add the index (over 100ms, so it appears in the slow log), then repeat step 1.
docker compose exec -T postgres psql -U shop -d shop -c \
  "CREATE INDEX idx_order_items_order_id ON order_items (order_id); ANALYZE order_items;"
docker compose logs --since 2m postgres | grep -E 'LOG:  duration'
```

**Hint:** read the top two nodes before the timing - the node name tells you the
shape (`Parallel Seq Scan` versus `Index Only Scan`), the `Buffers:` line tells you
the work. If the aggregate got slower you did nothing wrong: that is section 4's
result. Then name the cost with
`SELECT calls, mean_exec_time, total_exec_time FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 3;`
and see the same shapes labelled by `query` in
`curl -s localhost:8000/metrics | grep '^shop_db_query_duration_seconds_count'`. To
feel the queue, run eight `curl 'localhost:8000/api/pool-hog?seconds=8'` at once and
watch `shop_db_pool_connections{state="waiting"}` pass 2 - that is
`DatabasePoolWaiting` going pending.

**Cleanup, restoring the machine - mandatory, the next reader needs the index
absent:**

```bash
docker compose exec -T postgres psql -U shop -d shop -c "DROP INDEX idx_order_items_order_id;"
docker compose exec -T postgres psql -U shop -d shop -tc \
  "SELECT indexname FROM pg_indexes WHERE tablename='order_items';"
# must print exactly:  order_items_pkey
```

## 9. Next

You can now prove where time goes inside one service and inside the database. The
other half of the request is the part the customer sees, and it has no Postgres in
it: [15 - Next.js and the frontend](15-nextjs-frontend.md). If you have my SQL
notes, read their EXPLAIN chapter too - join strategies go deeper there.
