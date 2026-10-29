# 19 - Multi-tenant observability

The whole course has carried `tenant_id` from the first log line. This chapter
explains why, and what happens when one missing `WHERE` clause turns an
observability system into a data breach.

## 1. Simple explanation

Imagine an apartment building where every tenant has a mailbox, but the mail
room also has a shared table where the janitor sorts everything. If the janitor
puts one tenant's letters on the shared table by mistake, everyone in the
building can read them. The mailbox was private; the sorting table was not.

In software, the mailbox is the database query (filtered by tenant), and the
sorting table is the log line, the metric label and the trace attribute. A
tenant leak usually does not happen because someone decided to steal data. It
happens because a report forgot its filter and then helpfully logged the whole
result set "so we can debug it".

## 2. Real name

- **Tenant isolation**: every read and write is scoped to one tenant, in code,
  in SQL, and in the cache key.
- **Tenant context propagation**: the tenant is established once at the edge
  (header, JWT claim, subdomain) and carried through every layer without being
  re-read from the request body.
- **Noisy neighbour**: one tenant's behaviour (traffic, slow queries, errors)
  degrades shared resources for others.
- **Per-tenant SLI/SLO**: the availability and latency promise measured per
  tenant, not only platform-wide.
- **Unbounded label**: a label whose values grow with data (`order_id`,
  `customer_id`). `tenant_id` is bounded by the number of tenants and is safe
  until that number is in the thousands per metric.
- **Row-level security (RLS)**: a database policy that enforces the tenant
  filter even if the application forgets; defence in depth, not a substitute
  for correct queries.

## 3. Example

The tenant is established at the edge, allowlisted, and stored in
AsyncLocalStorage so every layer reads the same value:

```ts
// app/src/lib/tenancy.ts
export const KNOWN_TENANTS = [
  'tenant_acme', 'tenant_globex', 'tenant_initech', 'tenant_umbrella',
] as const;

// HMAC, not a plain hash: stable for correlation, not reversible by guessing
// an email address from a rainbow table.
export function hashIdentity(raw: string): string {
  return createHmac('sha256', HASH_SECRET).update(raw.toLowerCase()).digest('hex').slice(0, 16);
}
```

```ts
// app/src/middleware/requestContext.ts
export function tenantContext(req: Request, res: Response, next: NextFunction): void {
  const tenantHeader = req.header('x-tenant-id');
  const ctx: RequestContext = { requestId: String(res.getHeader('x-request-id') ?? requestId(req)) };

  if (tenantHeader) {
    if (!isKnownTenant(tenantHeader)) {
      // Rejecting unknown tenants at the edge is also a data-isolation control:
      // no query can run for a tenant we do not serve.
      next(new UnknownTenantError(tenantHeader));
      return;
    }
    ctx.tenantId = tenantHeader;
  }
  requestStorage.run(ctx, () => next());
}
```

Every query that touches tenant data filters on it. This is the checkout's
basket query; the third parameter is the tenant from the context, not from the
request body:

```ts
`SELECT p.sku, p.price_cents, i.quantity
   FROM unnest($1::text[], $2::int[]) AS i(sku, quantity)
   JOIN products p ON p.sku = i.sku AND p.tenant_id = $3
  WHERE p.is_active`,
[skus, quantities, tenantId],
```

**DANGER DEMO.** The leak endpoint is deliberately broken. It selects the newest
twenty orders with no tenant filter, then logs the whole result set:

```ts
dangerRouter.get('/danger/tenant-leak', async (_req, res) => {
  const ctx = currentContext();
  const rows = await query(
    'danger.leaky_report',
    // BUG ON PURPOSE: no tenant filter.
    'SELECT tenant_id, customer_hash FROM orders ORDER BY id DESC LIMIT 20',
  );
  // A second bug on purpose: the result set goes into the log line, so a
  // request tagged tenant_acme now writes tenant_initech's hashes to Loki.
  logger.warn({ other_tenant_rows: rows.rows }, 'danger demo: cross-tenant data in one log line');
  res.json({ requesting_tenant: ctx.tenantId, leaked_rows: rows.rows.length, ... });
});
```

