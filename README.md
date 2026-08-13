# Shopify → PostgreSQL Product Importer

Imports all products and variants from a Shopify store (via the Admin GraphQL
API) into a PostgreSQL database, keeping existing records in sync on repeat
runs.

## 1. Setup Instructions

1. Install Node.js 18+ (needed for the built-in `fetch`).
2. Install dependencies:
   ```bash
   npm install dotenv pg
   ```
3. Create a `.env` file in the project root:
   ```env
   # Shopify
   SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
   SHOPIFY_ADMIN_API_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
   SHOPIFY_API_VERSION=2026-07        # optional, defaults to 2026-07
   PRODUCTS_PER_PAGE=50               # optional, defaults to 50, max 250

   # PostgreSQL
   PG_HOST=localhost
   PG_PORT=5432
   PG_DATABASE=your_database
   PG_USER=your_user
   PG_PASSWORD=your_password
   PG_SSL_MODE=require                # optional, omit for local/no-SSL DBs
   ```
4. Make sure the Postgres database in `PG_DATABASE` already exists — the
   script creates the tables inside it, but not the database itself.

## 2. Required Shopify API Permissions

The Admin API access token needs the **`read_products`** scope. This covers
both `products` and their nested `variants` in the Admin GraphQL API. No
write scopes are required — the importer is read-only against Shopify.

## 3. Database Configuration Instructions

No manual schema setup is needed. On every run, the script calls
`ensureSchema()`, which executes `CREATE TABLE IF NOT EXISTS` /
`CREATE INDEX IF NOT EXISTS` for:

- `products` — one row per Shopify product
- `product_variants` — one row per Shopify variant, with a foreign key
  `product_id → products.id` (`ON DELETE CASCADE`)
- `idx_variants_product_id` — index on `product_variants.product_id` to keep
  variant lookups/joins fast

This is safe to run repeatedly; it won't touch tables that already exist.

