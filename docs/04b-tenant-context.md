# 04b - Tenant context and hashed identities

Two decisions that travel together: the tenant must be on *every* line without anyone remembering to
add it, and a person must be findable in those lines without being readable in them.

## 1. Simple explanation

The shop keeps one diary for everything, and four stores write in it: Acme, Globex, Initech, Umbrella.
A page saying "till was slow at noon" does not tell you whose till, so the librarian stamps the store
name on the line before writing. She never asks the writer to remember - the stamp is on the pen.

The diary sits on the counter where anyone can read it, so names do not go in it. A customer gets the
number from their sticker instead: same number next time, so one customer can still be followed, but
nobody at the counter can turn the number back into a name.

## 2. Real name

- **Request-scoped ambient context** - the object carrying `requestId`, `tenantId`, `customerHash` for
  one request. In Node that is **`AsyncLocalStorage`** (`node:async_hooks`): a store that follows the
  async chain across every `await`, so a helper three files away reads it without a parameter.
- **`mixin()`** - the Pino hook that merges fields into every line at write time: context becomes log
  fields with no `logger.info({ tenant_id })` anywhere in a route.
- **Keyed hash** - `hashIdentity()` is **HMAC-SHA256**, truncated to the first 16 hex characters
  (64 bits), keyed by `IDENTITY_HASH_SECRET`. Truncation is a size choice; what protects the value is
  that nobody outside can recompute it without the secret.
- **Pseudonymisation, not anonymisation** - a stable digest still marks *the same person* to anyone who
  can compute it or who knows one email. Anonymised data cannot be re-linked; hashed data can, which is
  why it is useful and why it stays personal data.
- **Per-tenant salt** (fold the tenant into the hash input, so one email is not one digest everywhere),
  **session GUC `app.tenant_id`** (a custom Postgres setting on the connection) and **row-level
  security** (the enforced version, absent here and covered in `19`).

## 3. Example

`app/src/lib/tenancy.ts` - the context, the two readers, the hash:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  tenantId?: string;
  // A keyed hash, never the raw address. Same customer is searchable across
  // log lines, but nobody can read an email out of Loki.
  customerHash?: string;
}

export const requestStorage = new AsyncLocalStorage<RequestContext>();

// Best-effort read: the line still gets written if there is no context.
export function currentContext(): Partial<RequestContext> { return requestStorage.getStore() ?? {}; }

// For code paths that genuinely cannot continue without a request context
// (checkout, idempotency). Fail loudly instead of writing NULL into a
// correlation column and losing the thread of the incident later.
export function requireContext(): RequestContext {
  const ctx = requestStorage.getStore();
  if (!ctx) throw new Error('request context is missing: is tenantContext() registered above this handler?');
  return ctx;
}

const HASH_SECRET = process.env.IDENTITY_HASH_SECRET ?? 'dev-only-insecure-secret';

export function hashIdentity(raw: string): string {   // lower-cased first, so Buyer@Example.com
  return createHmac('sha256', HASH_SECRET).update(raw.toLowerCase()).digest('hex').slice(0, 16);
}                                                        // and buyer@example.com are one person
```

The two readers are a decision about failure: a log line or a catalog read degrades to "field
missing", checkout must not, so it calls `requireContext()` and refuses the order when `ctx.tenantId`
is absent instead of running a query with no tenant filter. The middleware fills the context and
rejects anything off the allowlist first:

```ts
const ctx: RequestContext = { requestId: String(res.getHeader('x-request-id') ?? requestId(req)) };
const customer = req.header('x-customer-email');
if (customer) ctx.customerHash = hashIdentity(customer);   // raw value never leaves this function

requestStorage.run(ctx, () => {                            // <- everything below runs INSIDE it
  if (tenantHeader) {
    if (!isKnownTenant(tenantHeader)) { next(new UnknownTenantError(tenantHeader)); return; }
    ctx.tenantId = tenantHeader;
  }
  next();
});
```

`app/src/lib/logger.ts` is the only place that turns context into fields, which is why no route ever
mentions the tenant. `app/src/lib/db.ts` then tags the session before every query
(`SELECT set_config($1, $2, false)` with `app.tenant_id` and `ctx.tenantId`):

```ts
mixin() {
  const ctx = currentContext();
  const additions: Record<string, string> = {};
  if (ctx.requestId) additions['request_id'] = ctx.requestId;
  if (ctx.tenantId) additions['tenant_id'] = ctx.tenantId;
  if (ctx.customerHash) additions['customer_hash'] = ctx.customerHash;
  const span = trace.getSpan(context.active());   // 13a explains where trace_id comes from
  if (span) { additions['trace_id'] = span.spanContext().traceId; additions['span_id'] = span.spanContext().spanId; }
  return additions;
}
```

What may be stored at all is decided by `db/init/01_schema.sql`: `orders` has `tenant_id`,
`request_id` (the [04a](04a-request-ids.md) handle, as a column) and `customer_hash text NOT NULL`.
There is no email column and no card column anywhere in the schema. That is the design.

## 4. What you should see

The `probe-chain-01` checkout from [04a](04a-request-ids.md), with
`x-customer-email: chain@example.com` added. The second command is a reading aid: `grep -oE` pulls the
fields out of four JSON lines and `paste` puts six on one, because four whole lines would be unreadable.

```bash
docker compose exec -T postgres psql -U shop -d shop -c \
  "SELECT id, tenant_id, request_id, customer_hash, status FROM orders WHERE request_id='probe-chain-01'"
