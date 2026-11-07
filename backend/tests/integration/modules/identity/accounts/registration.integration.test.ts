import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorResponse } from '../../../../../src/http/contract.js';
import { buildApp } from '../../../../../src/app.js';
import { normalizeEmail } from '../../../../../src/modules/identity/accounts/email-normalization.js';
import { verifyPassword } from '../../../../../src/modules/identity/passwords/credentials.js';
import { digestIdentityToken } from '../../../../../src/modules/identity/token.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../../src/infrastructure/database/client.js';
import { FakeEmailSender } from '../../../../helpers/fake-email-sender.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../../helpers/test-database.js';

const runId = randomUUID();
const fixtureEmails: string[] = [];
const validPassword = 'correct horse battery 🎾';

let database: DatabaseClient | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let emailSender: FakeEmailSender;
let testDatabaseVerified = false;

function getDatabase(): DatabaseClient {
  if (!database) {
    throw new Error('Test database was not initialized.');
  }

  return database;
}

function getApp(): ReturnType<typeof buildApp> {
  if (!app) {
    throw new Error('Test app was not initialized.');
  }

  return app;
}

function fixtureEmail(label: string): string {
  const email = `registration-${runId}-${label}@example.test`;
  fixtureEmails.push(email);
  return email;
}

function register(email: string, remoteAddress: string, password = validPassword) {
  return getApp().inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress,
    payload: { email, password },
  });
}

async function waitForEmailAttempts(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(emailSender.attempts).toBe(count);
  });
}

beforeAll(async () => {
  const connectionString = requireTestDatabaseUrl(process.env);
  database = createDatabaseClient(connectionString);

  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  emailSender = new FakeEmailSender();
  app = buildApp({ database, emailSender });
  await app.ready();
});

beforeEach(() => {
  emailSender.reset();
});

afterAll(async () => {
  try {
    if (database && testDatabaseVerified) {
      for (const email of fixtureEmails) {
        await database.pool.query('DELETE FROM identity_users WHERE normalized_email = $1', [
          normalizeEmail(email),
        ]);
      }
    }
  } finally {
    if (app) {
      await app.close();
    } else if (database) {
      await database.close();
    }
  }
});

