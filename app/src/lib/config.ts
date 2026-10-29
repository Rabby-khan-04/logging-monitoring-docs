// Central place for every environment variable the services read.
// Keep this boring: config should be one screen, not a framework.

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function flag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

export const config = {
  serviceName: env('OTEL_SERVICE_NAME', 'shop-api'),
  port: Number(env('PORT', '8000')),
  databaseUrl: env(
    'DATABASE_URL',
    'postgres://shop:shop@postgres:5432/shop',
  ),
  paymentUrl: env('PAYMENT_SERVICE_URL', 'http://payment-gateway:8020/charge'),
  dbPoolMax: Number(env('DB_POOL_MAX', '8')),

  logLevel: env('LOG_LEVEL', 'info'),
  // Pretty output is for human eyes at a terminal. Never in production:
  // it destroys the JSON that Loki and LogQL depend on.
  prettyLogs: flag('LOG_PRETTY', false),
  // DANGER DEMO SWITCH. Turning redaction off makes the /danger/* endpoints
  // print real secrets. Only used to prove that redaction is load-bearing.
  redactionEnabled: flag('LOG_REDACT', true),

  otlpEndpoint: env('OTEL_EXPORTER_OTLP_ENDPOINT', ''),
  sentryDsn: env('SENTRY_DSN', ''),
  release: env('APP_RELEASE', 'dev'),

  // Chaos switches let a single container act sick so we can watch the
  // dashboards react. Off by default.
  slowCheckoutMs: Number(env('CHAOS_SLOW_CHECKOUT_MS', '0')),
  paymentDeclineRate: Number(env('CHAOS_PAYMENT_DECLINE_RATE', '0')),
} as const;
