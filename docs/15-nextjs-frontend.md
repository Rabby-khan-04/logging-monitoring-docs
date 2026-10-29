# 15 - Next.js and the frontend

> **There is no frontend in this stack.** No Next.js, no React, no browser, no HTML page: `app/package.json` depends on express, pino, pg, prom-client, zod, the OTel SDKs and `@sentry/node` - nothing that renders a page - and `curl -s localhost:8000/` answers `content-type=application/json`, an endpoint index. The Next.js-specific parts (3.2, 3.4, 3.5) are **reasoned from documentation; nothing in them was executed on this machine**, and names in `next/*` and `@sentry/nextjs` move between versions, so verify against the version you install. Section 4 is what was executed, and it is not filler: the registration-hook idea, the request-id and tenant-context pattern, and "server logs are only JSON if you make them JSON" are all demonstrated by the running `shop-api`, because inside, a Next server is a Node process.

---

## 1. Simple explanation

Your shop has two halves. One runs in a room you own, on a machine you control: you can read everything it says. The other runs in a stranger's pocket, on a phone with two bars of signal, in a browser you will never see.

For the pocket half you only know what it chooses to tell you, so you give it a tiny rule: "if anything goes wrong, or if the picture took too long to appear, phone the shop and say so." The rule has to be careful, because a million customers phoning at once is an expensive conversation, and because "the page felt slow" is not the same complaint as "the page is broken". The server half still needs exactly what 02a-05b taught: JSON lines, one request id, one tenant, one error logged once.

## 2. Real name

**Frontend observability**, a.k.a. **RUM** (real user monitoring): the browser's half of the three signals.

| Term | What it is |
|---|---|
| Browser error tracking | `error` and `unhandledrejection` capture, with bundle frames de-minified by source maps (12 covers the server half) |
| Core Web Vitals | The standardised experience measurements: **LCP** (largest contentful paint), **INP** (interaction to next paint), **CLS** (cumulative layout shift) |
| FCP / TTFB | First contentful paint, time to first byte: supporting actors, not the headline |
| Beacon | Last-chance delivery: `fetch(..., { keepalive: true })` or `navigator.sendBeacon`, because a normal `fetch` dies with the tab |
| Error boundary | React catching render errors in its subtree: `error.tsx`, `global-error.tsx` |
| `instrumentation.js` / `register()` | Next's startup hook, run once per server process before the first request |
| Route handler vs Server Component | The two kinds of server code: handlers have `req`/`res`, components do not |
| Runtime | `nodejs` vs `edge`: your hook code has to know which one it is in |

## 3. Example

### 3.1 The registration hook - the real, running version

From `docker-compose.yml`, the `shop-api` command:

```yaml
    command: ["sh", "-c", "./docker-entry.sh && ./node_modules/.bin/tsx --import ./src/instrumentation.ts src/server.ts"]
```

`--import` runs `app/src/instrumentation.ts` to completion *before* `server.ts` is evaluated, so the OpenTelemetry hook layer exists while `http`, `pg` and `express` are still unloaded. The file, abridged and re-wrapped to its decisions:

```ts
// OpenTelemetry bootstrap. This file is loaded with `--import` BEFORE the app,
// so the instrumentation hooks are installed before http/pg/express are loaded.
process.env.OTEL_METRICS_EXPORTER ??= 'none';   // prom-client owns metrics
process.env.OTEL_LOGS_EXPORTER ??= 'none';      // pino owns logs
process.env.OTEL_TRACES_EXPORTER ??= 'otlp';    // this process owns traces
const sdk = new NodeSDK({ instrumentations: [getNodeAutoInstrumentations({
  '@opentelemetry/instrumentation-fs': { enabled: false },   // noise
  '@opentelemetry/instrumentation-dns': { enabled: false },  // noise
  '@opentelemetry/instrumentation-net': { enabled: false },
})] });
await sdk.start();
const { initSentry } = await import('./lib/sentry.js');       // chapter 12
await initSentry();
process.on('SIGTERM', () => { void sdk.shutdown().finally(() => process.exit(0)); });
```

Three lessons that transfer straight into Next.js, all visible in 4.1: hooks must be installed **before** the things they instrument; configuration that needs no code belongs in **environment variables**, so deploys own it rather than commits; and shutdown matters - unflushed spans mean the tail of every deploy disappears, which is the same problem the browser has in 3.5.

### 3.2 The Next.js equivalent - NOT executed here

Reasoned from documentation, unrun:

```ts
// src/instrumentation.ts
export async function register() {
  // register() runs once per server process, before the first request.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
    new NodeSDK({ instrumentations: [getNodeAutoInstrumentations()] }).start();
  }
}
export async function onRequestError(err: unknown, req: unknown, ctx: unknown) {
  // One place for "the server blew up while rendering". Log it in YOUR format.
}
```

