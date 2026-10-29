-- Fake seed data. No real names, emails, addresses or card numbers anywhere.
INSERT INTO tenants (id, name, plan) VALUES
  ('tenant_acme', 'Acme Corp (fake)', 'growth'),
  ('tenant_globex', 'Globex (fake)', 'starter'),
  ('tenant_initech', 'Initech (fake)', 'enterprise'),
  ('tenant_umbrella', 'Umbrella (fake)', 'growth');

INSERT INTO products (tenant_id, sku, title, price_cents)
SELECT t.id,
       t.id || '-SKU' || lpad(s::text, 4, '0'),
       'Fake product ' || s || ' for ' || t.name,
       (10 + (random() * 4990)::int)
FROM tenants t
CROSS JOIN generate_series(1, 40) AS s;

-- ~12k historical orders across the tenants, with a realistic status mix and a
-- heavier volume for tenant_initech so the noisy-neighbour chapter has data.
INSERT INTO orders (tenant_id, request_id, customer_hash, status, total_cents, created_at)
SELECT o.tenant_id,
       'seed-' || gen_random_uuid()::text,
       md5(o.customer_seed::text),
       o.status,
       o.total_cents,
       now() - (o.age_days || ' days')::interval
FROM (
  SELECT t.id AS tenant_id,
         (random() * 100000)::int AS customer_seed,
         CASE
           WHEN r < 0.70 THEN 'confirmed'
           WHEN r < 0.85 THEN 'failed'
           WHEN r < 0.95 THEN 'pending'
           ELSE 'refunded'
         END AS status,
         (500 + (random() * 45000)::int) AS total_cents,
         (random() * 30)::numeric AS age_days
  FROM tenants t
  CROSS JOIN generate_series(1, CASE t.id WHEN 'tenant_initech' THEN 4500 ELSE 2500 END) g
  CROSS JOIN LATERAL (SELECT random() AS r) x
) o;

INSERT INTO order_items (order_id, sku, quantity, unit_price_cents)
SELECT oid.id,
       p.sku,
       1 + (random() * 3)::int,
       p.price_cents
FROM orders oid
JOIN products p ON p.tenant_id = oid.tenant_id
WHERE random() < 0.35;

INSERT INTO payments (order_id, tenant_id, provider, provider_charge_id, status, amount_cents)
SELECT o.id, o.tenant_id, 'stub-gateway', 'chb_fake_' || md5(o.id::text), 'captured', o.total_cents
FROM orders o
WHERE o.status = 'confirmed';

ANALYZE;
