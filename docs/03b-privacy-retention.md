# 03b - PII, card data and retention

Everything here is fake: `real.customer@example.com` uses the documentation-reserved domain and
`4242 4242 4242 4242` is a payment-gateway test card.

## 1. Simple explanation

The shop keeps a visitors' book on the counter, and everyone writes their name and phone number in
it, because that is how you remember who came in. At closing the owner put the book in the shredder
and nobody thought twice about it. Then somebody decided to keep the books "for a while, they might
be useful", and now one stranger who walks in can walk out with a month of names in a bag. Nothing
about the shop changed except how long the paper sat there.

Retention is the shredder. It is not only a cost dial you turn when the cupboard is full; it is the
reason the cupboard is not worth breaking into.

## 2. Real name

**Data minimisation** (keep the least that works) and **retention period** (how long stored data
lives before it is deleted automatically). The words that decide what may never be written down:

- **PII** - personally identifiable information: name, email, phone, address, device identifiers.
- **Cardholder data / Sensitive Authentication Data** - the PCI-DSS terms. A primary account number
  (PAN) may only be kept in strong ciphertext and never for authorisation purposes; **CVV, expiry
  and track data may not be stored after authorisation at all**, encrypted or not.
- **Tokenisation** - swap the number for a meaningless vault token at the edge, so the value you
  cannot afford to leak never enters your systems. `checkout.ts` fakes exactly this.
- **Retention vs rotation vs deletion** - retention is a policy ("gone after 72 hours"), rotation a
  storage mechanic ("cut the file at 10 MB, keep five"), deletion is the compactor acting on the
  policy. Only the last one removes anything, and only when it is switched on.

[03a](03a-redaction.md) decides *whether* a secret is in the store; retention decides *for how
long*. You need both, because a leak you failed to redact is only recoverable by expiry.

## 3. Example

Two of this stack's retention policies are not in application code at all.

```yaml
# loki/config.yaml
limits_config:
  retention_period: 72h          # default for every stream
  # Per-stream overrides. Accepted fields: priority, priority_label, selector, period.
  # `period` has a floor - 6h once made the container refuse to start with:
  #   CONFIG ERROR: invalid limits_config config: retention period must be >= 24h was 6h
  retention_stream:
    - priority: 1
      selector: '{service="shop-api", tenant_id="tenant_umbrella"}'
      period: 24h
  reject_old_samples: true       # a week-late backlog is refused, not absorbed
  reject_old_samples_max_age: 168h
compactor:
  retention_enabled: true        # without this line retention_period is decoration
  compaction_interval: 5m
```

Which stream a line joins is decided at ingestion, by the Alloy pipeline that lifts `level` and
`tenant_id` out of the JSON into labels - and a `selector` can only match labels. Minimisation,
meanwhile, is one decision in one file:

```ts
// app/src/routes/checkout.ts
const cardToken = `tok_fake_${hashIdentity(body.card.number)}`;
void body.card;               // the raw number is out of scope from here on
await query('checkout.insert_order',
  `INSERT INTO orders (tenant_id, request_id, customer_hash, status, total_cents, currency)
   VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING id`,
  [tenantId, ctx.requestId, hashIdentity(body.customer.email), totalCents, currency]);
```

```sql
-- db/init/01_schema.sql: the customer arrives as a hash, and nothing else
CREATE TABLE orders (
  id bigserial PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id),
  request_id text, customer_hash text NOT NULL, status text NOT NULL,
  total_cents integer NOT NULL, currency text NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now() );
```

## 4. What you should see

### 4.1 One checkout, four log lines, no PII

DANGER DEMO input: the request deliberately carries a fake email, a fake card number and a CVV, so
you can find out where each one lands.

```bash
curl -s -X POST localhost:8000/api/checkout -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_acme' -H 'x-request-id: doc03b-checkout2' \
  -d '{"customer":{"email":"real.customer@example.com","name":"Fake Customer"},"card":{"number":"4242 4242 4242 4242","exp":"04/28","cvv":"123"},"items":[{"sku":"tenant_acme-SKU0001","quantity":2}]}'
docker compose logs --since 30s shop-api | grep doc03b-checkout2
docker compose logs --since 60s shop-api | grep -Ec '4242[ -]?4242[ -]?4242[ -]?4242'
```

