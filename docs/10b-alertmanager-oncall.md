# 10b - Alertmanager, routing and on-call

Chapter 10a decided which conditions deserve an alert. This chapter decides who
hears about them, how often, and how to stop hearing about one that is already
being fixed.

## 1. Simple explanation

Imagine the receptionist at a hospital. The fire alarm, the lab and the
pharmacy all ring the same desk. A good receptionist does three things:

- sends each call to the right person (the fire alarm goes to the fire brigade,
  not the pharmacist);
- waits a few seconds before calling, so one problem that sets off six alarms
  produces one phone call, not six;
- and writes "out of order" on the lift phone when a repair crew is already
  standing in the lift, so nobody calls about it again.

Alertmanager is that receptionist. Prometheus decides something is true;
Alertmanager decides whether a human should be interrupted, by what, and how
many times.

## 2. Real name

- **Route tree**: the matching rules that send an alert to a **receiver**
  (webhook, email, Slack, PagerDuty). First match wins unless the route
  continues.
- **Matcher**: `severity = "page"`, evaluated against the alert's labels.
- **Grouping**: alerts sharing the `group_by` labels become one notification.
  `group_wait` is how long to collect siblings before sending, `group_interval`
  is the minimum gap between updates for the same group, and `repeat_interval`
  is how often an unfixed group is re-sent.
- **Inhibition**: suppress a target alert while a source alert is firing, e.g.
  every symptom of a service whose scrape target is down.
- **Silence**: a manual, time-boxed mute with a comment. Expires on its own;
  this is not the same thing as disabling a rule.
- **On-call rotation and escalation**: who is primary this week and who is
  woken when primary does not acknowledge. Both live in the paging tool
  (PagerDuty, Opsgenie, Grafana OnCall), not in Alertmanager. Here the paging
  tool is a webhook that prints JSON.

## 3. Example

The whole configuration is `alertmanager/alertmanager.yml`. The parts that
matter:

```yaml
global:
  # How long Alertmanager waits before calling an alert resolved when the
  # source stops sending it. Must be longer than the scrape/eval cycle.
  resolve_timeout: 2m

route:
  receiver: default
  # One notification per alertname per tenant. Without tenant_id, one bad
  # deploy affecting four tenants is one message that names none of them.
  group_by: ["alertname", "tenant_id"]
  group_wait: 10s        # collect siblings for 10s before the first send
  group_interval: 30s    # at most one update per group every 30s
  repeat_interval: 2h    # still broken? remind, but only every 2h

  routes:
    - matchers:
        - severity = "page"     # only pages wake people
      receiver: on-call
      group_wait: 5s            # pages get less patience than tickets
      group_interval: 15s
      repeat_interval: 30m      # an unresolved page re-sends twice an hour

    - matchers:
        - severity = "none"     # the Watchdog heartbeat
      receiver: heartbeat

receivers:
  - name: default
    webhook_configs:
      - url: http://alert-sink:8090/ingest?channel=default
        send_resolved: true     # the recovery message matters as much as the page

  - name: on-call
    webhook_configs:
      - url: http://alert-sink:8090/ingest?channel=oncall
        send_resolved: true
    # In production this is email_configs, slack_configs or pagerduty_configs.
    # Those need credentials and a real rotation, so they stay out of the repo.

inhibit_rules:
  # A dead target explains every symptom on that service. Suppress the symptom
  # pages while TargetDown fires, matching on the same `service` label.
  - source_matchers:
      - alertname = "TargetDown"
    target_matchers:
      - severity = "page"
    equal: ["service"]

  # 15% free disk explains unrelated warnings on the same host.
  - source_matchers:
      - alertname = "DiskFillingUp"
    target_matchers:
      - severity = "warn"
    equal: []
```

One block is declared and never used: `time_intervals: office-hours`. It is a
legal config and does nothing until a route references it with
`active_time_intervals: [office-hours]`. Config that looks like policy but is
not wired to anything is worse than no config, because people believe it.

## 4. What you should see

This is real output from the sink while the stack was being brought up. Three
scrape targets died at once, and the page arrived as **one** notification with
`alert.count: 3`:

```bash
$ docker compose logs alert-sink | grep '"channel":"oncall"' | head -4
{"level":"warn","alert.status":"firing","alert.channel":"oncall","alert.count":3,"alerts":[{"name":"TargetDown","severity":"page","tenant_id":null,"state":"firing","startsAt":"2026-10-29T06:20:46.682Z","summary":"cadvisor stopped answering scrapes"},{"name":"TargetDown","severity":"page","tenant_id":null,"state":"firing","startsAt":"2026-10-29T06:20:31.682Z","summary":"grafana stopped answering scrapes"},{"name":"TargetDown","severity":"page","tenant_id":null,"state":"firing","startsAt":"2026-10-29T06:20:46.682Z","summary":"node-exporter stopped answering scrapes"}]}
{"level":"info","alert.status":"resolved","alert.channel":"oncall","alert.count":3,"alerts":[{"name":"TargetDown","severity":"page","tenant_id":null,"state":"resolved","startsAt":"2026-10-29T06:20:46.682Z","summary":"cadvisor stopped answering scrapes"},{"name":"TargetDown","severity":"page","tenant_id":null,"state":"resolved","startsAt":"2026-10-29T06:20:31.682Z","summary":"grafana stopped answering scrapes"},{"name":"TargetDown","severity":"page","tenant_id":null,"state":"resolved","startsAt":"2026-10-29T06:20:46.682Z","summary":"node-exporter stopped answering scrapes"}]}
```

Grouping did its job: three pages' worth of text, one interruption. The
heartbeat takes a different route and never resolves, because it never stops:

```bash
$ docker compose logs alert-sink | grep heartbeat | head -1
{"level":"warn","alert.status":"firing","alert.channel":"heartbeat","alert.count":1,"alerts":[{"name":"Watchdog","severity":"none","tenant_id":null,"state":"firing","startsAt":"2026-10-29T06:19:24.891Z","summary":"Heartbeat: alerting pipeline is alive"}]}
```

Alertmanager itself reports which alerts it is currently holding, after
routing:

```bash
$ curl -s localhost:9093/api/v2/alerts | jq -c '.[] | {name:.labels.alertname, sev:.labels.severity, tenant:(.labels.tenant_id//"-"), state:.status.state, receivers:.receivers}'
{"name":"Watchdog","sev":"none","tenant":"-","state":"active","receivers":[{"name":"heartbeat"}]}
{"name":"TrafficCollapse","sev":"warn","tenant":"tenant_initech","state":"active","receivers":[{"name":"default"}]}
{"name":"TrafficCollapse","sev":"warn","tenant":"tenant_umbrella","state":"active","receivers":[{"name":"default"}]}
```

A silence created through the API, then listed:

```bash
$ curl -s -X POST localhost:9093/api/v2/silences -H 'content-type: application/json' \
  -d '{"matchers":[{"name":"alertname","value":"ApiLatencyP95High","isRegex":false},
                   {"name":"tenant_id","value":"tenant_initech","isRegex":false}],
      "startsAt":"2026-10-29T10:15:00Z","endsAt":"2026-10-29T10:25:00Z",
      "createdBy":"student","comment":"Chapter 10b: known slow tenant during a test"}'
{"silenceID":"4afe02f4-e721-4971-8c88-14e6bd558229"}

$ curl -s localhost:9093/api/v2/silences | jq -c '.[] | select(.status.state=="active") | {id:.id, state:.status.state, matchers:.matchers, comment:.comment}'
{"id":"4afe02f4-e721-4971-8c88-14e6bd558229","state":"active","matchers":[{"isEqual":true,"isRegex":false,"name":"alertname","value":"ApiLatencyP95High"},{"isEqual":true,"isRegex":false,"name":"tenant_id","value":"tenant_initech"}],"comment":"Chapter 10b: known slow tenant during a test"}
```

An expired silence looks the same except `"state":"expired"`, and it stays in
the list so the next person can see what was muted and why.

## 5. In a real multi-tenant e-commerce platform

`group_by: ["alertname", "tenant_id"]` is the single most important line for a
multi-tenant shop. During the timeout exercise, `ApiHighErrorRatio` fired for
tenant_initech and later for tenant_acme; because `tenant_id` is in the group
key, those were two notifications with a tenant name in each, not one anonymous
"error rate high". A responder's first question is always "everyone or just
them?", and the router answers it before the incident call starts.

The routing split matters commercially too. Declined cards (tenant_initech
runs at 25%) are a support ticket, not a page: `severity: warn`, receiver
`default`. A payment gateway timing out is revenue stopping: `severity: page`,
receiver `on-call`. Same system, two different cost calculations.