The `NEXT_RUNTIME` guard is not decoration: `register()` also runs in the edge runtime, where `@opentelemetry/sdk-node` and `pg` do not belong. Check your installed version for the exact hook names and where they may live - this is the part of the chapter most likely to drift.

### 3.3 Server logs - the pattern that IS running here

`next start` writes its own request lines to stdout, in prose. That is fine for a terminal and useless for Loki, which indexes JSON fields (06a): a prose line gives you one label, `service`. So log your own JSON and treat the framework's lines as noise. The running implementation, the `mixin` in `app/src/lib/logger.ts` (comments dropped, one branch re-wrapped onto a line), which is exactly what a Next server component needs from `headers()` plus AsyncLocalStorage:

```ts
    mixin() {
      const ctx = currentContext();
      const additions: Record<string, string> = {};
      if (ctx.requestId) additions['request_id'] = ctx.requestId;
      if (ctx.tenantId) additions['tenant_id'] = ctx.tenantId;
      if (ctx.customerHash) additions['customer_hash'] = ctx.customerHash;
      const span = trace.getSpan(context.active());
      if (span) { const sc = span.spanContext(); additions['trace_id'] = sc.traceId; additions['span_id'] = sc.spanId; }
      return additions;
    },
```

with the carrier from `app/src/lib/tenancy.ts`:

```ts
export const requestStorage = new AsyncLocalStorage<RequestContext>();
export function currentContext(): Partial<RequestContext> { return requestStorage.getStore() ?? {}; }
```

Next's Node runtime supports AsyncLocalStorage, so the answer has the same shape: generate or trust a request id at the edge of the server (04a), render inside `als.run({ requestId, tenantId }, ...)`, and let the mixin find it. What is genuinely different in a Next app is the number of processes, runtimes and *non-request* code paths: Server Components, Route Handlers, Server Actions and revalidation-triggered renders mean something may render outside any request, which is precisely where `requireContext()`'s fail-loudly guard (04b) earns its keep.

### 3.4 Client errors - NOT executed here

The most important sentence in this chapter: **Loki cannot see a browser.** Nothing in 4.2 would exist for a `TypeError` thrown in a client component after hydration.

- **React's own boundary**: `error.tsx` per segment, `global-error.tsx` for the root layout. Boundaries *render a fallback; they do not report*. Pair every boundary with an explicit report, or a tenant's broken page produces a polite "something went wrong" and no evidence.
- **The uncaught path**: `window.addEventListener('error', ...)` and `'unhandledrejection'`, which is what an error tracker's browser SDK installs for you, along with breadcrumbs and the build id.
- **Sentry's Next SDK**: separate client, server and edge configuration plus **source map upload during the build**, so `main-8f3a2b.js:2:19043` becomes `checkout/basket.tsx:41`. The browser only ever sees the bundle, so there is no `tsx`-style escape (and see 12's 3.4: this server needed no maps at all). One SDK per process still applies - 12 section 3.2.
- **Privacy**: the browser is where cookies, tokens and form values live, and client capture is *more* eager than server capture. `beforeSend` (12) is mandatory here too, with `sendDefaultPii: false`, and never tag with a customer email - use the hash from 04b.

### 3.5 Web Vitals - NOT executed and NOT measurable here

No page and no browser, so no number. The modern API is `web-vitals`' attribute reporting - `onLCP`, `onINP`, `onCLS`, plus `onFCP` and `onTTFB` - and the two rules people get wrong are *how often* and *when*:

```ts
// Reasoned from documentation. NOT run on this machine.
import { onCLS, onINP, onLCP } from 'web-vitals';
let sent = false;
function sendMetric(m: { name: string; value: number; rating: string; id: string }) {
  if (sent) return;                 // report once per page life, not once per callback
  sent = true;
  void fetch('/vitals', { method: 'POST', keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: m.name, value: m.value, rating: m.rating, id: m.id,
      page: location.pathname, release: window.__APP_RELEASE__ }) });
}
for (const on of [onCLS, onINP, onLCP]) on(sendMetric);   // FID is retired: INP replaced it
```

Each `on*` callback can fire **more than once**: LCP and CLS settle late, and INP is a rolling worst-case over interactions, so deduplicate by `m.id` or you bill per interaction. `keepalive`/`sendBeacon` exists because metrics arrive when the user leaves - the browser twin of the `SIGTERM` flush in 3.1, with the same failure mode: without it you lose exactly the slowest, worst visits, and your dashboard reports a healthy page nobody actually saw. Field data (real users) is the only valid source: a lab run on your laptop is not field data and synthetic checks cannot produce INP at all. Send it somewhere you can aggregate into a histogram and take percentiles of (07a, 08c), because the p95 of LCP is the number, not the mean.

