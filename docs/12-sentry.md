# 12 - Sentry

> **Sentry is configured in this repo but it is NOT running here.** `@sentry/node` 11.10.0 is a dependency, `initSentry()` dynamically imports it only when `SENTRY_DSN` is set, and this stack sets no `SENTRY_DSN` and has no Sentry container. No Sentry project, no UI, no issue list, no release page: everything below about Sentry's screens, grouping percentages or billing is reasoned from documentation and labelled as such. Section 4 is what was executed, and it carries the real lesson - the failure a Sentry event would carry is already in this stack's logs.

---

## 1. Simple explanation

Every time someone drops an ice cream, the shop writes a note: "mint cone, 3:12, by the door". By closing time there are 4,000 notes and nobody can read them.

An error tracker is a *box with dividers*: instead of 4,000 notes you get one pile, "mint cones fall over", with "4,000 times today" on the front, the name of whoever should fix it, and "this pile started after we changed the cone supplier on Tuesday". Loki is the CCTV tape: it recorded everything, in order, and you watch it yourself. Both describe the same fall.

## 2. Real name

**Error tracking** (exception aggregation). An **event** is one captured exception with its stack and context; an **issue** is many events collapsed by a **fingerprint**, the rule for "same error"; **release** and **environment** say which deploy on which box; a **frame** is one line of the stack; a **source map** turns a minified frame back into your code; **breadcrumbs** are what happened just before; **`beforeSend`** is your hook to mutate or drop an event before transmission.

The distinction this chapter keeps using: **Sentry** = per-event, grouped, release-tagged, owner-assigned exceptions at a vendor you pay per event. **Loki** = a queryable stream of log lines you own, billed by storage and retention (06a, 06b), with no concept of "issue" and no assignee. They overlap, and that overlap is a budget decision, not a religious one.

## 3. Example

### 3.1 The wiring that is real here

`app/src/lib/sentry.ts`, entire file:

```ts
// Optional Sentry wiring. Nothing here runs unless SENTRY_DSN is set, so the
// local stack stays fully offline by default.
import { config } from './config.js';
import { logger } from './logger.js';

// Sentry v9 and later are built on OpenTelemetry, so `Sentry.init` installs
// the span processor; it must run before your app code, alongside or instead
// of the plain NodeSDK. Do not run both SDKs on one process.
export async function initSentry(): Promise<void> {
  if (!config.sentryDsn) return;                    // <-- the entire "off" switch
  const Sentry = await import('@sentry/node');      // <-- not even loaded otherwise
  Sentry.init({
    dsn: config.sentryDsn,
    release: config.release,                        // APP_RELEASE, same value pino stamps
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0,                            // tracing belongs to OTel here
    beforeSend(event) {
      // Belt and braces: never let a request body leave the machine.
      if (event.request?.data) delete event.request.data;
      if (event.request?.headers) delete event.request.headers;
      return event;
    },
  });
  logger.info({ 'sentry.environment': process.env.NODE_ENV ?? 'development' }, 'Sentry enabled');
}
```

It is called from `app/src/instrumentation.ts`, which compose loads *before* the app (`await sdk.start()`, then `await initSentry()`), and configured in `app/src/lib/config.ts` by two lines: `sentryDsn: env('SENTRY_DSN', '')` (empty, so the guard fires) and `release: env('APP_RELEASE', 'dev')`. `x-app-env` in `docker-compose.yml` sets `APP_RELEASE: "1.0.0"` and the `OTEL_*` variables, and deliberately does **not** set `SENTRY_DSN`. The stack is offline because the flag is absent, not because the code is commented out.

### 3.2 `tracesSampleRate: 0`, and the two-SDK warning

Sentry v9+ (this repo pins 11.10.0) is **built on OpenTelemetry**: `Sentry.init` brings its own span processor, context manager and instrumentations. Two consequences. (1) **Do not run the OTel `NodeSDK` and Sentry tracing in one process and expect a clean result.** Here the NodeSDK owns traces and pushes to `otel-collector:4318` (Tempo), so Sentry's side is switched off; if you want spans *in* Sentry, decide which pipeline owns them and raise the rate on one side - two full pipelines means paying twice for the same spans and competing context managers. 13a explains spans. (2) **The old API surface is gone:** `Sentry.init({ integrations: [new Integrations.Http()] })` is pre-OTel v7/v8 styling, while v11 takes HTTP instrumentation from its OTel layer and you tune it with `sendDefaultPii`, `maxBreadcrumbs`, `ignoreErrors` and `beforeSend`. Do not copy a v6 blog post into a v11 app.

