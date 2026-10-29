# 03a - Redaction

This chapter starts with a leak, and everything it leaks is fake: `real.customer@example.com`
and `4242 4242 4242 4242` are documentation-reserved test values (`example.com` is reserved for
examples; `4242...` is a payment-gateway test card). One request, two log lines, both below.

## 1. Simple explanation

A shop keeps a diary. When something happens someone writes it down: "ten past four, order
thirty-three, card refused". The diary helps the owner fix things. But sometimes the writer also
copies down the customer's secret password, because that made debugging easier this morning - and
the diary sits on a shelf a lot of people reach.

Redaction is a thick black marker: before the page goes on the shelf you colour over the password
and the card number, and the rest of the sentence stays readable. Use it *before* the page is
filed, because once the secret is on the shelf, people have already copied it.

## 2. Real name

**Log redaction** (also field censoring, secret scrubbing): transforming the object about to be
serialised into a log line so that values under sensitive keys are replaced by a fixed token,
`[REDACTED]`, before any bytes leave the process. Three mechanisms are in play, and mixing them up
causes most of the bugs:

- **pino's `redact.paths`** - a censor list of **paths**. Each entry is anchored at the *root* of
  the object you logged and `*` matches exactly **one** level: `body.card.cvv` matches, `card.cvv`
  does not match a `cvv` inside `body`. pino 10.4.0 has **no recursive wildcard**: `**.cvv` and
  `**` are accepted without an error and match nothing.
- **Serializers** - pino's hook "a value under this key name goes through this function first".
  Ours walks the object to any depth, so nesting does not matter; it fires only for the names in
  `SCRUBBED_KEYS`.
- **Never putting the value in the object at all** (data minimisation at the source). Not
  redaction, and strictly better whenever it is available.

The values: **PII** (email, phone, address) and **Sensitive Authentication Data** (card
number/PAN, CVV, expiry), the PCI-DSS term for card fields that must never be kept after
authorisation ([03b](03b-privacy-retention.md)).

## 3. Example

`app/src/lib/logger.ts` holds the path list pino walks (58 entries, abridged) and the scrubber that
needs no paths, because it matches key **names** at any depth and falls back to the **shape** of the
value. One switch turns both on: `LOG_REDACT`, default true in `config.ts` and `"true"` for every
container in `docker-compose.yml`'s `x-app-env`.

```ts
const REDACT_PATHS = ['password', 'email', 'card.number', 'card.cvv', '*.password',
  // pino-http builds req/res for us, so censoring them means enumerating them
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'];

const SENSITIVE_KEYS = new Set(['password', 'cvv', 'pan', 'email', 'authorization',
  'cookie', 'api_key', 'x-api-key', 'street', 'zipcode' /* ... */]);
const SCRUBBED_KEYS = ['body', 'payload', 'data', 'card', 'metadata', 'auth'];

function scrub(value, parentKey, depth) {
  if (typeof value === 'string')     // a 13-19 digit run is a card number whatever
    return value.replace(/\b(?:\d[ -]*?){13,19}\b/g, (m) =>    // the key was called
      m.replace(/[ -]/g, '').length >= 13 ? '[MASKED-PAN]' : m);
  // objects: blank SENSITIVE_KEYS by name, blank card fields only inside `card`,
  // otherwise recurse; depth capped at 12
}

if (config.redactionEnabled) {
  base.redact = { paths: REDACT_PATHS, censor: '[REDACTED]' };
  base.serializers = buildSerializers();   // scrub() wired up for SCRUBBED_KEYS
}
```

The leaking line, from `app/src/routes/danger.ts` - the classic "log the request so I can debug
it" - and its fix, three lines later in the same file:

```ts
logger.info({ body: req.body }, 'danger demo: naive login logging');
logger.info(
  { 'auth.customer_hash': hashIdentity(String(req.body.email)),   // 619646acbde36173
    'auth.password_present': Boolean(req.body?.password), 'auth.result': 'success' },
  'login handled');
```

You still learn that someone failed to log in and how often, without writing down who. The hash
itself is [04b](04b-tenant-context.md).

## 4. What you should see

### 4.1 DANGER DEMO: redaction off

The running `shop-api` keeps redaction on, so the leak needs a throwaway container
with the flag flipped, removed afterwards. Port `8010` was already taken here.

```bash
docker compose run -d --rm --no-deps -p 8011:8000 -e LOG_REDACT=false -e LOG_DANGER=1 shop-api
# observability-learn-shop-api-run-57b8c469e23a Created, container 8161cd256a60
curl -s -X POST localhost:8011/danger/login -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_acme' -H 'x-request-id: danger-03a-leak1' \
  -H 'authorization: Bearer sk-live-supersecret-token' \
  -d '{"email":"real.customer@example.com","password":"hunter2-correct-horse","card":{"number":"4242 4242 4242 4242","cvv":"123","deeper":{"cvv":"999"}}}'
docker logs 8161cd256a600bd23d273cae7a09ec3409da30246e4760881fe08d60687d6ecd
```

