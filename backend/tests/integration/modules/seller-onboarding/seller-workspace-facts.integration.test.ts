import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireWorkspaceAccess } from '../../../../src/http/guards/authorize-workspace.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../src/infrastructure/database/client.js';
import { buildApp } from '../../../../src/app.js';
import { identityUsers } from '../../../../src/modules/identity/accounts/user.table.js';
import { createSession } from '../../../../src/modules/identity/sessions/session.service.js';
import { sellerApplications } from '../../../../src/modules/seller-onboarding/application.table.js';
import { sellerOperatingAccess } from '../../../../src/modules/seller-onboarding/review.table.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../helpers/test-database.js';

const runId = randomUUID();
const fixtureUserIds: string[] = [];

let sequence = 0;
let database: DatabaseClient | undefined;
let app: FastifyInstance | undefined;
let testDatabaseVerified = false;

type ApplicationStatus = typeof sellerApplications.$inferSelect.status;

interface UserFixture {
  id: string;
  token: string;
}

interface WorkspaceResponse {
  data: {
    defaultWorkspace: 'buyer';
    availableWorkspaces: {
      buyer: true;
      seller: boolean;
    };
    sellerApplicationStatus: 'not_applied' | 'pending' | 'approved' | 'rejected' | null;
    adminEntryState: 'unavailable' | 'mfa_required' | 'available';
    adminMfaFactorState: 'none' | 'pending' | 'active' | null;
  };
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

async function createUser(): Promise<UserFixture> {
  sequence += 1;
  const email = `seller-workspace-${runId}-${sequence}@example.test`;

  const [user] = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: email,
      status: 'active',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning({ id: identityUsers.id });

  if (!user) {
    throw new Error('Could not create the Seller workspace test user.');
  }

  fixtureUserIds.push(user.id);

  const session = await createSession(getDatabase().db, user.id);

  if (!session) {
    throw new Error('Could not create the Seller workspace test session.');
  }

  return { id: user.id, token: session.rawToken };
}

async function createApplication(userId: string, status: ApplicationStatus): Promise<string> {
  const [application] = await getDatabase()
    .db.insert(sellerApplications)
    .values({
      userId,
      category: 'individual',
      status,
      firstSubmittedAt: status === 'draft' ? null : new Date(),
    })
    .returning({ id: sellerApplications.id });

  if (!application) {
    throw new Error('Could not create the Seller workspace test application.');
  }

  return application.id;
}

async function createOperatingAccess(
  userId: string,
  applicationId: string,
  status: 'active' | 'suspended' = 'active',
): Promise<void> {
  await getDatabase().db.insert(sellerOperatingAccess).values({
    userId,
    applicationId,
    status,
  });
}

function requestWorkspaces(token: string) {
  return getApp().inject({
    method: 'GET',
    url: '/api/v1/me/workspaces',
    headers: { authorization: `Bearer ${token}` },
  });
}

function requestSellerRoute(token: string) {
  return getApp().inject({
    method: 'GET',
    url: '/__test/api/v1/seller',
    headers: { authorization: `Bearer ${token}` },
  });
}

function requestBuyerRoute(token: string) {
  return getApp().inject({
    method: 'GET',
    url: '/__test/api/v1/buyer',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function expectWorkspaceAndSellerAccess(
  user: UserFixture,
  applicationStatus: WorkspaceResponse['data']['sellerApplicationStatus'],
  sellerAvailable: boolean,
): Promise<void> {
  const workspaceResponse = await requestWorkspaces(user.token);

  expect(workspaceResponse.statusCode, workspaceResponse.body).toBe(200);
  expect(workspaceResponse.json<WorkspaceResponse>().data).toMatchObject({
    defaultWorkspace: 'buyer',
    availableWorkspaces: {
      buyer: true,
      seller: sellerAvailable,
    },
    sellerApplicationStatus: applicationStatus,
    adminEntryState: 'unavailable',
    adminMfaFactorState: null,
  });

  const sellerResponse = await requestSellerRoute(user.token);
  expect(sellerResponse.statusCode).toBe(sellerAvailable ? 200 : 403);

  const buyerResponse = await requestBuyerRoute(user.token);
  expect(buyerResponse.statusCode).toBe(200);
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  // No Seller facts override is passed: this exercises buildApp's production
  // database-backed provider for both /me/workspaces and the Seller guard.
  app = buildApp({ database });

  app.get(
    '/__test/api/v1/seller',
    { preHandler: requireWorkspaceAccess('seller') },
    async (request) => ({ data: { userId: request.identitySession?.userId } }),
  );

  app.get(
    '/__test/api/v1/buyer',
    { preHandler: requireWorkspaceAccess('buyer') },
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
    if (app) {
      await app.close();
    } else if (database) {
      await database.close();
    }
  }
});

describe('database-backed Seller workspace authorization', () => {
  it('maps no application and Draft to not_applied and denies Seller', async () => {
    const user = await createUser();

    await expectWorkspaceAndSellerAccess(user, 'not_applied', false);

    await createApplication(user.id, 'draft');
    await expectWorkspaceAndSellerAccess(user, 'not_applied', false);
  });

  it('maps Submitted and Changes requested to pending and denies Seller', async () => {
    const user = await createUser();
    const applicationId = await createApplication(user.id, 'submitted');

    await expectWorkspaceAndSellerAccess(user, 'pending', false);

    await getDatabase()
      .db.update(sellerApplications)
      .set({ status: 'changes_requested' })
      .where(eq(sellerApplications.id, applicationId));

    await expectWorkspaceAndSellerAccess(user, 'pending', false);
  });

  it('preserves Rejected and denies Seller', async () => {
    const user = await createUser();
    await createApplication(user.id, 'rejected');

    await expectWorkspaceAndSellerAccess(user, 'rejected', false);
  });

  it('allows Seller only when an approved application has active matching access', async () => {
    const user = await createUser();
    const applicationId = await createApplication(user.id, 'approved');
    await createOperatingAccess(user.id, applicationId, 'active');

    await expectWorkspaceAndSellerAccess(user, 'approved', true);
  });

  it('denies Seller for missing, suspended, or inconsistent operating access', async () => {
    const missingAccessUser = await createUser();
    await createApplication(missingAccessUser.id, 'approved');

    const suspendedAccessUser = await createUser();
    const suspendedApplicationId = await createApplication(suspendedAccessUser.id, 'approved');
    await createOperatingAccess(suspendedAccessUser.id, suspendedApplicationId, 'suspended');

    const inconsistentAccessUser = await createUser();
    const pendingApplicationId = await createApplication(inconsistentAccessUser.id, 'submitted');
    await createOperatingAccess(inconsistentAccessUser.id, pendingApplicationId, 'active');

    await expectWorkspaceAndSellerAccess(missingAccessUser, 'approved', false);
    await expectWorkspaceAndSellerAccess(suspendedAccessUser, 'approved', false);
    await expectWorkspaceAndSellerAccess(inconsistentAccessUser, 'pending', false);
  });

  it('rechecks approval and restrictions on every request in the same session', async () => {
    const user = await createUser();
    const applicationId = await createApplication(user.id, 'submitted');

    await expectWorkspaceAndSellerAccess(user, 'pending', false);

    await getDatabase()
      .db.update(sellerApplications)
      .set({ status: 'approved' })
      .where(eq(sellerApplications.id, applicationId));
    await createOperatingAccess(user.id, applicationId, 'active');

    await expectWorkspaceAndSellerAccess(user, 'approved', true);

    await getDatabase()
      .db.update(sellerOperatingAccess)
      .set({ status: 'suspended', updatedAt: new Date() })
      .where(eq(sellerOperatingAccess.userId, user.id));

    await expectWorkspaceAndSellerAccess(user, 'approved', false);
  });
});
