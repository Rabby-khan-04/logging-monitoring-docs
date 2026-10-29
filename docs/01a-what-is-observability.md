# 01a - What observability is, and why one of the three is never enough

## 1. Simple explanation

Imagine you leave the house in your mum's car, and she cannot see the road.
You want her to know how the car is doing without calling you. So you give her
three things.

A notebook: every time something happens, she writes one line down. "Petrol
low." "Strange noise." "Kid fell asleep." This is a **log**. It is a story, in
words, in the order it happened.

A dial on the dashboard: it does not tell a story, it only says "how many"
right now. Speed. Fuel. Engine temperature. This is a **metric**. It is a
number that updates all the time, so you can watch it and shout when it goes
too high.

A little camera that follows the kid the whole way: door, car, shop, home. You
can see exactly where the slow part was and who was with who. This is a
**trace**. It follows one trip from start to finish and records every stop.

Each one alone is not enough. A notebook does not tell you how often the bad
thing happens. A dial does not tell you why the needle moved. A camera does not
tell you what happened before the kid got in the car. You need all three, and
you need them to use the same trip so you can line them up. That is the whole
idea: three ways of looking at the same machine, joined together so one question
has one answer.

## 2. Real name

- **Observability** is the ability to ask any question about a running system
  and get an answer from the data it already emits, without adding new code for
  that specific question. Coined in control theory; popularised for software by
  the Google SRE book.
- **Logs** - an append-only, timestamped record of discrete events. Each event
  is one line. In this stack every line is structured JSON (see 02b), so a
  machine can filter it, not just grep it.
- **Metrics** - numbers aggregated over time, cheap to store and graph, meant
  to be watched continuously. The three types (counter, gauge, histogram) are
  explained in 07a. For now: a metric answers "how many / how much / how fast",
  never "which one".
- **Traces** - a tree of timed spans that follows one request as it crosses
  several services. A **span** is one unit of work with a start, an end and a
  parent link. Traces are explained properly in 13a.
- **Correlation** is the glue: the same identifier appears in all three, so a
  number on a graph leads you to a log line, which leads you to a trace. Here
  that identifier is `request_id` and `trace_id`, stamped on every line by the
  logger (see 04a and 04b).

One word we deliberately do not use yet, and will keep away from these pages
for a while: "cardinality". It describes how many different label combinations a
metric can grow, and it is the trap that blows up the bill. It is explained in
07b. Until then, treat metrics as "watching numbers".

## 3. Example

The three signals this project already emits, side by side, for the same kind
of event. Nothing here is invented; it is what the running app produces.

```ts
// app/src/lib/logger.ts - the LOG side. One logger, JSON on stdout.
// `base` fields are stamped on every line; `mixin` adds request/tenant/trace ids.
const logger = pino(buildOptions());

// app/src/middleware/requestContext.ts - the METRIC side.
// A counter with three labels, bumped when every response finishes.
httpRequestsTotal.inc({
  method: req.method,
  route,
  status_class: `${Math.floor(res.statusCode / 10)}xx`, // "20xx", "40xx", "50xx"
});

// app/src/lib/logger.ts - the TRACE side, folded into the log via the mixin.
// When a span is active its ids are copied onto the log line, which is what
// lets you jump from a log to the trace for the same request.
const span = trace.getSpan(context.active());
if (span) {
  additions['trace_id'] = span.spanContext().traceId;
  additions['span_id'] = span.spanContext().spanId;
}
```

Three separate emissions, but the `trace_id` and `request_id` on the log line
are the same ones carried by the trace, and the `route` + `status_class` on the
metric describe the same request. That overlap is the point.

## 4. What you should see

The stack is running. Ask it three questions and paste the three real answers.

**The log.** Make one request, then read the line the app wrote.

```
$ curl -s -o /dev/null localhost:8000/api/products -H 'x-tenant-id: tenant_acme' -H 'x-request-id: doc-01a-prod'
$ docker compose logs --since 20s shop-api 2>/dev/null | grep doc-01a-prod
{"level":"info","time":"2026-10-29T07:17:50.461Z","service.name":"shop-api","app.env":"production","app.release":"1.0.0","req":{"id":"doc-01a-prod","method":"GET","url":"/api/products","query":{},"params":{},"headers":{"host":"localhost:8000","user-agent":"curl/8.18.0","accept":"*/*","x-tenant-id":"tenant_acme","x-request-id":"doc-01a-prod"},"remoteAddress":"::ffff:172.25.0.1","remotePort":32886},"route":"","request_id":"doc-01a-prod","tenant_id":"tenant_acme","trace_id":"fa30581f59d9475a58027ff79b4aad35","span_id":"fb1b779c0e9b9b48","res":{"statusCode":200,"headers":{"x-request-id":"doc-01a-prod","content-type":"application/json; charset=utf-8","content-length":"2145","etag":"W/\"861-RHrXUZVG9dN2D434imGMVV684Ys\""}},"responseTime":2,"msg":"request completed"}
```

