import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  hashPassword,
  verifyPassword,
} from '../../../../../src/modules/identity/passwords/credentials.js';
import { identityCredentials } from '../../../../../src/modules/identity/passwords/credentials.table.js';
import { buildApp } from '../../../../../src/app.js';
import type { ApiErrorResponse } from '../../../../../src/http/contract.js';
import { identityUsers } from '../../../../../src/modules/identity/accounts/user.table.js';
import { normalizeEmail } from '../../../../../src/modules/identity/accounts/email-normalization.js';
import { createSession } from '../../../../../src/modules/identity/sessions/session.service.js';
import {
  digestIdentityToken,
  generatePasswordRecoveryToken,
} from '../../../../../src/modules/identity/token.js';
import { identityTokens } from '../../../../../src/modules/identity/token.table.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../../src/infrastructure/database/client.js';
import { FakeEmailSender } from '../../../../helpers/fake-email-sender.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../../helpers/test-database.js';

const { passwordHashCompletedHook } = vi.hoisted(() => ({
  passwordHashCompletedHook: {
    run: undefined as (() => Promise<void>) | undefined,
  },
}));

vi.mock('../../../../../src/modules/identity/passwords/credentials.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../../src/modules/identity/passwords/credentials.js')
    >();

  return {
    ...actual,
    hashPassword: async (password: string) => {
      const hash = await actual.hashPassword(password);
      await passwordHashCompletedHook.run?.();
      return hash;
    },
  };
});

const runId = randomUUID();
const fixtureUserIds: string[] = [];
const initialPassword = 'initial tennis passphrase';
const replacementPassword = 'replacement tennis passphrase';

let database: DatabaseClient | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let emailSender: FakeEmailSender;
let testDatabaseVerified = false;
let accountSequence = 0;

function getDatabase(): DatabaseClient {
  if (!database) throw new Error('Test database was not initialized.');
  return database;
}

function getApp(): ReturnType<typeof buildApp> {
  if (!app) throw new Error('Test app was not initialized.');
  return app;
}

async function createAccount(
  options: {
    status?: string;
    emailVerifiedAt?: Date | null;
  } = {},
): Promise<{ id: string; email: string }> {
  accountSequence += 1;
  const email = `password-reset-${runId}-${accountSequence}@example.test`;
  const users = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: normalizeEmail(email),
      status: options.status ?? 'active',
      emailVerifiedAt: options.emailVerifiedAt === undefined ? new Date() : options.emailVerifiedAt,
    })
    .returning({ id: identityUsers.id });
  const user = users[0];
  if (!user) throw new Error('Could not create the password-reset test user.');
  fixtureUserIds.push(user.id);

  await getDatabase()
    .db.insert(identityCredentials)
    .values({
      userId: user.id,
      passwordHash: await hashPassword(initialPassword),
    });

  return { id: user.id, email };
}

function forgot(email: string, remoteAddress: string) {
  return getApp().inject({
    method: 'POST',
    url: '/api/v1/auth/forgot-password',
    remoteAddress,
    payload: { email },
  });
}

function reset(token: string, password: string, remoteAddress: string) {
  return getApp().inject({
    method: 'POST',
    url: '/api/v1/auth/reset-password',
    remoteAddress,
    payload: { token, password },
  });
}

function tokenFromMessage(index = 0): string {
  const message = emailSender.messages[index];
  if (!message) throw new Error('Expected the fake sender to capture a reset email.');

  const href = /href="([^"]+)"/u.exec(message.html)?.[1];
  if (!href) throw new Error('Expected the reset email to contain a link.');

  const token = new URL(href).searchParams.get('token');
  if (!token) throw new Error('Expected the reset link to contain a token.');
  return token;
}

async function waitForAttempts(expected: number): Promise<void> {
  await vi.waitFor(() => expect(emailSender.attempts).toBe(expected));
}

async function requestResetLink(email: string, remoteAddress: string): Promise<string> {
  const attemptsBefore = emailSender.attempts;
  const response = await forgot(email, remoteAddress);
  expect(response.statusCode).toBe(202);
  expect(response.json()).toEqual({ data: { status: 'accepted' } });
  await waitForAttempts(attemptsBefore + 1);
  const messageIndex = emailSender.messages.findIndex((message) => message.to === email);
  if (messageIndex < 0) throw new Error('Expected a reset email for the fixture account.');
  return tokenFromMessage(messageIndex);
}

