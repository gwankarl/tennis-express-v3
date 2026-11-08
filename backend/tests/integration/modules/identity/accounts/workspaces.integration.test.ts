import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse } from '../../../../../src/http/contract.js';
import {
  requireWorkspaceAccess,
  type SellerWorkspaceFacts,
  type WorkspaceAuthorizationSources,
} from '../../../../../src/http/guards/authorize-workspace.js';
import { buildApp } from '../../../../../src/app.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../../src/infrastructure/database/client.js';
import { identityUserPermissions } from '../../../../../src/modules/identity/accounts/permission.table.js';
import { identityUsers } from '../../../../../src/modules/identity/accounts/user.table.js';
import { createSession } from '../../../../../src/modules/identity/sessions/session.service.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../../helpers/test-database.js';

const runId = randomUUID();
const fixtureUserIds: string[] = [];
const sellerFactsByUser = new Map<string, SellerWorkspaceFacts>();
const mfaElevatedSessionIds = new Set<string>();

let database: DatabaseClient | undefined;
let app: FastifyInstance | undefined;
let testDatabaseVerified = false;
let userSequence = 0;

interface AuthenticatedFixture {
  userId: string;
  token: string;
  sessionId: string;
}

interface WorkspacesResponse {
  data: {
    defaultWorkspace: 'buyer';
    availableWorkspaces: {
      buyer: true;
      seller: boolean;
    };
    sellerApplicationStatus: 'not_applied' | 'pending' | 'approved' | 'rejected' | null;
    adminEntryState: 'unavailable' | 'mfa_required' | 'available';
  };
}

const fixtureSources: WorkspaceAuthorizationSources = {
  async getSellerWorkspaceFacts(userId) {
    return sellerFactsByUser.get(userId);
  },
  async isSessionMfaElevated(sessionId) {
    return mfaElevatedSessionIds.has(sessionId);
  },
};

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

async function createAuthenticatedFixture(): Promise<AuthenticatedFixture> {
  userSequence += 1;
  const email = `workspaces-${runId}-${userSequence}@example.test`;

  const users = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: email,
      status: 'active',
      emailVerifiedAt: new Date(),
    })
    .returning({ userId: identityUsers.id });

  const user = users[0];

  if (!user) {
    throw new Error('Could not create the workspace test user.');
  }

  fixtureUserIds.push(user.userId);

  const session = await createSession(getDatabase().db, user.userId);

  if (!session) {
    throw new Error('Could not create the workspace test session.');
  }

  return {
    userId: user.userId,
    token: session.rawToken,
    sessionId: session.sessionId,
  };
}

async function grantAdministrator(userId: string): Promise<void> {
  await getDatabase().db.insert(identityUserPermissions).values({
    userId,
    permission: 'administrator',
  });
}

function requestWorkspaces(token?: string) {
  return getApp().inject({
    method: 'GET',
    url: '/api/v1/me/workspaces',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}

function requestTestSellerRoute(token: string) {
  return getApp().inject({
    method: 'GET',
    url: '/__test/api/v1/seller',
    headers: { authorization: `Bearer ${token}` },
  });
}

function requestTestAdminRoute(token: string) {
  return getApp().inject({
    method: 'GET',
    url: '/__test/api/v1/admin',
    headers: { authorization: `Bearer ${token}` },
  });
}

function expectError(
  response: {
    statusCode: number;
    headers: Record<string, unknown>;
    json<T>(): T;
  },
  statusCode: 401 | 403,
): void {
  expect(response.statusCode).toBe(statusCode);

  const body = response.json<ApiErrorResponse>();
  expect(body.error.code).toBe('REQUEST_ERROR');
  expect(body.error.message).toBe('Request failed');
  expect(body.requestId).toBe(response.headers['x-request-id']);
}

async function expectAvailability(
  token: string,
  expected: WorkspacesResponse['data'],
): Promise<void> {
  const response = await requestWorkspaces(token);

  expect(response.statusCode).toBe(200);
  expect(response.json<WorkspacesResponse>().data).toEqual(expected);
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  app = buildApp({
    database,
    workspaceAuthorizationSources: fixtureSources,
  });

  app.get(
    '/__test/api/v1/seller',
    { preHandler: requireWorkspaceAccess('seller', fixtureSources) },
    async (request) => ({ data: { userId: request.identitySession?.userId } }),
  );

  app.get(
    '/__test/api/v1/admin',
    { preHandler: requireWorkspaceAccess('admin', fixtureSources) },
    async (request) => ({ data: { userId: request.identitySession?.userId } }),
  );

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
    sellerFactsByUser.clear();
    mfaElevatedSessionIds.clear();

    if (app) {
      await app.close();
    } else if (database) {
      await database.close();
    }
  }
});

