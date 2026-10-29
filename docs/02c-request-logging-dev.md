# 02c - Request logging with pino-http, and pretty output in development

## 1. Simple explanation

You do not want to write by hand, for every single customer who walks in: "came
in at this time, asked for this, left after this long, happy/sad." That is the
same sentence a thousand times. So you hire a clerk who stands at the door and
writes one tidy line for every person who comes in and goes out.

pino-http is that door clerk for the shop. One line per request, automatic.

Three habits you have to teach the clerk:

- Give each visitor a name tag when they arrive, so you can find their line
  later; keep the tag they wore in from another shop, or write a new one.
- Do not write a line for people who only pop their head in to ask "is the shop
  open?", or for the meter-reader who comes every minute. They bury the page.
- Choose the size of voice by how the visit went: happy = normal, "wrong
  number" = a warn, "we dropped it" = an error.

And one thing for the workshop: at home you want the notes in friendly,
coloured form; in the real shop they must stay plain and machine-readable. Same
clerk, different presentation.

## 2. Real name

**pino-http** (11.0.0 here) is Express middleware that logs one line per HTTP
request on response finish, using your pino logger. The options that matter:

- **`genReqId(req, res)`** - produces the `req.id` stamped on the line. This
  project feeds it the incoming `x-request-id` header (so a chain started
  upstream is not broken) and mints a `randomUUID()` otherwise.
- **`autoLogging.ignore(req)`** - called when the request *arrives*, with
  exactly **one** argument. Return `true` to skip logging the request entirely.
  Because it runs at arrival, it can only decide from the URL, not the outcome.
- **`customLogLevel(req, res)`** - called at response-finish time; returns the
  level for the line, or the string `'silent'` to drop it. This is where the
  outcome is known (statusCode), and where double-logging is suppressed.
- **`customProps(req)`** - extra fields merged onto the line (here `route`).

**pino-pretty** (13.2.0) is a pino *transport*: it reformats the JSON for human
eyes at a terminal on a worker thread. It is a development-only presentation
layer.

Two hard-won rules bind this together. pino-http 11 calls `ignore` with **one**
argument, at arrival, so `ignore: (req, res) => ...` leaves `res` undefined and
a `.locals` read on it throws - turning every request into a 500 (this happened
here). And because the error handler already logs a 5xx with its stack, the
outcome-dependent work (including suppressing that duplicate) belongs in
`customLogLevel`, which can return `'silent'`. One failure, one line.

## 3. Example

The real middleware from `app/src/middleware/requestContext.ts`:

```ts
export const httpLogger = pinoHttp({
  logger,                                  // reuse the single app logger (02b)
  genReqId: requestId,                     // honour x-request-id, else randomUUID (04a)

  autoLogging: {
    // pino-http 11 calls this with ONE arg, at ARRIVAL: filter on URL only.
    ignore: (req) => {
      const url = (req as Request).url ?? '';
      return url.startsWith('/healthz')     // liveness probe, polled every few seconds
        || url.startsWith('/readyz')        // readiness probe
        || url.startsWith('/metrics');      // Prometheus scrapes this constantly
    },
  },

  // Runs at RESPONSE-FINISH time, when statusCode is known. This is where the
  // "how did it go" decision belongs - never in `ignore`.
  customLogLevel(req, res) {
    if ((res as Response).locals?.errorLogged) return 'silent'; // errorHandler already logged this 5xx
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';                   // a 404 becomes a warn, not info
    return 'info';
  },

  customProps(req) {
    return { route: (req as Request).baseUrl };                 // a stable path, not the raw url with ids/queries
  },
});
```

