// A 40-line stand-in for PagerDuty/Slack/email. It prints every Alertmanager
// payload to stdout, which means the alerts themselves end up in Loki like any
// other log line, and you can query "what did I get paged for this week".
//
// In production this is a real notifier with a secret; here it is deliberately
// dumb so nothing can leak and nothing can fail in a way you misdiagnose.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8090);

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { raw: body.slice(0, 500) };
    }
    const line = {
      level: parsed.status === 'firing' ? 'warn' : 'info',
      'alert.status': parsed.status,
      'alert.channel': new URL(req.url, 'http://x').searchParams.get('channel') ?? 'default',
      'alert.count': Array.isArray(parsed.alerts) ? parsed.alerts.length : 0,
      alerts: (parsed.alerts ?? []).map((a) => ({
        name: a.labels?.alertname,
        severity: a.labels?.severity,
        tenant_id: a.labels?.tenant_id ?? null,
        state: a.status,
        startsAt: a.startsAt,
        summary: a.annotations?.summary,
      })),
    };
    console.log(JSON.stringify(line));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}).listen(port, () => console.log(JSON.stringify({ level: 'info', msg: `alert sink on :${port}` })));
