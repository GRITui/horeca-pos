-- =============================================================================
-- Grit BizSuite — 0002_platform_extensions
-- Additive platform extensions on top of 0001_core. Idempotent: every
-- statement is guarded so re-running is a no-op.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Organizations: subscription tier + addon marketplace flags
-- ---------------------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS tier varchar(20) NOT NULL DEFAULT 'LITE'
    CHECK (tier IN ('LITE', 'GROWTH', 'SCALE'));

-- Addon marketplace flags (e.g. 'custom_reporting'). One row per enabled addon.
CREATE TABLE IF NOT EXISTS organization_addons (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  addon varchar(50) NOT NULL,
  PRIMARY KEY (organization_id, addon)
);

-- ---------------------------------------------------------------------------
-- Users: Grit Passport identity (shared SSO across all Grit apps)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email varchar(255) NOT NULL,
  password_hash varchar(255) NOT NULL,
  name varchar(255) NOT NULL,
  role varchar(20) NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, email)
);

-- ---------------------------------------------------------------------------
-- Product variants: child SKUs for matrix variants (Size/Color/Style)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku varchar(100) UNIQUE NOT NULL,
  name varchar(255) NOT NULL,
  price_delta decimal(10, 2) DEFAULT 0,
  attributes jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS product_variants_product_id_idx
  ON product_variants (product_id);

-- ---------------------------------------------------------------------------
-- Stock lots: FIFO cost layers (consumed oldest-first at sale time)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  received_at timestamp DEFAULT CURRENT_TIMESTAMP,
  quantity_received int NOT NULL,
  quantity_remaining int NOT NULL CHECK (quantity_remaining >= 0),
  unit_cost decimal(10, 2) NOT NULL
);

-- FIFO drain: fetch open lots for a (location, product) oldest-first.
CREATE INDEX IF NOT EXISTS stock_lots_fifo_idx
  ON stock_lots (location_id, product_id, received_at);

-- ---------------------------------------------------------------------------
-- Stock transfers between locations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_location_id uuid NOT NULL REFERENCES locations(id),
  to_location_id uuid NOT NULL REFERENCES locations(id),
  status varchar(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_transit', 'received', 'cancelled')),
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  received_at timestamp
);

CREATE INDEX IF NOT EXISTS stock_transfers_organization_status_idx
  ON stock_transfers (organization_id, status);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity int NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS stock_transfer_items_transfer_id_idx
  ON stock_transfer_items (transfer_id);

-- ---------------------------------------------------------------------------
-- Inventory stocks: one row per (location, product)
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS inventory_stocks_location_id_product_id_key
  ON inventory_stocks (location_id, product_id);

-- ---------------------------------------------------------------------------
-- Tasks: priority, idempotent event-driven card creation, completion tracking
-- ---------------------------------------------------------------------------

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS priority varchar(10) DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high'));

-- Idempotency key for cards created from events (event_id of the source
-- event). NULL for manually created cards; unique when present.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS source_event_id varchar(100);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_source_event_id_key
  ON tasks (source_event_id);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS completed_at timestamp;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS description text;

CREATE INDEX IF NOT EXISTS tasks_location_id_status_idx
  ON tasks (location_id, status);

-- ---------------------------------------------------------------------------
-- Transactions: org scope + idempotent offline sync
-- ---------------------------------------------------------------------------

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

-- Client-generated reference for transactions captured offline and synced
-- later; unique when present so a retried sync cannot double-book a sale.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS external_ref varchar(100);

CREATE UNIQUE INDEX IF NOT EXISTS transactions_external_ref_key
  ON transactions (external_ref);

CREATE INDEX IF NOT EXISTS transactions_location_id_created_at_idx
  ON transactions (location_id, created_at);

CREATE INDEX IF NOT EXISTS transactions_organization_id_created_at_idx
  ON transactions (organization_id, created_at);

CREATE INDEX IF NOT EXISTS transaction_items_transaction_id_idx
  ON transaction_items (transaction_id);

-- ---------------------------------------------------------------------------
-- Event outbox: durable record of published cross-app events
-- (see @grit/shared-events GritEventBus / OutboxStore)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS event_outbox (
  event_id varchar(100) PRIMARY KEY,
  event_name varchar(100) NOT NULL,
  -- Opaque envelope org id (apps may use non-uuid tenant ids, e.g. cuids),
  -- so this is intentionally text with no FK to organizations.
  organization_id text,
  payload jsonb NOT NULL,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  delivered_at timestamp
);

-- Retry drain scans only undelivered rows, oldest first.
CREATE INDEX IF NOT EXISTS event_outbox_undelivered_idx
  ON event_outbox (created_at)
  WHERE delivered_at IS NULL;

-- ---------------------------------------------------------------------------
-- Suppliers: named on Taskboard restock cards
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL
);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL;
