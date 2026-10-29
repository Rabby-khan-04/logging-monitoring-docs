# 04a - Request IDs

A request id is the one correlation handle you are allowed to hand to a customer. Everything below
was run against the live stack; the pre-fix lines come from `.artifacts/logs/levels-raw.txt`.

## 1. Simple explanation

You leave your bag at the lost-property desk. The assistant cannot write "the blue bag" on the
ticket, because half the bags are blue. So she writes a number on the bag and the same number on your
slip. Nothing about the bag changed; the number is what makes it findable.

A log file is that shelf, with thousands of blue bags on it. The number is the only reason anybody
ever finds *your* bag.

## 2. Real name

**Correlation ID** (also: request ID, `X-Request-Id`, "trace token" in older HTTP specs). A short,
unique, opaque string minted once at the edge of the system and carried through every log line,
database row and downstream call that the same request produces. Three neighbours worth separating:

- **Trace ID** - one *chain* of calls across services, so the shop-api line and the payment-gateway
  line for the same checkout share it. Different object, different rules; [13a](13a-spans.md)
  explains where it comes from.
- **Propagation** - putting the id on the outgoing request (`x-request-id`, `traceparent`) and
  reading it on the incoming side instead of minting a new one.
- **Idempotency key** - a client-chosen string meaning "do not run this twice". Related plumbing,
  opposite trust model: a request id is a label, an idempotency key is an instruction.

Where the id lives matters as much as what it is. Here `request_id` is a **log field**: a key inside
the JSON line, filtered at query time. It is deliberately **not a Loki stream label** and **not a
Prometheus label**, because labels are indexes and a value with no upper bound turns every request
into a new index entry. `07b` measures what that costs; section 4 has the short proof from Loki's
own label list.

## 3. Example

`app/src/middleware/requestContext.ts` - accept an id from outside only if it is boring:

```ts
import { randomUUID } from 'node:crypto';

// Honour an incoming X-Request-Id (a browser or another service may already
// have one) so the chain stays unbroken; otherwise mint a fresh id.
export function requestId(req: Request): string {
  const incoming = req.header('x-request-id');
  if (incoming && /^[\w-]{8,64}$/.test(incoming)) return incoming;   // <- the whole policy
  return randomUUID();
}
```

That regex is the security decision, not decoration. Letters, digits, underscore and dash only - no
quotes, newlines or control characters that could forge a second log line in a line-oriented
transport. At least 8 characters so the value is not `a`; at most 64 so a client cannot make every
line of their request carry a 100 KB payload. Anything else is thrown away for a UUID they cannot
choose.

The same function is also wired in as `genReqId: requestId` inside `pinoHttp({ logger, genReqId:
requestId, ... })`, so `req.id` in the access log obeys the identical rule and the two logs cannot
disagree. Then `tenantContext()` in the same file:

```ts
export function tenantContext(req: Request, res: Response, next: NextFunction): void {
  const tenantHeader = req.header('x-tenant-id');
  const ctx: RequestContext = { requestId: String(res.getHeader('x-request-id') ?? requestId(req)) };

  // Hand the id back to the caller BEFORE any validation: if we reject the
  // request, the response body contains this request_id and the customer can
  // quote it. Logging it is only possible if the context is already active.
  res.setHeader('x-request-id', ctx.requestId);      // <- this line was the fix

  requestStorage.run(ctx, () => {                    // <- the rejection now runs INSIDE the context
    if (tenantHeader) {
      if (!isKnownTenant(tenantHeader)) { next(new UnknownTenantError(tenantHeader)); return; }
      ctx.tenantId = tenantHeader;
    }
    next();
  });
}
```

`app/src/lib/logger.ts` then stamps that id onto every line from the ambient context, so no handler
has to remember; the `mixin()` that does it is printed in full in [04b](04b-tenant-context.md).

The id also leaves the log world. `app/src/routes/checkout.ts` uses it as the default idempotency key
(`req.header('idempotency-key') ?? ctx.requestId`) and writes it into the order row, so a Loki filter
and `select ... from orders where request_id = '...'` answer the same question.

## 4. What you should see