function expectGenericRequestError(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  json<T>(): T;
}): void {
  expect(response.statusCode).toBe(401);
  const body = response.json<ApiErrorResponse>();
  expect(body.error.code).toBe('REQUEST_ERROR');
  expect(body.error.message).toBe('Request failed');
  expect(body.requestId).toBe(response.headers['x-request-id']);
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  emailSender = new FakeEmailSender();
  app = buildApp({ database, emailSender, frontendOrigin: 'http://127.0.0.1:5173' });
  await app.ready();
});

beforeEach(() => {
  emailSender.reset();
});

afterAll(async () => {
  try {
    if (database && testDatabaseVerified && fixtureUserIds.length > 0) {
      await database.pool.query('DELETE FROM identity_users WHERE id = ANY($1::uuid[])', [
        fixtureUserIds,
      ]);
    }
  } finally {
    if (app) {
      await app.close();
    } else if (database) {
      await database.close();
    }
  }
});

describe('POST /api/v1/auth/forgot-password', () => {
  it('returns the same accepted response for eligible, unknown, ineligible, and failed delivery cases', async () => {
    const active = await createAccount();
    const unverified = await createAccount({ emailVerifiedAt: null });
    const suspended = await createAccount({ status: 'suspended' });
    emailSender.failNextSend();

    const activeResponse = await forgot(active.email.toUpperCase(), '192.0.2.31');
    const unknownResponse = await forgot(`missing-${runId}@example.test`, '192.0.2.32');
    const unverifiedResponse = await forgot(unverified.email, '192.0.2.33');
    const suspendedResponse = await forgot(suspended.email, '192.0.2.34');

    for (const response of [
      activeResponse,
      unknownResponse,
      unverifiedResponse,
      suspendedResponse,
    ]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ data: { status: 'accepted' } });
      expect(response.body).not.toContain(active.email);
      expect(response.body).not.toContain('token');
    }

    await waitForAttempts(1);
    expect(emailSender.messages).toHaveLength(0);
  });

  it('returns before SMTP delivery finishes', async () => {
    const account = await createAccount();
    const releaseSend = emailSender.holdNextSend();

    try {
      const response = await forgot(account.email, '192.0.2.35');
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ data: { status: 'accepted' } });
      await waitForAttempts(1);
    } finally {
      releaseSend();
    }
    await vi.waitFor(() => expect(emailSender.messages).toHaveLength(1));
  });

  it('keeps valid requests generic when the IP or normalized-email limit is reached', async () => {
    const ipLimitedAccounts = await Promise.all(Array.from({ length: 6 }, () => createAccount()));
    const ipResponses = await Promise.all(
      ipLimitedAccounts.map((account) => forgot(account.email, '192.0.2.36')),
    );

    expect(ipResponses.map((response) => response.statusCode)).toEqual([
      202, 202, 202, 202, 202, 202,
    ]);
    expect(ipResponses.every((response) => response.json().data.status === 'accepted')).toBe(true);
    await waitForAttempts(5);

    const emailLimitedAccount = await createAccount();
    const priorAttempts = emailSender.attempts;
    const emailResponses = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        forgot(emailLimitedAccount.email.toUpperCase(), `192.0.2.${40 + index}`),
      ),
    );

    expect(emailResponses.map((response) => response.statusCode)).toEqual([202, 202, 202, 202]);
    expect(emailResponses.every((response) => response.json().data.status === 'accepted')).toBe(
      true,
    );
    await waitForAttempts(priorAttempts + 3);
  });
});

