import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse } from '../../../../../src/http/contract.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../../src/infrastructure/database/client.js';
import { buildApp } from '../../../../../src/app.js';
import { identityUsers } from '../../../../../src/modules/identity/accounts/user.table.js';
import { createSession } from '../../../../../src/modules/identity/sessions/session.service.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../../helpers/test-database.js';

const runId = randomUUID();
const fixtureUserIds: string[] = [];
let sequence = 0;

let database: DatabaseClient | undefined;
let app: FastifyInstance | undefined;
let testDatabaseVerified = false;

interface ProfileData {
  id: string;
  displayName: string | null;
  email: string;
  emailVerifiedAt: string;
}

function getDatabase(): DatabaseClient {
  if (!database) {
    throw new Error('Test database was not initialized.');
  }

  return database;
}

function getApp(): FastifyInstance {
  if (!app) {
    throw new Error('Test app was not initialized.');
  }

  return app;
}

async function createUser(options: { status?: string } = {}): Promise<{
  id: string;
  email: string;
}> {
  sequence += 1;
  const email = `profile-${runId}-${sequence}@example.test`;

  const users = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: email,
      status: options.status ?? 'active',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning({ id: identityUsers.id });

  const user = users[0];

  if (!user) {
    throw new Error('Could not create the profile test user.');
  }

  fixtureUserIds.push(user.id);
  return { id: user.id, email };
}

async function createAuthenticatedUser(options: { status?: string } = {}): Promise<{
  id: string;
  email: string;
  token: string;
}> {
  const user = await createUser(options);
  const session = await createSession(getDatabase().db, user.id);

  if (!session) {
    throw new Error('Could not create the profile test session.');
  }

  return { ...user, token: session.rawToken };
}

function getProfile(token?: string) {
  return getApp().inject({
    method: 'GET',
    url: '/api/v1/me/profile',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}

function patchProfile(token: string, payload: Record<string, unknown>) {
  return getApp().inject({
    method: 'PATCH',
    url: '/api/v1/me/profile',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function expectUnauthorized(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  json<T>(): T;
}): void {
  expect(response.statusCode).toBe(401);

  const body = response.json<ApiErrorResponse>();
  expect(body.error.code).toBe('REQUEST_ERROR');
  expect(body.requestId).toBe(response.headers['x-request-id']);
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  app = buildApp({ database });
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

describe('GET and PATCH /api/v1/me/profile', () => {
  it('returns an unset display name and the authenticated profile fields', async () => {
    const user = await createAuthenticatedUser();
    const response = await getProfile(user.token);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: ProfileData }>().data).toEqual({
      id: user.id,
      displayName: null,
      email: user.email,
      emailVerifiedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('trims and persists the display name without changing another user profile', async () => {
    const first = await createAuthenticatedUser();
    const second = await createAuthenticatedUser();

    const updated = await patchProfile(first.token, { displayName: '  First Player  ' });

    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ data: ProfileData }>().data).toMatchObject({
      id: first.id,
      displayName: 'First Player',
      email: first.email,
    });

    const firstRead = await getProfile(first.token);
    const secondRead = await getProfile(second.token);

    expect(firstRead.json<{ data: ProfileData }>().data.displayName).toBe('First Player');
    expect(secondRead.json<{ data: ProfileData }>().data).toMatchObject({
      id: second.id,
      displayName: null,
      email: second.email,
    });
  });

  it('rejects empty, null, blank, overlong, and unexpected update fields', async () => {
    const user = await createAuthenticatedUser();
    const payloads: Array<Record<string, unknown>> = [
      {},
      { displayName: null },
      { displayName: '   ' },
      { displayName: 'x'.repeat(101) },
      { displayName: 'Attempted change', id: user.id },
      { displayName: 'Attempted change', email: 'other@example.test' },
      { displayName: 'Attempted change', permissions: ['administrator'] },
    ];

    for (const payload of payloads) {
      const response = await patchProfile(user.token, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
    }

    const unchanged = await getProfile(user.token);
    expect(unchanged.json<{ data: ProfileData }>().data.displayName).toBeNull();
  });

  it('rejects missing and invalid sessions', async () => {
    const missingSession = await getProfile();
    expectUnauthorized(missingSession);

    const invalidSession = await getProfile('a'.repeat(43));
    expectUnauthorized(invalidSession);
  });

  it('rejects a session after its account becomes ineligible', async () => {
    const user = await createAuthenticatedUser();

    await getDatabase()
      .db.update(identityUsers)
      .set({ status: 'suspended' })
      .where(eq(identityUsers.id, user.id));

    expectUnauthorized(await getProfile(user.token));
  });
});
