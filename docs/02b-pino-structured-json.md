# 02b - Structured JSON with Pino: base fields, isoTime, formatters, mixin, serializers, child loggers

## 1. Simple explanation

A page torn from a diary says "the shop was busy today, someone complained."
You cannot sort all the diary pages by "who complained" because it is only
words on a line.

Now imagine every diary line is written in little labelled boxes instead:

[who] [when] [what happened] [box number]

Because the boxes are always in the same place with the same names, a machine
can pick out "every line where who = the shop and what happened = complained"
in one step. That is structured logging: not a sentence, but a set of named
boxes, one line at a time.

Pino is the person who writes the boxes. It has a few good habits: it stamps
the same few boxes on every single line for you (the shop's name, which world
we are in), it writes the time in one clear format everyone agrees on, it can
add a box for the trip this line belongs to, and - the big one - it can black
out a box before it ever hits the paper, so a secret never gets written at all.

## 2. Real name

**Structured logging** means emitting each event as a machine-parseable record
(JSON object, one per line, NDJSON) rather than a prose sentence, so the log
store can index fields and you can filter on them.

The Pino options this project uses, precisely:

- **`base`** - the object merged into *every* line automatically. Here it holds
  `service.name`, `app.env`, `app.release`. These are the fields you filter on
  in Loki; if it is not in `base` or added per-call, it is not on the line.
- **`timestamp: pino.stdTimeFunctions.isoTime`** - writes `time` as an ISO-8601
  UTC string (`2026-10-29T07:21:05.224Z`). The default is epoch milliseconds,
  which is unreadable to a human and awkward to compare. Loki accepts ISO
  directly.
- **`formatters.level`** - turns the numeric level (`30`) into its label
  (`"info"`). Pino stores `level` as a number; a formatter rewrites it to a
  string before the line is serialised, so humans and Loki's `level` label see
  `info` not `30`.
- **`mixin()`** - a function Pino calls just before writing each line; whatever
  object it returns is merged in. This is where per-request identity
  (`request_id`, `tenant_id`, `customer_hash`) and trace correlation
  (`trace_id`, `span_id`) are injected from the ambient request context.
- **serializers** - functions keyed by field name that transform a value before
  it is written. Used here for the deep-scrub that blanks sensitive keys at any
  depth (the safe side of what chapter 03a demonstrates).
- **child loggers** (`logger.child({...})`) - a derived logger that carries
  extra bound fields for its whole life, so you set `tenant_id` once at the top
  of a request and every line beneath it has it without repeating.

## 3. Example

The real `buildOptions()` from `app/src/lib/logger.ts`, annotated:

```ts
// app/src/lib/logger.ts
const base: LoggerOptions = {
  level: config.logLevel,
  // `base` is stamped on every line: the fields you filter on in Loki.
  base: {
    'service.name': config.serviceName,          // "shop-api" - matches the Prometheus job name on purpose
    'app.env': process.env.NODE_ENV ?? 'development',
    'app.release': config.release,               // "1.0.0" - which build produced this line
  },
  // ISO timestamps are readable by Loki and by humans. Epoch millis are not.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Emit the level as a string ("info") instead of a number (30).
  formatters: { level: (label) => ({ level: label }) },
  mixin() {
    const ctx = currentContext();                // reads Node AsyncLocalStorage (per-request store, 04b)
    const additions: Record<string, string> = {};
    if (ctx.requestId) additions['request_id'] = ctx.requestId;   // correlation id, 04a
    if (ctx.tenantId) additions['tenant_id'] = ctx.tenantId;       // which shop, 04b
    if (ctx.customerHash) additions['customer_hash'] = ctx.customerHash; // hashed, never the raw email
    const span = trace.getSpan(context.active());                 // if a trace span is live...
    if (span) {
      additions['trace_id'] = span.spanContext().traceId;         // ...paste its ids on the log line
      additions['span_id'] = span.spanContext().spanId;
    }
    return additions;
  },
};

if (config.redactionEnabled) {          // LOG_REDACT=true by default
  base.redact = { paths: REDACT_PATHS, censor: '[REDACTED]' };  // covers pino-http's own req/res
  base.serializers = buildSerializers();                          // the deep-scrub for OUR objects
}
```

The deep-scrub serializer (why enumeration alone is not enough is chapter 03a;
this is the shape that catches any nesting):

```ts
// app/src/lib/logger.ts - scrub() blanks sensitive keys at ANY depth.
for (const [key, val] of Object.entries(value)) {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) out[key] = '[REDACTED]';       // email, cvv, token, ...
  else if (parentKey === 'card' && CARD_CHILD_KEYS.has(lower)) out[key] = '[REDACTED]'; // number inside a card
  else out[key] = scrub(val, lower, depth + 1);                 // recurse; nothing escapes by hiding a level deeper
}
```

A child logger, the way a request handler would use it:

