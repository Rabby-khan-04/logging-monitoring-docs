-- Schema for the observability learning stack. Fake data only.
-- Deliberately missing: an index on order_items(order_id). Chapter 14 asks you
-- to find that with pg_stat_statements and add it yourself.

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE tenants (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  plan        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE products (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  sku          text NOT NULL,
  title        text NOT NULL,
  price_cents  integer NOT NULL CHECK (price_cents > 0),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);
CREATE INDEX idx_products_tenant_active ON products (tenant_id, is_active);

CREATE TABLE orders (
  id             bigserial PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants(id),
  request_id     text,
  customer_hash  text NOT NULL,
  status         text NOT NULL,
  total_cents    integer NOT NULL,
  currency       text NOT NULL DEFAULT 'USD',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_tenant_created ON orders (tenant_id, created_at DESC);
CREATE INDEX idx_orders_request_id ON orders (request_id);

CREATE TABLE order_items (
  id                bigserial PRIMARY KEY,
  order_id          bigint NOT NULL REFERENCES orders(id),
  sku               text NOT NULL,
  quantity          integer NOT NULL,
  unit_price_cents  integer NOT NULL
  -- no index on order_id, on purpose (see the note at the top)
);

CREATE TABLE payments (
  id                  bigserial PRIMARY KEY,
  order_id            bigint NOT NULL REFERENCES orders(id),
  tenant_id           text NOT NULL REFERENCES tenants(id),
  provider            text NOT NULL,
  provider_charge_id  text NOT NULL,
  status              text NOT NULL,
  amount_cents        integer NOT NULL,
  currency            text NOT NULL DEFAULT 'USD',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_order ON payments (order_id);

-- Lets pg_stat_activity show which tenant a session belongs to, so a
-- noisy-neighbour investigation can name the tenant without reading app code.
CREATE OR REPLACE FUNCTION set_session_tenant() RETURNS void AS $$
BEGIN
  PERFORM set_config('app.tenant_id', current_setting('application_name'), true);
END;
$$ LANGUAGE plpgsql;
