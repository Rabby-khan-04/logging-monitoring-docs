# 02a - Log levels: what each one means, when it fires here, and why debug is not free

## 1. Simple explanation

Your notebook has a pen for each kind of news.

If the house is on fire, you do not whisper it at the bottom of a page - you
shout it in big red letters. If the milk is nearly out, a small pencil note is
fine. Levels are just different-sized voices so the important lines stand out
and the boring ones do not crowd the page.

The voices, quietest to loudest, are:

- "just checking" (trace)
- "a tiny detail, only when I am curious" (debug)
- "normal thing happened" (info)
- "not broken, but I would keep an eye on it" (warn)
- "this one is broken" (error)
- "the whole thing is falling down" (fatal)

You set a volume dial. If you say "only shout info and louder", then every
"just checking" and "tiny detail" is never written down at all - the pen does
not even touch the page. That dial is what keeps the notebook small during a
normal day and full during a bad one.

## 2. Real name

Pino (this project's logger, 10.4.0) defines seven levels, each with a fixed
numeric priority:

| Level | Pino number | Meaning |
|---|---|---|
| `trace` | 10 | the most detailed, per-step, usually off |
| `debug` | 20 | diagnostic detail for developers |
| `info` | 30 | normal operation - this project's default |
| `warn` | 40 | abnormal but handled; client mistakes, soft failures |
| `error` | 50 | a request genuinely failed; you want a stack |
| `fatal` | 60 | the process is about to die |
| `silent` | Infinity | nothing is written |

The key rule: **setting the level is a threshold, not a filter on one level.**
`level: "info"` means "emit info and everything louder" (info, warn, error,
fatal). Lines quieter than the threshold are dropped before any work happens.

The threshold check is the reason the app is cheap on a normal day: below
`info`, a `logger.debug(...)` call is dropped at the `isLevelEnabled` gate
before the message string or the object is built.

## 3. Example

The dial is read from the environment in one place, so an operator changes it
without touching code.

```ts
// app/src/lib/config.ts - LOG_LEVEL comes from the environment; default "info".
logLevel: env('LOG_LEVEL', 'info'),
```

```ts
// app/src/lib/logger.ts - that value becomes the Pino threshold.
const base: LoggerOptions = {
  level: config.logLevel,        // everything below this number is dropped
  base: {
    'service.name': config.serviceName,
    'app.env': process.env.NODE_ENV ?? 'development',
    'app.release': config.release,
  },
  // ...
};
```

```yaml
# docker-compose.yml - the operator's dial per service.
shop-api:
  environment:
    LOG_LEVEL: "info"
```

Where each level actually fires in this app (verified in the source, not
guessed):

```ts
logger.info({ 'network.port': config.port }, 'shop-api listening'); // server.ts - startup
logger.info({ order_id, total_cents, currency }, 'order created');  // checkout.ts - normal path
logger.debug({ product_count: products.length }, 'catalog listed'); // catalog.ts - dev detail
logger.warn({ ...fields, 'http.method': req.method }, err.message); // errorHandler.ts - a 4xx client mistake
logger.error({ err, ... }, 'request failed');                       // errorHandler.ts - a 5xx, with stack
logger.fatal({ err, 'error.name': 'uncaughtException' }, '...');    // server.ts - process is dying
```

Note there is **no `logger.trace(...)` call anywhere in the app.** trace is
declared but never emitted; the dial stops at debug for a reason.

## 4. What you should see

**The threshold, measured.** This script builds two Pino loggers with the exact
`base`, `isoTime` and `formatters.level` of the app, calls all six levels on
each, and prints `isLevelEnabled`. It runs inside the container against the
installed pino, so this is real output, not a sketch:

```
$ docker compose cp /tmp/levels-demo.mjs shop-api:/tmp/levels-demo.mjs
$ docker compose exec -T shop-api sh -c 'cd /app && ./node_modules/.bin/tsx /tmp/levels-demo.mjs'
--- LOG_LEVEL=info ---
{"level":"info","time":"2026-10-29T07:19:33.897Z","service.name":"shop-api","app.env":"production","msg":"request completed"}
{"level":"warn","time":"2026-10-29T07:19:33.897Z","service.name":"shop-api","app.env":"production","msg":"payment declined"}
{"level":"error","time":"2026-10-29T07:19:33.897Z","service.name":"shop-api","app.env":"production","msg":"request failed"}
{"level":"fatal","time":"2026-10-29T07:19:33.897Z","service.name":"shop-api","app.env":"production","msg":"uncaught"}
--- LOG_LEVEL=debug ---
{"level":"debug","time":"2026-10-29T07:19:33.898Z","service.name":"shop-api","app.env":"production","msg":"catalog listed"}
--- isLevelEnabled at info ---
debug? false info? true
{"level":"info","time":"2026-10-29T07:19:33.898Z","service.name":"shop-api","app.env":"production","msg":"request completed"}
```

Read it carefully: at `info`, `trace` and `debug` produced nothing. At `debug`,
`debug` appears but `trace` still does not. `isLevelEnabled('debug')` is `false`
at info - that boolean short-circuit is the whole cost saving.

**The same levels in the live app.** Trigger one warn and one error and read
them out of the running container's log:

```
$ curl -s -o /dev/null localhost:8000/api/orders/999999 -H 'x-tenant-id: tenant_acme' -H 'x-request-id: doc-02a-warn'
$ curl -s -o /dev/null localhost:8000/api/boom -H 'x-tenant-id: tenant_acme' -H 'x-request-id: doc-02a-err'
$ docker compose logs --since 8s shop-api 2>/dev/null | grep doc-02a | grep -v '"req"'
{"level":"warn","time":"2026-10-29T07:19:49.920Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"doc-02a-warn","tenant_id":"tenant_acme","trace_id":"512d36997c0ab9455b2f8cec5de96cf5","span_id":"05fd0ce5224b6257","error.name":"NotFoundError","error.code":"not_found","error.status":404,"error.retryable":false,"http.method":"GET","msg":"Order not found"}
{"level":"error","time":"2026-10-29T07:19:49.928Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"doc-02a-err","tenant_id":"tenant_acme","trace_id":"99f40fe2d0f74cfecad3e307faae65c1","span_id":"d9c36db98e7a1550","err":{"type":"TypeError","message":"Cannot read properties of undefined (reading 'length')","stack":"TypeError: Cannot read properties of undefined (reading 'length')\n    at <anonymous> (/app/src/routes/debug.ts:26:49)\n    at Layer.handleRequest (/app/node_modules/router/lib/layer.js:152:17)\n    at AsyncLocalStorage.run (node:internal/async_local_storage/async_context_frame:65:14)\n    at AsyncLocalStorageContextManager.with (/app/node_modules/@opentelemetry/context-async-hooks/src/AsyncLocalStorageContextManager.ts:80:36)\n    at ContextAPI.with (/app/node_modules/@opentelemetry/api/src/api/context.ts:81:38)\n    at Layer.wrapped_handle_request (/app/node_modules/@opentelemetry/instrumentation-router/src/instrumentation.ts:114:28)\n    at next (/app/node_modules/router/lib/route.js:157:13)\n    at Route.dispatch (/app/node_modules/router/lib/route.js:117:3)\n    at handle (/app/node_modules/router/index.js:435:11)\n    at Layer.handleRequest (/app/node_modules/router/lib/layer.js:152:17)"},"error.name":"TypeError","error.code":"internal_error","error.message":"Cannot read properties of undefined (reading 'length')","http.method":"GET","http.route":"/api/boom","msg":"request failed"}
```

The 404 is a `warn` and carries no stack (a client typed a bad id - normal
traffic). The 500 is an `error` and carries the full `err.stack`. That
difference is the discipline: warn you trend on a dashboard, error you page on.

## 5. In a real multi-tenant e-commerce platform

`tenant_initech` runs a scraper that asks for products that do not exist, so
every few seconds you get a `warn` "Order not found". At `debug` they also
want to see `catalog listed` with `product_count`, to prove the tenant filter
worked. But `tenant_acme` at peak is thousands of requests per minute: leaving
`debug` on for everyone would bury the two `error` lines that actually matter.

The right shape: keep the base dial at `info` for all tenants, and raise only
`tenant_initech`'s to `debug` for a short window while you investigate, then
drop it back. Levels are how you keep a noisy neighbour from drowning the three
lines that page you.

## 6. When to use it, when not to

- `info` is the floor for anything you want permanently: request completed,
  order created. It is a fact about traffic.
- `warn` is for "handled but notable". A 4xx, a soft decline. If you `warn` on
  genuine bugs you create alert noise; if you `error` on user typos you create
  false pages.
- `debug` is a temporary lens, not a permanent record. It is the loudest way to
  spend money on a store you keep for weeks.
- `error` should mean "a human may need this" and `fatal` "this process is
  gone". Do not fire `fatal` for anything you can recover from.

Cost and noise, plainly: the higher the volume of detail you keep, the more you
pay the log store and the slower every search gets. Levels are the cheapest
volume knob you own, and they are free to set at the door, not in a query.

## 7. Common mistakes

- "Everything is `error`". If a bad password, a missing product and a crash are
  all `error`, you cannot alert on the crash without paging on the typo.
- Setting the level to `debug` "temporarily" and forgetting. The next incident
  is invisible under a mountain of `catalog listed`.
- Thinking `level: "info"` shows only info lines. It shows info *and louder*;
  it hides the quieter ones.
- Building the expensive object before the level check. `logger.debug(
  { rows: await query(...) })` runs the query even when debug is off. Gate it:
  `if (logger.isLevelEnabled('debug')) ...`.
- Using `trace` and `debug` interchangeably; here trace is unused on purpose.

## 8. Try it yourself

Turn the dial and watch a `catalog listed` line appear when it was not there
before, then disappear when you turn it past `info`.

The running shop has `LOG_LEVEL=info` baked into its environment, and you must
not restart it (other work shares the stack). Instead prove the threshold on a
throwaway logger running inside the container, against the installed pino:

```
$ docker compose exec -it shop-api sh -c 'cd /app && ./node_modules/.bin/tsx /tmp/levels-demo.mjs'
```

(That file is the script from section 4; you can copy your own with
`docker compose cp ./levels-demo.mjs shop-api:/tmp/levels-demo.mjs`.)

Hint: change the two `make('info')` / `make('debug')` levels to `make('warn')`
and re-run. `catalog listed` (debug) and `request completed` (info) both vanish,
because warn's threshold drops everything quieter - you have built a filter with
one number.

Cleanup (this returns the machine to exactly how you found it - the shared stack
was never touched, only a temp file inside the container is removed):

```
$ docker compose exec -T shop-api rm -f /tmp/levels-demo.mjs
$ curl -s localhost:8000/healthz
{"status":"alive","service":"shop-api"}
```

## 9. Next

Levels decide *whether* a line is written. The next chapter decides *what shape*
it has: [02b - Structured JSON with Pino](02b-pino-structured-json.md).