`initSentry()` is awaited in `instrumentation.ts` rather than `server.ts` for the same reason the SDK is: hooks must exist before `http`, `pg` and `express` load.

### 3.3 Why `beforeSend` deletes things

This is [03a - Redaction](03a-redaction.md) applied to a different transport. Pino never writes the card number because the scrubbing serializer runs before the line is written. Sentry's default capture *attaches request context* - bodies, headers, cookies - because it debugs well and it is somebody else's database, and `sendDefaultPii: false` limits identity fields without promising that nothing sensitive leaves. So the local code strips `event.request.data` and `.headers` at the last moment, keeping the decision in one reviewable place instead of 40 route handlers. On a card-paying shop that is a compliance requirement, not a nicety.

### 3.4 Releases and source maps, honestly

A **release** answers "which deploy introduced this pile?". The identifier already exists and is stamped on every log line as `app.release` (4.2); wiring it up is the `release: config.release` line above - real code, missing destination.

**Source maps** un-minify frames. `app/tsconfig.json` sets `"sourceMap": true` with `"outDir": "dist"` and the `start` script runs `dist/*.js`, so a compiled deploy would want maps uploaded. But this stack runs `tsx` on the sources and 4.2 shows a frame that already names `/app/src/routes/debug.ts:26:49`: this server needs no maps at all. They are a browser-bundle problem (15) and a minified-build problem, not a universal requirement.

## 4. What you should see

4.1-4.4 were executed against the running stack on 2026-10-29. Nothing was sent to Sentry; 4.4 explains how that is guaranteed.

### 4.1 No DSN: Sentry is not even loaded

```
$ curl -s localhost:8000/healthz
{"status":"alive","service":"shop-api"}

$ docker compose exec -T shop-api printenv SENTRY_DSN; echo "printenv SENTRY_DSN exit=$?"
printenv SENTRY_DSN exit=1
$ docker compose logs --since 2m shop-api | grep -c 'Sentry enabled'
0
$ docker compose exec -T shop-api node -e "console.log('sentry module resolvable:', !!require.resolve('@sentry/node'))"
sentry module resolvable: true
```

The variable is unset (exit 1 = not found), the `'Sentry enabled'` line that `initSentry()` logs at the end has never been written, and the package *is* installed: installed but never imported, because the guard on line 10 fires before the `await import('@sentry/node')` on line 12.

### 4.2 The failure a Sentry event would carry, as a log line

```
$ curl -s localhost:8000/api/boom -H 'x-tenant-id: tenant_acme' -H 'x-request-id: probe-sentry-01'
{"error":{"code":"internal_error","message":"Internal error","request_id":"probe-sentry-01"}}

$ docker compose logs --since 40s shop-api | grep probe-sentry
```

```
shop-api-1  | {"level":"error","time":"2026-10-29T08:19:38.088Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","request_id":"probe-sentry-01","tenant_id":"tenant_acme","trace_id":"cb19a9bb85295bff1db3594bdc961c88","span_id":"7e8cb13aaf2be20a","err":{"type":"TypeError","message":"Cannot read properties of undefined (reading 'length')","stack":"TypeError: Cannot read properties of undefined (reading 'length')\n    at <anonymous> (/app/src/routes/debug.ts:26:49)\n    at Layer.handleRequest (/app/node_modules/router/lib/layer.js:152:17)\n    at AsyncLocalStorage.run (node:internal/async_local_storage/async_context_frame:65:14)\n    at AsyncLocalStorageContextManager.with (/app/node_modules/@opentelemetry/context-async-hooks/src/AsyncLocalStorageContextManager.ts:80:36)\n    at ContextAPI.with (/app/node_modules/@opentelemetry/api/src/api/context.ts:81:38)\n    at Layer.wrapped_handle_request (/app/node_modules/@opentelemetry/instrumentation-router/src/instrumentation.ts:114:28)\n    at next (/app/node_modules/router/lib/route.js:157:13)\n    at Route.dispatch (/app/node_modules/router/lib/route.js:117:3)\n    at handle (/app/node_modules/router/index.js:435:11)\n    at Layer.handleRequest (/app/node_modules/router/lib/layer.js:152:17)"},"error.name":"TypeError","error.code":"internal_error","error.message":"Cannot read properties of undefined (reading 'length')","http.method":"GET","http.route":"/api/boom","msg":"request failed"}
```