The fix is two independent changes, because these are two independent bugs:

```ts
// 1. Scope the query. Use the context, never a body field.
'SELECT tenant_id, customer_hash FROM orders WHERE tenant_id = $1 ORDER BY id DESC LIMIT 20',
[ctx.tenantId],

// 2. Log a count, not rows. If you must debug the rows, log them at debug
// level, with no tenant-identifying fields, and never with PII.
logger.info({ rows: rows.rowCount }, 'tenant report generated');
```

At the metrics layer, per-tenant queries are the same expressions with a
`by (tenant_id)` clause:

```promql
# Request rate per tenant, from the histogram (the counter has no tenant label;
# see chapter 07a for why that is a trap worth remembering).
sum by (tenant_id) (rate(shop_http_request_duration_seconds_count[5m]))

# Conversion per tenant.
sum by (tenant_id) (shop_checkout_step_total{step="confirmed"})
/
sum by (tenant_id) (shop_checkout_step_total{step="cart_received"})
```

LogQL keeps the tenant as a stream label set at ingestion by Alloy, so it also
acts as a cheap filter:

```logql
{service_name="shop-api", tenant_id="tenant_initech"} | json | level="error"
```

## 4. What you should see

The leak, executed with fake data. The request says it belongs to tenant_acme
and returns twenty rows that belong to tenant_initech:

```bash
$ curl -s -H 'x-tenant-id: tenant_acme' localhost:8000/danger/tenant-leak \
  | jq -c '{requesting_tenant, leaked_rows, tenants_seen}'
{"requesting_tenant":"tenant_acme","leaked_rows":20,"tenants_seen":["tenant_initech"]}
```

The log line proves the damage reached the observability system, where it will
stay for the retention period and be visible to anyone with dashboard access:

```bash
$ # Loki, last 2 minutes
{"level":"warn","requesting_tenant":"tenant_acme","rows":[
  {"tenant_id":"tenant_initech","customer_hash":"44e19d2a2ecdb52a"},
  {"tenant_id":"tenant_initech","customer_hash":"5f2ba43a32591bb0"},
  {"tenant_id":"tenant_initech","customer_hash":"d69acd022803999c"},
  {"tenant_id":"tenant_initech","customer_hash":"9ca5f426b807b1d3"},
  {"tenant_id":"tenant_initech","customer_hash":"982f83fa811fb400"}]}
```

The hashes are fake and keyed, which limits the blast radius; the tenant id is
not, and the fact that the rows exist at all is the breach. Now the healthy
picture, from a balanced load generator run of 70 seconds, counted over five
minutes:

```bash
$ # lines per tenant
tenant_acme      218
tenant_globex    172
tenant_initech   204
tenant_umbrella  158

$ # bytes per tenant
tenant_acme      121 KiB
tenant_globex     94 KiB
tenant_initech   114 KiB
tenant_umbrella   94 KiB
```

Four tenants, four streams, no tenant inside another's stream. The earlier
15-minute capture with a load generator showed the same property with a much
noisier neighbour: initech 2000 lines, acme 1482, globex 1356, umbrella 1284.
The enterprise tenant is not just bigger; it is also the one with 25% declined
cards and extra gateway latency, so it dominates both volume and error counts.

That is visible in the funnel, too: shortly before this run, tenant_initech had
confirmed 487 of 3032 carts (16.1%) while the other three were between 94% and
97%. A platform-wide conversion number would have hidden it completely.

## 5. In a real multi-tenant e-commerce platform

The commercial reason for per-tenant observability is that tenants pay
different amounts for different promises. Initech is on the enterprise plan and
has a 99.95% SLO; Globex is on starter and has 99.5%. The same outage is a
contract breach for one and a Tuesday for the other, and the only way to know
which is to measure per tenant.

The operational reason is triage. When `CheckoutFailureBurst` fires for
tenant_initech only, support can call that merchant before the status page says
anything. When it fires for all four, it is a platform incident. The alert
already carries the tenant in its labels; the dashboard variable filters the
same series; the log query filters the same stream label.

Leaks happen at the seams:

- a report endpoint that filters in the UI but not in SQL;
- a cache keyed by product id but not by tenant, so tenant B gets tenant A's
  price;
