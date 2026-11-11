import { loadBackendEnv, parseEnv } from '../src/config/env.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../src/infrastructure/database/client.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../tests/helpers/test-database.js';

async function backfillListingVariants(): Promise<void> {
  let database: DatabaseClient | undefined;

  try {
    loadBackendEnv();

    const args = process.argv.slice(2);
    const useTestDatabase = args.length === 1 && args[0] === '--test';

    if (args.length > 0 && !useTestDatabase) {
      throw new Error('Unsupported backfill command arguments.');
    }

    const connectionString = useTestDatabase
      ? requireTestDatabaseUrl(process.env)
      : parseEnv(process.env).databaseUrl;
    database = createDatabaseClient(connectionString);

    if (useTestDatabase) {
      await verifyTestDatabaseIdentity(database.pool);
    }

    const result = await database.pool.query(`
      WITH referenced_configurations AS (
        SELECT listing_id, catalog_variant_id
        FROM seller_listing_draft_configurations
        UNION
        SELECT listing_id, catalog_variant_id
        FROM seller_listing_revision_configurations
      ), missing_configurations AS (
        SELECT
          referenced.listing_id,
          listing.seller_id,
          referenced.catalog_variant_id,
          gen_random_uuid() AS id
        FROM referenced_configurations AS referenced
        INNER JOIN seller_listings AS listing
          ON listing.id = referenced.listing_id
        LEFT JOIN seller_listing_variants AS existing
          ON existing.listing_id = referenced.listing_id
          AND existing.catalog_variant_id = referenced.catalog_variant_id
        WHERE existing.id IS NULL
      )
      INSERT INTO seller_listing_variants (
        id,
        listing_id,
        seller_id,
        catalog_variant_id,
        sku
      )
      SELECT
        missing.id,
        missing.listing_id,
        missing.seller_id,
        missing.catalog_variant_id,
        'TX-' || upper(replace(missing.id::text, '-', ''))
      FROM missing_configurations AS missing
      ON CONFLICT (listing_id, catalog_variant_id) DO NOTHING
    `);

    console.log(
      useTestDatabase
        ? `Backfilled ${result.rowCount ?? 0} sellable variants in the verified test database.`
        : `Backfilled ${result.rowCount ?? 0} sellable variants in the configured development database.`,
    );
  } catch {
    console.error('Listing variant backfill failed; database connection details were omitted.');
    process.exitCode = 1;
  } finally {
    if (database) {
      try {
        await database.close();
      } catch {
        console.error('Listing variant backfill pool shutdown failed.');
        process.exitCode = 1;
      }
    }
  }
}

void backfillListingVariants();
