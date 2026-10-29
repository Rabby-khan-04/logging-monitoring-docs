# 09a - Grafana dashboards: panels, variables, provisioning, annotations

Everything before this chapter was about collecting signals. This chapter is
about the screen you actually look at.

## 1. Simple explanation

A dashboard is a wall with the important dials on it.

Think of a car. You do not open the bonnet to find out how fast you are going.
You look at a round dial that is always in view, that you can read in half a
second, and that does not lie to you. A dashboard does the same for software: the
few numbers that matter sit where your eyes already are, so noticing a problem is
not a job.

Two more ideas make it work. One dashboard answers one question: "is the shop
healthy right now?" is a question, "show me every number we have" is a shrug.
And the dials should be fitted at the factory, not screwed in by each driver: if
everyone rebuilds the wall by hand, everyone drives a slightly different car. So
the dashboard is a **file** in the project and the tool builds the wall from it.
Your dashboard and mine are then the same dashboard, and a change to it is
reviewed like any other code.

## 2. Real name

| Term | Precise meaning in Grafana |
|---|---|
| **Dashboard** | A JSON model with a `uid`, a list of `panels`, a time range, a refresh rate and template variables. Identified by `uid`, never by title. |
| **Panel** | One visualisation bound to queries: a `type` (`timeseries`, `stat`, `table`, `logs`), a `gridPos` (x, y, w, h on a 24-column grid) and `fieldConfig` (units, thresholds). |
| **Target** | A single query inside a panel, keyed by `refId` (`A`, `B`). Three targets draw three sets of series. |
| **Datasource** | A registered backend Grafana queries. Here: Prometheus (`uid: prometheus`), Loki (`uid: loki`), Tempo (`uid: tempo`). |
| **Template variable** | A placeholder scoped to the dashboard, filled from a query. Written `$tenant` inside a PromQL string and substituted before the request is sent. |
| **Annotation** | A time-stamped note drawn as a vertical line across panels, stored apart from metric data: deploys, incidents, config changes. |
| **Provisioning** | File-based, declarative setup of datasources and dashboards, read at startup and re-polled on an interval. The alternative is clicking through the UI. |

## 3. Example

The whole Grafana setup is three files and nothing in it was clicked.
`grafana/provisioning/datasources/datasources.yaml`:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    uid: prometheus                 # fixed uid: dashboards reference this, so a
                                    # recreated datasource never breaks them
    type: prometheus
    access: proxy                   # Grafana's backend makes the request
    url: http://prometheus:9090     # the docker network name, not localhost
    isDefault: true
    jsonData:
      timeInterval: 15s             # minimum resolution: stops a 7-day range
                                    # becoming millions of points
      httpMethod: POST              # long PromQL does not blow past URL limits

  - name: Loki
    uid: loki
    type: loki
    access: proxy
    url: http://loki:3100
    jsonData:
      maxLines: 1000
      lokiSearchTraces:             # this is what puts a trace button on a log
        datasourceUid: tempo        # line that carries a trace_id field

  - name: Tempo
    uid: tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    jsonData:
      httpMethod: GET
      tracesToLogsV2:               # the other direction: trace -> its logs
        datasourceUid: loki
        filterByTraceID: true       # the log query is narrowed by trace id
        filterBySpanID: false
        spanEndTimeLimit: 3000
      serviceMap:
        datasourceUid: prometheus   # Service graph panel reads metric data
      nodeGraph:
        enabled: true               # node-graph view inside a trace
```

Those last six lines are why the stack feels connected: a log line carrying a
`trace_id` gets a link that opens its trace, and a span gets a link that opens
its logs. Tracing is chapters 13a-13c; wiring the links is here.
`grafana/provisioning/dashboards/provider.yaml`:

```yaml
apiVersion: 1
providers:
  - name: observability-learn
    orgId: 1
    folder: learning               # every JSON file lands in this folder
    type: file
    updateIntervalSeconds: 30      # files are re-read every 30s: editing JSON on
                                   # disk changes the live dashboard, no restart
    allowUiUpdates: true           # UI edits are written back to the file
    options:
      path: /var/lib/grafana/dashboards   # ./grafana/dashboards, bind-mounted
