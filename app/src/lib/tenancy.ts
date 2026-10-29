// Tenant + request context, carried through AsyncLocalStorage so it survives
// every await without threading parameters through all function signatures.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  tenantId?: string;
  // A keyed hash, never the raw address. Same customer is searchable across
  // log lines, but nobody can read an email out of Loki.
  customerHash?: string;
  route?: string;
}

export const requestStorage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): Partial<RequestContext> {
  return requestStorage.getStore() ?? {};
}

// For code paths that genuinely cannot continue without a request context
// (checkout, idempotency). Fail loudly in development instead of writing NULL
// into a correlation column and losing the thread of the incident later.
export function requireContext(): RequestContext {
  const ctx = requestStorage.getStore();
  if (!ctx) {
    throw new Error('request context is missing: is tenantContext() registered above this handler?');
  }
  return ctx;
}

// The allowlist is deliberately tiny and fake. These are made-up tenants.
export const KNOWN_TENANTS = [
  'tenant_acme',
  'tenant_globex',
  'tenant_initech',
  'tenant_umbrella',
] as const;

export type TenantId = (typeof KNOWN_TENANTS)[number];

export function isKnownTenant(value: string): value is TenantId {
  return (KNOWN_TENANTS as readonly string[]).includes(value);
}

// Hashing identity values: stable for correlation, unreadable in a log file.
// The secret lives in the environment; in production it is a managed secret.
const HASH_SECRET = process.env.IDENTITY_HASH_SECRET ?? 'dev-only-insecure-secret';

export function hashIdentity(raw: string): string {
  return createHmac('sha256', HASH_SECRET).update(raw.toLowerCase()).digest('hex').slice(0, 16);
}