The dev-only pretty transport, from `app/src/lib/logger.ts`, switched on by
`LOG_PRETTY` (from 02b's `config.prettyLogs`):

```ts
if (config.prettyLogs) {                 // development only; compose ships LOG_PRETTY="false"
  base.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname,service.name,app.env,app.release', // hide the boxes you do not need to eyeball
    },
  };
}
```

## 4. What you should see

**genReqId + customLogLevel, on the live app.** A 404 request, whose incoming
`x-request-id` was `doc-02c-warn`:

```
$ curl -s -o /dev/null localhost:8000/api/orders/999999 -H 'x-tenant-id: tenant_acme' -H 'x-request-id: doc-02c-warn'
$ docker compose logs --since 120s shop-api 2>/dev/null | grep doc-02c-warn | grep 'request completed'
shop-api-1  | {"level":"warn","time":"2026-10-29T07:27:41.034Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","req":{"id":"doc-02c-warn","method":"GET","url":"/api/orders/999999","query":{},"params":{},"headers":{"host":"localhost:8000","user-agent":"curl/8.18.0","accept":"*/*","x-tenant-id":"tenant_acme","x-request-id":"doc-02c-warn"},"remoteAddress":"::ffff:172.25.0.1","remotePort":53738},"route":"","request_id":"doc-02c-warn","tenant_id":"tenant_acme","trace_id":"3ac153b1b59cf8052c7d6146c4112ebb","span_id":"6f834d138de60443","res":{"statusCode":404,"headers":{"x-request-id":"doc-02c-warn","content-type":"application/json; charset=utf-8","content-length":"86","etag":"W/\"56-CqzhvJrJED8avCtoGUP3Tq66pmM\""}},"responseTime":1,"msg":"request completed"}
```

Two facts, one line: `"req":{"id":"doc-02c-warn"...}` proves `genReqId` kept the
header you sent, and `"level":"warn"` on `statusCode":404` proves `customLogLevel`
upgraded the voice from info to warn.

**autoLogging.ignore, on the live app.** Hit the three ignored paths, then one
real path, and count logged request lines:

```
$ curl -s -o /dev/null localhost:8000/healthz; curl -s -o /dev/null localhost:8000/metrics; curl -s -o /dev/null localhost:8000/readyz
$ docker compose logs --since 4s shop-api 2>/dev/null | grep -E '"url":"/(healthz|readyz|metrics)' | grep -c 'request completed'
0
$ curl -s -o /dev/null localhost:8000/api/products -H 'x-tenant-id: tenant_acme' -H 'x-request-id: doc-02c-prod'
$ docker compose logs --since 3s shop-api 2>/dev/null | grep doc-02c-prod | grep -c 'request completed'
1
```

The probes and the scrape produced zero lines - they arrived, got answered, and
were never written down. The product call produced one. That is the difference
between a readable log and one where 90% is health checks.

**pino-pretty, development output.** This is the app's real startup line run
through the pretty transport (what `LOG_PRETTY=true` produces at a terminal):

```
$ docker compose logs shop-api | grep 'shop-api listening' | sed 's/^shop-api-1  | //' | docker compose exec -T shop-api sh -c 'cd /app && ./node_modules/.bin/pino-pretty'
[06:48:16.043] INFO: shop-api listening
    service.name: "shop-api"
    app.env: "production"
    app.release: "1.0.0"
    network.port: 8000
    log_level: "info"
    redaction: "on"
    otlp: "http://otel-collector:4318"
    pool_max: 8
```

Readable, indented, coloured at a real terminal - and Loki cannot query it.
`.artifacts/logs/pino-pretty.txt` holds a fuller colour capture taken with
`LOG_PRETTY=true LOG_LEVEL=debug`; note it shows `DEBUG` lines (`catalog listed`)
that production at `info` never emits. Production ships raw JSON.

## 5. In a real multi-tenant e-commerce platform

`tenant_acme` wires a health check to `GET /healthz` every five seconds and a
scraper to `/metrics`. Without `autoLogging.ignore`, those two alone would be
the bulk of your log volume for zero diagnostic value, and the Loki bill tracks
that noise. Worse, logging the scrape at `info` puts probes into
`http_requests_total`, so the request-rate you alert on looks artificially
healthy. Ignoring them at the door keeps the cost and the metrics honest, while
`tenant_globex`'s real API calls - and their `warn` on a 404, `error` on a 500 -
are logged in full.

## 6. When to use it, when not to

- Use pino-http as the one automatic request logger for the whole service; it
  gives complete coverage without per-route logging.
- Use `ignore` only for URL-known, arrival-time decisions (probes, scrapes);
  anything needing the result belongs in `customLogLevel`.
- Use pino-pretty only in development; in production it destroys the JSON that
  LogQL, the `level` label and every field filter depend on (see 06a).
- If one request can produce two lines (handler + pino-http) you double-count in
  Loki; silence one with the `'silent'` return.

## 7. Common mistakes

- Writing `ignore: (req, res) => ...` copied from pino-http 10 or an old blog
  post. In v11 there is no second argument; `res` is undefined and touching
  `res.locals` throws, turning every request into a 500 (verified here; the
  stack trace is in the roadmap's captured raw logs).
- Putting the 5xx suppression in `ignore`. `ignore` runs at arrival and cannot
  know the status yet; the fix must be in `customLogLevel`.
- Logging everything, health checks included, then wondering why the request
  rate is flat and Loki is full of `/healthz`.
- Shipping pino-pretty to production because it looked nicer in the demo.
- Reading `req.url` for the route field: it carries query strings and raw ids,
  so each variant is a different value; use the matched route template.

## 8. Try it yourself

Send one request that carries its own `x-request-id` and confirm `genReqId`
kept it rather than minting a UUID.

```
$ curl -s localhost:8000/api/products -H 'x-tenant-id: tenant_acme' -H 'x-request-id: doc-02c-try' -o /dev/null
$ docker compose logs --since 6s shop-api 2>/dev/null | grep doc-02c-try | grep -o '"id":"doc-02c-try"'
```

Hint: then send one *without* the header (`-H 'x-request-id:'` clears it) and
look at the `id` that appears - a UUID. The header wins when present; that is
how a chain of services shares one request id (04a).

Cleanup: this only made read GET requests; nothing persists or needs undoing.
Confirm the shared stack is still healthy and untouched:

```
$ curl -s localhost:8000/healthz
{"status":"alive","service":"shop-api"}
```

## 9. Next

You can log a request safely. The next chapter is what you must *never* log,
shown by leaking it first: [03a - Redaction](03a-redaction.md).
