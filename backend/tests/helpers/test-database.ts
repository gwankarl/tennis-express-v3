import type { Pool } from 'pg';

const EXPECTED_DATABASE = 'tennis_xpress_app_test';
const EXPECTED_LOGIN = 'tennis_xpress_app_test';
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);

export function requireTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const connectionString = env.TEST_DATABASE_URL?.trim();

  if (!connectionString) {
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  }

  let target: URL;

  try {
    target = new URL(connectionString);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  const databaseName = decodeURIComponent(target.pathname.slice(1));
  const loginName = decodeURIComponent(target.username);

  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !ALLOWED_HOSTS.has(target.hostname) ||
    !target.port ||
    databaseName !== EXPECTED_DATABASE ||
    loginName !== EXPECTED_LOGIN
  ) {
    throw new Error(
      'TEST_DATABASE_URL must target the local tennis_xpress_app_test database using its matching login.',
    );
  }

  return connectionString;
}

export async function verifyTestDatabaseIdentity(pool: Pool): Promise<void> {
  let result;

  try {
    result = await pool.query<{
      database_name: string;
      login_name: string;
    }>('SELECT current_database() AS database_name, current_user AS login_name');
  } catch {
    throw new Error('Could not verify the PostgreSQL test database identity.');
  }

  const identity = result.rows[0];

  if (identity?.database_name !== EXPECTED_DATABASE || identity.login_name !== EXPECTED_LOGIN) {
    throw new Error(
      'Connected PostgreSQL database or login does not match the expected test target.',
    );
  }
}