The bug I shipped first, captured in `.artifacts/logs/levels-raw.txt`. The rejection was raised
before `requestStorage.run()`, so the mixin had no context to read. `request_id` is absent from both
lines, and the second line's response headers show `x-request-id` was never set either - while the
body (84 bytes) still quoted an id:

```json
{"level":"warn","time":"2026-10-29T06:44:11.530Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","trace_id":"55dd7b239a93de145c12fd263c41a7f5","span_id":"41307b8ac0fef91c","error.name":"UnknownTenantError","error.code":"unknown_tenant","error.status":403,"error.retryable":false,"http.method":"GET","msg":"Unknown tenant 'evil_unknown_tenant'"}
{"level":"warn","time":"2026-10-29T06:44:11.531Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","req":{"id":"capB-warn-05","method":"GET","url":"/api/products","query":{},"params":{},"headers":{"host":"localhost:8000","user-agent":"curl/8.18.0","accept":"*/*","x-tenant-id":"evil_unknown_tenant","x-request-id":"capB-warn-05"},"remoteAddress":"::ffff:172.25.0.1","remotePort":51118},"route":"","trace_id":"55dd7b239a93de145c12fd263c41a7f5","span_id":"01445db4c5167388","res":{"statusCode":403,"headers":{"content-type":"application/json; charset=utf-8","content-length":"84","etag":"W/\"54-qFpeymKe3jXTYBKiGW8fXdyW+vw\""}},"responseTime":2,"msg":"request completed"}
```

Now the same request against the fixed middleware:

```bash
curl -s -i localhost:8000/api/products -H 'x-tenant-id: evil_unknown' -H 'x-request-id: probe-reject-01'
docker compose logs --since 90s shop-api | grep -v '"req"' | grep probe-reject-01
```

```
HTTP/1.1 403 Forbidden
x-request-id: probe-reject-01
Content-Type: application/json; charset=utf-8
Content-Length: 108

{"error":{"code":"unknown_tenant","message":"Unknown tenant 'evil_unknown'","request_id":"probe-reject-01"}}
{"level":"warn","time":"2026-10-29T08:19:44.386Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"probe-reject-01","trace_id":"757b1e345d44cb61ffcae1af90288265","span_id":"ce7367aeb7049ad5","error.name":"UnknownTenantError","error.code":"unknown_tenant","error.status":403,"error.retryable":false,"http.method":"GET","msg":"Unknown tenant 'evil_unknown'"}
```

The customer's id and the log's id are now the same string, on a request that never reached a
handler - that is the entire point of setting the header before validating. The allowlist also
rejects a client id that is too long (I sent 300 `x` characters) and mints its own:

```
HTTP/1.1 403 Forbidden
x-request-id: 7b7f7dc0-bc5b-46c0-8a0a-0b89d708cfef
```

One id, every line of one checkout, and the row in Postgres:

```bash
curl -s localhost:8000/api/checkout -H 'content-type: application/json' -H 'x-tenant-id: tenant_acme' \
  -H 'x-request-id: probe-chain-01' -d '{...}'
docker compose exec -T postgres psql -U shop -d shop -c \
  "SELECT id, tenant_id, request_id, customer_hash, status FROM orders WHERE request_id='probe-chain-01'"
```

The response body, verbatim, and the row it wrote:

```
{"order_id":"17013","status":"confirmed","total_cents":2822,"currency":"USD"}
  id   |  tenant_id  |   request_id   |  customer_hash   |  status
-------+-------------+----------------+------------------+-----------
 17013 | tenant_acme | probe-chain-01 | f2e484bbf18e1639 | confirmed
```

That request produced four log lines - order created, gateway responded, checkout confirmed and
pino-http's own access line - all carrying `probe-chain-01`; section 4 of
[04b](04b-tenant-context.md) prints them. Each of those lines also carries `trace_id` and `span_id`,
like the lines above: that is the cross-service version of this idea, not explained here -
[13a](13a-spans.md) explains where the value comes from.

And why the id must not become an index. Loki's own list of label names contains the four-value
`tenant_id` and no `request_id`, because `request_id` would create one stream per request. (The
endpoint for names is `/labels`; `/loki/api/v1/label_names` answers `404 page not found` here.)

```bash
curl -s localhost:3101/loki/api/v1/labels
```

```
{"status":"success","data":["compose_version","container","level","service","service_name","tenant_id"]}
```