That line already holds what an error tracker sells you: exception type, message, full stack with file and line, release, environment, tenant, request id, and a `trace_id` for Tempo. What it does not hold: grouping, an owner, "first seen in 2.41.0", a notification. That is the honest gap.

### 4.3 The same line is queryable in Loki

```
$ curl -sG 'http://localhost:3101/loki/api/v1/query' --data-urlencode 'query={service="shop-api"} |= "probe-sentry-01"'
log queries are not supported as an instant query type, please change your query to a range query type

$ curl -sG 'http://localhost:3101/loki/api/v1/query_range' \
    --data-urlencode 'query={service="shop-api"} |= "probe-sentry-01"' \
    --data-urlencode "start=..." --data-urlencode "end=..." --data-urlencode 'limit=2'
http=200
{"status":"success","data":{"resultType":"streams","result":[{"stream":{"container":"observability-learn-shop-api-1","detected_level":"error","level":"error","service":"shop-api","service_name":"shop-api","tenant_id":"tenant_acme"},"values":[["1793261978088672929","{\"level\":\"error\",\"time\":\"20
```

Truncated by `head -c 300`, so it ends mid-line, and `start=`/`end=` were epoch-nanosecond values elided here for space. Two traps, both hit for real: log queries need `query_range`, not `/query`; and `container="shop-api-1"` returned an empty `result`, because Loki's `container` label is the Docker container name `observability-learn-shop-api-1`, not the compose service name.

### 4.4 The closest honest look at a Sentry event object

No UI, event page or issue count can be shown here and I will not invent one. What can be shown is the object *before transmission*, using this project's own `beforeSend` pattern: a one-off process inside the running container, a DSN pointing at nothing, and `beforeSend` returning `null`, which drops the event - so nothing left the machine.

```
$ timeout 60 docker compose exec -T shop-api node --input-type=module -e 'import * as Sentry from "@sentry/node"; Sentry.init({dsn: "http://key@127.0.0.1/1", release: "1.0.0", environment: "local", tracesSampleRate: 0, beforeSend(event) { if (event.event_id) {} if (event.request) { delete event.request.data; delete event.request.headers; } console.log("SENTRY_EVENT=" + JSON.stringify({keys: Object.keys(event).sort(), release: event.release, environment: event.environment, platform: event.platform, type: event.exception && event.exception.values && event.exception.values[0].type, hasStack: !!(event.exception && event.exception.values && event.exception.values[0].stacktrace), frames: event.exception && event.exception.values[0].stacktrace && event.exception.values[0].stacktrace.frames.length, requestKept: !!event.request})); return null; }}); try { const b = {}; console.log(b.items.length); } catch (e) { Sentry.captureException(e); } await Sentry.close();'
SENTRY_EVENT={"keys":["breadcrumbs","contexts","environment","event_id","exception","level","modules","platform","release","sdk","sdkProcessingMetadata","server_name","timestamp"],"release":"1.0.0","environment":"local","platform":"node","type":"TypeError","hasStack":true,"frames":5,"requestKept":false}
```

Three takeaways: the event is small and boring, and grouping works on `exception` plus frames; `modules` and `server_name` ride along by default, so your dependency inventory and hostname travel with every event, which is a decision rather than a default; and `frames: 5` with `requestKept: false` is specific to this bare script, which had no HTTP scope to attach - in a real request pipeline the same SDK does attach request context, which is exactly what `beforeSend` exists to strip.

### 4.5 Not shown, on purpose

No Sentry screen, issue count, release page or suspect commit, source map upload, Sentry alert rule, invoice or browser SDK was observed on this machine. Verify those against your own project; if your Sentry disagrees with this chapter, your Sentry is right.

## 5. In a real multi-tenant e-commerce platform

A mid-market retailer, `tenant_acme` and `tenant_globex` sharing one API deployment, checkout peak at 19:00. Release `2.41.0` ships at 18:50 and at 18:57 a `TypeError` starts firing in the basket-pricing helper.

**What Loki gives you** is lines like 4.2, with stack, `tenant_id`, `app.release` and `trace_id`, and a filter showing it is `tenant_acme` only because that tenant sells bundles. You learn the shape of the problem from a query you had to write, at 19:02, while on-call reads a wall of near-identical lines. **What the error tracker adds** is the four things a log line cannot do: thousands of identical events collapsed into **one issue** with a count and a first-seen time; that issue **tagged with the release**, so "new in 2.41.0" is on the front and it reopens as *regressed* if it comes back; **assignment** to the pricing team without a human deciding who cares; and a **notification** the moment the group appears, rather than when a threshold happens to trip (10a and 10c are the threshold side).

