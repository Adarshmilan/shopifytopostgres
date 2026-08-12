require('dotenv').config();
const { Pool } = require('pg');

// ── Config ──────────────────────────────────────────────────────────────
const CONFIG = {
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
  accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
  apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
  productsPerPage: parseInt(process.env.PRODUCTS_PER_PAGE || '50', 10),
};

function validateConfig() {
  const required = {
    SHOPIFY_STORE_DOMAIN: CONFIG.storeDomain,
    SHOPIFY_ADMIN_API_ACCESS_TOKEN: CONFIG.accessToken,
    PG_DATABASE: process.env.PG_DATABASE,
    PG_USER: process.env.PG_USER,
    PG_PASSWORD: process.env.PG_PASSWORD,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
}

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: process.env.PG_SSL_MODE === 'require' ? { rejectUnauthorized: false } : false,
});
pool.on('error', (err) => console.error('Unexpected PG pool error:', err.message));

// ── Schema ──────────────────────────────────────────────────────────────
const SCHEMA_SQL = `
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
`;

async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
  } finally {
    client.release();
  }
}

// ── Shopify Admin GraphQL client ───────────────────────────────────────
const GRAPHQL_URL = `https://${CONFIG.storeDomain}/admin/api/${CONFIG.apiVersion}/graphql.json`;

const PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          title
          handle
          description
          vendor
          productType
          status
          tags
          featuredImage { url }
          createdAt
          updatedAt
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                compareAtPrice
                inventoryQuantity
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shopifyIdToNumber(gid) {
  // "gid://shopify/Product/123456789" -> "123456789"
  return gid ? gid.split('/').pop() : null;
}

