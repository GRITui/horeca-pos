-- =============================================================================
-- Grit BizSuite — demo seed data (dev/demo environments only, never production)
--
-- Requires migrations/0001_core.sql and 0002_platform_extensions.sql to be
-- applied first. Idempotent: fixed UUIDs + ON CONFLICT DO NOTHING, so
-- re-running is a no-op.
-- =============================================================================

-- --------------------------------------------------------------------------
-- Organization: SCALE tier with the custom_reporting addon enabled
-- --------------------------------------------------------------------------

INSERT INTO organizations (id, name, tier)
VALUES ('11111111-1111-4111-8111-111111111111', 'Grit Demo Trading Co.', 'SCALE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO organization_addons (organization_id, addon)
VALUES ('11111111-1111-4111-8111-111111111111', 'custom_reporting')
ON CONFLICT (organization_id, addon) DO NOTHING;

-- --------------------------------------------------------------------------
-- Locations: one retail storefront + one warehouse
-- --------------------------------------------------------------------------

INSERT INTO locations (id, organization_id, name, type)
VALUES
  ('22222222-2222-4222-8222-222222222201', '11111111-1111-4111-8111-111111111111', 'Downtown Storefront', 'retail'),
  ('22222222-2222-4222-8222-222222222202', '11111111-1111-4111-8111-111111111111', 'Central Warehouse',   'warehouse')
ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------
-- Users: one per role. Password hashes are PLACEHOLDERS shaped like bcrypt
-- output — replace with real bcrypt hashes (e.g. bcrypt.hash("...", 12))
-- before using these accounts to log in.
-- --------------------------------------------------------------------------

INSERT INTO users (id, organization_id, email, password_hash, name, role)
VALUES
  ('33333333-3333-4333-8333-333333333301', '11111111-1111-4111-8111-111111111111', 'owner@gritdemo.test',   '$2b$12$PLACEHOLDER.REPLACE.ME.owner00000000000000000000000', 'Olivia Owner',   'owner'),
  ('33333333-3333-4333-8333-333333333302', '11111111-1111-4111-8111-111111111111', 'manager@gritdemo.test', '$2b$12$PLACEHOLDER.REPLACE.ME.manager0000000000000000000000', 'Manny Manager',  'manager'),
  ('33333333-3333-4333-8333-333333333303', '11111111-1111-4111-8111-111111111111', 'staff@gritdemo.test',   '$2b$12$PLACEHOLDER.REPLACE.ME.staff00000000000000000000000', 'Stacy Staff',    'staff')
ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------
-- Supplier (named on Taskboard restock cards)
-- --------------------------------------------------------------------------

INSERT INTO suppliers (id, organization_id, name)
VALUES ('44444444-4444-4444-8444-444444444401', '11111111-1111-4111-8111-111111111111', 'Acme Wholesale Supply')
ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------
-- Products + matrix variants
-- --------------------------------------------------------------------------

INSERT INTO products (id, organization_id, sku, name, base_price, attributes, supplier_id)
VALUES
  ('55555555-5555-4555-8555-555555555501', '11111111-1111-4111-8111-111111111111', 'TEE-CLASSIC',  'Classic Logo Tee',      19.90, '{"category": "apparel"}'::jsonb,  '44444444-4444-4444-8444-444444444401'),
  ('55555555-5555-4555-8555-555555555502', '11111111-1111-4111-8111-111111111111', 'MUG-ENAMEL',   'Enamel Camp Mug',       12.50, '{"category": "drinkware"}'::jsonb, '44444444-4444-4444-8444-444444444401')
ON CONFLICT (id) DO NOTHING;

INSERT INTO product_variants (id, product_id, sku, name, price_delta, attributes)
VALUES
  ('66666666-6666-4666-8666-666666666601', '55555555-5555-4555-8555-555555555501', 'TEE-CLASSIC-S-BLK', 'Classic Logo Tee — S / Black',  0.00, '{"size": "S", "color": "Black"}'::jsonb),
  ('66666666-6666-4666-8666-666666666602', '55555555-5555-4555-8555-555555555501', 'TEE-CLASSIC-L-BLK', 'Classic Logo Tee — L / Black',  2.00, '{"size": "L", "color": "Black"}'::jsonb),
  ('66666666-6666-4666-8666-666666666603', '55555555-5555-4555-8555-555555555502', 'MUG-ENAMEL-GRN',    'Enamel Camp Mug — Green',       0.00, '{"color": "Green"}'::jsonb),
  ('66666666-6666-4666-8666-666666666604', '55555555-5555-4555-8555-555555555502', 'MUG-ENAMEL-NVY',    'Enamel Camp Mug — Navy',        0.50, '{"color": "Navy"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------
-- Initial inventory: per-(location, product) available quantities
-- --------------------------------------------------------------------------

INSERT INTO inventory_stocks (location_id, product_id, quantity_available, reorder_threshold)
VALUES
  ('22222222-2222-4222-8222-222222222201', '55555555-5555-4555-8555-555555555501', 24, 10),
  ('22222222-2222-4222-8222-222222222201', '55555555-5555-4555-8555-555555555502', 18, 8),
  ('22222222-2222-4222-8222-222222222202', '55555555-5555-4555-8555-555555555501', 200, 50),
  ('22222222-2222-4222-8222-222222222202', '55555555-5555-4555-8555-555555555502', 120, 30)
ON CONFLICT (location_id, product_id) DO NOTHING;

-- --------------------------------------------------------------------------
-- FIFO cost layers (stock lots), matching the on-hand quantities above
-- --------------------------------------------------------------------------

INSERT INTO stock_lots (id, location_id, product_id, received_at, quantity_received, quantity_remaining, unit_cost)
VALUES
  -- Retail storefront
  ('77777777-7777-4777-8777-777777777701', '22222222-2222-4222-8222-222222222201', '55555555-5555-4555-8555-555555555501', '2026-06-01 09:00:00', 24,  24,  8.20),
  ('77777777-7777-4777-8777-777777777702', '22222222-2222-4222-8222-222222222201', '55555555-5555-4555-8555-555555555502', '2026-06-01 09:00:00', 18,  18,  5.10),
  -- Central warehouse: two tee lots at different costs to exercise FIFO
  ('77777777-7777-4777-8777-777777777703', '22222222-2222-4222-8222-222222222202', '55555555-5555-4555-8555-555555555501', '2026-05-15 08:00:00', 120, 120, 7.80),
  ('77777777-7777-4777-8777-777777777704', '22222222-2222-4222-8222-222222222202', '55555555-5555-4555-8555-555555555501', '2026-07-01 08:00:00', 80,  80,  8.40),
  ('77777777-7777-4777-8777-777777777705', '22222222-2222-4222-8222-222222222202', '55555555-5555-4555-8555-555555555502', '2026-06-20 08:00:00', 120, 120, 4.95)
ON CONFLICT (id) DO NOTHING;
