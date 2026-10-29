// Manual spans, for the parts auto-instrumentation cannot see: business steps
// like "charge card" or "reserve stock".
import { trace, context, propagation, SpanStatusCode } from '@opentelemetry/api';
import { config } from './config.js';

// The name must match what you look for in Tempo.
const tracer = trace.getTracer(config.serviceName);

export interface SpanHandle {
  end(): void;
  error(err: unknown): void;
  setAttribute(key: string, value: string | number | boolean): void;
}

// Start/stop style, because checkout spans several awaits and callbacks and a
// simple async wrapper cannot span a queue hop. The span is not made "active":
// use withSpan() when you want children to attach automatically.
export function startSpan(name: string, attrs: Record<string, string | number | boolean> = {}): SpanHandle {
  const span = tracer.startSpan(name, { attributes: attrs });
  return {
    setAttribute(key, value) {
      span.setAttribute(key, value);
    },
    error(err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message ?? 'error' });
    },
    end() {
      span.end();
    },
  };
}

// Run `fn` inside a new span, with the span made "active" so that nested HTTP
// and database calls attach to it automatically.
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: { setAttribute(k: string, v: string | number | boolean): void }) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

// The manual version of context propagation. The HTTP auto-instrumentation
// does this for you; seeing it once is the point.
export function outboundTraceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, {
    set: (c, k, v) => {
      c[k] = v;
    },
  });
  return carrier;
}

export function currentTraceId(): string | undefined {
  const span = trace.getSpan(context.active());
  return span?.spanContext().traceId;
}
