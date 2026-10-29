// OpenTelemetry bootstrap. This file is loaded with `--import` BEFORE the app,
// so the instrumentation hooks are installed before http/pg/express are loaded.
//
// Everything that does not need code lives in environment variables: that is
// the modern, deployment-owned way to configure the SDK.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

// Metrics come from prom-client, and logs come from Pino straight to stdout.
// Exporting them again over OTLP would create duplicate series with different
// names, so both are explicitly off here.
process.env.OTEL_METRICS_EXPORTER ??= 'none';
process.env.OTEL_LOGS_EXPORTER ??= 'none';
process.env.OTEL_TRACES_EXPORTER ??= 'otlp';

const sdk = new NodeSDK({
  instrumentations: [
    getNodeAutoInstrumentations({
      // Filesystem and DNS spans drown the interesting ones in noise.
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      // pg and http stay enabled: those are the dependencies we care about.
    }),
  ],
});

await sdk.start();

// Optional, off by default. Only starts a Sentry client when a DSN exists.
const { initSentry } = await import('./lib/sentry.js');
await initSentry();

process.on('SIGTERM', () => {
  // Flush pending spans, then let the supervisor kill us.
  void sdk.shutdown().finally(() => process.exit(0));
});
