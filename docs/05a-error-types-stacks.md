# 05a - Error types and stack traces

All output below was run on the laptop stack from `docs/00-roadmap.md`: API on
8000, fake payment gateway on 8020, Loki on 3101. Nothing here is invented.

## 1. Simple explanation

A shop has three tills. One stops working. A worker shouts "the till is broken!"
and goes home. Nobody learns anything.

Now imagine the worker writes a slip and puts it in a drawer: which till (till
2), which part (the card reader, not the screen), whose fault it smells like (the
shopper's card, our reader, or the bank's line), and whether trying again would
help (yes for a bank line, no for a dead reader). A good error log line is that
slip: the same four questions, in the same words, every time, so a tired person
six months later can read it and decide something. The allowed answers are few
and chosen by you; a long list of invented answers is as useless as shouting. And
a cost note, because there is always one: an error line is the most expensive
line you will write, because it carries a stack.

## 2. Real name

- **Error object**: a JS `Error` (or subclass) with `message`, `name` and - if it
  was really thrown - a `stack`.
- **Typed error class / error taxonomy**: one class per kind of failure
  (`ValidationError`, `UpstreamError`, ...), so code branches on
  `err instanceof X` instead of comparing message text.
- **`statusCode`** the HTTP status the failure must produce; **`code`** its
  stable machine name (`payment_declined`) - here a union of eight values, so an
  invented code does not compile; **`retryable`** "would the same request
  probably succeed again?"; **`cause`** the original error behind a wrapper (the
  `Error` option `{ cause }`), so wrapping never destroys the real reason.
- **Stack trace**: the calls on the way down when the error was made. One line is
  a **frame**: `at <name> (<file>:<line>:<col>)`; the top frame is where it
  happened, the lower frames are how we got there.
- **Client error (4xx) vs platform error (5xx)**: whose problem it is, and here
  it decides the log level (level meanings: chapter 02a). The one middleware that
  makes that call is the **error handler**.
- **`error.*` summary fields**: the flat fields next to the nested `err` object -
  `error.name`, `error.code`, `error.status`, `error.retryable`. Flat and bounded
  on purpose: the handler also uses `code` as a counter label, and a stack never
  becomes a label value (chapters 07a and 07b).

## 3. Example

`app/src/lib/errors.ts`, trimmed to what matters:

```ts
// The whole vocabulary of failure names. A union, so an invented code is a
// compile error, not a surprise six weeks later.
export type ErrorCode =
  | 'validation_failed' | 'unknown_tenant' | 'not_found' | 'payment_declined'
  | 'upstream_timeout' | 'upstream_error' | 'db_error' | 'internal_error';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(message: string, options: { code: ErrorCode; statusCode: number; retryable?: boolean; cause?: unknown }) {
    // `cause` keeps the original error, so wrapping never hides the real reason.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;                    // class name, not "Error"
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    Error.captureStackTrace?.(this, new.target);    // drop the constructor frame
  }
}
```

Each subclass hard-codes its own answer: `ValidationError` 400
`validation_failed`, `UnknownTenantError` 403, `NotFoundError` 404,
`PaymentDeclinedError` 402, `UpstreamError` 502 and `UpstreamTimeoutError` 504
(both `retryable: true`), `DatabaseError` 500 `db_error`. `errorFields(err)` then
turns any thrown thing into flat log fields: an `AppError` gives the four
`error.*` names above; any other `Error` gives `internal_error` plus the message;
a thrown string gives `'error.name': 'unknown'`. It never returns the stack, the
headers or the body.

`app/src/middleware/errorHandler.ts` is the only place a server-side failure is
logged:

```ts
if (statusCode >= 500) {
  // One error, one log line. Mark the response so pino-http's own finish
  // line is suppressed for this request; without this you get two error
  // lines per failure and every Loki query over-counts by 2x.
  res.locals.errorLogged = true;
  // err: the real Error object, so Pino's serializer writes message + stack.
  logger.error({ err: err as Error, ...fields, 'http.method': req.method, 'http.route': req.route?.path ?? req.path }, 'request failed');
} else {
  // Client mistakes are normal traffic: one warn line, no stack, no page.
  logger.warn({ ...fields, 'http.method': req.method }, (err as Error).message);
}

// An AppError message is written to be shown. An unknown error's message is not:
// it can contain SQL, paths, or another tenant's data.
res.status(statusCode).json({ error: { code, message: isAppError ? err.message : 'Internal error', request_id: ctx.requestId } });
```