describe('POST /api/v1/auth/reset-password', () => {
  it('rejects unknown and expired tokens with the same generic error', async () => {
    const account = await createAccount();
    const expiredToken = generatePasswordRecoveryToken();
    await getDatabase()
      .db.insert(identityTokens)
      .values({
        userId: account.id,
        purpose: 'password_reset',
        tokenDigest: expiredToken.digest,
        expiresAt: new Date(Date.now() - 1000),
      });

    const invalid = await reset('A'.repeat(43), replacementPassword, '192.0.2.51');
    const expired = await reset(expiredToken.rawToken, replacementPassword, '192.0.2.52');

    expectGenericRequestError(invalid);
    expectGenericRequestError(expired);
    expect(invalid.body).not.toContain(expiredToken.rawToken);
  });

  it('rejects a reset token that expires while the new password is being hashed', async () => {
    const account = await createAccount();
    const token = await requestResetLink(account.email, '192.0.2.69');
    const expiresAt = new Date(Date.now() + 2_000);
    let hashCompleted = false;

    await getDatabase().pool.query(
      'UPDATE identity_tokens SET expires_at = $2 WHERE token_digest = $1',
      [digestIdentityToken(token), expiresAt],
    );

    passwordHashCompletedHook.run = async () => {
      hashCompleted = true;
      const delay = Math.max(0, expiresAt.getTime() + 50 - Date.now());
      await new Promise((resolve) => setTimeout(resolve, delay));
    };

    let response: Awaited<ReturnType<typeof reset>> | undefined;
    try {
      response = await reset(token, replacementPassword, '192.0.2.70');
    } finally {
      passwordHashCompletedHook.run = undefined;
    }

    expect(hashCompleted).toBe(true);
    if (!response) throw new Error('Expected the reset request to return a response.');
    expectGenericRequestError(response);

    const credential = await getDatabase()
      .db.select({ passwordHash: identityCredentials.passwordHash })
      .from(identityCredentials)
      .where(eq(identityCredentials.userId, account.id))
      .limit(1);

    expect(await verifyPassword(initialPassword, credential[0]!.passwordHash)).toBe(true);
  });

  it('requires the shared password policy without consuming a valid reset link', async () => {
    const account = await createAccount();
    const token = await requestResetLink(account.email, '192.0.2.53');

    const invalidPassword = await reset(token, 'fourteen chars', '192.0.2.54');
    expect(invalidPassword.statusCode).toBe(400);
    expect(invalidPassword.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');

    const validPassword = 'a valid replacement passphrase';
    const success = await reset(token, validPassword, '192.0.2.55');
    expect(success.statusCode).toBe(200);
    expect(success.json()).toEqual({ data: { status: 'reset' } });
  });

  it('updates the credential, revokes sessions, rejects the old password, and accepts the new one', async () => {
    const account = await createAccount();
    const session = await createSession(getDatabase().db, account.id);
    if (!session) throw new Error('Expected the fixture account session to be created.');

    const token = await requestResetLink(account.email, '192.0.2.56');
    const response = await reset(token, replacementPassword, '192.0.2.57');

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain(replacementPassword);

    const oldSessionResponse = await getApp().inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${session.rawToken}` },
    });
    expectGenericRequestError(oldSessionResponse);

    const oldPasswordLogin = await getApp().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '192.0.2.58',
      payload: { email: account.email, password: initialPassword },
    });
    expectGenericRequestError(oldPasswordLogin);

    const newPasswordLogin = await getApp().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '192.0.2.59',
      payload: { email: account.email, password: replacementPassword },
    });
    expect(newPasswordLogin.statusCode).toBe(200);
    expect(newPasswordLogin.json().data.sessionToken).toBeTruthy();

    const credential = await getDatabase()
      .db.select({ passwordHash: identityCredentials.passwordHash })
      .from(identityCredentials)
      .where(eq(identityCredentials.userId, account.id))
      .limit(1);
    expect(await verifyPassword(replacementPassword, credential[0]!.passwordHash)).toBe(true);

    const reused = await reset(token, 'another valid password phrase', '192.0.2.60');
    expectGenericRequestError(reused);
  });

  it('allows at most one concurrent submission of the same reset token', async () => {
    const account = await createAccount();
    const token = await requestResetLink(account.email, '192.0.2.61');

    const results = await Promise.all([
      reset(token, 'first concurrent replacement password', '192.0.2.62'),
      reset(token, 'second concurrent replacement password', '192.0.2.63'),
    ]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    const winningPassword =
      results[0]?.statusCode === 200
        ? 'first concurrent replacement password'
        : 'second concurrent replacement password';
    const credential = await getDatabase()
      .db.select({ passwordHash: identityCredentials.passwordHash })
      .from(identityCredentials)
      .where(eq(identityCredentials.userId, account.id))
      .limit(1);
    expect(await verifyPassword(winningPassword, credential[0]!.passwordHash)).toBe(true);
  });

  it('invalidates other outstanding reset links after one succeeds', async () => {
    const account = await createAccount();
    const firstToken = await requestResetLink(account.email, '192.0.2.64');
    const secondToken = await requestResetLink(account.email, '192.0.2.65');

    const results = await Promise.all([
      reset(firstToken, 'first link replacement password', '192.0.2.66'),
      reset(secondToken, 'second link replacement password', '192.0.2.67'),
    ]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 401]);
  });

  it('rate-limits reset token attempts by IP', async () => {
    const unknownToken = 'Z'.repeat(43);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await reset(unknownToken, replacementPassword, '192.0.2.68');
      expectGenericRequestError(response);
    }

    const limited = await reset(unknownToken, replacementPassword, '192.0.2.68');
    expect(limited.statusCode).toBe(429);
    expect(limited.json<ApiErrorResponse>().error.code).toBe('REQUEST_ERROR');
    expect(limited.json<ApiErrorResponse>().requestId).toBe(limited.headers['x-request-id']);
  });
});
