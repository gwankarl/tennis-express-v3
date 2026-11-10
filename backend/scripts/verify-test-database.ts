import { loadBackendEnv } from '../src/config/env.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../src/infrastructure/database/client.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../tests/helpers/test-database.js';

async function verifyTestDatabase(): Promise<void> {
  let database: DatabaseClient | undefined;

  try {
    loadBackendEnv();

    // Validate the URL before opening a connection. This function does not
    // fall back to DATABASE_URL.
    const connectionString = requireTestDatabaseUrl(process.env);
    database = createDatabaseClient(connectionString);

    // Confirm the database and login returned by PostgreSQL before migrations.
    await verifyTestDatabaseIdentity(database.pool);
    console.log('Verified test database: tennis_xpress_app_test / tennis_xpress_app_test');
  } catch {
    console.error('Test database verification failed; connection details were omitted.');
    process.exitCode = 1;
  } finally {
    if (database) {
      try {
        await database.close();
      } catch {
        console.error('Test database pool shutdown failed.');
        process.exitCode = 1;
      }
    }
  }
}

void verifyTestDatabase();
