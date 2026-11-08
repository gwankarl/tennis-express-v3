import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../../src/app.js';
import type { ApiErrorResponse } from '../../../../../src/http/contract.js';
import { identityUsers } from '../../../../../src/modules/identity/accounts/user.table.js';
import { normalizeEmail } from '../../../../../src/modules/identity/accounts/email-normalization.js';
import {
  hashPassword,
  verifyPassword,
} from '../../../../../src/modules/identity/passwords/credentials.js';
import { identityCredentials } from '../../../../../src/modules/identity/passwords/credentials.table.js';
import { identitySessions } from '../../../../../src/modules/identity/sessions/session.table.js';
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
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../../helpers/test-database.js';

const runId = randomUUID();
const fixtureUserIds: string[] = [];
const initialPassword = 'initial tennis passphrase';
const changedPassword = 'a changed tennis passphrase';

let database: DatabaseClient | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let databaseVerified = false;
let sequence = 0;

function getDatabase(): DatabaseClient {
  if (!database) throw new Error('Test database was not initialized.');
  return database;
}

function getApp(): ReturnType<typeof buildApp> {
  if (!app) throw new Error('Test app was not initialized.');
  return app;
}

async function createAccount(): Promise<{ id: string; email: string }> {
  sequence += 1;
  const email = `password-change-${runId}-${sequence}@example.test`;
  const users = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: normalizeEmail(email),
      status: 'active',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: identityUsers.id });
  const user = users[0];
  if (!user) throw new Error('Could not create the password-change test user.');
  fixtureUserIds.push(user.id);
  await getDatabase()
    .db.insert(identityCredentials)
    .values({
      userId: user.id,
      passwordHash: await hashPassword(initialPassword),
    });
  return { id: user.id, email };
}

function changePassword(
  token: string,
  currentPassword: string,
  newPassword: string,
  remoteAddress: string,
) {
  return getApp().inject({
    method: 'POST',
    url: '/api/v1/auth/change-password',
    remoteAddress,
    headers: { authorization: `Bearer ${token}` },
    payload: { currentPassword, newPassword },
  });
}

function expectRequestError(response: {
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

async function expectSessionValid(token: string): Promise<void> {
  const response = await getApp().inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  databaseVerified = true;
  app = buildApp({ database });
  await app.ready();
});

afterAll(async () => {
  try {
    if (database && databaseVerified && fixtureUserIds.length > 0) {
      await database.pool.query('DELETE FROM identity_users WHERE id = ANY($1::uuid[])', [
        fixtureUserIds,
      ]);
    }
  } finally {
    if (app) await app.close();
    else if (database) await database.close();
  }
});

describe('POST /api/v1/auth/change-password', () => {
  it('rejects a wrong current password and an invalid new password without revoking sessions', async () => {
    const user = await createAccount();
    const first = await createSession(getDatabase().db, user.id);
    const second = await createSession(getDatabase().db, user.id);
    if (!first || !second) throw new Error('Expected fixture sessions.');

    const wrongCurrent = await changePassword(
      first.rawToken,
      'not the current password',
      changedPassword,
      '192.0.2.201',
    );
    expect(wrongCurrent.statusCode).toBe(400);
    expect(wrongCurrent.json<ApiErrorResponse>().error.details).toEqual([
      { field: 'currentPassword', rule: 'incorrect' },
    ]);

    const invalidNew = await changePassword(
      first.rawToken,
      initialPassword,
      'fourteen chars',
      '192.0.2.202',
    );
    expect(invalidNew.statusCode).toBe(400);
    expect(invalidNew.json<ApiErrorResponse>().error.details).toEqual([
      { field: 'newPassword', rule: 'too_short' },
    ]);

    await expectSessionValid(first.rawToken);
    await expectSessionValid(second.rawToken);
  });

  it('changes the password atomically and revokes every session and outstanding reset link', async () => {
    const user = await createAccount();
    const first = await createSession(getDatabase().db, user.id);
    const second = await createSession(getDatabase().db, user.id);
    if (!first || !second) throw new Error('Expected fixture sessions.');

    const resetToken = generatePasswordRecoveryToken();
    await getDatabase()
      .db.insert(identityTokens)
      .values({
        userId: user.id,
        purpose: 'password_reset',
        tokenDigest: resetToken.digest,
        expiresAt: new Date(Date.now() + 60_000),
      });

    const response = await changePassword(
      first.rawToken,
      initialPassword,
      changedPassword,
      '192.0.2.203',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { status: 'changed' } });
    expect(response.body).not.toContain(initialPassword);
    expect(response.body).not.toContain(changedPassword);

    const tokenRows = await getDatabase()
      .db.select({ consumedAt: identityTokens.consumedAt })
      .from(identityTokens)
      .where(eq(identityTokens.tokenDigest, digestIdentityToken(resetToken.rawToken)))
      .limit(1);
    expect(tokenRows[0]?.consumedAt).toBeInstanceOf(Date);

    const sessions = await getDatabase()
      .db.select({ revokedAt: identitySessions.revokedAt })
      .from(identitySessions)
      .where(eq(identitySessions.userId, user.id));
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.revokedAt instanceof Date)).toBe(true);

    const firstRevoked = await getApp().inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${first.rawToken}` },
    });
    const secondRevoked = await getApp().inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${second.rawToken}` },
    });
    expectRequestError(firstRevoked);
    expectRequestError(secondRevoked);

    const oldLogin = await getApp().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '192.0.2.204',
      payload: { email: user.email, password: initialPassword },
    });
    expectRequestError(oldLogin);
    const newLogin = await getApp().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '192.0.2.205',
      payload: { email: user.email, password: changedPassword },
    });
    expect(newLogin.statusCode).toBe(200);
    const credential = await getDatabase()
      .db.select({ passwordHash: identityCredentials.passwordHash })
      .from(identityCredentials)
      .where(eq(identityCredentials.userId, user.id))
      .limit(1);
    expect(await verifyPassword(changedPassword, credential[0]!.passwordHash)).toBe(true);
  });

  it('rate-limits repeated attempts by IP', async () => {
    const user = await createAccount();
    const session = await createSession(getDatabase().db, user.id);
    if (!session) throw new Error('Expected a fixture session.');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await changePassword(
        session.rawToken,
        'incorrect current password',
        changedPassword,
        '192.0.2.206',
      );
      expect(response.statusCode).toBe(400);
    }
    const limited = await changePassword(
      session.rawToken,
      'incorrect current password',
      changedPassword,
      '192.0.2.206',
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.json<ApiErrorResponse>().requestId).toBe(limited.headers['x-request-id']);
    await expectSessionValid(session.rawToken);
  });

  it('does not leave a concurrent old-password login session valid after the change', async () => {
    const user = await createAccount();
    const session = await createSession(getDatabase().db, user.id);
    if (!session) throw new Error('Expected a fixture session.');

    const [changeResponse, loginResponse] = await Promise.all([
      changePassword(session.rawToken, initialPassword, changedPassword, '192.0.2.207'),
      getApp().inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '192.0.2.208',
        payload: { email: user.email, password: initialPassword },
      }),
    ]);

    expect(changeResponse.statusCode).toBe(200);
    if (loginResponse.statusCode === 200) {
      const racedToken = loginResponse.json<{ data: { sessionToken: string } }>().data.sessionToken;
      const racedSession = await getApp().inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${racedToken}` },
      });
      expectRequestError(racedSession);
    } else {
      expectRequestError(loginResponse);
    }
  });
});