Throw sites are one line each - `app/src/routes/checkout.ts:106` is
`throw new ValidationError('one or more skus are not available for this tenant')`.
Nothing sits between the `throw` and the log line: Express 5.3 forwards a `throw`
out of an `async` handler straight to `errorHandler`. On Express 4 every async
route needed a wrapper or the rejection vanished.

## 4. What you should see

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8000/api/error/validation -H 'x-tenant-id: tenant_acme' -H 'x-request-id: ch05-validation'
curl -s -o /dev/null -w '%{http_code}\n' localhost:8000/api/products         -H 'x-tenant-id: tenant_nope'  -H 'x-request-id: ch05-tenant'
curl -s -o /dev/null -w '%{http_code}\n' localhost:8000/api/boom             -H 'x-tenant-id: tenant_acme'  -H 'x-request-id: ch05-boom'
sleep 2 && docker compose logs --since 30s shop-api | grep 'ch05-validation'
```

Statuses from this run: `400`, `403`, `500`. Every response body carries the same
`code` as its log line plus the `request_id` a shopper can quote, e.g.
`{"error":{"code":"internal_error","message":"Internal error","request_id":"ch05-boom"}}`. The 400 log line, verbatim:

```
shop-api-1  | {"level":"warn","time":"2026-10-29T07:31:27.218Z","service.name":"shop-api","request_id":"ch05-validation","tenant_id":"tenant_acme","trace_id":"f45845e0df17d47c80b92f571fd65e80","span_id":"ad6384d8aca14aeb","error.name":"ValidationError","error.code":"validation_failed","error.status":400,"error.retryable":false,"http.method":"GET","msg":"demo validation failure"}
```

That is the slip: which till (`request_id`), which part (`error.name`), whose
fault (`error.status":400`), try again (`error.retryable":false`) - and no stack,
a bad basket does not need one. The `ch05-tenant` line is the only one with no
`tenant_id`: the failure *is* that the tenant is not ours, so it cannot be a
label either (chapter 04b). `ch05-boom` is the 500 case: the same fields plus a
nested `err` whose stack begins `TypeError: Cannot read properties of undefined
(reading 'length')` at `/app/src/routes/debug.ts:26:49`. Full text in 05b.

The best example of the shape is a real cross-service 502 for the noisy neighbour
(`x-chaos: error` is a header the fake gateway understands; all data is fake):

```bash
curl -s -X POST localhost:8000/api/checkout -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_initech' -H 'x-request-id: doc05-upstreamerr' -H 'x-chaos: error' \
  -d '{"customer":{"email":"shopper+initech@example.test","name":"Shopper"},"card":{"number":"4242 4242 4242 4242","exp":"12/30","cvv":"123"},"items":[{"sku":"tenant_initech-SKU0001","quantity":2}]}'
