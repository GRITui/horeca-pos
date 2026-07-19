-- =============================================================================
-- Grit BizSuite — 0001_core
-- Base platform schema (verbatim from the platform spec, plus IF NOT EXISTS
-- guards so re-running the migration is a no-op).
--
-- gen_random_uuid() is built into PostgreSQL 13+ (Neon runs newer), so no
-- extension is required.
-- =============================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  type varchar(50) CHECK (type IN ('retail', 'warehouse', 'service_hub', 'kitchen'))
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  sku varchar(100) UNIQUE NOT NULL,
  name varchar(255) NOT NULL,
  base_price decimal(10, 2) NOT NULL,
  attributes jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id),
  total_amount decimal(10, 2) NOT NULL,
  tax_amount decimal(10, 2) NOT NULL,
  payment_status varchar(50) DEFAULT 'completed',
  created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transaction_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid REFERENCES transactions(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id),
  quantity int NOT NULL CHECK (quantity > 0),
  unit_price decimal(10, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_stocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  quantity_available int NOT NULL DEFAULT 0,
  reorder_threshold int DEFAULT 10
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  title varchar(255) NOT NULL,
  status varchar(50) CHECK (status IN ('todo', 'in_progress', 'review', 'done')),
  triggered_by varchar(50) DEFAULT 'manual',
  assigned_shift varchar(100),
  created_at timestamp DEFAULT CURRENT_TIMESTAMP
);
