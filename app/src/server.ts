import { createApp } from './app.js';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { markReady } from './routes/health.js';
import { pool } from './lib/db.js';

const app = createApp();

// Two process-level handlers, because some failures never reach a route.
// Both log once and then behave predictably: no silent exits, no double lines.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason, 'error.name': 'unhandledRejection' }, 'unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  // The state of the process is unknown after this. Log with fatal, then exit
  // and let the supervisor start a clean replacement.
  logger.fatal({ err, 'error.name': 'uncaughtException' }, 'uncaught exception, shutting down');
  process.exit(1);
});

const server = app.listen(config.port, () => {
  markReady();
  logger.info(
    {
      'network.port': config.port,
      log_level: config.logLevel,
      redaction: config.redactionEnabled ? 'on' : 'OFF (danger demo mode)',
      otlp: config.otlpEndpoint || 'disabled',
      pool_max: config.dbPoolMax,
    },
    'shop-api listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    void pool.end().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  });
  // Anything still running after 10s is a leak worth finding in the logs.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