```

```
{"level":"error","time":"2026-10-29T07:30:44.628Z","service.name":"shop-api","request_id":"doc05-upstreamerr","tenant_id":"tenant_initech","trace_id":"74c6b54a5dad349fc7cbbddd78ad2dc5","span_id":"1bdb3c839bfde1dd","err":{"type":"UpstreamError","message":"payment-gateway returned 500 {\"error\":{\"code\":\"upstream_error\",\"message\":\"forced chaos error\"}}","stack":"UpstreamError: payment-gateway returned 500 [...] at async chargeCard (/app/src/lib/payments.ts:34:12)\n    at async <anonymous> (/app/src/routes/checkout.ts:146:20)","statusCode":502,"code":"upstream_error","retryable":true,"name":"UpstreamError"},"error.name":"UpstreamError","error.code":"upstream_error","error.status":502,"error.retryable":true,"http.method":"POST","http.route":"/api/checkout","msg":"request failed"}
```

Typed, flat decision fields, a stack whose last frame is in your own code
(`checkout.ts:146`), and one line; `[...]` marks where I trimmed frames, nothing
else changed. `trace_id` and `span_id` sit on every line above, following one is
chapter 13a.

## 5. In a real multi-tenant e-commerce platform

`tenant_initech` is this stack's configured noisy neighbour: the fake gateway
declines 25% of its charges and adds 260ms latency (`app/src/payment-service.ts`).
Its failures arrive in bulk, in three categories needing three answers:

- `payment_declined` (402, warn): their shoppers have bad cards. Their problem,
  and it must never look like an outage.
- `upstream_error` / `upstream_timeout` (502/504, error, retryable): our call to
  the acquirer failed. Ours, or the acquirer's. Retry once, then page.
- `validation_failed` (400, warn) concentrated on initech only: their integration
  pushed a bad payload. Not our bug, not a page.

Without the taxonomy all three are "500 Internal Server Error" and you cannot
separate them without reading 200 lines. With it, the decision is a lookup on
`error.code` and `error.retryable`; counting them per tenant is chapter 07a, and
the lines already carry the fields to count on.

## 6. When to use it, when not to

Use a typed error and one `error` line when a request path fails in a way a human
or a client must react to; when an outbound call breaks (always with a deadline:
`AbortSignal.timeout(2_500)`, `app/src/lib/payments.ts`); and when nothing else
will see it - which is what the two process handlers in `app/src/server.ts`
(`unhandledRejection`, and `uncaughtException` at `fatal`) are for.

Do not, when it is an expected business outcome you could return as a value (a
loop trying three cards should not log three error lines); when you are about to
log it *and* rethrow it (05b); when it is really input noise (4xx is `warn`, so a
shop hammering a dead SKU stays cheap and out of your paging path); or when the
value for `code` would be unbounded - a SKU, a URL, a card message.

Measured cost, not guessed: a normal `shop-api` access line was 864 bytes and the
service averaged 671 bytes per line over 15 minutes (the query is chapter 06a).
The badly-logged timeout line below is 1177 bytes by itself, and during the chaos
test `tenant_initech` wrote 264 `error` lines in 12 minutes against 2 for
`tenant_acme`. Error volume is a bill as well as an alarm.

## 7. Common mistakes

1. **Matching on message text** (`err.message.includes('timeout')`): the first
   reword breaks it. Use `instanceof`.
2. **Throwing a string or a plain object.** No stack, no `name`, and Pino's `err`
   serializer prints almost nothing. You keep a shape, you lose the "where".
3. **Logging a 4xx at `error`.** Then `error` no longer means "our fault", and the
   first paging rule you write cries about bad baskets.
4. **Forwarding `err.message` to the client for unknown errors.** This repo's
   `UpstreamError` message embeds the gateway's response body, so a 502 to a
   shopper can carry an internal string; the handler shows only hand-written
   messages.
5. **Letting the stack reach a label.** `err.stack` has line numbers and sometimes
   query values; only the four flat `error.*` fields are safe, and 07b measures
   what a wrong label costs.
6. **Catching to log, then rethrowing "to be safe".** Next chapter, with the bug
   this repo actually shipped.
7. **Declaring a class and never throwing it.** Verified here: `UpstreamTimeoutError`
   appears only in an `instanceof` test (`app/src/lib/payments.ts:85`) and
   `DatabaseError` is thrown nowhere, so a real gateway timeout surfaces as Node's
   `AbortSignal` error and is logged as `error.code":"internal_error"`. Verbatim
   from `x-chaos: timeout`, `[...]` standing for 22 repeated DOM constants:

   ```
   {"level":"error","time":"2026-10-29T07:26:27.972Z","service.name":"shop-api","request_id":"doc05-chaos","tenant_id":"tenant_initech","err":{"type":"DOMException","message":"The operation was aborted due to timeout","stack":"TimeoutError: The operation was aborted due to timeout","name":"TimeoutError","code":23,"INDEX_SIZE_ERR":1,"DOMSTRING_SIZE_ERR":2,"HIERARCHY_REQUEST_ERR":3,[...] "TIMEOUT_ERR":23,"INVALID_NODE_TYPE_ERR":24,"DATA_CLONE_ERR":25},"error.name":"TimeoutError","error.code":"internal_error","error.message":"The operation was aborted due to timeout","http.method":"POST","http.route":"/api/checkout","msg":"request failed"}
   ```

   Two lessons: the taxonomy has a hole exactly where a retry policy needs it, and
   `err` here is a non-`Error` object carrying 25 DOM constants. Fix: wrap at the
   call site - `throw new UpstreamTimeoutError('payment-gateway')`.

## 8. Try it yourself

Run the three probes above plus the 502 checkout, then answer in one line each:
how many lines did `/api/boom` write, how many did the 502 write, and which two
fields would you read first to decide whether to wake anyone up?

```bash
docker compose logs --since 90s shop-api | grep -c 'ch05-boom'
docker compose logs --since 90s shop-api | grep -c 'doc05-upstreamerr'
```

Hint: not the status code - the pair is `level` and `error.retryable`. Alerting on
it is chapter 10a, counting it per tenant is 07a. Cleanup: nothing to delete,
`x-chaos` changes the fake gateway for one call only, and your probe lines sit in
Loki inside the 72h window - 06b explains why waiting is the tool, not deleting.

## 9. Next

[05b - One error, one log line](05b-no-double-logging.md): the double-logging bug
this repo shipped, the two-line evidence still sitting in Loki, and the
pino-http option that fixed it.
