CREATE TABLE IF NOT EXISTS products (
  id                  SERIAL PRIMARY KEY,
  shopify_product_id  TEXT UNIQUE NOT NULL,
  title               TEXT,
  handle              TEXT,
  description         TEXT,
  vendor              TEXT,
  product_type        TEXT,
  status              TEXT,
  tags                TEXT[],
  featured_image_url  TEXT,
  created_at          TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_variants (
  id                  SERIAL PRIMARY KEY,
  shopify_variant_id  TEXT UNIQUE NOT NULL,
  product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title               TEXT,
  sku                 TEXT,
  price               NUMERIC(12, 2),
  compare_at_price    NUMERIC(12, 2),
  inventory_quantity  INTEGER,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_variants_product_id ON product_variants(product_id);
