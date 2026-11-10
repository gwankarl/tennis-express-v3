import { loadBackendEnv, parseEnv } from '../src/config/env.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../src/infrastructure/database/client.js';
import { seedCatalogLaunchData } from '../src/modules/catalog/launch-data.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../tests/helpers/test-database.js';

async function seedCatalog(): Promise<void> {
  let database: DatabaseClient | undefined;

  try {
    loadBackendEnv();

    const args = process.argv.slice(2);
    const useTestDatabase = args.length === 1 && args[0] === '--test';

    if (args.length > 0 && !useTestDatabase) {
      throw new Error('Unsupported seed command arguments.');
    }

    const connectionString = useTestDatabase
      ? requireTestDatabaseUrl(process.env)
      : parseEnv(process.env).databaseUrl;

    database = createDatabaseClient(connectionString);

    if (useTestDatabase) {
      await verifyTestDatabaseIdentity(database.pool);
    }

    await seedCatalogLaunchData(database.db);
    console.log(
      useTestDatabase
        ? 'Catalog launch data loaded into the verified test database.'
        : 'Catalog launch data loaded into the configured development database.',
    );
  } catch {
    console.error('Catalog launch-data loading failed; database connection details were omitted.');
    process.exitCode = 1;
  } finally {
    if (database) {
      try {
        await database.close();
      } catch {
        console.error('Catalog seed database pool shutdown failed.');
        process.exitCode = 1;
      }
    }
  }
}

void seedCatalog();
