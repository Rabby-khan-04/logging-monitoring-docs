# 05b - One error, one log line

All output was captured on the laptop stack from `docs/00-roadmap.md` (API 8000,
gateway 8020, Loki 3101), except the bug-era lines from the checked-in capture
`.artifacts/logs/shop-api-raw.txt`, labelled as such. `[...]` marks a shortened stack.

## 1. Simple explanation

Two shop staff see the same jug of milk on the floor. Both write it in the incident
book. In the morning the manager reads two entries, sends for two cleaners and
books two spills. Nothing happened twice; it was only written twice.

That is the whole lesson: one bad thing, one line, written by whoever knows most
about it. Two lines are not just wasted paper - after them you cannot count
anything. "How often did the card machine fail?" comes back 2x too high, and it is
worst on the busiest day, the only day you needed the number. The paper bill is
real too: the second line this repo shipped was 1736 bytes and said nothing the
first line had not.

## 2. Real name

- **Double logging / log amplification**: the same failure recorded by two writers.
  Amplification factor = lines per incident; measured here, 2 before the fix, 1 after.
- **Single owner**: one place per concern writes. Here `errorHandler` owns failures
  and `pino-http` owns the per-request access line.
- **Auto-logging**: `pino-http`'s habit of writing one line per request when the
  response finishes (chapter 02c). It is a *second writer*, so it needs rules.
- **Arrival time vs finish time**: the two moments a logging middleware can act. At
  arrival it knows only the request; at finish it knows `statusCode`, `err`, duration.
  Every dedup decision depends on which moment your option runs at.
- **`autoLogging.ignore(req)`**: arrival-time opt-out; takes **one** argument.
- **`customLogLevel(req, res, err)`**: finish-time level chooser; may return
  `'silent'` - not a Pino level, but an instruction to write nothing.
