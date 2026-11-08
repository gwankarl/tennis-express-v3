import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../../../../../src/modules/identity/passwords/credentials.js';
import { identityCredentials } from '../../../../../src/modules/identity/passwords/credentials.table.js';
import { buildApp } from '../../../../../src/app.js';
import type { ApiErrorResponse } from '../../../../../src/http/contract.js';
import { requireAuthentication } from '../../../../../src/http/guards/authenticate.js';
import { digestIdentityToken } from '../../../../../src/modules/identity/token.js';
import {
  createSession,
  revokeAllSessionsForUser,
  revokeSession,
  validateSession,
} from '../../../../../src/modules/identity/sessions/session.service.js';
import { identitySessions } from '../../../../../src/modules/identity/sessions/session.table.js';
import { identityUsers } from '../../../../../src/modules/identity/accounts/user.table.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../../src/infrastructure/database/client.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../../helpers/test-database.js';

const runId = randomUUID();
const baseTime = new Date('2026-01-01T00:00:00.000Z');
const fixtureUserIds: string[] = [];
let userSequence = 0;

let database: DatabaseClient | undefined;
let app: FastifyInstance | undefined;
let testDatabaseVerified = false;

function getDatabase(): DatabaseClient {
  if (!database) throw new Error('Test database was not initialized.');
  return database;
}

function getApp(): FastifyInstance {
  if (!app) throw new Error('Test app was not initialized.');
  return app;
}

async function createUser(
  options: {
    status?: string;
    emailVerifiedAt?: Date | null;
    email?: string;
  } = {},
): Promise<string> {
  userSequence += 1;
  const email = options.email ?? `session-${runId}-${userSequence}@example.test`;

  const users = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: email,
      status: options.status ?? 'active',
      emailVerifiedAt: options.emailVerifiedAt === undefined ? baseTime : options.emailVerifiedAt,
    })
    .returning({ id: identityUsers.id });

  const user = users[0];

  if (!user) throw new Error('Could not create the session test user.');

  fixtureUserIds.push(user.id);
  return user.id;
}

async function createLoginUser(
  options: {
    status?: string;
    emailVerifiedAt?: Date | null;
    password?: string;
  } = {},
): Promise<{ userId: string; email: string; password: string }> {
  const password = options.password ?? 'correct horse battery staple';
  const email = `login-${runId}-${userSequence}@example.test`;
  const userId = await createUser({ ...options, email });
  const passwordHash = await hashPassword(password);

  await getDatabase().db.insert(identityCredentials).values({
    userId,
    passwordHash,
  });

  return { userId, email, password };
}

