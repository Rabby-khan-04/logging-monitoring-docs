// Structured logging with Pino. One logger per process, JSON on stdout.
import pino, { type LoggerOptions } from 'pino';
import { trace, context } from '@opentelemetry/api';
import { config } from './config.js';
import { currentContext } from './tenancy.js';

// Every field name below describes something that must never reach a log file.
//
// TWO TRAPS I LEARNED THE HARD WAY, both verified by running pino 10 here:
//   1. Paths are anchored at the ROOT of the object you log, and `*` matches
//      exactly ONE level. So `card.cvv` does NOT catch `{ body: { card: { cvv }
//      } }`; you would need `body.card.cvv`. A new wrapper key silently
//      re-exposes everything underneath it.
//   2. There is no recursive wildcard. `**.cvv` and `**` are accepted without
//      error and match NOTHING (they also do not fail to compile — they just
//      leak). Any blog post telling you `**` works is out of date or wrong.
// Because enumeration cannot keep up, the real fix is the deep scrub serializer
// below, which walks the object whatever its shape. `redact` stays as the layer
// that covers pino-http's own req/res objects, which we do not construct.
const REDACT_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  '*.password',
  'email',
  '*.email',
  'phone',
  '*.phone',
  'address',
  '*.address',
  'cardNumber',
  '*.cardNumber',
  'pan',
  '*.pan',
  'cvv',
  '*.cvv',
  'cvc',
  'card.number',
  'card.cvv',
  'card.exp',
  'req.body.card.number',
  'req.body.card.cvv',
  'req.body.password',
  'req.body.email',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  'stripeAccountKey',
  'providerChargeId',
];

// Key names the scrubber blanks at ANY depth. Deliberately conservative: it
// only matches names that are sensitive by themselves, never generic ones like
// `id` or `name`.
const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'newpassword',
  'currentpassword',
  'passwordconfirmation',
  'secret',
  'client_secret',
  'clientsecret',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'session_token',
  'authtoken',
  'authorization',
  'cookie',
  'set-cookie',
  'api_key',
  'apikey',
  'x-api-key',
  'cvv',
  'cvc',
  'pan',
  'cardnumber',
  'card_number',
  'email',
  'phonenumber',
  'phone_number',
  'street',
  'zipcode',
  'zip_code',
  'postal_code',
]);

// Inside an object called `card`, these short keys are card fields. Scoped to
// the parent name so `exp` on a product is not scrubbed.
const CARD_CHILD_KEYS = new Set(['number', 'cvv', 'cvc', 'exp', 'expiry', 'brand']);

type Scrubbed = unknown;

function scrub(value: Scrubbed, parentKey: string | null, depth: number): Scrubbed {
  if (value === null || value === undefined || depth > 12) return value;
  if (typeof value === 'string') {
    // A bare 13-19 digit run in a free-text field is a PAN no matter what the
    // key was called, so catch it by shape as well as by name.
    return value.replace(/\b(?:\d[ -]*?){13,19}\b/g, (m) =>
      m.replace(/[ -]/g, '').length >= 13 ? '[MASKED-PAN]' : m,
    );
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, parentKey, depth + 1));
  if (typeof value !== 'object') return value;

  const out: Record<string, Scrubbed> = {};
  for (const [key, val] of Object.entries(value as Record<string, Scrubbed>)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower)) {
      out[key] = '[REDACTED]';
    } else if (parentKey === 'card' && CARD_CHILD_KEYS.has(lower)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = scrub(val, lower, depth + 1);
    }
  }
  return out;
}

// Keys application code dumps request data under. A serializer runs before
// redact and before the line is written, so it catches new nesting shapes
// without anyone remembering to extend a list.
const SCRUBBED_KEYS = ['body', 'payload', 'data', 'card', 'metadata', 'attributes', 'auth'];

function buildSerializers(): NonNullable<LoggerOptions['serializers']> {
  const serializers: Record<string, (obj: unknown) => unknown> = {};
  for (const key of SCRUBBED_KEYS) serializers[key] = (obj) => scrub(obj, key, 0);
  return serializers;
}

function buildOptions(): LoggerOptions {
  const base: LoggerOptions = {
    level: config.logLevel,
    // `base` is stamped on every line: the fields you filter on in Loki.
    base: {
      'service.name': config.serviceName,
      'app.env': process.env.NODE_ENV ?? 'development',
      'app.release': config.release,
    },
    // ISO timestamps are readable by Loki and by humans. Epoch millis are not.
    timestamp: pino.stdTimeFunctions.isoTime,
    // Emit the level as a string ("info") instead of a number (30).
    formatters: { level: (label) => ({ level: label }) },
    mixin() {
      const ctx = currentContext();
      const additions: Record<string, string> = {};
      if (ctx.requestId) additions['request_id'] = ctx.requestId;
      if (ctx.tenantId) additions['tenant_id'] = ctx.tenantId;
      if (ctx.customerHash) additions['customer_hash'] = ctx.customerHash;

      // Log-to-trace correlation: paste the trace_id from a log line into
      // Tempo and you land on the exact request.
      const span = trace.getSpan(context.active());
      if (span) {
        const sc = span.spanContext();
        additions['trace_id'] = sc.traceId;
        additions['span_id'] = sc.spanId;
      }
      return additions;
    },
  };

  if (config.redactionEnabled) {
    base.redact = { paths: REDACT_PATHS, censor: '[REDACTED]' };
    base.serializers = buildSerializers();
  }

  if (config.prettyLogs) {
    // Development only. pino-pretty is a worker thread and a formatting layer
    // that Loki cannot query. Production always ships raw JSON.
    base.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service.name,app.env,app.release',
      },
    };
  }

  return base;
}

export const logger = pino(buildOptions());