- a background job that processes all tenants with one database role;
- a debug log that dumps `rows` and lands in Loki.

The countermeasures are boring and effective: tenant from the edge only, a
`WHERE tenant_id` in every query, RLS as a second fence, `tenant_id` on every
log line and metric that can afford it, and a code-review rule that a query
against a tenant table without a tenant predicate is a bug even if it "works".

## 6. When to use it, when not to

Put `tenant_id` on every log line, every error, every business metric, and every
trace attribute for the request. That is affordable at four tenants and still
affordable at a few hundred. Use per-tenant dashboards for support and
customer success; use per-tenant SLOs for the contracts that promise them.

Do not put `tenant_id` on every infrastructure metric: `node_cpu_seconds_total`
is not per tenant, and pretending otherwise multiplies series for no answer.
Do not make the tenant an unbounded label by using a customer-chosen slug with
no allowlist; the allowlist in `KNOWN_TENANTS` is a cardinality control as well
as a security control. At thousands of tenants, per-tenant series become a
cardinality problem (chapter 07b): keep tenant labels on the metrics you alert
on, and aggregate the rest.

Cost: every tenant label multiplies series and log streams. At four tenants the
cost is negligible; at ten thousand, measure before you promise. The dangerous
middle ground is a tenant id that changes per request - that is not a tenant,
that is a request id, and it belongs in logs only.

## 7. Common mistakes

1. **Filtering in the application, not in SQL.** A `rows.filter(...)` after an
   unfiltered query is one refactor away from a leak; the database should never
   return the other tenant's rows.
2. **Reading the tenant from the body.** A caller can claim any tenant. The
   edge derives it from an authenticated header or token and allowlists it.
3. **Logging the result set.** The leak above. Log counts and ids you control,
   never rows that may contain another tenant's data.
4. **Shared cache keys.** `product:123` must be `tenant:acme:product:123`, or
   the cache becomes the leak.
5. **One database role for all tenants.** RLS cannot help if the application
   role is the table owner with `BYPASSRLS`; use a restricted role for
   tenant-facing queries.
6. **A platform-wide average.** It hides one tenant at 16% conversion inside a
   comfortable 96%.
7. **Treating the hashed customer id as anonymous.** It is pseudonymous: stable
   and correlatable, which is exactly why it is useful, and why it must never
   be joined back to an email in a shared dashboard.

## 8. Try it yourself

Prove the leak and then prove the fix, without touching real data.

```bash
# 1. The broken endpoint: a request for acme reads initech's rows.
curl -s -H 'x-tenant-id: tenant_acme' localhost:8000/danger/tenant-leak \
  | jq -c '{requesting_tenant, leaked_rows, tenants_seen}'

# 2. Find the log line in Loki. Notice the requesting tenant and the row tenants.
curl -sG localhost:3101/loki/api/v1/query_range --data-urlencode \
  'query={service_name="shop-api"} |= "cross-tenant data"' \
  --data-urlencode "start=$(( ($(date +%s)-300) * 1000000000 ))" \
  | jq -r '.data.result[].values[][1]' | tail -1 | jq -c '{tenant_id, n:(.other_tenant_rows|length), first:.other_tenant_rows[0]}'

# 3. Apply the fix from section 3 to app/src/routes/danger.ts, restart, repeat:
docker compose restart shop-api
curl -s -H 'x-tenant-id: tenant_acme' localhost:8000/danger/tenant-leak \
  | jq -c '{requesting_tenant, leaked_rows, tenants_seen}'
```

**Hint:** after the fix, `tenants_seen` should be exactly `["tenant_acme"]` and
the log line should contain a count, not rows. If it still leaks, check that the
parameter is `ctx.tenantId` and not a value from `req.body`.

**Cleanup:** restore the deliberate bug if you want the later chapters' danger
demo to keep working; it is a teaching endpoint. The log lines from both
versions remain in Loki until retention expires, which is the point of chapter
06b.

## 9. Next

You have all four signals and the tenant discipline. [20a - One checkout, end
to end](20a-checkout-end-to-end.md) instruments a single request with all of
them and follows it across every tool.