Inhibition is what turns a crash into one page instead of twelve. When
`TargetDown` fired for shop-api, every `ApiHighErrorRatio` and `ApiLatencyP95High`
for that service became uninformative: nobody can judge a service whose metrics
have stopped arriving. The inhibition rule says exactly that, and only for
alerts carrying the same `service` label.

## 6. When to use it, when not to

Use grouping always; it is free and it is the difference between a readable
page and a wall of text. Use inhibition for a genuinely causal pair that shares
a label - dead target versus its symptoms, host disk versus host warnings. Use
a silence when you are actively working on a known issue and want the pager
quiet while you do.

Do not use a silence to "make the alert go away" when the underlying problem is
unfixed. A silence hides the page, not the outage; put the ticket number in the
comment and the expiry before the end of your shift. Do not inhibit on
`equal: []` unless the source really explains every target - our disk rule uses
`equal: []` and therefore suppresses every `warn` on the stack while the disk
is full. That is deliberate here because the disk is shared, but on a
multi-cluster setup it would be far too broad.

Cost: every route you add is a promise that someone reads that channel. The
`heartbeat` route is the exception whose value is that nobody reads it. Email
and Slack integrations are cheap to add and expensive to maintain; a page that
lands in a Slack channel with 40 unread messages is not a page.

## 7. Common mistakes

1. **A silence with no expiry.** The API above requires `endsAt`; a UI can
   still set one a year out. The next incident then happens silently. Our
   expired silence from a previous exercise is the model: short, commented,
   gone.
2. **Grouping by too much.** Adding `instance` to `group_by` splits one
   service outage into one notification per replica. Grouping by too little
   (just `severity`) merges unrelated incidents into one unreadable message.
3. **`repeat_interval` too short.** Thirty seconds means the same broken thing
   re-pages 120 times an hour, and people mute the channel - the beginning of
   the end.
4. **Inhibiting on the wrong label.** `equal: ["service"]` works because both
   the source and target carry it. If the labels do not match, inhibition
   silently does nothing; check `/api/v2/alerts` and look at the labels, not
   the YAML.
5. **Config that is never referenced.** The unused `office-hours` interval.
   Nothing errors, nothing happens.
6. **One receiver for everything.** If `page` and `warn` go to the same place,
   severity is decoration. Chapter 10a argued about which alerts deserve to
   exist; this chapter is where that decision becomes a routing table.
7. **Treating resolved as success.** A resolved notification only means the
   condition stopped being true. If it resolved because traffic stopped, you
   have a worse problem; this is why `TrafficCollapse` exists.

## 8. Try it yourself

Silence something, then prove it was silenced, then let it expire.

```bash
# 1. Start a short outage so there is something to mute.
./scripts/outage.sh 120 timeout tenant_initech &

# 2. Create a 5-minute silence for the latency warning on that tenant.
END=$(date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST localhost:9093/api/v2/silences -H 'content-type: application/json' -d "{
  \"matchers\":[{\"name\":\"alertname\",\"value\":\"ApiLatencyP95High\",\"isRegex\":false},
                {\"name\":\"tenant_id\",\"value\":\"tenant_initech\",\"isRegex\":false}],
  \"startsAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"endsAt\":\"$END\",
  \"createdBy\":\"me\",\"comment\":\"exercise\"}"

# 3. Watch it take effect.
curl -s localhost:9093/api/v2/alerts \
  | jq -c '.[] | select(.labels.alertname=="ApiLatencyP95High") | {tenant:.labels.tenant_id, state:.status.state, silenced:.status.silencedBy}'
```

**Hint:** a silenced alert is still `active` in Alertmanager and still `firing`
in Prometheus; only the notification stops. That is the point - the truth is
not hidden, the interruption is. The `silencedBy` array holds the silence IDs.

**Cleanup:** silence it forever is the mistake; delete it instead:

```bash
SID=$(curl -s localhost:9093/api/v2/silences | jq -r '.[] | select(.status.state=="active" and .createdBy=="me") | .id')
curl -s -X DELETE "localhost:9093/api/v2/silence/$SID" -o /dev/null -w '%{http_code}\n'
```

## 9. Next

Routing decides who is woken. It does not decide whether the promise you made
to customers is being kept. [10c - SLIs, SLOs and error budgets](10c-sli-slo-error-budget.md)
turns "too many errors" into a number with a deadline.