```json
{"level":"info","time":"2026-10-29T07:51:50.015Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"doc03b-checkout2","tenant_id":"tenant_acme","trace_id":"a7a372f433541a6861faabea54031e0d","span_id":"c62f883303093ea5","order_id":"15178","total_cents":5644,"currency":"USD","msg":"order created"}
{"level":"info","time":"2026-10-29T07:51:50.095Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"doc03b-checkout2","tenant_id":"tenant_acme","trace_id":"a7a372f433541a6861faabea54031e0d","span_id":"115f39e927ac3ee4","payment.status":"captured","payment.decline_reason":null,"duration_ms":80,"msg":"payment gateway responded"}
{"level":"info","time":"2026-10-29T07:51:50.097Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"doc03b-checkout2","tenant_id":"tenant_acme","trace_id":"a7a372f433541a6861faabea54031e0d","span_id":"c62f883303093ea5","order_id":"15178","provider_charge_id":"chb_fake_2f2a86e9","msg":"checkout confirmed"}
{"level":"info","time":"2026-10-29T07:51:50.097Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","req":{"id":"doc03b-checkout2","method":"POST","url":"/api/checkout","query":{},"params":{},"headers":{"host":"localhost:8000","user-agent":"curl/8.18.0","accept":"*/*","content-type":"application/json","x-tenant-id":"tenant_acme","x-request-id":"doc03b-checkout2","content-length":"193"},"remoteAddress":"::ffff:172.25.0.1","remotePort":41258},"route":"","request_id":"doc03b-checkout2","tenant_id":"tenant_acme","trace_id":"a7a372f433541a6861faabea54031e0d","span_id":"7d0bc78fa08d02e9","res":{"statusCode":201,"headers":{"x-request-id":"doc03b-checkout2","content-type":"application/json; charset=utf-8","content-length":"77","etag":"W/\"4d-AT0Ru5kgph1b9YLTs63Iyk+x0Cw\""}},"responseTime":86,"msg":"request completed"}
```

```
0
```

Four lines and no human in them: the email never reached a `logger` call, the card number became a
token, `trace_id`/`span_id` are for later ([13a](13a-spans.md)). What is *not* in the output matters
as much as what is - which is why the grep returns zero.

### 4.2 What the database kept, and what it never had

```bash
docker compose exec -T postgres psql -U shop -d shop \
  -c "SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND (column_name ILIKE '%email%' OR column_name ILIKE '%card%' OR column_name ILIKE '%pan%' OR column_name ILIKE '%phone%');" \
  -c "SELECT id, tenant_id, request_id, customer_hash, status, total_cents FROM orders WHERE request_id='doc03b-checkout2';" \
  -c "SELECT count(*) AS orders, count(request_id) AS with_request_id, count(DISTINCT customer_hash) AS distinct_customers FROM orders;"
```

```
 column_name
-------------
(0 rows)

  id   |  tenant_id  |    request_id    |  customer_hash   |  status   | total_cents
-------+-------------+------------------+------------------+-----------+-------------
 15178 | tenant_acme | doc03b-checkout2 | 619646acbde36173 | confirmed |        5644

 orders | with_request_id | distinct_customers
--------+-----------------+--------------------
  15208 |           15208 |              13124
```

Every row carries `request_id`, so the number a customer quotes and a log grep reach the same
order. Read the asymmetry: **this row has no expiry**, because accounting needs it, while the lines
about it expire in 72 hours. Your counts will be higher - the traffic generator is still running.

### 4.3 What the log store actually believes

`limits_config` is a request; the running process tells you what it took. It is a big dump, so grep
the retention-shaped lines out of it:

```bash
curl -s localhost:3101/config | grep -E '^(  retention_period|  retention_enabled|  deletion_mode|  - period|    priority|    selector)'
```

```
  retention_enabled: true
  deletion_mode: filter-and-delete
  retention_period: 3d
  - period: 1d
    priority: 1
    selector: '{service="shop-api", tenant_id="tenant_umbrella"}'
  retention_period: 0s
```

`72h` normalised to `3d`, `24h` to `1d`. The last line belongs to a different subsystem
(`table_manager.retention_period`, inert with filesystem storage) and is exactly the kind of decoy
knob to distrust. And the rule's `selector` mentions `tenant_id`, so check that the label exists:

```bash
curl -s 'localhost:3101/loki/api/v1/label/tenant_id/values'
```

```
{"status":"success","data":["tenant_acme","tenant_globex","tenant_initech","tenant_umbrella"]}
```

A line logged *without* `tenant_id` - startup lines, the payment gateway's lines, anything rejected
before the tenant was resolved (04a shows the exact line) - joins a stream that has no such label,
so the 24-hour rule can never match it. Queries are [06a](06a-loki-logql.md); the money side is
[06b](06b-retention-rotation-cost.md).

## 5. In a real multi-tenant e-commerce platform

`tenant_umbrella` had a breach last year and signed a contract promising their logs live a day, not
three. One rule, 24 hours, done - for the lines that carry the label.

The edge case is what makes on-call interesting. Umbrella's support tool sends `x-customer-email` on
every request, and one arrives with a tenant id you do not serve, so it is rejected at the edge.
That rejection line has a `request_id` and no `tenant_id`, the header survived redaction (03a,
mistake 4), and the short retention rule cannot see it: the one line holding something like an email
address sits in a shared store for three days, not because anyone chose it, but because two controls
were keyed on different things.

Meanwhile the orders table keeps `customer_hash` forever, deliberately: a keyed hash is not an
address, and finance needs the row. Logs answer "what happened at 10:04", the database answers "what
did we sell".

## 6. When to use it, when not to

Set retention per store, not globally: 72 hours for debug logs, days rather than months for anything
that could hold a leaked secret, a separate longer policy for business records in the database.
Include every copy, which means the container runtime too -
`docker inspect -f '{{.LogPath}} {{.HostConfig.LogConfig.Type}}' observability-learn-shop-api-1`
reports `json-file` with no `max-size`, so an unrotated raw copy of every line lives on the host
independently of Loki. Do not use retention to fix a redaction bug: for three days the secret is
readable and retroactive deletion is manual and dangerous. Do not put tax and order records in a log
pipeline either; they need years, and a store you shorten when the disk gets tight is wrong for them.

## 7. Common mistakes

1. **Setting `retention_period` without `retention_enabled: true`.** Reads as a policy, deletes nothing.
2. **Asking for a sub-day window.** `period: 6h` is refused at startup
   (`retention period must be >= 24h was 6h`) and the container never comes up: deletes land on day
   boundaries.
3. **Keying a per-stream rule on a label some lines lack.** Umbrella's 24h rule silently skips every
   line logged before the tenant was known.
4. **Keeping "just the email, for support convenience".** It becomes the one thing a subpoena names;
   keep a hash and the request id, and let the provider hold the rest.
5. **Assuming `[REDACTED]` means deleted.** A censored field still proves a secret existed at a time.
6. **One retention number for the whole system.** Container files, Loki streams, Tempo spans,
   Prometheus series and Postgres rows each have their own lifetime; four of those five are
   configured in four places here, and they drift.
7. **Forgetting ingest rejection is retention too.** `reject_old_samples` plus its max age is what
   stops a week-late replay from landing in your store.

## 8. Try it yourself

One request, two stores, two different memories.

```bash
curl -s -X POST localhost:8000/api/checkout -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_globex' -H 'x-request-id: doc03b-exercise' \
  -d '{"customer":{"email":"real.customer@example.com","name":"Fake Customer"},"card":{"number":"4242 4242 4242 4242","exp":"04/28","cvv":"123"},"items":[{"sku":"tenant_globex-SKU0001","quantity":1}]}'
docker compose exec -T postgres psql -U shop -d shop \
  -c "SELECT id, customer_hash FROM orders WHERE request_id='doc03b-exercise';"
```

The row should show a hash you cannot read back. Now repeat it as a DANGER DEMO with
`-H 'x-customer-email: real.customer@example.com'` and a fresh `x-request-id` (still the fake
address), and grep the container logs for it. Hint: 03a mistake 4 says why the header survives, and
4.3 says how long. Cleanup: nothing was edited - confirm `docker compose ps` lists 13 services with
`shop-api` at its original uptime, then let the lines expire on their own.

## 9. Next

[04a - Request IDs](04a-request-ids.md): the field that ties a log line, a database row and a
customer's support email together, and where trusting a caller-supplied one goes wrong.