- **Dedup marker**: `res.locals.errorLogged = true`, a note on the response object
  saying "an owner already wrote this" (`res.locals` is Express's per-request scratch).

## 3. Example

The owner, `app/src/middleware/errorHandler.ts:38-45`:

```ts
if (statusCode >= 500) {
  // One error, one log line. Mark the response so pino-http's own finish
  // line is suppressed for this request; without this you get two error
  // lines per failure and every Loki query over-counts by 2x.
  res.locals.errorLogged = true;
  logger.error({ err: err as Error, ...fields, 'http.method': req.method, 'http.route': req.route?.path ?? req.path }, 'request failed');
} else {
  logger.warn({ ...fields, 'http.method': req.method }, (err as Error).message);
}
```

The second writer, `app/src/middleware/requestContext.ts:38-49` (the shipped fix):

```ts
autoLogging: {
  // Runs when the request ARRIVES: it can only judge the URL. Health checks
  // and Prometheus scrapes are cut here, or they become most of your volume.
  // startsWith, not === - `/metrics/demo` must be silent too.
  ignore: (req) => {
    const url = (req as Request).url ?? '';
    return url.startsWith('/healthz') || url.startsWith('/readyz') || url.startsWith('/metrics');
  },
},
customLogLevel(req, res) {
  // Runs when the response FINISHES, so it can see what the handler decided.
  if ((res as Response).locals?.errorLogged) return 'silent';   // dedup lives here
  if (res.statusCode >= 500) return 'error';
  if (res.statusCode >= 400) return 'warn';
  return 'info';
},
```

Why the split, from the installed `pino-http` 11.0.0 rather than from memory:

```js
// index.d.ts:50      - note there is no res parameter to ignore()
ignore?: ((req: IM) => boolean);
// logger.js:182-183  - ignore() is called as the request comes in
const isIgnored = autoLoggingIgnore(req)
// logger.js:53-54, 101-103 - the finish line may be silenced
if (level === 'silent') { return }
// logger.js:114-115  - the finish line, if allowed, invents its own error
if (err || res.err || res.statusCode >= 500) {
  const error = err || res.err || new Error('failed with status code ' + res.statusCode)
```

That last line is why the duplicate looks so silly: with no error object to hand on,
the second writer manufactured `Error('failed with status code 500')`, whose stack
points into `node_modules` instead of at your code.

## 4. What you should see

**A. The bug this repo shipped.** The first draft put the dedup in `ignore` and read
`res.locals` there. `ignore` receives one argument, so `res` was `undefined`, and the
throw happened at arrival, before any route ran: every request 500'd. Verbatim from
`.artifacts/logs/shop-api-raw.txt`:

```
shop-api-1  | {"level":"error","time":"2026-10-29T06:38:28.402Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","trace_id":"eb09c6b95e546d7d35a33501ccefb14e","span_id":"dc174759b6fb6939","err":{"type":"TypeError","message":"Cannot read properties of undefined (reading 'locals')","stack":"TypeError: Cannot read properties of undefined (reading 'locals')\n    at ignore (/app/src/middleware/requestContext.ts:34:40)\n    at loggingMiddleware (/app/node_modules/pino-http/logger.js:183:27)\n [...]    at /app/node_modules/router/index.js:297:9"},"error.name":"TypeError","error.code":"internal_error","error.message":"Cannot read properties of undefined (reading 'locals')","http.method":"GET","http.route":"/api/products","msg":"request failed"}
```

Read the holes: no `request_id`, no `tenant_id`. The crash happened inside the
request logger, before the tenant middleware could put either into the context
(chapters 04a, 04b). A failure you cannot attribute is a failure you cannot bill.

**B. One failure, two lines.** Still sitting in Loki from that era, `request_id`
`cap-err-0005`: one `/api/boom` call, two `error` lines 1 ms apart. Chapter 06a
explains this query; run it as pasted.

```bash
curl -sG localhost:3101/loki/api/v1/query_range --data-urlencode \
  'query={service="shop-api"} | json | request_id="cap-err-0005"' \
  --data-urlencode 'start=2026-10-29T06:40:00Z' --data-urlencode 'end=2026-10-29T06:41:00Z'
```

Line 1 (1457 bytes), the owner: real error, real stack, `http.route`.

```
{"level":"error","time":"2026-10-29T06:40:32.277Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"cap-err-0005","tenant_id":"tenant_acme","trace_id":"26e64c47d1aca631ab8c54b9906871d4","span_id":"7e980287a314f0e7","err":{"type":"TypeError","message":"Cannot read properties of undefined (reading 'length')","stack":"TypeError: Cannot read properties of undefined (reading 'length')\n    at <anonymous> (/app/src/routes/debug.ts:26:49)\n    at Layer.handleRequest (/app/node_modules/router/lib/layer.js:152:17)\n [...]    at Layer.handleRequest (/app/node_modules/router/lib/layer.js:152:17)"},"error.name":"TypeError","error.code":"internal_error","error.message":"Cannot read properties of undefined (reading 'length')","http.method":"GET","http.route":"/api/boom","msg":"request failed"}
```

Line 2 (1736 bytes), the stowaway: its own `Error`, the whole `req` and `res`, a
different sentence in `msg`, and no route.

```
{"level":"error","time":"2026-10-29T06:40:32.277Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","req":{"id":"cap-err-0005","method":"GET","url":"/api/boom","query":{},"params":{},"headers":{"host":"localhost:8000","user-agent":"curl/8.18.0","accept":"*/*","x-tenant-id":"tenant_acme","x-request-id":"cap-err-0005"},"remoteAddress":"::ffff:172.25.0.1","remotePort":54606},"route":"","request_id":"cap-err-0005","tenant_id":"tenant_acme","trace_id":"26e64c47d1aca631ab8c54b9906871d4","span_id":"ead82876ef8cd3c4","res":{"statusCode":500,"headers":{"x-request-id":"cap-err-0005","content-type":"application/json; charset=utf-8","content-length":"90","etag":"W/\"5a-LE0MNb7Low2NfkJEcs3XFgbEekY\""}},"err":{"type":"Error","message":"failed with status code 500","stack":"Error: failed with status code 500\n    at onResFinished (/app/node_modules/pino-http/logger.js:115:39)\n    at ServerResponse.onResponseComplete (/app/node_modules/pino-http/logger.js:178:14) [...]"},"responseTime":1,"msg":"request errored"}
```

3193 bytes and two `error` lines for one `TypeError`; after the fix, 1469 bytes and
one line - 54% of the volume for free.

**C. Now, the same probe.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8000/api/boom -H 'x-tenant-id: tenant_acme' -H 'x-request-id: ch05b-boom'
sleep 3 && docker compose logs --since 60s shop-api | grep -c 'ch05b-boom'
docker compose logs --since 60s shop-api | grep 'ch05b-boom'
```

```
500
1
shop-api-1  | {"level":"error","time":"2026-10-29T07:59:25.496Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"ch05b-boom","tenant_id":"tenant_acme","trace_id":"3f6ef7fcd880c90b1ba661f8187bc7b6","span_id":"c8dd905bebcc4218","err":{"type":"TypeError","message":"Cannot read properties of undefined (reading 'length')","stack":"TypeError: Cannot read properties of undefined (reading 'length')\n    at <anonymous> (/app/src/routes/debug.ts:26:49)\n    at Layer.handleRequest (/app/node_modules/router/lib/layer.js:152:17)\n [...]    at Layer.handleRequest (/app/node_modules/router/lib/layer.js:152:17)"},"error.name":"TypeError","error.code":"internal_error","error.message":"Cannot read properties of undefined (reading 'length')","http.method":"GET","http.route":"/api/boom","msg":"request failed"}
```

One line, `msg":"request failed"`, and no `"request errored"` anywhere near it. The
counters agree over a longer window (chapter 06a for the syntax, copy as pasted):

```bash
curl -sG localhost:3101/loki/api/v1/query --data-urlencode 'query=sum(count_over_time({service="shop-api"} |~ "\"msg\":\"request errored\"" [3h]))'
```

`3h` returns `6` (the bug era), `30m` returns an empty result - no lines at all,
which is not the same as zero and is chapter 06a's problem. Against those: 4032 and
712 `request failed` lines in the same windows.

**D. The noise rules and the 4xx case.** Six probes, lines per `request_id`:

```bash
for id in ch05b-boom ch05b-400 ch05b-404 ch05b-healthz ch05b-metrics ch05b-mdemo; do
  printf '%s %s\n' "$id" "$(docker compose logs --since 60s shop-api | grep -c "$id")"
done
```

```
ch05b-boom 1
ch05b-400 2
ch05b-404 1
ch05b-healthz 0
ch05b-metrics 0
ch05b-mdemo 0
```

`/healthz`, `/metrics`, `/metrics/demo`: silent, as intended. `/api/boom`: 1. The
unmatched 404: 1, and it is the `pino-http` access line (`msg":"request completed"`
at `warn`) - `notFound()` answers with JSON and does not log, which is right, a
wrong URL is the shopper's mistake, not our failure. `/api/error/validation` is 2,
and that is not this bug: 420 bytes of `warn` from the handler
(`msg":"demo validation failure"`) plus 777 bytes of `warn` access line. Two lines
answering two different questions, neither one an error record.

## 5. In a real multi-tenant e-commerce platform

`tenant_initech` is this stack's configured noisy neighbour: the fake gateway
declines 25% of its charges and adds 260ms (`app/src/payment-service.ts`), and a
chaos run wrote 264 `error` lines for it in 12 minutes against 2 for `tenant_acme`
(chapter 05a). Amplification is never evenly spread - it multiplies the loudest
tenant. Their share of the bill doubles first, and worse: "initech 528, acme 4"
reads as a defect in initech's integration when the defect is in your logger, and
their engineer gets the phone call.

The same shape, "two lines for one event", also appears across services: `shop-api`
logs the declined charge and `payment-gateway` logs it too. Keep both. Different
processes, different owners, different view of the cause - you need the pair to tell
"our call was bad" from "their box was down". Double logging means two writers in
one process for one exception, not one line per incident across a whole system.

## 6. When to use it, when not to

Use the marker when an owner has already recorded the failure with the real `err`,
which here is exactly the 5xx branch of `errorHandler`. Use `ignore` only for URLs
that will never be incidents: health checks, scrapes, load-balancer pings.

Do not dedup lines that answer different questions (access line vs error record:
keep both). Do not dedup the process handlers - `app/src/server.ts` logs
`unhandledRejection` at `error` and `uncaughtException` at `fatal` then exits, and
those have no response to mark and no second writer to silence. Do not fix this with
`autoLogging: false`, which throws away every access line and with it every latency
and traffic question you will ask next month. And if a failure path can end the
process, log before you rethrow: the marker costs nothing, the gap in the log is
permanent.

## 7. Common mistakes

1. **Dedup inside `ignore`.** Wrong moment: it runs at arrival and cannot know the
   outcome. Section 4A is the result.
2. **Ignoring the one-argument signature.** `ignore: (req, res) => res.locals...`
   throws at runtime on *every* request, and the lines you get lose `request_id` and
   `tenant_id` along with the 200s.
3. **`url === '/metrics'` instead of `startsWith`.** `/metrics/demo` is then logged
   forever, and it is scraped.
4. **Logging at the throw site "for context", then rethrowing.** Two error lines
   again; add fields to the one line the handler writes instead.
5. **Adding two metric queries together** ("failed" + "errored") and calling it the
   error count. In the bug era that sum was 2x the number of incidents.
6. **Filtering the duplicate out in the query.** `|! "request errored"` makes the
   count look right, keeps every byte stored and paid for, and hides the bug.
7. **Alerting on the manufactured stack.** `Error('failed with status code 500')`
   points into `node_modules`, so your paging text blames a library.
8. **Testing the fix with a reused `request_id`.** Asking twice with `ch05b-boom`
   gave two error lines in one 60s window and looked exactly like the bug. Unique id
   per probe, always (chapter 04a).

## 8. Try it yourself

Prove line-per-incident, then go looking for a route that breaks it:

```bash
id="ch05b-exercise-$(date +%s)"
curl -s -o /dev/null localhost:8000/api/boom -H 'x-tenant-id: tenant_acme' -H "x-request-id: $id"
sleep 3
docker compose logs --since 60s shop-api | grep '"level":"error"' \
  | grep -o '"request_id":"[^"]*"' | sort | uniq -c | sort -rn | head -5
```

Every count in that output was `1`, including `ch05b-exercise-1793260790`. Hint:
repeat it with `'"level":"warn"'` and you will see `2`s - the access line for a 4xx,
not a bug. The rule under test is "at most one *error*-level line per `request_id`",
so the check has to be per level. Cleanup: nothing to undo and no flag to reset; your
probe lines stay in Loki until the 72h retention drops them, and chapter 06b shows
why waiting is the tool here and the delete API is not.

## 9. Next

[06a - Loki and LogQL](06a-loki-logql.md): where all these lines go, how to find one
`request_id` again, and which queries are cheap.
