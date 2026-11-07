import { sql } from 'drizzle-orm';
import { loadBackendEnv, parseEnv } from '../src/config/env.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../src/infrastructure/database/client.js';

async function checkDatabase(): Promise<void> {
  let database: DatabaseClient | undefined;

  try {
    loadBackendEnv();
    const config = parseEnv(process.env);
    database = createDatabaseClient(config.databaseUrl);

    const result = await database.db.execute(sql`SELECT 1 AS connected`);
    console.log(result.rows[0]);
  } catch {
    console.error('Database check failed; connection details were omitted.');
    process.exitCode = 1;
  } finally {
    if (database) {
      try {
        await database.close();
      } catch {
        console.error('Database pool shutdown failed.');
        process.exitCode = 1;
      }
    }
  }
}

void checkDatabase();