## 5. In a real multi-tenant e-commerce platform

`tenant_globex` support ticket: "one of my customers could not check out at 08:19, the page said an
error, I have nothing to give you." Except they do - the response body quoted `request_id`, because
`tenantContext` sets it before validating. Filter Loki on that string, get every line of that call at
once, see whether the failure was `payment_declined` or a timeout, and `select id, status from orders
where request_id = '...'` says whether a row was ever written. Without the id you are searching
14.26 lines/second of shop-api logs on a guess. The same ticket about `tenant_initech` - the busiest
of the four tenants here, 2,000 lines in 15 minutes against `tenant_umbrella`'s 1,284 - needs the id
*and* a tenant on every line, which is [04b](04b-tenant-context.md).

## 6. When to use it, when not to

Use it on every inbound HTTP request, every message pulled off a queue, every cron run (mint one at
the start and log it). Propagating an existing id costs one header, minting one costs a
`randomUUID()`. Do not use it as a label, and do not let it be the only thing you can filter on:
per-tenant and per-route filtering is what keeps a log store affordable, and a request id is a
needle, not a map.

Do not trust a client-supplied id beyond the allowlist - and note what the allowlist does *not* buy
you: a valid-shaped id can still collide with somebody else's. Not theoretical here. `checkout.ts`
falls back to `ctx.requestId` as the idempotency key and the cache is one process-wide `Map` with no
tenant in the key, so asking for `probe-chain-01` (a `tenant_acme` order) as `tenant_globex` returns
acme's payload:

```bash
curl -s localhost:8000/api/checkout -H 'x-tenant-id: tenant_globex' -H 'Idempotency-Key: probe-chain-01' -d '{...}'
```

```
HTTP/1.1 200 OK
x-request-id: probe-replay-01

{"order_id":"17013","status":"confirmed","total_cents":2822,"currency":"USD"}
```

The log line for that replay is correctly tagged `"tenant_id":"tenant_globex"`, so the tenant field
did its job and the *cache key* failed: an id a client may choose is an id a client may guess. If a
request id ever feeds a decision (replay, refund, dedupe), namespace it by tenant or require a
separate idempotency key.

## 7. Common mistakes

1. **Minting per log line instead of per request.** Ten lines, ten ids, no chain. Generate once at
   the edge, read from context - that is what `mixin()` plus `AsyncLocalStorage` is for.
2. **Losing the id on the rejection path, and with it the response header.** The bug in section 4:
   `next(err)` outside the context leaves the most interesting line of the request with no handle on
   it, and a rejection that quotes an id in JSON while dropping the header gives two sources of
   truth. Enter the context and set the header first, then validate.
3. **Trusting `x-request-id` blindly.** Unbounded length, control characters, attacker-chosen values.
   The `{8,64}` and `[\w-]` are the fix and they are a policy decision: write down why, or the next
   developer "simplifies" them away.
4. **Putting the id in `msg` text** (`"request probe-01 failed"`) instead of a field: searchable by
   accident, not by structure. `02b` covers why fields beat prose.
5. **Using it as a credential.** It turns up in logs, tickets and screenshots. It identifies a
   request and authorises nothing - section 6 shows the cost of forgetting that.

## 8. Try it yourself

Send three `GET /api/products` requests with `x-tenant-id: tenant_acme` and these ids:
`my-long-enough-id`, `short` (5 characters), `has spaces in it`. Note the `x-request-id` response
header each time, then find the log lines:

```bash
docker compose logs --since 60s shop-api | grep '"request completed"' | grep -oE '"request_id":"[^"]*"'
```

Two of the three should come back as UUIDs. Hint: the difference is not length alone - check which
characters are allowed. Then look at `req.headers` inside the access line for the `short` request:
the rejected value is still echoed there, harmless for a boring string and exactly why the character
class matters.

Cleanup: nothing to undo. Three `GET` reads, no rows written; the lines expire under the 72-hour Loki
retention in `loki/config.yaml`. Leave the containers running as you found them.

## 9. Next

The request id says *which call*, not *whose shop* - and a tenant is exactly the opposite of an
unbounded value, which is why it earns a label. [04b - Tenant context and hashed identities](04b-tenant-context.md).
