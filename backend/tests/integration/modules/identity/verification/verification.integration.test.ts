import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorResponse } from '../../../../../src/http/contract.js';
import { buildApp } from '../../../../../src/app.js';
import { normalizeEmail } from '../../../../../src/modules/identity/accounts/email-normalization.js';
import {
  generateEmailVerificationToken,
  digestIdentityToken,
} from '../../../../../src/modules/identity/token.js';
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
const validPassword = 'a safe tennis passphrase';

let database: DatabaseClient | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let emailSender: FakeEmailSender;
let testDatabaseVerified = false;

function getDatabase(): DatabaseClient {
  if (!database) throw new Error('Test database was not initialized.');
  return database;
}

function getApp(): ReturnType<typeof buildApp> {
  if (!app) throw new Error('Test app was not initialized.');
  return app;
}

function fixtureEmail(label: string): string {
  const email = `verification-${runId}-${label}@example.test`;
  fixtureEmails.push(email);
  return email;
}

function verify(token: string, remoteAddress: string, password = validPassword) {
  return getApp().inject({
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    remoteAddress,
    payload: { token, password },
  });
}

function resend(email: string, remoteAddress: string) {
  return getApp().inject({
    method: 'POST',
    url: '/api/v1/auth/resend-verification',
    remoteAddress,
    payload: { email },
  });
}

function tokenFromMessage(index = 0): string {
  const message = emailSender.messages[index];

  if (!message) throw new Error('Expected the fake sender to capture an email.');

  const href = /href="([^"]+)"/u.exec(message.html)?.[1];

  if (!href) throw new Error('Expected the verification email to contain a link.');

  const token = new URL(href).searchParams.get('token');

  if (!token) throw new Error('Expected the verification link to contain a token.');

  return token;
}

async function waitForAttempts(expected: number): Promise<void> {
  await vi.waitFor(() => {
    expect(emailSender.attempts).toBe(expected);
  });
}

async function signup(email: string, remoteAddress: string): Promise<string> {
  const previousAttempts = emailSender.attempts;
  const response = await getApp().inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress,
    payload: { email, password: validPassword },
  });

  expect(response.statusCode).toBe(202);
  await waitForAttempts(previousAttempts + 1);

  const messageIndex = emailSender.messages.findIndex((message) => message.to === email);

  if (messageIndex < 0) throw new Error('Expected the signup email to be captured.');

  return tokenFromMessage(messageIndex);
}