describe('POST /api/v1/auth/register', () => {
  it('creates a pending account and sends a digest-backed verification token', async () => {
    const email = fixtureEmail('success');
    const startedAt = Date.now();

    const response = await register(email, '192.0.2.101');

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      data: { status: 'accepted' },
    });
    expect(response.body).not.toContain(validPassword);

    await waitForEmailAttempts(1);
    expect(emailSender.messages).toHaveLength(1);

    const accountResult = await getDatabase().pool.query<{
      id: string;
      delivery_email: string;
      normalized_email: string;
      status: string;
    }>(
      `SELECT id, delivery_email, normalized_email, status
       FROM identity_users
       WHERE normalized_email = $1`,
      [normalizeEmail(email)],
    );

    const account = accountResult.rows[0];
    expect(account).toBeDefined();

    if (!account) {
      throw new Error('Expected the registration account to exist.');
    }

    expect(account.delivery_email).toBe(email);
    expect(account.normalized_email).toBe(normalizeEmail(email));
    expect(account.status).toBe('pending_verification');

    const credentialResult = await getDatabase().pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM identity_credentials WHERE user_id = $1',
      [account.id],
    );
    const credential = credentialResult.rows[0];

    expect(credential).toBeDefined();

    if (!credential) {
      throw new Error('Expected the registration credential to exist.');
    }

    expect(await verifyPassword(validPassword, credential.password_hash)).toBe(true);

    const tokenResult = await getDatabase().pool.query<{
      token_digest: string;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT token_digest, expires_at, consumed_at
       FROM identity_tokens
       WHERE user_id = $1 AND purpose = 'email_verification'`,
      [account.id],
    );

    const token = tokenResult.rows[0];
    expect(token).toBeDefined();

    if (!token) {
      throw new Error('Expected an email-verification token to exist.');
    }

    const expiryTime = new Date(token.expires_at).getTime();
    expect(expiryTime).toBeGreaterThanOrEqual(startedAt + 24 * 60 * 60 * 1000 - 1_000);
    expect(token.consumed_at).toBeNull();

    const message = emailSender.messages[0];

    if (!message) {
      throw new Error('Expected a verification email to be captured by the fake sender.');
    }

    const linkMatch = /href="([^"]+)"/u.exec(message.html);
    const verificationLink = linkMatch?.[1];

    if (!verificationLink) {
      throw new Error('Expected the verification email to contain a link.');
    }

    const rawToken = new URL(verificationLink).searchParams.get('token');
    expect(rawToken).toBeTruthy();

    if (!rawToken) {
      throw new Error('Expected the verification link to contain a token.');
    }

    expect(digestIdentityToken(rawToken)).toBe(token.token_digest);
    expect(response.body).not.toContain(rawToken);
    expect(response.body).not.toContain(verificationLink);
  });

  it('returns the shared validation error for invalid input', async () => {
    const response = await getApp().inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: '192.0.2.102',
      payload: {
        email: 'not-an-email',
        password: 'short',
      },
    });

    expect(response.statusCode).toBe(400);

    const body = response.json<ApiErrorResponse>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.requestId).toBe(response.headers['x-request-id']);
    expect(response.body).not.toContain('short');
  });

  it('returns the same generic response for a duplicate without changing the account or password', async () => {
    const email = fixtureEmail('duplicate');
    const normalizedEmail = normalizeEmail(email);
    const existingHash = 'existing-password-hash-must-remain-unchanged';

    const insertResult = await getDatabase().pool.query<{ id: string }>(
      `INSERT INTO identity_users (delivery_email, normalized_email, status)
       VALUES ($1, $2, 'active')
       RETURNING id`,
      [email, normalizedEmail],
    );

    const existingUser = insertResult.rows[0];

    if (!existingUser) {
      throw new Error('Could not create the duplicate-signup fixture.');
    }

    await getDatabase().pool.query(
      `INSERT INTO identity_credentials (user_id, password_hash)
       VALUES ($1, $2)`,
      [existingUser.id, existingHash],
    );

    const response = await register(
      email.toUpperCase(),
      '192.0.2.103',
      'a different valid password',
    );

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      data: { status: 'accepted' },
    });

    const existingResult = await getDatabase().pool.query<{
      delivery_email: string;
      status: string;
      password_hash: string;
    }>(
      `SELECT users.delivery_email, users.status, credentials.password_hash
       FROM identity_users AS users
       JOIN identity_credentials AS credentials ON credentials.user_id = users.id
       WHERE users.id = $1`,
      [existingUser.id],
    );

    expect(existingResult.rows[0]).toEqual({
      delivery_email: email,
      status: 'active',
      password_hash: existingHash,
    });
    expect(emailSender.attempts).toBe(0);
  });

  it('creates only one account when two normalized-email signups race', async () => {
    const email = fixtureEmail('concurrent');

    const responses = await Promise.all([
      register(email, '192.0.2.104', 'first valid registration password'),
      register(email.toUpperCase(), '192.0.2.104', 'second valid registration password'),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
    expect(responses[0]?.json()).toEqual({
      data: { status: 'accepted' },
    });
    expect(responses[1]?.json()).toEqual({
      data: { status: 'accepted' },
    });

    await waitForEmailAttempts(1);

    const accountResult = await getDatabase().pool.query<{ id: string }>(
      'SELECT id FROM identity_users WHERE normalized_email = $1',
      [normalizeEmail(email)],
    );

    expect(accountResult.rows).toHaveLength(1);

    const userId = accountResult.rows[0]?.id;

    if (!userId) {
      throw new Error('Expected one account after concurrent registration.');
    }

    const credentialResult = await getDatabase().pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM identity_credentials WHERE user_id = $1',
      [userId],
    );
    expect(credentialResult.rows).toHaveLength(1);

    const tokenResult = await getDatabase().pool.query<{ token_digest: string }>(
      `SELECT token_digest
       FROM identity_tokens
       WHERE user_id = $1 AND purpose = 'email_verification'`,
      [userId],
    );
    expect(tokenResult.rows).toHaveLength(1);
    expect(emailSender.messages).toHaveLength(1);

    const storedHash = credentialResult.rows[0]?.password_hash;

    if (!storedHash) {
      throw new Error('Expected the winning registration password hash.');
    }

    const firstPasswordWorks = await verifyPassword(
      'first valid registration password',
      storedHash,
    );
    const secondPasswordWorks = await verifyPassword(
      'second valid registration password',
      storedHash,
    );

    expect(Number(firstPasswordWorks) + Number(secondPasswordWorks)).toBe(1);
  });

  it('returns 202 and leaves the account pending when email delivery fails', async () => {
    const email = fixtureEmail('delivery-failure');
    emailSender.failNextSend();

    const response = await register(email, '192.0.2.105');

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      data: { status: 'accepted' },
    });

    await waitForEmailAttempts(1);

    const result = await getDatabase().pool.query<{ status: string }>(
      'SELECT status FROM identity_users WHERE normalized_email = $1',
      [normalizeEmail(email)],
    );

    expect(result.rows[0]?.status).toBe('pending_verification');
    expect(emailSender.messages).toHaveLength(0);
  });

  it('returns before a slow verification-email send completes', async () => {
    const email = fixtureEmail('slow-delivery');
    const releaseSend = emailSender.holdNextSend();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const response = await Promise.race([
        register(email, '192.0.2.106'),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Registration waited for email delivery.')),
            5_000,
          );
        }),
      ]);

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: { status: 'accepted' },
      });
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }

      releaseSend();
    }

    await waitForEmailAttempts(1);
    await vi.waitFor(() => {
      expect(emailSender.messages).toHaveLength(1);
    });
  });

  it('rate-limits an IP before allowing more registration attempts', async () => {
    const email = fixtureEmail('rate-limited');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await register(email, '192.0.2.107');
      expect(response.statusCode).toBe(202);
    }

    const limitedResponse = await register(email, '192.0.2.107');

    expect(limitedResponse.statusCode).toBe(429);

    const body = limitedResponse.json<ApiErrorResponse>();
    expect(body.error.code).toBe('REQUEST_ERROR');
    expect(body.requestId).toBe(limitedResponse.headers['x-request-id']);
  });
});