Made-up shape, **not observed on this machine**, to show one beacon's fields:

```json
{ "name": "LCP", "value": 2418, "rating": "needs-improvement", "id": "v4-abc",
  "page": "/product/1234", "release": "2.41.0", "tenant_id": "tenant_acme" }
```

## 4. What you should see

All commands below ran on this machine on 2026-10-29 against the running stack. All of it concerns the **server** half.

### 4.1 The instrumentation hook really does run first

```
$ docker compose logs shop-api | grep -m1 'shop-api listening'
shop-api-1  | {"level":"info","time":"2026-10-29T06:30:08.256Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","network.port":8000,"log_level":"info","redaction":"on","otlp":"http://otel-collector:4318","pool_max":8,"msg":"shop-api listening"}
```

That line proves `instrumentation.ts` finished before the listener opened: `otlp` is resolved and non-empty (config came from `x-app-env`), `redaction` is `on`, `pool_max` is 8, and `trace_id`/`span_id` appear on every later request line, which only happens if the SDK started first. Note also what the line *is*: one JSON object on stdout. That is the format a Next server must also produce, for the same reason.

### 4.2 A normal server request, in these logs

```
$ curl -s 'localhost:8000/api/products?limit=2' -H 'x-tenant-id: tenant_globex' -H 'x-request-id: probe-fe-01'
{"tenant_id":"tenant_globex","products":[{"id":"2","sku":"tenant_globex-SKU0001","title":"Fake product 1 for Globex (fake)","price_cents":551},{"id":"6","sku":"tenant_globex-SKU0002","title":"Fake pro

$ docker compose logs --since 40s shop-api | grep probe-fe-01
```

```
shop-api-1  | {"level":"info","time":"2026-10-29T08:22:42.196Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","req":{"id":"probe-fe-01","method":"GET","url":"/api/products?limit=2","query":{"limit":"2"},"params":{},"headers":{"host":"localhost:8000","user-agent":"curl/8.18.0","accept":"*/*","x-tenant-id":"tenant_globex","x-request-id":"probe-fe-01"},"remoteAddress":"::ffff:172.25.0.1","remotePort":45880},"route":"","request_id":"probe-fe-01","tenant_id":"tenant_globex","trace_id":"8d7742c835a2b99e7199f5926004c448","span_id":"9ec9f9b477b70322","res":{"statusCode":200,"headers":{"x-request-id":"probe-fe-01","content-type":"application/json; charset=utf-8","content-length":"246","etag":"W/\"f6-SbO8kRZKcoOwskapJsmndpdcLVI\""}},"responseTime":1,"msg":"request completed"}
```

Four details that map one-to-one onto a Next.js server. (1) The request id **round-trips**: I sent `probe-fe-01` and the response echoes it in a header, so a browser can quote that id back when it reports a problem later - that is the join between a client error and a server trace. (2) `trace_id` and `span_id` are present, from the mixin in 3.3, because the SDK started first. (3) `responseTime: 1` is **server** duration; the customer's page took far longer - network, HTML, JS, hydration, images. LCP is what the customer experiences, `responseTime` is what you control, and confusing them is how a team celebrates a fast API over a slow shop. (4) `req.headers` are logged and redacted by name (03a); a browser beacon is just another request with another body and gets scrubbed the same way.

The failure path is not repeated here: 12 section 4.2 has the verbatim 500 line with the full stack from this same stack.

### 4.3 What could not be run, stated plainly

- No Next.js command ran: `next` is not a dependency and no container serves a page. `docker compose ps --format '{{.Name}}' | wc -l` printed `13`, and piping the same list through `grep -ciE 'next|front|web|nginx'` printed `0`.
- `curl -s -o /dev/null -w 'content-type=%{content_type}' localhost:8000/` printed `content-type=application/json; charset=utf-8`: an API index, not a document.
- No Web Vitals measurement of any kind exists on this machine, so every number and threshold in 3.5 is documentation-derived or explicitly invented.
- No browser error, hydration failure, `error.tsx` render or source map upload was observed.

## 5. In a real multi-tenant e-commerce platform

A storefront with 70% mobile traffic, tenants sharing one Next app with a per-tenant theme bundle. Two incidents: one you can see, one you cannot.

**Visible:** marketing ships a full-resolution hero image for `tenant_acme`'s autumn campaign. Nothing breaks and no error line exists anywhere; LCP for `/` on 4G goes from roughly 1.8 s to roughly 4.1 s (illustrative, not measured here), mobile conversions slide over the weekend, and the API dashboard is spotless - the `responseTime: 1` in 4.2 is still 1 ms. Only field data shows it, and only if the beacon carries `page` and `release` so you can slice to one tenant's home page. Loki helps *if* you have a `/vitals` route logging beacons as JSON, which is the 4.2 pattern, and gives you "p95 LCP for tenant_acme this hour".