async function shopifyGraphQL(query, variables, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    let response;
    try {
      response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': CONFIG.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (networkErr) {
      if (attempt === retries) throw new Error(`Network error: ${networkErr.message}`);
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if (response.status === 429) {
      const retryAfter = parseFloat(response.headers.get('Retry-After') || '2');
      console.warn(`  Rate limited (429). Waiting ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      continue;
    }
    if (response.status >= 500) {
      if (attempt === retries) throw new Error(`Shopify server error: ${response.status}`);
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();

    // GraphQL-level throttling comes back as an error with code THROTTLED,
    // not an HTTP status. Back off using the point bucket's restore rate.
    const throttled = json.errors?.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled) {
      const status = json.extensions?.cost?.throttleStatus;
      const waitMs = status ? Math.ceil((50 - status.currentlyAvailable) / status.restoreRate) * 1000 : 2000;
      console.warn(`  GraphQL cost throttled. Waiting ${waitMs}ms...`);
      await sleep(Math.max(waitMs, 1000));
      continue;
    }
    if (json.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
    }

    // Proactively slow down if we're close to exhausting the point bucket.
    const cost = json.extensions?.cost?.throttleStatus;
    if (cost && cost.currentlyAvailable / cost.maximumAvailable < 0.2) {
      await sleep(1000);
    }

    return json.data;
  }
}

// ── Transform Shopify nodes into DB rows ───────────────────────────────
function toProductRow(node) {
  return {
    shopify_product_id: shopifyIdToNumber(node.id),
    title: node.title ?? null,
    handle: node.handle ?? null,
    description: node.description ?? null,
    vendor: node.vendor ?? null,
    product_type: node.productType ?? null,
    status: node.status ?? null,
    tags: node.tags?.length ? node.tags : null,
    featured_image_url: node.featuredImage?.url ?? null,
    created_at: node.createdAt ? new Date(node.createdAt) : null,
    updated_at: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}

function toVariantRow(node) {
  return {
    shopify_variant_id: shopifyIdToNumber(node.id),
    title: node.title ?? null,
    sku: node.sku ?? null,
    price: node.price != null ? parseFloat(node.price) : null,
    compare_at_price: node.compareAtPrice != null ? parseFloat(node.compareAtPrice) : null,
    inventory_quantity: node.inventoryQuantity ?? null,
  };
}

// ── Upserts ─────────────────────────────────────────────────────────────
async function upsertProduct(client, row) {
  const { rows } = await client.query(
    `INSERT INTO products (
       shopify_product_id, title, handle, description, vendor, product_type,
       status, tags, featured_image_url, created_at, updated_at, imported_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
     ON CONFLICT (shopify_product_id) DO UPDATE SET
       title = EXCLUDED.title,
       handle = EXCLUDED.handle,
       description = EXCLUDED.description,
       vendor = EXCLUDED.vendor,
       product_type = EXCLUDED.product_type,
       status = EXCLUDED.status,
       tags = EXCLUDED.tags,
       featured_image_url = EXCLUDED.featured_image_url,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at,
       imported_at = NOW()
     RETURNING id, (xmax = 0) AS is_insert`,
    [row.shopify_product_id, row.title, row.handle, row.description, row.vendor,
    row.product_type, row.status, row.tags, row.featured_image_url, row.created_at, row.updated_at]
  );
  return rows[0]; // { id, is_insert }
}

async function upsertVariant(client, row, productId) {
  const { rows } = await client.query(
    `INSERT INTO product_variants (
       shopify_variant_id, product_id, title, sku, price, compare_at_price,
       inventory_quantity, imported_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
     ON CONFLICT (shopify_variant_id) DO UPDATE SET
       product_id = EXCLUDED.product_id,
       title = EXCLUDED.title,
       sku = EXCLUDED.sku,
       price = EXCLUDED.price,
       compare_at_price = EXCLUDED.compare_at_price,
       inventory_quantity = EXCLUDED.inventory_quantity,
       imported_at = NOW()
     RETURNING (xmax = 0) AS is_insert`,
    [row.shopify_variant_id, productId, row.title, row.sku, row.price, row.compare_at_price, row.inventory_quantity]
  );
  return rows[0]; // { is_insert }
}

async function importProduct(stats, node) {
  const productRow = toProductRow(node);

  // A record with no usable Shopify ID can't be upserted (it's our unique
  // key) — skip it rather than letting it fail as a DB error.
  if (!productRow.shopify_product_id) {
    stats.recordsSkipped++;
    console.warn(`  Skipped product with missing/invalid id: ${JSON.stringify(node.title ?? node)}`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const product = await upsertProduct(client, productRow);
    product.is_insert ? stats.productsInserted++ : stats.productsUpdated++;

    for (const edge of node.variants?.edges ?? []) {
      const variantRow = toVariantRow(edge.node);

      if (!variantRow.shopify_variant_id) {
        stats.recordsSkipped++;
        console.warn(`  Skipped variant with missing/invalid id on product ${productRow.shopify_product_id}`);
        continue;
      }

      try {
        const variant = await upsertVariant(client, variantRow, product.id);
        variant.is_insert ? stats.variantsInserted++ : stats.variantsUpdated++;
      } catch (err) {
        stats.errors++;
        console.error(`  Variant error (${edge.node.id}): ${err.message}`);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    throw err;
  } finally {
    client.release();
  }
}

// ── Main import loop ────────────────────────────────────────────────────
async function run() {
  validateConfig();
  await ensureSchema();

  const stats = {
    productsSeen: 0, productsInserted: 0, productsUpdated: 0,
    variantsInserted: 0, variantsUpdated: 0, recordsSkipped: 0, errors: 0,
  };

  let after = null;
  let hasNextPage = true;
  let page = 0;

  console.log(`Importing products from ${CONFIG.storeDomain} (API ${CONFIG.apiVersion})...\n`);

  while (hasNextPage) {
    page++;
    let data;
    try {
      data = await shopifyGraphQL(PRODUCTS_QUERY, { first: CONFIG.productsPerPage, after });
    } catch (err) {
      console.error(`Failed to fetch page ${page}: ${err.message}`);
      stats.errors++;
      break;
    }

    const edges = data?.products?.edges ?? [];
    hasNextPage = data?.products?.pageInfo?.hasNextPage ?? false;
    after = data?.products?.pageInfo?.endCursor ?? null;

    for (const edge of edges) {
      stats.productsSeen++;
      try {
        await importProduct(stats, edge.node);
      } catch (err) {
        stats.errors++;
        console.error(`Product error (${edge.node.id}): ${err.message}`);
      }
    }

    console.log(`Page ${page}: ${edges.length} products (running total: ${stats.productsSeen})`);
  }

  console.log('\n──────── Import Summary ────────');
  console.log(`Products seen:       ${stats.productsSeen}`);
  console.log(`Products inserted:   ${stats.productsInserted}`);
  console.log(`Products updated:    ${stats.productsUpdated}`);
  console.log(`Variants inserted:   ${stats.variantsInserted}`);
  console.log(`Variants updated:    ${stats.variantsUpdated}`);
  console.log(`Records skipped:     ${stats.recordsSkipped}`);
  console.log(`Errors:              ${stats.errors}`);
  console.log('─────────────────────────────────');

  await pool.end();
  process.exit(stats.errors > 0 ? 1 : 0);
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Fatal error:', err.message);
    pool.end();
    process.exit(1);
  });
}