```ts
const req = logger.child({ request_id: '...', tenant_id: 'tenant_initech' });
// every call below inherits those two fields; you never restate them
req.info({ product_count: 3 }, 'catalog listed');
```

## 4. What you should see

This script imports the *real* app logger, makes a child logger, and logs a
nested card object so you can see base fields, the level formatter, child
inheritance, and the deep-scrub all at once. Run inside the container:

```
$ docker compose exec -T shop-api sh -c 'cd /app && ./node_modules/.bin/tsx /tmp/child-demo.mjs'
{"level":"info","time":"2026-10-29T07:21:05.224Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"doc-02b-child","tenant_id":"tenant_initech","product_count":3,"msg":"catalog listed"}
{"level":"warn","time":"2026-10-29T07:21:05.225Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"doc-02b-child","tenant_id":"tenant_initech","payment.decline_reason":"insufficient_funds","msg":"payment declined"}
{"level":"info","time":"2026-10-29T07:21:05.225Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","body":{"card":{"number":"[REDACTED]","cvv":"[REDACTED]","brand":"[REDACTED]"},"email":"[REDACTED]"},"msg":"card handled"}
```

Read the boxes:

- `service.name`, `app.env`, `app.release` are on all three lines - that is
  `base`, added with no effort at the call site.
- `level` is the string `info` / `warn` - that is `formatters.level`, not the
  number 30/40.
- `time` is an ISO string - that is `isoTime`.
- `request_id` and `tenant_id` are on both child lines even though only the
  child logger named them once - that is **child logger inheritance**.
- The card object was logged as `{ body: { card: { number, cvv, brand }, email } }`
  and every leaf came back `[REDACTED]` at two levels of nesting - that is the
  deep-scrub serializer, doing the job `redact` paths cannot.

Notice what is *absent*: no `trace_id`/`span_id`. Outside a real HTTP request
there is no active span, so `mixin` correctly adds nothing. See a live request
line (from 01a, `doc-01a-prod`) and it does carry both, because there the span
was active.

## 5. In a real multi-tenant e-commerce platform

`tenant_globex` complains that one checkout double-charged. The support ticket
quotes only the `request_id` shown back to the customer. Because `base` stamped
`service.name:"shop-api"` and `app.release:"1.0.0"`, you know which build to
read; because `mixin` stamped `tenant_id:"tenant_globex"` and `customer_hash`,
you can pull *only that tenant's* lines and follow one human across several
requests without ever storing their email. The JSON shape is what turns "search
the text" into "filter the fields".

## 6. When to use it, when not to

- Use structured fields for anything you might filter, count, or alert on:
  ids, tenant, status code, route, error code. A value that lives only inside
  the free-text `msg` is invisible to the log store's index.
- Do not flatten everything into giant top-level objects. Nest `res` and `req`
  (as Pino does) so Loki keeps a bounded label set; explode every key and you
  pay for it in the store.
- Child loggers are the cheap win for per-request context; do not hand-pass a
  `tenant_id` argument through ten functions when one `child()` at the edge
  does it.
- The deep-scrub walks the whole object on every line, so it costs CPU on very
  large payloads - gate `LOG_REDACT` accordingly (it stays on by default here).

## 7. Common mistakes

- Expecting `redact` paths to catch nested data. They are anchored at the root
  and `*` matches exactly one level, so `card.cvv` misses `body.card.cvv`, and
  `**.cvv` matches nothing (verified - chapter 03a). That is why the serializer
  exists; relying on `redact` alone leaks.
- Putting the searchable value only in `msg`. `msg` is prose for humans;
  filterable facts belong in fields.
- Calling `mixin` a place to do slow work. It runs per line; keep it to reading
  already-resolved context, not querying the database.
- Forgetting `base` fields differ from Loki labels. `service.name` in the JSON
  is not the Loki `service` label; Alloy/Loki derive the bounded label set
  separately (06a).

## 8. Try it yourself

Add one field of your own to a child logger and confirm it lands on every line.

Copy this into `child-demo.mjs`, `docker compose cp` it to
`shop-api:/tmp/child-demo.mjs`, run it as in section 4, and look for your new
key on both output lines:

```js
import { logger } from '/app/src/lib/logger.ts';
const c = logger.child({ request_id: 'doc-02b-try', tenant_id: 'tenant_umbrella' });
c.info({ your_field: 'hello' }, 'my first structured line');
```

Hint: after you run it, also try `logger.info({ your_field: 'hello' }, 'no
child')` and notice it lacks `request_id`/`tenant_id` - that difference is
exactly what a child logger buys you.

Cleanup (removes only the temp file; the shared stack is untouched):

```
$ docker compose exec -T shop-api rm -f /tmp/child-demo.mjs
```

## 9. Next

One JSON line is one event. The next chapter is the machinery that turns every
HTTP request into exactly one such line:
[02c - Request logging in development](02c-request-logging-dev.md).