**Invisible:** a client component reads `basket.items.length` and throws only after hydration on one older Safari. Server logs are clean, because the failing code is not on your machine; Loki, this whole pipeline, has zero lines about it, and alerts stay green - while every shopper on that browser sees the `error.tsx` fallback at checkout. That is the honest boundary of 02a through 14: **server-side signals cannot observe a client-side bug**. The answer is not "log more", it is browser capture with uploaded source maps so the frame resolves to `basket.tsx:41`, reported with the same `x-request-id` and `tenant_id` so the two halves can still be joined when the page arrives.

## 6. When to use it, when not to

Browser volume is the cost story: visitors are 100-1000x your requests-per-second, and every page view can be an event.

- **Vitals:** sample 1-10% for aggregates - the p95 of 10,000 sampled visits is still p95 - and use the full rate only while debugging a specific page. Aggregate into a histogram and let raw beacons expire fast (07a, 08c, 06b): a metric-shaped firehose is the same problem 07b measured.
- **Client errors:** send all *new* errors, cap known-noisy ones, and drop what is not your bug - `ChunkLoadError` and syntax errors from stale bundles right after a deploy, `AbortError` when the user navigates away, injected extension scripts, anything whose only frame is `chrome-extension://`. `release` and `environment` filters handle most of it, and dropping is a `beforeSend` decision (12).
- **Session replay and console capture:** highest noise, highest privacy risk, real per-session cost. Defensible on a checkout funnel, indefensible on an account page.
- **Don't** use RUM as uptime monitoring (11), as the source of business metrics (16: orders come from the server, which is the truth), or instead of server error tracking. **Don't bother at all** on a page with no users, and never present a dev-mode measurement as field data.

## 7. Common mistakes

1. Assuming browser failures are in your logs. They are not - see the Safari case in section 5.
2. Letting `next start`'s own format be your format: prose gives you no labels.
3. Reporting Web Vitals more than once, or never. Multiple sends multiply the bill, and a plain `fetch` on `pagehide` loses exactly the worst visits: deduplicate by metric `id` and send with `keepalive`.
4. Using retired or wrong metrics - FID is gone, INP replaced it, and lab numbers are not field numbers.
5. Shipping a minified bundle without uploaded source maps: the issue list becomes alphabet soup and the team stops reading it.
6. Configuring instrumentation too late. `register()` exists so hooks land before the first request, exactly like `--import` in 3.1; an SDK started inside a handler leaves trace-shaped holes that look like random data loss.
7. Ignoring `NEXT_RUNTIME` and importing a Node SDK into the edge runtime.
8. Sending identity from the browser - emails, names, addresses, tokens, cart contents. The DOM is one giant context field if you let it be: same rule as 03a and 12's `beforeSend`, with more to strip.
9. Treating a green API dashboard as a healthy shop: `responseTime` and the customer's experience are different SLOs and need different alerts (10a).

## 8. Try it yourself

Prove where the server-side boundary is using only the running stack, then write the client half on paper. Send three requests with recognisable ids: `curl -s localhost:8000/api/slow?ms=1200 -H 'x-tenant-id: tenant_acme' -H 'x-request-id: probe-vitals-1'`, the same for `/api/products?limit=2`, and a failure via `/api/error/crash`. Find each line twice - in `docker compose logs --since 60s shop-api | grep probe-vitals-1` and in Loki with a range query `{service="shop-api"} |= "probe-vitals-1"` - and compare `responseTime`: the ~1200 ms sleep is server time, and a real page would have spent far more of the customer's patience outside your logs.

Then write, but do not add, the `/vitals` POST handler you would put in this app: log the payload with the same `logger` and increment a histogram. Check it against three questions - does it stamp `tenant_id` and `release`? does it reject a body bigger than a few hundred bytes? does it treat every browser-supplied field as a *claim* rather than a fact, the way 04b and 19 teach you to treat a header?

**Hint:** `{service="shop-api"}` works, while `container="shop-api-1"` returns an empty `result` (the real value is `observability-learn-shop-api-1`), and log queries need `/loki/api/v1/query_range` - `/query` answers "log queries are not supported as an instant query type".

**Cleanup:** nothing to undo. Those are ordinary requests, your probe lines expire with Loki's retention window (06b), and `/api/slow` holds no resources; confirm the stack is calm with `curl -s localhost:8000/healthz` and `docker compose ps`. If you did edit a file while experimenting, delete your own edit rather than reverting shared work - other readers are in this repo too.

## 9. Next

You now have the customer's point of view, which is the one your business pays for: [16 - Business metrics](16-business-metrics.md).
