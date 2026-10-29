// One pg Pool, plus the observability wrapper every query goes through.
// The wrapper exists so that "the database is slow" is a measurement, not an
// opinion: duration histogram + a warn log line past a threshold.
import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';
import { dbQueryDurationSeconds } from './metrics.js';
import { currentContext } from './tenancy.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Small on purpose. A big pool hides slow queries and melts Postgres when
  // something upstream stalls. Tune up only with evidence.
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

// Queries slower than this get a log line so Loki can find the exact request.
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? '100');

pool.on('error', (err) => {
  // An error on an *idle* connection: log it once here, do not rethrow, and do
  // not log it again in the request path. One error, one log line.
  logger.error({ err, 'error.name': 'pool_idle_error' }, 'idle database connection errored');
});

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  const start = process.hrtime.bigint();
  const ctx = currentContext();
  const client = await pool.connect();
  try {
    // Tag the session so pg_stat_activity and pg_stat_statements can be
    // attributed per tenant without parsing application code.
    if (ctx.tenantId) {
      await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', ctx.tenantId]);
    }
    const result = await client.query(text, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
  } finally {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    client.release();
    dbQueryDurationSeconds.observe({ query: name }, ms / 1000);
    if (ms > SLOW_QUERY_MS) {
      // Duration and query name only. NEVER the parameter values: they can
      // carry emails, addresses and card data.
      logger.warn(
        { query_name: name, duration_ms: Math.round(ms), slow_query_threshold_ms: SLOW_QUERY_MS },
        'slow query',
      );
    }
  }
}

export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = process.hrtime.bigint();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Number(process.hrtime.bigint() - start) / 1e6 };
  } catch {
    return { ok: false, latencyMs: Number(process.hrtime.bigint() - start) / 1e6 };
  }
}
