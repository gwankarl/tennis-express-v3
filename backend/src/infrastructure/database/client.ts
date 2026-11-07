import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export interface DatabaseClient {
  db: ReturnType<typeof drizzle>;
  pool: Pool;
  close(): Promise<void>;
}

export function createDatabaseClient(connectionString: string): DatabaseClient {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
  });

  const db = drizzle({ client: pool });
  let closePromise: Promise<void> | undefined;

  return {
    db,
    pool,
    close(): Promise<void> {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