describe('GET /api/v1/me/workspaces', () => {
  it('rejects unauthenticated requests with the shared error and request ID', async () => {
    expectError(await requestWorkspaces(), 401);
  });

  it('returns Buyer as the default when no seller or admin source grants access', async () => {
    const fixture = await createAuthenticatedFixture();

    await expectAvailability(fixture.token, {
      defaultWorkspace: 'buyer',
      availableWorkspaces: { buyer: true, seller: false },
      sellerApplicationStatus: null,
      adminEntryState: 'unavailable',
    });
  });

  it('keeps Buyer available while a seller application is pending', async () => {
    const fixture = await createAuthenticatedFixture();
    sellerFactsByUser.set(fixture.userId, {
      applicationStatus: 'pending',
      operatingAccess: 'inactive',
    });

    await expectAvailability(fixture.token, {
      defaultWorkspace: 'buyer',
      availableWorkspaces: { buyer: true, seller: false },
      sellerApplicationStatus: 'pending',
      adminEntryState: 'unavailable',
    });

    expectError(await requestTestSellerRoute(fixture.token), 403);
  });

  it('reports active Seller access separately from the application status', async () => {
    const fixture = await createAuthenticatedFixture();
    sellerFactsByUser.set(fixture.userId, {
      applicationStatus: 'approved',
      operatingAccess: 'active',
    });

    await expectAvailability(fixture.token, {
      defaultWorkspace: 'buyer',
      availableWorkspaces: { buyer: true, seller: true },
      sellerApplicationStatus: 'approved',
      adminEntryState: 'unavailable',
    });

    const protectedSellerRoute = await requestTestSellerRoute(fixture.token);
    expect(protectedSellerRoute.statusCode).toBe(200);
  });

  it('keeps Seller unavailable when approved seller operating access is restricted', async () => {
    const fixture = await createAuthenticatedFixture();
    sellerFactsByUser.set(fixture.userId, {
      applicationStatus: 'approved',
      operatingAccess: 'suspended',
    });

    await expectAvailability(fixture.token, {
      defaultWorkspace: 'buyer',
      availableWorkspaces: { buyer: true, seller: false },
      sellerApplicationStatus: 'approved',
      adminEntryState: 'unavailable',
    });

    expectError(await requestTestSellerRoute(fixture.token), 403);
  });

  it('reflects permission and MFA changes while the session remains valid', async () => {
    const fixture = await createAuthenticatedFixture();

    await expectAvailability(fixture.token, {
      defaultWorkspace: 'buyer',
      availableWorkspaces: { buyer: true, seller: false },
      sellerApplicationStatus: null,
      adminEntryState: 'unavailable',
    });

    await grantAdministrator(fixture.userId);

    await expectAvailability(fixture.token, {
      defaultWorkspace: 'buyer',
      availableWorkspaces: { buyer: true, seller: false },
      sellerApplicationStatus: null,
      adminEntryState: 'mfa_required',
    });
    expectError(await requestTestAdminRoute(fixture.token), 403);

    mfaElevatedSessionIds.add(fixture.sessionId);

    await expectAvailability(fixture.token, {
      defaultWorkspace: 'buyer',
      availableWorkspaces: { buyer: true, seller: false },
      sellerApplicationStatus: null,
      adminEntryState: 'available',
    });
    expect((await requestTestAdminRoute(fixture.token)).statusCode).toBe(200);

    await getDatabase()
      .db.delete(identityUserPermissions)
      .where(
        and(
          eq(identityUserPermissions.userId, fixture.userId),
          eq(identityUserPermissions.permission, 'administrator'),
        ),
      );

    await expectAvailability(fixture.token, {
      defaultWorkspace: 'buyer',
      availableWorkspaces: { buyer: true, seller: false },
      sellerApplicationStatus: null,
      adminEntryState: 'unavailable',
    });
    expectError(await requestTestAdminRoute(fixture.token), 403);

    const currentUser = await getApp().inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${fixture.token}` },
    });
    expect(currentUser.statusCode).toBe(200);
  });

  it('rejects a session after account eligibility changes', async () => {
    const fixture = await createAuthenticatedFixture();

    await expectAvailability(fixture.token, {
      defaultWorkspace: 'buyer',
      availableWorkspaces: { buyer: true, seller: false },
      sellerApplicationStatus: null,
      adminEntryState: 'unavailable',
    });

    await getDatabase()
      .db.update(identityUsers)
      .set({ status: 'suspended' })
      .where(eq(identityUsers.id, fixture.userId));

    const restricted = await requestWorkspaces(fixture.token);
    expect(restricted.statusCode).toBe(403);
    expect(restricted.json<ApiErrorResponse>()).toMatchObject({
      error: {
        code: 'ACCOUNT_RESTRICTED',
        message: 'Account access is restricted',
      },
      requestId: restricted.headers['x-request-id'],
    });
  });
});
