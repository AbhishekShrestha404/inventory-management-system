CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS ingredients (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  unit TEXT NOT NULL CHECK (unit IN ('kg','g','l','ml','piece')),
  low_stock NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (low_stock >= 0),
  active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS ingredient_lots (
  id BIGSERIAL PRIMARY KEY,
  ingredient_id BIGINT NOT NULL REFERENCES ingredients(id),
  supplier TEXT NOT NULL,
  received_at DATE NOT NULL DEFAULT CURRENT_DATE,
  expires_at DATE NOT NULL,
  received_qty NUMERIC(12,3) NOT NULL CHECK (received_qty > 0),
  remaining_qty NUMERIC(12,3) NOT NULL CHECK (remaining_qty >= 0),
  unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0)
);
CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  sweet_name TEXT NOT NULL,
  variant TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  daily_target INTEGER NOT NULL DEFAULT 0 CHECK (daily_target >= 0),
  low_stock INTEGER NOT NULL DEFAULT 0 CHECK (low_stock >= 0),
  shelf_life_days INTEGER NOT NULL DEFAULT 7 CHECK (shelf_life_days > 0),
  active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS recipes (
  product_id BIGINT NOT NULL REFERENCES products(id),
  ingredient_id BIGINT NOT NULL REFERENCES ingredients(id),
  qty_per_packet NUMERIC(12,3) NOT NULL CHECK (qty_per_packet > 0),
  PRIMARY KEY (product_id, ingredient_id)
);
CREATE TABLE IF NOT EXISTS target_overrides (
  product_id BIGINT NOT NULL REFERENCES products(id),
  production_date DATE NOT NULL,
  target_qty INTEGER NOT NULL CHECK (target_qty >= 0),
  PRIMARY KEY (product_id, production_date)
);
CREATE TABLE IF NOT EXISTS batches (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  produced_qty INTEGER NOT NULL CHECK (produced_qty > 0),
  produced_at DATE NOT NULL,
  expires_at DATE NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_lots (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL UNIQUE REFERENCES batches(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  expires_at DATE NOT NULL,
  remaining_qty INTEGER NOT NULL CHECK (remaining_qty >= 0)
);
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  due_date DATE NOT NULL,
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('pickup','delivery')),
  address TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','fulfilled','cancelled')),
  paid BOOLEAN NOT NULL DEFAULT false,
  total NUMERIC(12,2) NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0)
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGSERIAL PRIMARY KEY,
  stock_type TEXT NOT NULL CHECK (stock_type IN ('ingredient','product')),
  item_id BIGINT NOT NULL,
  lot_id BIGINT NOT NULL,
  quantity NUMERIC(12,3) NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('receipt','production_use','production_output','fulfillment','adjustment')),
  reference_id BIGINT,
  note TEXT NOT NULL DEFAULT '',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS ingredient_lots_use_idx ON ingredient_lots(ingredient_id,expires_at) WHERE remaining_qty > 0;
CREATE INDEX IF NOT EXISTS product_lots_use_idx ON product_lots(product_id,expires_at) WHERE remaining_qty > 0;
CREATE INDEX IF NOT EXISTS orders_due_idx ON orders(due_date) WHERE status = 'confirmed';