docker compose logs --since 45s shop-api | grep probe-chain-01 | \
  grep -oE '"(level|request_id|tenant_id|customer_hash|msg)":"?[^,"]*"?' | paste - - - - - -
```

```
  id   |  tenant_id  |   request_id   |  customer_hash   |  status
-------+-------------+----------------+------------------+-----------
 17013 | tenant_acme | probe-chain-01 | f2e484bbf18e1639 | confirmed

"level":"info"	"request_id":"probe-chain-01"	"tenant_id":"tenant_acme"	"customer_hash":"f2e484bbf18e1639"	"msg":"order created"	"level":"info"
"request_id":"probe-chain-01"	"tenant_id":"tenant_acme"	"customer_hash":"f2e484bbf18e1639"	"msg":"payment gateway responded"	"level":"info"	"request_id":"probe-chain-01"
"tenant_id":"tenant_acme"	"customer_hash":"f2e484bbf18e1639"	"msg":"checkout confirmed"	"level":"info"	"request_id":"probe-chain-01"	"tenant_id":"tenant_acme"
"customer_hash":"f2e484bbf18e1639"	"msg":"request completed"
```

Four lines written by four different parts of the code, none of which mentions a tenant - the mixin
did it - plus a row you can join to them. The full lines also carry `trace_id` and `span_id`, like the
lines in `04a` section 4; that is a cross-service idea and `13a` explains where it comes from.

Now the honest part of hashing. `Buyer@Example.com` went in under `tenant_acme`, `buyer@example.com`
under `tenant_globex`:

```
customer_hash":"328c78f567ad8d36"
request_id":"probe-hash-01"
request_id":"probe-hash-02"
tenant_id":"tenant_acme"
tenant_id":"tenant_globex"
```

One digest, two tenants. Anyone holding the secret - or anyone who knows one customer's email and can
check it - links that customer across stores: the feature (searchable) and the exposure in one line.

And the part I did not like. The application hashed the address, but pino-http serialises
`req.headers`, and `REDACT_PATHS` covers `req.headers.authorization`, `cookie` and
`req.headers["x-api-key"]` - not this header:

```bash
docker compose logs --since 90s shop-api | grep -o 'x-customer-email":"[^"]*"'
```

```
x-customer-email":"chain@example.com"
```

The obvious addition is the same bracketed form already in that list. **I did not verify the fix**:
editing `app/` was out of scope, so treat it as the thing to test, not a tested line.

The database tag, from the app's own Postgres:

```bash
docker compose exec -T postgres psql -U shop -d shop \
  -c "SELECT set_config('app.tenant_id','tenant_globex',false) AS set" \
  -c "SELECT current_setting('app.tenant_id') AS still_tagged"
```

```
     set
---------------
 tenant_globex

 still_tagged
--------------
 tenant_globex
```

The tag does survive on the session (`is_local = false`, so it outlives the statement and the pooled
The tag does survive on the session (`is_local = false`, so it outlives the statement and the pooled
connection) and reads back with `current_setting()`. But a custom GUC is neither a column of
`pg_stat_activity` nor listed in `pg_settings` (`WHERE name LIKE 'app.%'` gives `(0 rows)`) - asking
that view for the app's backends returns only `pid | state | last_query`, here
`8725 | idle | SELECT tenant_id, customer_hash FROM orders O...` - so per-tenant attribution needs a
join to the app's own `tenant_id` field or an `application_name` naming the tenant.

**DANGER DEMO** - `/danger/tenant-leak`, a missing `WHERE tenant_id` on purpose, `LOG_DANGER=1` gated
(it answered 200, so the flag is set in the running container):

```bash
curl -s localhost:8000/danger/tenant-leak -H 'x-tenant-id: tenant_acme' -H 'x-request-id: probe-leak-01'
docker compose logs --since 120s shop-api | grep 'other_tenant_rows' | grep -o 'other_tenant_rows.\{0,240\}'
```

```
{"requesting_tenant":"tenant_acme","leaked_rows":20,"tenants_seen":["tenant_acme"],"known_tenants":["tenant_acme","tenant_globex","tenant_initech","tenant_umbrella"]}