The story of one request, in words, with the `trace_id` already embedded.

**The metric.** Ask Prometheus for the rate of requests by status class.

```
$ curl -sG localhost:9090/api/v1/query --data-urlencode 'query=sum(rate(shop_http_requests_total[5m])) by (status_class)'
{"status":"success","data":{"resultType":"vector","result":[{"metric":{"status_class":"20xx"},"value":[1793258497.311,"1.6563787017543858"]},{"metric":{"status_class":"40xx"},"value":[1793258497.311,"0.014035087719298244"]},{"metric":{"status_class":"50xx"},"value":[1793258497.311,"0.8247682982456139"]}]}}
```

Three numbers, no story. It tells you "roughly 0.8 requests per second are
failing" but not which order, which tenant, or why.

**The trace.** Ask Tempo for one recent trace.

```
$ curl -s -G localhost:3201/api/search --data-urlencode 'limit=1'
{"traces":[{"traceID":"4704d16217415f3478474c5f844f93d","rootServiceName":"shop-api","rootTraceName":"GET","startTimeUnixNano":"1793257872893000000","durationMs":1}],"metrics":{"inspectedTraces":8,"inspectedBytes":"20704","completedJobs":1,"totalJobs":3}}
```

One trip, timed end to end. It does not tell you the fuel level; it tells you
where the time went.

## 5. In a real multi-tenant e-commerce platform

At 02:00 the Grafana graph for `shop_http_requests_total` turns red: the
`50xx` line spikes only for `tenant_initech` (the configured noisy neighbour).

- The **metric** found the problem and scoped it to one tenant, but says nothing
  about why.
- You filter **logs** to `tenant_id="tenant_initech"` and find every failing
  `request failed` line carries the same `error.code":"payment_declined"`.
- You copy one `trace_id` from that line into Tempo and the **trace** shows the
  900ms was spent inside the payment gateway hop, not the app.

None of the three answers the whole question. Metrics say "who and how much",
logs say "what exactly", traces say "where and how slow". Only together, on the
same tenant, do they say "initech's checkout is slow because the acquirer is
timing out".

## 6. When to use it, when not to

You always use all three; the question is the ratio.

- Metrics are the cheapest to keep and the only signal you can alert on at
  scale, so they are your always-on smoke detector. Storing them is a fixed,
  small number per service.
- Logs are far more expensive, because one line per request at real traffic is
  a lot of bytes. They are the microscope you pull out after the alarm, not
  something you watch on a wall. The cost is discussed in 06b.
- Traces are the most expensive per event, so production usually samples them
  (see 13b). Keep the ones that slow or failed; drop the boring ones.

Noise rule: if you find yourself reading a metric to diagnose a single request,
you wanted a log. If you grep logs to work out a rate, you wanted a metric.

## 7. Common mistakes

- Treating logs as the only signal, then paging on a string match. Logs at
  volume are slow and blunt; alert on a metric, diagnose with a log.
- Having all three but not correlated: a `trace_id` that never appears in the
  logs is a second system you have to search by timestamp. Here the logger's
  `mixin` fixes that (see 02b).
- Collecting everything "just in case". Retention and cost are chapters 06b and
  07b for a reason.
- Reaching for a trace to answer "how many" - a trace is one request, not a
  population.

## 8. Try it yourself

Run all three questions above yourself and confirm you get the same *shape*
(the same keys), even though the exact numbers and ids differ.

Hint: your `status_class` counts will move because you are generating load by
running the curl; that is expected and is exactly the point metrics capture.

Then clean up so nothing is left running and no orphan lines linger:

```
# you only issued read queries and two harmless GETs, so there is nothing to
# tear down. Confirm the app is still healthy and you changed nothing:
$ curl -s localhost:8000/healthz
{"status":"alive","service":"shop-api"}
```

## 9. Next

You now know what the three signals are. Next, meet the twelve containers that
make them on this laptop: [01b - The local stack](01b-the-local-stack.md).
