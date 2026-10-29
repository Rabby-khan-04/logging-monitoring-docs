// Optional Sentry wiring. Nothing here runs unless SENTRY_DSN is set, so the
// local stack stays fully offline by default.
import { config } from './config.js';
import { logger } from './logger.js';

// Sentry v9 and later are built on OpenTelemetry, so `Sentry.init` installs
// the span processor; it must run before your app code, alongside or instead
// of the plain NodeSDK. Do not run both SDKs on one process.
export async function initSentry(): Promise<void> {
  if (!config.sentryDsn) return;

  const Sentry = await import('@sentry/node');
  Sentry.init({
    dsn: config.sentryDsn,
    release: config.release,
    environment: process.env.NODE_ENV ?? 'development',
    // Traces are already going to the collector; leave sampling off so Sentry
    // does not silently drop the errors you are testing with.
    tracesSampleRate: 0,
    beforeSend(event) {
      // Belt and braces: never let a request body leave the machine.
      if (event.request?.data) delete event.request.data;
      if (event.request?.headers) delete event.request.headers;
      return event;
    },
  });
  logger.info({ 'sentry.environment': process.env.NODE_ENV ?? 'development' }, 'Sentry enabled');
}