other_tenant_rows":[{"tenant_id":"tenant_acme","customer_hash":"627aa983f700b72b76bb5ab67a05339c"},{"tenant_id":"tenant_acme","customer_hash":"cb2d04733814531072bf2733d0048595"},{"tenant_id":"tenant_acme","customer_hash":"0ec3e118a9423fe80b02330bd91963be"},
```

Twenty rows read with no tenant filter, all of them dumped into one warn line. That page happened to be
one tenant's (oldest ids first), so `tenants_seen` shows one value - the missing filter is still the
bug, and the line is the worse half: a request tagged `tenant_acme` wrote row data into a stream every
support engineer reads. The safe version is the rest of `catalog.ts`: `WHERE tenant_id = $2` from the
context, and result sets that never enter a line.

## 5. In a real multi-tenant e-commerce platform

`tenant_umbrella`'s account manager says their checkout "feels slower than Initech's". With
`tenant_id` on every line that is a query, not a meeting: Initech made 2,000 shop-api lines in a
15-minute window here against Umbrella's 1,284, at 14.26 lines/second overall. `06a` gives the LogQL
and `07b` why that value is affordable as a label while `request_id` is not. The second reason is the
request that arrives by email: Umbrella asks you to delete a customer, there is no email column to
search, so you hash the address they give you, run `select id from orders where customer_hash = '...'`
and filter Loki for the digest. Nothing had to store the address in order to answer.

## 6. When to use it, when not to

**Use ambient context for the tenant whenever one process serves many tenants.** The alternative is
threading a tenant through every signature, and the failure mode of "every function" is the one that
forgets. The cost is small: one HMAC per request, `customer_hash` only when the header is present, and
`tenant_id` as a Loki label costing one stream per tenant (four here) - affordable only because the
value comes from an allowlist.

**Do not hash a small population.** A digest of anything an outsider can enumerate is not a pseudonym:
they hash the list they already have. With four tenants and a few thousand fake customers
`hashIdentity` buys correlation, not anonymity, and must never be called anonymisation in a document a
lawyer reads. **Do not share one key across tenants** if linking is a problem: put the tenant in the
HMAC input (`update(tenantId + ':' + raw.toLowerCase())`) and you lose the person who shops at two
tenants. **Never let a hash authorise anything** - `x-tenant-id` is a claim, not a credential; a real
system derives the tenant from the session or API key (`19`). **Never put a result set in a line.**

## 7. Common mistakes

1. **A module-level `currentTenant`.** Node interleaves handlers on one thread, so concurrent requests
   overwrite each other and tenant A's line gets tenant B's stamp. Why `AsyncLocalStorage` exists.
2. **Passing the logger instead of the context.** A per-request child logger (see `02b`) must reach
   every function; the moment a helper uses the imported root logger, that line has no tenant.
3. **Starting work outside `requestStorage.run()`.** A detached `setTimeout`, a queue producer, a
   promise made before the middleware: the store is empty and the field vanishes from the one line you
   needed.
4. **Registering the middleware too late.** `app.ts` puts `httpLogger` then `tenantContext` above the
   routers; below a router and that router loses the fields - same class of bug as `04a`'s rejection.
5. **Plain `sha256(email)` with no key.** Reversed by hashing a list of common addresses, so the secret
   belongs in a managed store, not in the `'dev-only-insecure-secret'` fallback `tenancy.ts` carries;
   and 16 hex characters is a size choice, not strength.
6. **Assuming hashing means you can log the input.** The header echo in section 4 is that mistake in its
   pure form: right thing in the handler, no look at what the logger serialises by default.
7. **Letting `tenant_id` be an arbitrary string.** `isKnownTenant` rejects unknown tenants at the edge:
   one control that is both data isolation and label-count control.

## 8. Try it yourself

Send two `GET /api/products` requests with `x-customer-email: you@example.com` - one
`x-tenant-id: tenant_acme`, one `x-tenant-id: tenant_initech`, each with a distinct `x-request-id` -
then:

```bash
docker compose logs --since 60s shop-api | grep -oE '(tenant_id|customer_hash)":"[^"]*"' | sort | uniq -c
```

Expect two `tenant_id` values and one `customer_hash` counted twice; repeat with a different email and
the digest changes. Hint: if two *different* emails give the same digest, check your shell quoting
first; if one email really does give the same digest under both tenants, you have found the correlation
property from section 5, not a bug. Cleanup: two read-only `GET`s, no rows written, and the lines
expire under the 72-hour retention in `loki/config.yaml` - leave the stack running as you found it.

## 9. Next

Context answers *which call* and *whose shop*. What is left is what a failure should look like in those
lines: which error type, which level, how much stack.
[05a - Error types and stacks](05a-error-types-stacks.md).