async function findSession(tokenDigest: string) {
  const result = await getDatabase().pool.query<{
    token_digest: string;
    user_id: string;
    last_seen_at: Date;
    idle_expires_at: Date;
    absolute_expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT token_digest, user_id, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
     FROM identity_sessions
     WHERE token_digest = $1`,
    [tokenDigest],
  );

  return result.rows[0];
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  app = buildApp({ database });
  app.get('/test-auth', { preHandler: requireAuthentication }, async (request) => ({
    data: { userId: request.identitySession?.userId },
  }));
  await app.ready();
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

describe('identity session service', () => {
  it('creates a digest-backed session with fixed deadlines', async () => {
    const userId = await createUser();
    const created = await createSession(getDatabase().db, userId, baseTime);

    expect(created).toBeDefined();
    if (!created) throw new Error('Expected session creation to succeed.');

    expect(created.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.absoluteExpiresAt.getTime()).toBe(baseTime.getTime() + 24 * 60 * 60 * 1000);

    const stored = await findSession(digestIdentityToken(created.rawToken));

    expect(stored?.token_digest).toBe(digestIdentityToken(created.rawToken));
    expect(stored?.token_digest).not.toBe(created.rawToken);
    expect(stored?.last_seen_at.getTime()).toBe(baseTime.getTime());
    expect(stored?.idle_expires_at.getTime()).toBe(baseTime.getTime() + 30 * 60 * 1000);
    expect(stored?.absolute_expires_at.getTime()).toBe(created.absoluteExpiresAt.getTime());
  });

  it('rejects an invalid token', async () => {
    expect(await validateSession(getDatabase().db, 'A'.repeat(43), baseTime)).toBeUndefined();
  });

  it('rejects activity at the idle expiry boundary without renewing it', async () => {
    const userId = await createUser();
    const created = await createSession(getDatabase().db, userId, baseTime);

    if (!created) throw new Error('Expected session creation to succeed.');

    const result = await validateSession(
      getDatabase().db,
      created.rawToken,
      new Date(baseTime.getTime() + 30 * 60 * 1000),
    );

    expect(result).toBeUndefined();
  });

  it('rejects a session that expires while waiting for the user lock', async () => {
    const userId = await createUser();
    const expiresAt = new Date(Date.now() + 500);
    const createdAt = new Date(expiresAt.getTime() - 30 * 60 * 1000);
    const created = await createSession(getDatabase().db, userId, createdAt);

    if (!created) throw new Error('Expected session creation to succeed.');

    const lockClient = await getDatabase().pool.connect();
    let validation: ReturnType<typeof validateSession> | undefined;

    try {
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT id FROM identity_users WHERE id = $1 FOR UPDATE', [userId]);

      validation = validateSession(getDatabase().db, created.rawToken);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await lockClient.query('COMMIT');
      expect(await validation).toBeUndefined();
    } finally {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      lockClient.release();
    }
  });

  it('does not renew an expired session under concurrent activity', async () => {
    const userId = await createUser();
    const created = await createSession(getDatabase().db, userId, baseTime);

    if (!created) throw new Error('Expected session creation to succeed.');

    const expiryTime = new Date(baseTime.getTime() + 30 * 60 * 1000);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        validateSession(getDatabase().db, created.rawToken, expiryTime),
      ),
    );

    expect(results).toEqual([undefined, undefined, undefined, undefined]);

    const stored = await findSession(digestIdentityToken(created.rawToken));
    expect(stored?.last_seen_at.getTime()).toBe(baseTime.getTime());
    expect(stored?.idle_expires_at.getTime()).toBe(expiryTime.getTime());
  });

  it('renews idle expiry on valid activity without moving the absolute deadline', async () => {
    const userId = await createUser();
    const created = await createSession(getDatabase().db, userId, baseTime);

    if (!created) throw new Error('Expected session creation to succeed.');

    const activityTime = new Date(baseTime.getTime() + 10 * 60 * 1000);
    expect(await validateSession(getDatabase().db, created.rawToken, activityTime)).toEqual({
      sessionId: created.sessionId,
      userId,
    });

    const stored = await findSession(digestIdentityToken(created.rawToken));

    expect(stored?.last_seen_at.getTime()).toBe(activityTime.getTime());
    expect(stored?.idle_expires_at.getTime()).toBe(activityTime.getTime() + 30 * 60 * 1000);
    expect(stored?.absolute_expires_at.getTime()).toBe(created.absoluteExpiresAt.getTime());
  });

  it('does not extend beyond the absolute expiry and rejects at that exact boundary', async () => {
    const userId = await createUser();
    const created = await createSession(getDatabase().db, userId, baseTime);

    if (!created) throw new Error('Expected session creation to succeed.');

    const digest = digestIdentityToken(created.rawToken);

    // Place idle expiry at the absolute deadline to model repeated valid activity.
    await getDatabase()
      .db.update(identitySessions)
      .set({ idleExpiresAt: created.absoluteExpiresAt })
      .where(eq(identitySessions.id, created.sessionId));

    const justBeforeDeadline = new Date(created.absoluteExpiresAt.getTime() - 1);
    expect(
      await validateSession(getDatabase().db, created.rawToken, justBeforeDeadline),
    ).toBeDefined();

    const atDeadline = await validateSession(
      getDatabase().db,
      created.rawToken,
      created.absoluteExpiresAt,
    );
    expect(atDeadline).toBeUndefined();

    const stored = await findSession(digest);
    expect(stored?.absolute_expires_at.getTime()).toBe(created.absoluteExpiresAt.getTime());
    expect(stored?.idle_expires_at.getTime()).toBe(created.absoluteExpiresAt.getTime());
  });

  it('rejects revoked sessions and revokes only the selected session', async () => {
    const userId = await createUser();
    const first = await createSession(getDatabase().db, userId, baseTime);
    const second = await createSession(getDatabase().db, userId, baseTime);

    if (!first || !second) throw new Error('Expected session creation to succeed.');

    expect(await revokeSession(getDatabase().db, userId, first.sessionId, baseTime)).toBe(true);
    expect(await validateSession(getDatabase().db, first.rawToken, baseTime)).toBeUndefined();
    expect(await validateSession(getDatabase().db, second.rawToken, baseTime)).toBeDefined();
  });

  it('does not revive a session when activity races with revocation', async () => {
    const userId = await createUser();
    const created = await createSession(getDatabase().db, userId, baseTime);

    if (!created) throw new Error('Expected session creation to succeed.');

    const activityTime = new Date(baseTime.getTime() + 5 * 60 * 1000);
    const [, revoked] = await Promise.all([
      validateSession(getDatabase().db, created.rawToken, activityTime),
      revokeSession(getDatabase().db, userId, created.sessionId, activityTime),
    ]);

    expect(revoked).toBe(true);
    expect(await validateSession(getDatabase().db, created.rawToken, activityTime)).toBeUndefined();

    const stored = await findSession(digestIdentityToken(created.rawToken));
    expect(stored?.revoked_at?.getTime()).toBe(activityTime.getTime());
  });

  it('revokes every session through a caller-owned transaction', async () => {
    const userId = await createUser();
    const first = await createSession(getDatabase().db, userId, baseTime);
    const second = await createSession(getDatabase().db, userId, baseTime);

    if (!first || !second) throw new Error('Expected session creation to succeed.');

    await getDatabase().db.transaction(async (transaction) => {
      await revokeAllSessionsForUser(transaction, userId, baseTime);
    });

    expect(await validateSession(getDatabase().db, first.rawToken, baseTime)).toBeUndefined();
    expect(await validateSession(getDatabase().db, second.rawToken, baseTime)).toBeUndefined();
  });

  it.each([
    ['unverified', 'active', null],
    ['suspended', 'suspended', baseTime],
  ] as const)(
    'rejects an existing session for an %s account',
    async (_label, status, verifiedAt) => {
      const userId = await createUser();
      const created = await createSession(getDatabase().db, userId, baseTime);

      if (!created) throw new Error('Expected session creation to succeed.');

      await getDatabase()
        .db.update(identityUsers)
        .set({ status, emailVerifiedAt: verifiedAt })
        .where(eq(identityUsers.id, userId));

      expect(await validateSession(getDatabase().db, created.rawToken, baseTime)).toBeUndefined();
    },
  );

  it('does not create sessions for unverified or suspended accounts', async () => {
    const unverifiedUserId = await createUser({ emailVerifiedAt: null });
    const suspendedUserId = await createUser({ status: 'suspended' });

    expect(await createSession(getDatabase().db, unverifiedUserId, baseTime)).toBeUndefined();
    expect(await createSession(getDatabase().db, suspendedUserId, baseTime)).toBeUndefined();
  });
});

describe('Fastify authentication guard', () => {
  it('returns the shared generic 401 for missing and invalid bearer credentials', async () => {
    const missing = await getApp().inject({ method: 'GET', url: '/test-auth' });
    const invalid = await getApp().inject({
      method: 'GET',
      url: '/test-auth',
      headers: { authorization: `Bearer ${'A'.repeat(43)}` },
    });

    for (const response of [missing, invalid]) {
      expect(response.statusCode).toBe(401);
      const body = response.json<ApiErrorResponse>();
      expect(body.error.code).toBe('REQUEST_ERROR');
      expect(body.requestId).toBe(response.headers['x-request-id']);
    }
  });

  it('attaches only the validated user/session context to the request', async () => {
    const userId = await createUser();
    // The HTTP guard uses the real clock, so this credential must also be current.
    const created = await createSession(getDatabase().db, userId);

    if (!created) throw new Error('Expected session creation to succeed.');

    const response = await getApp().inject({
      method: 'GET',
      url: '/test-auth',
      headers: { authorization: `Bearer ${created.rawToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { userId } });
    expect(response.body).not.toContain(created.rawToken);
    expect(response.body).not.toContain('tokenDigest');
  });

  it('reports a restricted account without exposing the reason and still permits logout', async () => {
    const userId = await createUser();
    const created = await createSession(getDatabase().db, userId);

    if (!created) throw new Error('Expected session creation to succeed.');

    await getDatabase()
      .db.update(identityUsers)
      .set({ status: 'suspended' })
      .where(eq(identityUsers.id, userId));

    const headers = { authorization: `Bearer ${created.rawToken}` };
    const restrictedResponses = await Promise.all([
      getApp().inject({ method: 'GET', url: '/test-auth', headers }),
      getApp().inject({ method: 'GET', url: '/api/v1/auth/me', headers }),
      getApp().inject({ method: 'GET', url: '/api/v1/me/profile', headers }),
      getApp().inject({ method: 'GET', url: '/api/v1/me/workspaces', headers }),
    ]);

    for (const response of restrictedResponses) {
      expect(response.statusCode).toBe(403);
      const body = response.json<ApiErrorResponse>();
      expect(body.error.code).toBe('ACCOUNT_RESTRICTED');
      expect(body.error.message).toBe('Account access is restricted');
      expect(body.requestId).toBe(response.headers['x-request-id']);
      expect(response.body).not.toContain('suspended');
    }

    const logout = await getApp().inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers,
    });

    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ data: { status: 'logged_out' } });
    expect(await validateSession(getDatabase().db, created.rawToken)).toBeUndefined();
  });
});