```

And `grafana/dashboards/stack-health.json`, trimmed to the variable and the
three lines of one panel that matter (chapter 09b walks the full panel list):

```json
{ "uid": "stack-health", "title": "00 - Stack health", "refresh": "15s",
  "time": { "from": "now-1h", "to": "now" },
  "templating": { "list": [
    { "name": "tenant", "type": "query", "refresh": 1, "includeAll": true, "multi": true,
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "query": "label_values(shop_http_request_duration_seconds_count, tenant_id)" } ]},
  "panels": [
    { "type": "timeseries", "title": "5xx ratio by route (Errors)", "id": 7,
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "percentunit", "max": 0.05, "min": 0,
        "thresholds": { "mode": "absolute", "steps": [
          { "color": "green", "value": null }, { "color": "red", "value": 0.01 } ]} }},
      "targets": [ { "refId": "A", "legendFormat": "{{route}}",
        "expr": "sum by (route) (rate(shop_http_request_duration_seconds_count{status_code=~\"5..\", tenant_id=~\"$tenant\", route=~\"$route\"}[5m])) / clamp_min(sum by (route) (rate(shop_http_request_duration_seconds_count{tenant_id=~\"$tenant\", route=~\"$route\"}[5m])), 0.01)" } ] }
  ] }
```

Three parts do the work. `unit: percentunit` with `max: 0.05` makes the axis read
"0-5%" instead of a bare `0.047` and stops one 40% spike flattening every other
line. `thresholds` turns the panel red at exactly the number `ApiHighErrorRatio`
pages at (chapter 10a), so the wall and the pager agree. `legendFormat` turns a
series identity into one readable word; drop it and the legend is the expression.

## 4. What you should see

All of it is live output from this machine.

```bash
$ curl -s -u admin:admin "localhost:3001/api/search?query=" | jq -c '.[] | {type, title, url, folderTitle}'
{"type":"dash-folder","title":"learning","url":"/dashboards/f/eg2nxr3q3lvy8f/learning","folderTitle":null}
{"type":"dash-db","title":"00 - Stack health","url":"/d/stack-health/00-stack-health","folderTitle":"learning"}

$ curl -s -u admin:admin localhost:3001/api/dashboards/uid/stack-health | jq -r '.dashboard.version, ([.dashboard.panels[]]|length), ([.dashboard.templating.list[].name]|join(", "))'
3
12
tenant, route

