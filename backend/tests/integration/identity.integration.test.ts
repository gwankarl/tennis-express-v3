import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireTestDatabaseUrl, verifyTestDatabaseIdentity } from '../helpers/test-database.js';

let pool: Pool | undefined;

async function withRollbackTransaction(run: (client: PoolClient) => Promise<void>): Promise<void> {
  if (!pool) {
    throw new Error('Test database pool was not initialized.');
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await run(client);
  } finally {
    try {
      if (transactionStarted) {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  }
}

async function insertUser(
  client: PoolClient,
  deliveryEmail: string,
  normalizedEmail: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO identity_users (delivery_email, normalized_email, status)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [deliveryEmail, normalizedEmail, 'active'],
  );

  const user = result.rows[0];

  if (!user) {
    throw new Error('Identity user fixture insert returned no row.');
  }

  return user.id;
}

async function getPostgresErrorCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      return error.code;
    }

    return undefined;
  }
}

beforeAll(async () => {
  const connectionString = requireTestDatabaseUrl(process.env);
  pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
  });

  await verifyTestDatabaseIdentity(pool);
});

afterAll(async () => {
  await pool?.end();
});

describe('identity persistence constraints', () => {
  it('rejects a duplicate normalized email', async () => {
    await withRollbackTransaction(async (client) => {
      const suffix = randomUUID();
      const normalizedEmail = `identity-${suffix}@example.test`;

      await insertUser(client, `First-${suffix}@example.test`, normalizedEmail);

      const errorCode = await getPostgresErrorCode(() =>
        insertUser(client, `Second-${suffix}@example.test`, normalizedEmail),
      );

      expect(errorCode).toBe('23505');
    });
  });

  it('allows only one password credential per user', async () => {
    await withRollbackTransaction(async (client) => {
      const suffix = randomUUID();
      const userId = await insertUser(
        client,
        `credential-${suffix}@example.test`,
        `credential-${suffix}@example.test`,
      );

      await client.query(
        `INSERT INTO identity_credentials (user_id, password_hash)
         VALUES ($1, $2)`,
        [userId, 'synthetic-password-hash-one'],
      );

      const errorCode = await getPostgresErrorCode(() =>
        client.query(
          `INSERT INTO identity_credentials (user_id, password_hash)
           VALUES ($1, $2)`,
          [userId, 'synthetic-password-hash-two'],
        ),
      );

      expect(errorCode).toBe('23505');
    });
  });

  it('rejects a token for a user that does not exist', async () => {
    await withRollbackTransaction(async (client) => {
      const errorCode = await getPostgresErrorCode(() =>
        client.query(
          `INSERT INTO identity_tokens
             (user_id, purpose, token_digest, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [randomUUID(), 'email_verification', 'a'.repeat(64), new Date(Date.now() + 60_000)],
        ),
      );

      expect(errorCode).toBe('23503');
    });
  });

  it('rejects a duplicate token digest', async () => {
    await withRollbackTransaction(async (client) => {
      const suffix = randomUUID();
      const userId = await insertUser(
        client,
        `token-${suffix}@example.test`,
        `token-${suffix}@example.test`,
      );
      const tokenDigest = 'b'.repeat(64);
      const expiresAt = new Date(Date.now() + 60_000);

      await client.query(
        `INSERT INTO identity_tokens
           (user_id, purpose, token_digest, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [userId, 'email_verification', tokenDigest, expiresAt],
      );

      const errorCode = await getPostgresErrorCode(() =>
        client.query(
          `INSERT INTO identity_tokens
             (user_id, purpose, token_digest, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [userId, 'password_reset', tokenDigest, expiresAt],
        ),
      );

      expect(errorCode).toBe('23505');
    });
  });
});