function expectRequestError(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  json<T>(): T;
}) {
  expect(response.statusCode).toBe(401);
  const body = response.json<ApiErrorResponse>();
  expect(body.error.code).toBe('REQUEST_ERROR');
  expect(body.requestId).toBe(response.headers['x-request-id']);
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

describe('POST /api/v1/auth/verify-email', () => {
  it('activates a pending account and invalidates every verification link', async () => {
    const email = fixtureEmail('success');
    const firstToken = await signup(email, '192.0.2.201');

    const resendResponse = await resend(email, '192.0.2.202');
    expect(resendResponse.statusCode).toBe(202);
    await waitForAttempts(2);
    const secondToken = tokenFromMessage(1);

    const response = await verify(firstToken, '192.0.2.203');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { status: 'verified' } });
    expect(response.body).not.toContain(firstToken);
    expect(response.body).not.toContain(validPassword);

    const user = await getDatabase().pool.query<{
      status: string;
      email_verified_at: Date | null;
    }>(
      `SELECT status, email_verified_at
       FROM identity_users
       WHERE normalized_email = $1`,
      [normalizeEmail(email)],
    );

    expect(user.rows[0]?.status).toBe('active');
    expect(user.rows[0]?.email_verified_at).toBeInstanceOf(Date);

    const tokens = await getDatabase().pool.query<{ consumed_at: Date | null }>(
      `SELECT tokens.consumed_at
       FROM identity_tokens AS tokens
       JOIN identity_users AS users ON users.id = tokens.user_id
       WHERE users.normalized_email = $1
         AND tokens.purpose = 'email_verification'`,
      [normalizeEmail(email)],
    );

    expect(tokens.rows.length).toBe(2);
    expect(tokens.rows.every((token) => token.consumed_at instanceof Date)).toBe(true);

    expectRequestError(await verify(secondToken, '192.0.2.204'));
  });

  it('rejects the wrong password without consuming the token or activating the account', async () => {
    const email = fixtureEmail('wrong-password');
    const token = await signup(email, '192.0.2.205');

    const response = await verify(token, '192.0.2.206', 'a different passphrase');

    expectRequestError(response);

    const result = await getDatabase().pool.query<{
      status: string;
      consumed_at: Date | null;
    }>(
      `SELECT users.status, tokens.consumed_at
       FROM identity_users AS users
       JOIN identity_tokens AS tokens ON tokens.user_id = users.id
       WHERE users.normalized_email = $1
         AND tokens.purpose = 'email_verification'`,
      [normalizeEmail(email)],
    );

    expect(result.rows[0]?.status).toBe('pending_verification');
    expect(result.rows[0]?.consumed_at).toBeNull();
  });

  it('rejects an unknown valid-format token', async () => {
    const token = generateEmailVerificationToken().rawToken;
    expectRequestError(await verify(token, '192.0.2.207'));
  });

  it('rejects an expired token', async () => {
    const email = fixtureEmail('expired');
    const token = await signup(email, '192.0.2.208');

    await getDatabase().pool.query(
      'UPDATE identity_tokens SET expires_at = $2 WHERE token_digest = $1',
      [digestIdentityToken(token), new Date(Date.now() - 1_000)],
    );

    expectRequestError(await verify(token, '192.0.2.209'));
  });

  it('allows only one of two concurrent submissions with the same link', async () => {
    const email = fixtureEmail('concurrent-same');
    const token = await signup(email, '192.0.2.210');

    const responses = await Promise.all([
      verify(token, '192.0.2.211'),
      verify(token, '192.0.2.211'),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
  });

  it('allows only one of two concurrent submissions using different links', async () => {
    const email = fixtureEmail('concurrent-different');
    const firstToken = await signup(email, '192.0.2.212');

    expect((await resend(email, '192.0.2.213')).statusCode).toBe(202);
    await waitForAttempts(2);
    const secondToken = tokenFromMessage(1);

    const responses = await Promise.all([
      verify(firstToken, '192.0.2.214'),
      verify(secondToken, '192.0.2.214'),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
  });
});

describe('POST /api/v1/auth/resend-verification', () => {
  it('returns the same accepted response when the per-email limit suppresses delivery', async () => {
    const email = fixtureEmail('email-limit');
    await signup(email, '192.0.2.220');
    const initialAttempts = emailSender.attempts;

    const resendAddresses = [email, email.toUpperCase(), email];

    for (const [index, address] of resendAddresses.entries()) {
      const response = await resend(address, `192.0.2.${221 + index}`);
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ data: { status: 'accepted' } });
      await waitForAttempts(initialAttempts + index + 1);
    }

    const limited = await resend(email.toUpperCase(), '192.0.2.224');
    expect(limited.statusCode).toBe(202);
    expect(limited.json()).toEqual({ data: { status: 'accepted' } });
    expect(emailSender.attempts).toBe(initialAttempts + 3);

    const tokenRows = await getDatabase().pool.query<{
      token_digest: string;
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT tokens.token_digest, tokens.created_at, tokens.expires_at
       FROM identity_tokens AS tokens
       JOIN identity_users AS users ON users.id = tokens.user_id
       WHERE users.normalized_email = $1
         AND tokens.purpose = 'email_verification'
       ORDER BY tokens.created_at`,
      [normalizeEmail(email)],
    );

    expect(tokenRows.rows).toHaveLength(4);
    expect(new Set(tokenRows.rows.map((row) => row.token_digest)).size).toBe(4);

    for (const row of tokenRows.rows) {
      expect(row.expires_at.getTime() - row.created_at.getTime()).toBeGreaterThanOrEqual(
        24 * 60 * 60 * 1000 - 1_000,
      );
    }
  });

  it('returns the same accepted response when the per-IP limit suppresses delivery', async () => {
    const emails: string[] = [];

    for (let index = 0; index < 6; index += 1) {
      const email = fixtureEmail(`ip-limit-${index}`);
      await signup(email, `192.0.2.${230 + index}`);
      emails.push(email);
    }

    emailSender.reset();

    for (const email of emails) {
      const response = await resend(email, '192.0.2.240');
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ data: { status: 'accepted' } });
    }

    await waitForAttempts(5);
    expect(emailSender.messages).toHaveLength(5);
  });

  it('keeps an earlier link usable when a resend delivery fails', async () => {
    const email = fixtureEmail('failed-resend');
    const earlierToken = await signup(email, '192.0.2.241');
    emailSender.failNextSend();

    const response = await resend(email, '192.0.2.242');

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ data: { status: 'accepted' } });
    await waitForAttempts(2);
    expect(emailSender.messages).toHaveLength(1);

    const verified = await verify(earlierToken, '192.0.2.243');
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ data: { status: 'verified' } });
  });
});