```json
{"level":"info","time":"2026-10-29T07:18:53.265Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"danger-03a-leak1","tenant_id":"tenant_acme","trace_id":"74413d56f9d0cec3b863226b5c284a3b","span_id":"37d695ec30a865ee","body":{"email":"real.customer@example.com","password":"hunter2-correct-horse","card":{"number":"4242 4242 4242 4242","cvv":"123","deeper":{"cvv":"999"}}},"msg":"danger demo: naive login logging"}
{"level":"info","time":"2026-10-29T07:18:53.269Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","req":{"id":"danger-03a-leak1","method":"POST","url":"/danger/login","query":{},"params":{},"headers":{"host":"localhost:8011","user-agent":"curl/8.18.0","accept":"*/*","content-type":"application/json","x-tenant-id":"tenant_acme","x-request-id":"danger-03a-leak1","authorization":"Bearer sk-live-supersecret-token","content-length":"147"},"remoteAddress":"::ffff:172.25.0.1","remotePort":55684},"route":"","request_id":"danger-03a-leak1","tenant_id":"tenant_acme","trace_id":"74413d56f9d0cec3b863226b5c284a3b","span_id":"331dfb56ec485d47","res":{"statusCode":200,"headers":{"x-request-id":"danger-03a-leak1","content-type":"application/json; charset=utf-8","content-length":"19","etag":"W/\"13-AmooA5OnMEh8iMfUQ0ZRl4fKgtE\""}},"responseTime":5,"msg":"request completed"}
```

Two leaks, not one: the password and address out of `req.body`, and pino-http's own
`req.headers` handing a live API token to the log store without anyone ever writing
`logger.info({ token })`. The `trace_id`/`span_id` fields are not relevant yet
([13a](13a-spans.md)).

### 4.2 The redaction that stops it

Identical request against the running `shop-api`, read back with `docker compose logs --since 60s shop-api`:

```json
{"level":"info","time":"2026-10-29T07:19:32.617Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"safe-03a-fix1","tenant_id":"tenant_acme","trace_id":"c591619938103589f15a0a19a0703ad2","span_id":"f06452d8df876106","body":{"email":"[REDACTED]","password":"[REDACTED]","card":{"number":"[REDACTED]","cvv":"[REDACTED]","deeper":{"cvv":"[REDACTED]"}}},"msg":"danger demo: naive login logging"}
{"level":"info","time":"2026-10-29T07:19:32.618Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","req":{"id":"safe-03a-fix1","method":"POST","url":"/danger/login","query":{},"params":{},"headers":{"host":"localhost:8000","user-agent":"curl/8.18.0","accept":"*/*","content-type":"application/json","x-tenant-id":"tenant_acme","x-request-id":"safe-03a-fix1","authorization":"[REDACTED]","content-length":"147"},"remoteAddress":"::ffff:172.25.0.1","remotePort":42058},"route":"","request_id":"safe-03a-fix1","tenant_id":"tenant_acme","trace_id":"c591619938103589f15a0a19a0703ad2","span_id":"a359c5cf39766845","res":{"statusCode":200,"headers":{"x-request-id":"safe-03a-fix1","content-type":"application/json; charset=utf-8","content-length":"19","etag":"W/\"13-AmooA5OnMEh8iMfUQ0ZRl4fKgtE\""}},"responseTime":1,"msg":"request completed"}
```

Same fields, same line count, same debugging value; only what could hurt someone is gone. The
stored artifact `.artifacts/logs/danger-REDACTED.txt` predates `scrub()` and still shows
`card.number` in the clear: it disagrees with the running stack, and the running stack wins.

### 4.3 Proof that a path list cannot win

```bash
cat <<'EOF' | docker compose run --rm --no-deps -i -w /app shop-api sh -c 'NODE_PATH=/app/node_modules node -'
const pino = require('pino');
const obj = { body: { card: { cvv: '123', deeper: { cvv: '999' } } } };
for (const paths of [['card.cvv'], ['body.card.cvv'], ['**.cvv'], ['**']]) {
  let out;
  const logger = pino({ redact: { paths, censor: '[REDACTED]' } }, { write(s) { out = JSON.parse(s).body; } });
  logger.info(obj, 'x');
  console.log('paths=' + JSON.stringify(paths) + ' -> ' + JSON.stringify(out));
}
EOF
```

```
paths=["card.cvv"] -> {"card":{"cvv":"123","deeper":{"cvv":"999"}}}
paths=["body.card.cvv"] -> {"card":{"cvv":"[REDACTED]","deeper":{"cvv":"999"}}}
paths=["**.cvv"] -> {"card":{"cvv":"123","deeper":{"cvv":"999"}}}
paths=["**"] -> {"card":{"cvv":"123","deeper":{"cvv":"999"}}}
```

Read the last two rows twice: the recursive wildcards that dozens of blog posts tell you to write
**do not fail and do not match** - they silently leak. And the one correct anchored path still
missed `deeper.cvv`, because a path has a fixed depth. `scrub()` exists for that, and it matches
shapes as well as names - two key names on no list, each holding a card number:

```bash
curl -s -X POST localhost:8000/danger/login -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_umbrella' -H 'x-request-id: doc03a-shape1' \
  -d '{"note":"declined card 4242424242424242 at 10:04","support_ticket":"ticket 4242 4242 4242 4242 dup"}'
docker compose logs --since 60s shop-api | grep doc03a-shape1
```

```json
{"level":"info","time":"2026-10-29T07:22:29.335Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"doc03a-shape1","tenant_id":"tenant_umbrella","trace_id":"2fe5ee725542339eba24718152adb77b","span_id":"6e2fc149c8b60641","body":{"note":"declined card [MASKED-PAN] at 10:04","support_ticket":"ticket [MASKED-PAN] dup"},"msg":"danger demo: naive login logging"}
```

## 5. In a real multi-tenant e-commerce platform

Four shops, one back room: `tenant_acme`, `tenant_globex`, `tenant_initech` and
`tenant_umbrella` share this binary and one log store, because four stores mean four times
the cost and four times the on-call. Isolation in the store is therefore a *content* problem,
and redaction is what makes sharing affordable.

Concrete case: `tenant_globex`'s support agents pass request IDs around to chase failed
orders. A developer adds `logger.info({ body: req.body }, 'globex debug')`, ships it, forgets
it. For two weeks every globex login writes a real address and password into the shared
store, readable by `tenant_initech`'s engineers. That ends the contract.

## 6. When to use it, when not to

Use redaction process-wide and always on, with no per-call-site opt-in: anything switched on
where you log will be switched off at the one place that matters. It must cover credentials,
card data, addresses, session tokens and anything in `Authorization` or `Cookie`. Do not
reach for it where you can keep the value out of the object: `checkout.ts` mints a token and
then writes `void body.card`, so no downstream line *can* log the number - cheaper in CPU and
much cheaper in worry. Two costs. **Noise**: `SENSITIVE_KEYS` matches `email` at any depth,
so a support payload's "who is affected" field becomes `[REDACTED]` too and on-call asks the
customer again - log a hash (04b). **CPU**: `scrub()` walks and rebuilds the object, so every
logged body pays an extra traversal; pino's `redact` touches only listed paths and is cheaper,
so keep it for `req`/`res` and do not log huge payloads.

## 7. Common mistakes

1. **Believing `**` works.** It does not in pino 10.4.0 and it fails silently (4.3). Only a test
   asserting the *censored output* proves anything.
2. **Enumerating paths and stopping.** A new wrapper key (`{ payload: ... }`) silently re-exposes
   everything under it, because paths are anchored.
3. **Censoring the body but not the transport.** pino-http logs `req.headers`, so `authorization`,
   `cookie` and `x-api-key` need their own entries.
4. **Name-only matching.** Verified here with redaction **on**: `x-customer-email` is in neither
   `REDACT_PATHS` nor `SENSITIVE_KEYS`, and `headers` is not in `SCRUBBED_KEYS`, so the
   `request completed` line carries `"x-customer-email":"real.customer@example.com"` raw (DANGER
   DEMO). Fix: add that header path, scrub all of `headers`, or stop putting PII in headers. The
   gap is still in this build, which is why chapter 21's checklist asks *how* redaction matches.
5. **Censoring values while interpolating them.** `logger.info(\`charged ${card}\`)` puts the
   number in a string no path can reach.
6. **Treating redaction as an environment toggle.** A hand-run container with `LOG_REDACT=false`
   leaks real data, which is why the demo also needs `LOG_DANGER=1`.
7. **Assuming censoring is deletion.** `[REDACTED]` still says a secret was there, and when - one
   more reason a shorter retention window is a safety control ([03b](03b-privacy-retention.md)).

## 8. Try it yourself

Send the same fake address down two routes into the log line: once inside the JSON body,
once in a header the scrubber has never met.

```bash
curl -s -o /dev/null localhost:8000/api/products -H 'x-tenant-id: tenant_acme' \
  -H 'x-request-id: doc03a-exercise' -H 'x-customer-email: real.customer@example.com'
curl -s -o /dev/null -X POST localhost:8000/danger/login -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_acme' -H 'x-request-id: doc03a-exercise-body' \
  -d '{"email":"real.customer@example.com","password":"hunter2-correct-horse"}'
docker compose logs --since 60s shop-api | grep doc03a-exercise
```

Exactly one `real.customer@example.com` should come back. Which route kept it, and why do
the answers differ? Hint: the serializer only fires for names in `SCRUBBED_KEYS` (`body` is
one of them, `headers` is not). Cleanup: you changed nothing, so confirm it -
`docker ps --format '{{.Names}}' | grep run-` prints nothing and `docker compose ps` lists 13
services with `shop-api` at its original uptime.

## 9. Next

[03b - PII, card data and retention](03b-privacy-retention.md): what must never be
logged at all, and why a shorter retention window is a security control rather than
only a cost dial.
