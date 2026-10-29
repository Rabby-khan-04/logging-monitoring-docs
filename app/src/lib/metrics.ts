// Prometheus metrics. Every metric name here is load-bearing: it is either on
// a dashboard, in an alert rule, or both. Anything else is noise to be deleted.
import client from 'prom-client';
import { config } from './config.js';
import { pool } from './db.js';

// `register` is what /metrics serves. Keep one per process.
export const register = client.register;

// Process and Node runtime metrics: event loop lag, memory, active handles.
// Free, and the first thing you check when a pod is sick.
client.collectDefaultMetrics({
  register,
  prefix: 'shop_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// RED method for HTTP: Rate, Errors, Duration.
// The histogram gives you all three: _count is the rate, the bucket sums let
// you compute p50/p95/p99, and you split errors by status_code.
//
// Cardinality warning: `route` is the *mounted path template* (/api/orders/:id),
// never the concrete URL. Label values must come from a bounded set.
export const httpRequestDurationSeconds = new client.Histogram({
  name: 'shop_http_request_duration_seconds',
  help: 'Latency of HTTP requests in seconds, by route, status and tenant.',
  labelNames: ['method', 'route', 'status_code', 'tenant_id'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: 'shop_http_requests_total',
  help: 'Total HTTP requests, by method, route template and status class.',
  labelNames: ['method', 'route', 'status_class'] as const,
  registers: [register],
});

// Errors worth paging on, counted separately from plain 4xx.
export const httpErrorsTotal = new client.Counter({
  name: 'shop_http_errors_total',
  help: 'Server-side failures by error code and tenant.',
  labelNames: ['code', 'tenant_id'] as const,
  registers: [register],
});

// ---- Checkout funnel: business metrics as first-class citizens ----
// One counter per funnel step. Checkout drop-off is the difference between
// these series, which is why they must all carry tenant_id.
export const checkoutStepTotal = new client.Counter({
  name: 'shop_checkout_step_total',
  help: 'Orders reaching each checkout step.',
  labelNames: ['tenant_id', 'step'] as const,
  registers: [register],
});

export const checkoutOutcomeTotal = new client.Counter({
  name: 'shop_checkout_outcome_total',
  help: 'Final checkout outcomes.',
  labelNames: ['tenant_id', 'outcome'] as const,
  registers: [register],
});

export const paymentFailuresTotal = new client.Counter({
  name: 'shop_payment_failures_total',
  help: 'Payments that did not capture, by reason.',
  labelNames: ['tenant_id', 'reason'] as const,
  registers: [register],
});

// Money moving through the platform. A counter of cents, not a gauge of
// "revenue", because gauges cannot be summed correctly over time.
export const orderValueCentsTotal = new client.Counter({
  name: 'shop_order_value_cents_total',
  help: 'Sum of captured order value in cents.',
  labelNames: ['tenant_id', 'currency'] as const,
  registers: [register],
});

export const ordersInFlight = new client.Gauge({
  name: 'shop_orders_in_flight',
  help: 'Checkouts currently being processed.',
  labelNames: ['tenant_id'] as const,
  registers: [register],
});

// ---- Dependency latency: you cannot alert on "the DB is slow" without it ----
export const dbQueryDurationSeconds = new client.Histogram({
  name: 'shop_db_query_duration_seconds',
  help: 'SQL query duration by named query.',
  labelNames: ['query'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const paymentProviderDurationSeconds = new client.Histogram({
  name: 'shop_payment_provider_duration_seconds',
  help: 'Latency of the upstream payment gateway.',
  labelNames: ['outcome'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// Connection pool exhaustion shows up here long before customers notice.
export const dbPoolConnections = new client.Gauge({
  name: 'shop_db_pool_connections',
  help: 'PostgreSQL pool size by state.',
  labelNames: ['state'] as const,
  async collect() {
    // Called at scrape time, not on every request: cheap by design.
    this.set({ state: 'total' }, pool.totalCount);
    this.set({ state: 'idle' }, pool.idleCount);
    this.set({ state: 'waiting' }, pool.waitingCount);
  },
  registers: [register],
});

// Which build is running. Answers "did we just deploy this?" in one query.
// Note: prom-client 15 has no Info metric type, so the idiomatic Prometheus
// pattern is a Gauge that is always 1 and carries the metadata in labels.
export const buildInfo = new client.Gauge({
  name: 'shop_build_info',
  help: 'Build metadata for the running process, always 1.',
  labelNames: ['release', 'environment'] as const,
  registers: [register],
});
buildInfo.set({ release: config.release, environment: process.env.NODE_ENV ?? 'development' }, 1);

// ---- Cardinality demo: a SEPARATE registry so the damage stays contained ----
// Chapter 07b turns this on to show what an unbounded label does to
// Prometheus. /metrics never serves this; /metrics/demo does.
export const demoRegistry = new client.Registry();

export const badRequestPathTotal = new client.Counter({
  name: 'shop_demo_cardinality_total',
  help: 'Deliberately bad example: an unbounded label value.',
  labelNames: ['path', 'client_ip'] as const,
  registers: [demoRegistry],
});