Multi-tenant wrinkles: keep `tenant_id` a **tag**, never part of the fingerprint, or one bug becomes four issues and on-call learns to ignore all four. One tenant's retry storm can spend the whole monthly event budget - chapter 19's noisy neighbour in a new costume. A shared project crosses tenant boundaries by design, so the engineer assigned to `tenant_acme` reads `tenant_globex` request context inside the same event. And `PaymentDeclinedError` (402) is a business outcome for metrics and logs, not an issue (05a).

## 6. When to use it, when not to

Error trackers bill per event, with separate meters for traced transactions, session replay, attachments, profiling and crons. They also bill noise: an issue list nobody triages is just Loki with a subscription. Decide the overlap once and write it down.

| Question | Cheaper answer |
|---|---|
| Is checkout broken now, for whom, at what rate? | Metrics and alerts (08b, 10a) |
| What was the stack, and has it been fixed before? | Error tracker issue |
| Every log line for this request id | Loki (06a) |
| How many orders did we lose? | Business metrics (16), never an error tracker |
| Every 400 from one broken mobile app | Drop it in `beforeSend`, count it as a metric |

Send: `TypeError`, `ReferenceError`, "should be impossible" branches, `DatabaseError` after the retry budget. Do not send: `ValidationError` (400), `UnknownTenantError` (403), `NotFoundError` (404), `PaymentDeclinedError` (402), retries that succeeded, probe failures from a misconfigured health check (11), bot scans, and `captureMessage` at `info` in a hot path - the classic four-figure bill for logging the word "debugging". Keep `tracesSampleRate` at 0 unless you chose to pay for Sentry tracing, and set event caps before the first incident, because the incident where you need the events is the incident that generates 50,000 of them.

## 7. Common mistakes

1. Running the OTel NodeSDK and Sentry tracing in one process and wondering why spans double. v11 Sentry *is* OTel: one owner per pipeline.
2. `Sentry.init()` after the app has served requests - too late for the frames and spans you care about. Hence `--import`.
3. Treating every exception as worth paying for: declines and validation failures make one useless issue and a real invoice.
4. Shipping default request capture on a card-paying shop. `sendDefaultPii: false` is not "nothing sensitive leaves"; `beforeSend` is (03a).
5. No `release`, so "did the last deploy break this?" is unanswerable and half the tool's value evaporates. Reuse the `APP_RELEASE` you already stamp on logs.
6. High-cardinality fingerprints: `request_id`, `user_id` or `order_id` in the grouping key gives 10,000 issues and zero signal. That is what tags are for.
7. Trusting minified browser stacks with no uploaded source maps (15). Readable server frames here do not transfer to a bundle.
8. Using the error tracker as the alerting system: it reports a new issue but does not know your error budget. Alerts come from rules; the issue is where you go after the page.
9. Deleting the SDK because "we have Loki". Loki will not tell you that a fifteen-month-old issue regressed yesterday, and it has no notion of an owner. The answer to cost is minimisation and caps, not amnesia.

## 8. Try it yourself

Re-run the probe from 4.4 with your own hands on the event: add `delete event.modules;` and `delete event.server_name;` inside `beforeSend`, keep `return null`, print `Object.keys(event).sort()` again, and diff the two key lists. **Hint:** that printed list *is* the privacy surface of a Node error event - anything you do not delete is something a vendor stores and a colleague can read.

Then, with no Sentry involved: `curl -s localhost:8000/api/error/not-found -H 'x-tenant-id: tenant_acme'`, the same for `/api/error/crash`, and find both lines in Loki. One is a `warn` with no stack, the other an `error` with a full stack. Which would you pay to see as an issue? That judgement, applied across your whole app, is your monthly bill.

**Cleanup:** nothing to clean. The probe was a one-off process inside the running container, it exited, it sent nothing (`beforeSend` returned `null`) and it changed no file or container; confirm with `curl -s localhost:8000/healthz`. If you later set a real `SENTRY_DSN` to experiment, unset it afterwards: a valid DSN starts uploading immediately, and this repo's fake data should stay local.

## 9. Next

Spans are the third signal, and 4.2 already handed you one: [13a - Spans, the OTel SDK and auto-instrumentation](13a-spans.md).