Connection settings are read from the `PG_*` environment variables above and
passed to a `pg` connection `Pool`. If `PG_SSL_MODE=require`, SSL is enabled
(with `rejectUnauthorized: false`, suitable for most managed Postgres
providers' default certificates).

## 4. Command to Run the Importer

```bash
node import.js
```

The script validates required env vars, ensures the schema exists, then
imports. It exits with code `0` on a clean run, or `1` if any errors
occurred (see the summary printed at the end) or if required config is
missing.

## 5. Shopify → PostgreSQL Field Mapping

**Product** (`products` table):

| Shopify field (GraphQL)     | Postgres column       | Notes                              |
|------------------------------|------------------------|-------------------------------------|
| `id`                          | `shopify_product_id`  | GID converted to numeric string (e.g. `gid://shopify/Product/123` → `123`) |
| `title`                       | `title`                | |
| `handle`                      | `handle`                | |
| `description`                 | `description`          | |
| `vendor`                      | `vendor`                | |
| `productType`                 | `product_type`         | |
| `status`                      | `status`                | |
| `tags`                        | `tags`                  | stored as Postgres `TEXT[]`; empty array stored as `NULL` |
| `featuredImage.url`           | `featured_image_url`   | `NULL` if no featured image |
| `createdAt`                   | `created_at`            | parsed to `TIMESTAMPTZ` |
| `updatedAt`                   | `updated_at`            | parsed to `TIMESTAMPTZ` |
| —                              | `imported_at`           | set to `NOW()` on every insert/update |

**Variant** (`product_variants` table):

| Shopify field (GraphQL)     | Postgres column         | Notes |
|------------------------------|---------------------------|-------|
| `id`                          | `shopify_variant_id`     | GID converted to numeric string |
| —                              | `product_id`              | FK, resolved from the parent product's row `id` after upsert |
| `title`                       | `title`                    | |
| `sku`                         | `sku`                      | |
| `price`                       | `price`                    | parsed to float, stored as `NUMERIC(12,2)` |
| `compareAtPrice`              | `compare_at_price`        | parsed to float, `NULL` if absent |
| `inventoryQuantity`           | `inventory_quantity`      | |
| —                              | `imported_at`              | set to `NOW()` on every insert/update |

## 6. Pagination Approach

Products are fetched using Shopify's **cursor-based pagination**:

- Each GraphQL request asks for `first: PRODUCTS_PER_PAGE` products, starting
  `after` the previous page's cursor.
- The response's `pageInfo.hasNextPage` / `pageInfo.endCursor` drive the loop
  — the script keeps requesting pages until `hasNextPage` is `false`.
- Variants are **not** paginated separately: each product query pulls up to
  `variants(first: 100)` inline, which covers Shopify's own per-product
  variant cap (100), so no product's variants get cut off.

## 7. Duplicate and Update Handling

Both tables use a natural unique key from Shopify (`shopify_product_id`,
`shopify_variant_id`) with a Postgres `UNIQUE` constraint. Every write is an
`INSERT ... ON CONFLICT (...) DO UPDATE`:

- First time a product/variant is seen → inserted as a new row.
- Every subsequent run → the existing row (matched on the Shopify ID) is
  updated in place, not duplicated.
- The script distinguishes insert vs. update per row via `(xmax = 0) AS
  is_insert` in the `RETURNING` clause, which feeds the insert/update counts
  in the final summary.
- Each product and its variants are imported inside a single Postgres
  transaction (`BEGIN` / `COMMIT` / `ROLLBACK`), so a partial write for one
  product can't leave it half-imported.

## 8. Error-Handling Approach

- **Shopify request level**: `shopifyGraphQL()` retries transient failures
  (network errors, `5xx` responses) up to 3 times with exponential backoff.
  `429` responses and GraphQL-level `THROTTLED` cost errors are handled
  explicitly by waiting the amount of time Shopify's throttle status
  indicates before retrying. The client also proactively pauses for a second
  when the query-cost bucket drops below 20% remaining, to avoid getting
  throttled in the first place.
- **Page level**: if a page request fails after retries, the error is
  logged, counted, and the import loop stops (rather than looping forever on
  a broken connection).
- **Record level**: each product, and each of its variants, is imported in
  its own `try/catch`. A failure on one product or variant is logged and
  counted, and the loop moves on to the next record — a single bad record
  never aborts the whole import.
- **Skipped vs. errored**: records missing a usable Shopify ID (the field
  the DB relies on as its unique key) are **skipped** before touching the
  database, and counted separately from **errors**. Errors are reserved for
  real failures — DB constraint violations, connection issues, etc.
- **Summary reporting**: every run ends with a printed summary — products
  seen, products inserted, products updated, variants inserted, variants
  updated, records skipped, and errors encountered — so partial or failed
  runs are always visible, not silent.

## 9. Known Limitations

- **No delete detection**: the importer only inserts/updates. If a product
  is deleted or archived in Shopify, its row remains in Postgres unchanged.
- **Variant cap of 100 per product**: this matches Shopify's own maximum
  variants-per-product, so in practice no variants are missed — but if that
  Shopify limit is ever raised, this script would need a follow-up query to
  paginate variants independently.
- **No metafields, images beyond the featured image, collections, or
  inventory locations**: only the fields listed in the mapping above are
  imported.
- **Sequential, not parallelized**: products are imported one at a time
  (page by page, product by product), which is simple and safe but not the
  fastest option for very large catalogs.
- **Full re-scan every run**: there's no incremental/delta sync using
  `updatedAt` — every run re-fetches and re-upserts the entire product
  catalog.
- **Single store per run**: `SHOPIFY_STORE_DOMAIN` is a single value; syncing
  multiple stores means running the script multiple times with different
  `.env` configs.

## 10. AI Tools Used

**Claude** (Anthropic) was used for two things on this project:

1. **Code review against a requirements checklist** — the importer script
   was checked line-by-line against an 11-point spec (connection, pagination,
   variant retrieval, field transforms, upsert/dedup behavior, optional-field
   handling, per-record error isolation, and the import summary). This
   surfaced one gap: the summary was missing a "records skipped" count, with
   no underlying logic to distinguish a *skipped* record (missing required
   ID, never touches the DB) from an *errored* one (a DB write that actually
   failed). Claude added the `recordsSkipped` stat, the skip checks in
   `importProduct()`, and the corresponding summary line.
2. **This README** — generated from the final script and schema to document
   setup, configuration, behavior, and limitations in one place.

All logic changes were reviewed for correctness (including a syntax check)
before being accepted.