describe('identity login and session routes', () => {
  it('logs in, reads /me, logs out only that session, and preserves a second session', async () => {
    const fixture = await createLoginUser();
    const secondSession = await createSession(getDatabase().db, fixture.userId);

    if (!secondSession) throw new Error('Expected the second session to be created.');

    const loginResponse = await getApp().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '192.0.2.201',
      payload: { email: fixture.email.toUpperCase(), password: fixture.password },
    });

    expect(loginResponse.statusCode).toBe(200);
    expect(loginResponse.headers['cache-control']).toContain('no-store');

    const loginBody = loginResponse.json<{
      data: { sessionToken: string; tokenType: 'Bearer'; expiresAt: string };
    }>();
    expect(loginBody.data.tokenType).toBe('Bearer');
    expect(loginBody.data.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(loginBody.data.expiresAt).toBeTruthy();

    const meResponse = await getApp().inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${loginBody.data.sessionToken}` },
    });

    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json()).toEqual({
      data: { id: fixture.userId, email: fixture.email },
    });

    const logoutResponse = await getApp().inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${loginBody.data.sessionToken}` },
    });

    expect(logoutResponse.statusCode).toBe(200);
    expect(logoutResponse.json()).toEqual({ data: { status: 'logged_out' } });

    const revokedSessionResponse = await getApp().inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${loginBody.data.sessionToken}` },
    });
    const secondSessionResponse = await getApp().inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${secondSession.rawToken}` },
    });

    expect(revokedSessionResponse.statusCode).toBe(401);
    expect(secondSessionResponse.statusCode).toBe(200);
  });

  it.each([
    ['wrong password', 'active', baseTime, 'incorrect password'],
    ['unverified account', 'active', null, 'correct horse battery staple'],
    ['suspended account', 'suspended', baseTime, 'correct horse battery staple'],
  ])('returns the same generic 401 for %s', async (_case, status, verifiedAt, password) => {
    const fixture = await createLoginUser({
      status: status as string,
      emailVerifiedAt: verifiedAt as Date | null,
    });

    const response = await getApp().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: `192.0.2.${210 + userSequence}`,
      payload: { email: fixture.email, password },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    });
    expect(response.json().requestId).toBe(response.headers['x-request-id']);
    expect(response.body).not.toContain(fixture.password);
  });

  it('returns the same generic 401 for an unknown email', async () => {
    const response = await getApp().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '192.0.2.230',
      payload: {
        email: `unknown-${runId}@example.test`,
        password: 'correct horse battery staple',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    });
    expect(response.json().requestId).toBe(response.headers['x-request-id']);
  });

  it('rate-limits login attempts by IP before password verification', async () => {
    const fixture = await createLoginUser();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await getApp().inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '192.0.2.240',
        payload: { email: fixture.email, password: 'wrong password' },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await getApp().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '192.0.2.240',
      payload: { email: fixture.email, password: 'wrong password' },
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('REQUEST_ERROR');
  });
});
