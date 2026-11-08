import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse } from '../../../../src/http/contract.js';
import {
  requireWorkspaceAccess,
  type SellerWorkspaceFacts,
  type WorkspaceAuthorizationSources,
  type WorkspaceName,
} from '../../../../src/http/guards/authorize-workspace.js';
import { buildApp } from '../../../../src/app.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../src/infrastructure/database/client.js';
import { identityUserPermissions } from '../../../../src/modules/identity/accounts/permission.table.js';
import { identityUsers } from '../../../../src/modules/identity/accounts/user.table.js';
import { createSession } from '../../../../src/modules/identity/sessions/session.service.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../helpers/test-database.js';

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
  const email = `workspace-${runId}-${userSequence}@example.test`;

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

function registerTestWorkspaceRoute(
  target: FastifyInstance,
  path: string,
  workspace: WorkspaceName,
  sources?: WorkspaceAuthorizationSources,
): void {
  target.get(path, { preHandler: requireWorkspaceAccess(workspace, sources) }, async (request) => ({
    data: {
      workspace,
      userId: request.identitySession?.userId,
    },
  }));
}

function getWorkspace(path: string, token?: string) {
  return getApp().inject({
    method: 'GET',
    url: path,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
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

function expectWorkspaceAllowed(
  response: {
    statusCode: number;
    json<T>(): T;
  },
  workspace: WorkspaceName,
  userId: string,
): void {
  expect(response.statusCode).toBe(200);
  expect(response.json<{ data: { workspace: string; userId: string } }>()).toEqual({
    data: { workspace, userId },
  });
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  app = buildApp({ database });

  registerTestWorkspaceRoute(app, '/__test/api/v1/workspaces/buyer', 'buyer');
  registerTestWorkspaceRoute(app, '/__test/api/v1/workspaces/seller', 'seller');
  registerTestWorkspaceRoute(
    app,
    '/__test/api/v1/workspaces/seller-fixture',
    'seller',
    fixtureSources,
  );
  registerTestWorkspaceRoute(app, '/__test/api/v1/workspaces/admin', 'admin');
  registerTestWorkspaceRoute(
    app,
    '/__test/api/v1/workspaces/admin-fixture',
    'admin',
    fixtureSources,
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

describe('workspace authorization guard', () => {
  it('rejects unauthenticated requests and denies Seller without a production access source', async () => {
    const unauthenticated = await getWorkspace('/__test/api/v1/workspaces/buyer');
    expectError(unauthenticated, 401);

    const fixture = await createAuthenticatedFixture();
    const buyer = await getWorkspace('/__test/api/v1/workspaces/buyer', fixture.token);
    expectWorkspaceAllowed(buyer, 'buyer', fixture.userId);

    sellerFactsByUser.set(fixture.userId, {
      applicationStatus: 'approved',
      operatingAccess: 'active',
    });

    const sellerWithoutSource = await getWorkspace(
      '/__test/api/v1/workspaces/seller',
      fixture.token,
    );
    expectError(sellerWithoutSource, 403);
  });

  it('denies Buyer after the account becomes ineligible even when the session exists', async () => {
    const fixture = await createAuthenticatedFixture();

    await getDatabase()
      .db.update(identityUsers)
      .set({ status: 'suspended' })
      .where(eq(identityUsers.id, fixture.userId));

    const restricted = await getWorkspace('/__test/api/v1/workspaces/buyer', fixture.token);
    expect(restricted.statusCode).toBe(403);

    const body = restricted.json<ApiErrorResponse>();
    expect(body.error.code).toBe('ACCOUNT_RESTRICTED');
    expect(body.error.message).toBe('Account access is restricted');
    expect(body.requestId).toBe(restricted.headers['x-request-id']);
  });

  it('requires approved application state and active Seller operating access', async () => {
    const fixture = await createAuthenticatedFixture();
    const deniedFixtures: SellerWorkspaceFacts[] = [
      { applicationStatus: 'pending', operatingAccess: 'active' },
      { applicationStatus: 'approved', operatingAccess: 'inactive' },
      { applicationStatus: 'approved', operatingAccess: 'suspended' },
      { applicationStatus: 'rejected', operatingAccess: 'active' },
    ];

    for (const sellerFacts of deniedFixtures) {
      sellerFactsByUser.set(fixture.userId, sellerFacts);
      expectError(
        await getWorkspace('/__test/api/v1/workspaces/seller-fixture', fixture.token),
        403,
      );
    }

    sellerFactsByUser.set(fixture.userId, {
      applicationStatus: 'approved',
      operatingAccess: 'active',
    });

    expectWorkspaceAllowed(
      await getWorkspace('/__test/api/v1/workspaces/seller-fixture', fixture.token),
      'seller',
      fixture.userId,
    );
  });

  it('denies an administrator grant when the current session has no MFA elevation', async () => {
    const fixture = await createAuthenticatedFixture();
    await grantAdministrator(fixture.userId);

    expectError(await getWorkspace('/__test/api/v1/workspaces/admin', fixture.token), 403);
  });

  it('rechecks administrator permission while the same session remains valid', async () => {
    const fixture = await createAuthenticatedFixture();
    await grantAdministrator(fixture.userId);
    mfaElevatedSessionIds.add(fixture.sessionId);

    expectWorkspaceAllowed(
      await getWorkspace('/__test/api/v1/workspaces/admin-fixture', fixture.token),
      'admin',
      fixture.userId,
    );

    await getDatabase()
      .db.delete(identityUserPermissions)
      .where(
        and(
          eq(identityUserPermissions.userId, fixture.userId),
          eq(identityUserPermissions.permission, 'administrator'),
        ),
      );

    const currentUser = await getApp().inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${fixture.token}` },
    });
    expect(currentUser.statusCode).toBe(200);

    expectError(await getWorkspace('/__test/api/v1/workspaces/admin-fixture', fixture.token), 403);
  });

  it('allows Buyer, Seller, and Admin together only when each required fact is present', async () => {
    const fixture = await createAuthenticatedFixture();
    await grantAdministrator(fixture.userId);
    sellerFactsByUser.set(fixture.userId, {
      applicationStatus: 'approved',
      operatingAccess: 'active',
    });
    mfaElevatedSessionIds.add(fixture.sessionId);

    expectWorkspaceAllowed(
      await getWorkspace('/__test/api/v1/workspaces/buyer', fixture.token),
      'buyer',
      fixture.userId,
    );
    expectWorkspaceAllowed(
      await getWorkspace('/__test/api/v1/workspaces/seller-fixture', fixture.token),
      'seller',
      fixture.userId,
    );
    expectWorkspaceAllowed(
      await getWorkspace('/__test/api/v1/workspaces/admin-fixture', fixture.token),
      'admin',
      fixture.userId,
    );
  });
});