$ curl -s -u admin:admin localhost:3001/api/datasources | jq -r '.[] | "\(.uid)  \(.jsonData|keys|join(","))"'
loki  lokiSearchTraces,maxLines
prometheus  httpMethod,timeInterval
tempo  httpMethod,nodeGraph,serviceMap,tracesToLogsV2
```

The provisioned datasources come back with exactly the keys shown in section 3,
including both cross-signal links. The dashboard was version 1 when this chapter
set out; after I edited the JSON on disk and waited one `updateIntervalSeconds`
the API reported version 3, with the seven extra panels chapter 09b explains one
at a time (ids 6 to 12: rate by route, 5xx ratio by route, p95 by route,
checkout funnel, payment gateway p95, process health, per-tenant scorecard). The
`route` variable is chained to `tenant`, and it resolves - chapter 09b shows the
values.

## 5. In a real multi-tenant e-commerce platform

Variables are the only sane way to do per-tenant views. Without `$tenant` you
have two bad options: one dashboard per tenant, which drifts the moment someone
edits one of them, or a dashboard with no tenant filter, which averages four
shops into one meaningless line. With the variable, one dashboard serves all
four tenants and the choice is a dropdown. Because it reads `tenant_id` off the
metric, a new tenant appears in the dropdown the first time it sends a request -
nobody has to remember to add it. `multi` plus `includeAll` makes "All" the
default; an on-call engineer who suspects tenant_initech selects that one tenant
and every panel narrows at once. `tenant_id` exists on the metric because of
chapter 04b; if a code path forgets to set it, traffic lands under
`tenant_id="none"` and the dropdown quietly lies to you. That leak is chapter
19's subject.

## 6. When to use it, when not to

Use a dashboard for a question you ask on a schedule: every deploy, every
morning, every time the phone rings. For a one-off question ("what did
tenant_globex hit at 09:14?") use Explore, not a new panel. A panel is a promise
that someone will read it; a panel nobody reads is a query tax with no benefit.

Cost, measured on this file: 12 panels, 17 Prometheus targets, one Loki query,
`"refresh": "15s"`. An open browser tab therefore issues roughly 68 Prometheus
queries a minute, about 98,000 a day left running overnight. Three mitigations
are already in place: `timeInterval: 15s` caps resolution, the scorecard panel
uses `instant: true` (one evaluation, not a range), the default window is
`now-1h`. The same board at 5s refresh with six viewers is a conversation with
whoever owns the Prometheus budget.

When **not** to use Grafana here: alerting. These return nothing, on purpose.

```bash
$ curl -s -u admin:admin localhost:3001/api/v1/provisioning/alert-rules
[]
$ curl -s -u admin:admin localhost:3001/api/v1/provisioning/contact-points
[]
```

Alerting in this stack is Prometheus rules evaluated by Prometheus and delivered
by Alertmanager. Two alerting systems on one platform means two sets of silences
and two answers to "why did I get paged". Chapters 10a-10c cover the pipeline
that is wired up.

## 7. Common mistakes

1. **Referencing a datasource by name or numeric id.** Use `uid`. With `name`,
   the day a datasource is recreated every panel says "Datasource not found".
2. **No `legendFormat`, no `unit`.** A legend of raw PromQL and an axis of bare
   decimals: `0.047` reads as 47 seconds or 47 requests, depending on who is
   panicking.
3. **Unbounded queries in a panel.** `sum by (route) (rate(...))` with no
   `tenant_id=~"$tenant"` ignores the dropdown and scans every series. The
   variable is the label selector that keeps the query cheap (chapter 07b).
4. **Editing the provisioned dashboard in the UI and walking away.** With
   `allowUiUpdates: true` a UI save bumps the version; the next person to edit
   the JSON wins and the other change vanishes. Treat the file as the source of
   truth and diff it in review.
5. **Averaging latency on the headline panel** (08c), because an average fits on
   a `stat` panel and looks confident. **No annotations** either: the chart shows
   a cliff at 09:00 and nobody remembers the deploy.

## 8. Try it yourself

Put an annotation on the dashboard from the API, prove it landed, remove it.

```bash
# 1. mark something that happened, on panel 3, at the current time
curl -s -u admin:admin -X POST localhost:3001/api/annotations \
  -H 'content-type: application/json' \
  -d '{"dashboardUID":"stack-health","panelId":3,"time":'"$(date -u +%s000)"',"tags":["outage","tenant_initech"],"text":"fake gateway timeouts for tenant_initech"}'
# 2. prove it exists, and note the id
curl -s -u admin:admin "localhost:3001/api/annotations?dashboardUID=stack-health&limit=5"
# 3. cleanup: delete it, then re-run step 2 and expect []
curl -s -u admin:admin -X DELETE localhost:3001/api/annotations/<id-from-step-1>
```

Step 3 is also the check: open `http://localhost:3001/d/stack-health` in the
time range around now and look for the vertical line across the "5xx ratio (RED:
Errors)" panel before deleting it. What I got, trimmed to the interesting
fields:

```
{"id":3,"message":"Annotation added"}
{"id":3,"dashboardUID":"stack-health","panelId":3,"text":"fake gateway timeouts for tenant_initech","tags":["outage","tenant_initech"],"login":"admin","time":1793259219000}
{"message":"Annotation deleted"}
[]
```

**Hint:** if the line does not show up, either the built-in annotation query is
disabled or the time range does not contain the event; the dashboard JSON now
carries `"annotations": {"list": [{"builtIn": 1, "enable": true, ...}]}` for
that reason. **Cleanup and the lesson:** annotations live in Grafana's own
storage, not in Prometheus or Loki, so deleting the event leaves nothing behind
in the metric data - and a deploy marker costs zero cardinality, which beats
inventing a metric called `deploy_count`.

## 9. Next

[09b - The API dashboard, panel by panel](09b-api-dashboard.md) takes these 12
panels apart one at a time, with the values they really rendered.
