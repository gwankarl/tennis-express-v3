import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse } from '../../../../src/http/contract.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../src/infrastructure/database/client.js';
import { buildApp } from '../../../../src/app.js';
import { identityUsers } from '../../../../src/modules/identity/accounts/user.table.js';
import { createSession } from '../../../../src/modules/identity/sessions/session.service.js';
import { sellerApplications } from '../../../../src/modules/seller-onboarding/application.table.js';
import { sellerApplicationEvidence } from '../../../../src/modules/seller-onboarding/application-evidence.table.js';
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

interface Application {
  id: string;
  category: 'individual' | 'commercial';
  status: 'draft' | 'submitted' | 'changes_requested' | 'approved' | 'rejected';
  revision: number;
  legalName: string | null;
  sellerDisplayName: string | null;
  areaServed: string | null;
  contactPhone: string | null;
  registeredBusinessName: string | null;
  businessRole: string | null;
  storefrontName: string | null;
  proofOfAuthorityRequired: boolean;
  evidence: Array<{
    type: 'applicant_id' | 'business_registration' | 'proof_of_authority';
    mediaType: 'image/jpeg' | 'image/png' | 'application/pdf';
    byteSize: number;
    updatedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

interface ApplicationResponse {
  data: { application: Application | null };
}

interface AuthenticatedFixture {
  userId: string;
  token: string;
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

async function createAuthenticatedFixture(): Promise<AuthenticatedFixture> {
  sequence += 1;
  const email = `seller-application-${runId}-${sequence}@example.test`;

  const users = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: email,
      status: 'active',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning({ id: identityUsers.id });

  const user = users[0];

  if (!user) {
    throw new Error('Could not create the seller application test user.');
  }

  fixtureUserIds.push(user.id);

  const session = await createSession(getDatabase().db, user.id);

  if (!session) {
    throw new Error('Could not create the seller application test session.');
  }

  return { userId: user.id, token: session.rawToken };
}

function createDraft(token: string, payload: Record<string, unknown>) {
  return getApp().inject({
    method: 'POST',
    url: '/api/v1/me/seller-applications',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function getCurrent(token: string) {
  return getApp().inject({
    method: 'GET',
    url: '/api/v1/me/seller-applications/current',
    headers: { authorization: `Bearer ${token}` },
  });
}

function updateApplication(token: string, applicationId: string, payload: Record<string, unknown>) {
  return getApp().inject({
    method: 'PATCH',
    url: `/api/v1/me/seller-applications/${applicationId}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function expectRequestError(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  json<T>(): T;
}): ApiErrorResponse {
  const body = response.json<ApiErrorResponse>();

  expect(body.error.code).toBe('REQUEST_ERROR');
  expect(body.error.message).toBe('Request failed');
  expect(body.requestId).toBe(response.headers['x-request-id']);

  return body;
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

describe('seller application drafts', () => {
  it('creates an incomplete Draft and returns only applicant-facing fields', async () => {
    const user = await createAuthenticatedFixture();
    const response = await createDraft(user.token, { category: 'individual' });

    expect(response.statusCode).toBe(201);
    const application = response.json<ApplicationResponse>().data.application;

    expect(application).toMatchObject({
      category: 'individual',
      status: 'draft',
      revision: 1,
      legalName: null,
      sellerDisplayName: null,
      areaServed: null,
      contactPhone: null,
      registeredBusinessName: null,
      businessRole: null,
      storefrontName: null,
      proofOfAuthorityRequired: false,
      evidence: [],
    });
    expect(response.body).not.toMatch(/userId|email|storageKey|storage_key/i);
  });

  it('returns safe evidence status and a proof-of-authority request on the current application', async () => {
    const user = await createAuthenticatedFixture();
    const created = await createDraft(user.token, { category: 'commercial' });
    const application = created.json<ApplicationResponse>().data.application;

    if (!application) {
      throw new Error('Draft creation returned no application.');
    }

    const evidenceUpdatedAt = new Date('2026-10-01T12:00:00.000Z');

    await getDatabase()
      .db.update(sellerApplications)
      .set({ proofOfAuthorityRequired: true })
      .where(eq(sellerApplications.id, application.id));

    await getDatabase()
      .db.insert(sellerApplicationEvidence)
      .values({
        applicationId: application.id,
        type: 'applicant_id',
        storageKey: `synthetic/${runId}/${application.id}/applicant-id.pdf`,
        mediaType: 'application/pdf',
        byteSize: 2048,
        sha256: 'a'.repeat(64),
        createdAt: evidenceUpdatedAt,
        updatedAt: evidenceUpdatedAt,
      });

    const response = await getCurrent(user.token);

    expect(response.statusCode).toBe(200);
    expect(response.json<ApplicationResponse>().data.application).toMatchObject({
      id: application.id,
      proofOfAuthorityRequired: true,
      evidence: [
        {
          type: 'applicant_id',
          mediaType: 'application/pdf',
          byteSize: 2048,
          updatedAt: evidenceUpdatedAt.toISOString(),
        },
      ],
    });
    expect(response.body).not.toContain('storageKey');
    expect(response.body).not.toContain('storage_key');
    expect(response.body).not.toContain(`synthetic/${runId}/${application.id}`);
  });

  it('reads and updates the session owner’s Draft', async () => {
    const user = await createAuthenticatedFixture();
    const created = await createDraft(user.token, { category: 'individual' });
    const initial = created.json<ApplicationResponse>().data.application;

    if (!initial) {
      throw new Error('Draft creation returned no application.');
    }

    const updated = await updateApplication(user.token, initial.id, {
      expectedRevision: 1,
      legalName: 'Synthetic Applicant',
      sellerDisplayName: 'Yaounde Tennis',
      areaServed: 'Central Yaounde',
      contactPhone: '+237600000001',
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json<ApplicationResponse>().data.application).toMatchObject({
      id: initial.id,
      status: 'draft',
      revision: 2,
      legalName: 'Synthetic Applicant',
      sellerDisplayName: 'Yaounde Tennis',
      areaServed: 'Central Yaounde',
      contactPhone: '+237600000001',
    });

    const read = await getCurrent(user.token);

    expect(read.statusCode).toBe(200);
    expect(read.json<ApplicationResponse>().data.application).toMatchObject({
      id: initial.id,
      revision: 2,
      legalName: 'Synthetic Applicant',
    });
  });

  it('allows a category change before first submission and clears old-category fields', async () => {
    const user = await createAuthenticatedFixture();
    const created = await createDraft(user.token, {
      category: 'individual',
      legalName: 'Synthetic Applicant',
      sellerDisplayName: 'Individual Seller',
    });
    const initial = created.json<ApplicationResponse>().data.application;

    if (!initial) {
      throw new Error('Draft creation returned no application.');
    }

    const updated = await updateApplication(user.token, initial.id, {
      expectedRevision: 1,
      category: 'commercial',
      registeredBusinessName: 'Synthetic Tennis Ltd',
      businessRole: 'Owner',
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json<ApplicationResponse>().data.application).toMatchObject({
      category: 'commercial',
      registeredBusinessName: 'Synthetic Tennis Ltd',
      businessRole: 'Owner',
      sellerDisplayName: null,
    });
  });

  it('rejects concurrent attempts to create a second open application', async () => {
    const user = await createAuthenticatedFixture();

    const responses = await Promise.all([
      createDraft(user.token, { category: 'individual' }),
      createDraft(user.token, { category: 'commercial' }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expectRequestError(responses.find((response) => response.statusCode === 409)!);

    const count = await getDatabase()
      .db.select({ id: sellerApplications.id })
      .from(sellerApplications)
      .where(eq(sellerApplications.userId, user.userId));

    expect(count).toHaveLength(1);
  });

  it('rejects stale revisions, invalid values, and unexpected fields', async () => {
    const user = await createAuthenticatedFixture();
    const created = await createDraft(user.token, { category: 'individual' });
    const initial = created.json<ApplicationResponse>().data.application;

    if (!initial) {
      throw new Error('Draft creation returned no application.');
    }

    const firstUpdate = await updateApplication(user.token, initial.id, {
      expectedRevision: 1,
      legalName: 'First Update',
    });
    expect(firstUpdate.statusCode).toBe(200);

    const stale = await updateApplication(user.token, initial.id, {
      expectedRevision: 1,
      legalName: 'Stale Update',
    });
    expect(stale.statusCode).toBe(409);
    expectRequestError(stale);

    const invalidPayloads: Array<Record<string, unknown>> = [
      { expectedRevision: 2, legalName: '   ' },
      { expectedRevision: 2, unknownField: 'not allowed' },
      { expectedRevision: 2, businessRole: 'Owner' },
      { expectedRevision: 0, legalName: 'Invalid revision' },
    ];

    for (const payload of invalidPayloads) {
      const invalid = await updateApplication(user.token, initial.id, payload);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json<ApiErrorResponse>().error.code).toBe('VALIDATION_ERROR');
      expect(invalid.json<ApiErrorResponse>().requestId).toBe(invalid.headers['x-request-id']);
    }
  });

  it('returns the same not-found error for a foreign application and an unknown ID', async () => {
    const owner = await createAuthenticatedFixture();
    const other = await createAuthenticatedFixture();
    const created = await createDraft(owner.token, { category: 'individual' });
    const application = created.json<ApplicationResponse>().data.application;

    if (!application) {
      throw new Error('Draft creation returned no application.');
    }

    const foreign = await updateApplication(other.token, application.id, {
      expectedRevision: 1,
      legalName: 'Must not update another account',
    });
    const unknown = await updateApplication(other.token, randomUUID(), {
      expectedRevision: 1,
      legalName: 'Unknown application',
    });

    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(expectRequestError(foreign).error).toEqual(expectRequestError(unknown).error);

    const ownerRead = await getCurrent(owner.token);
    expect(ownerRead.json<ApplicationResponse>().data.application).toMatchObject({
      id: application.id,
      legalName: null,
      revision: 1,
    });

    const otherRead = await getCurrent(other.token);
    expect(otherRead.json<ApplicationResponse>().data.application).toBeNull();
  });

  it('allows reapplication after rejection and returns the latest closed outcome', async () => {
    const user = await createAuthenticatedFixture();
    const created = await createDraft(user.token, { category: 'individual' });
    const rejected = created.json<ApplicationResponse>().data.application;

    if (!rejected) {
      throw new Error('Draft creation returned no application.');
    }

    await getDatabase()
      .db.update(sellerApplications)
      .set({
        status: 'rejected',
        firstSubmittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sellerApplications.id, rejected.id));

    const readClosed = await getCurrent(user.token);
    expect(readClosed.json<ApplicationResponse>().data.application).toMatchObject({
      id: rejected.id,
      status: 'rejected',
    });

    const reapplied = await createDraft(user.token, { category: 'commercial' });
    expect(reapplied.statusCode).toBe(201);
    expect(reapplied.json<ApplicationResponse>().data.application).toMatchObject({
      category: 'commercial',
      status: 'draft',
    });

    const latest = await getCurrent(user.token);
    expect(latest.json<ApplicationResponse>().data.application).toMatchObject({
      category: 'commercial',
      status: 'draft',
    });
  });

  it('returns an approved closed outcome and prevents a new onboarding cycle', async () => {
    const user = await createAuthenticatedFixture();
    const created = await createDraft(user.token, { category: 'individual' });
    const approved = created.json<ApplicationResponse>().data.application;

    if (!approved) {
      throw new Error('Draft creation returned no application.');
    }

    await getDatabase()
      .db.update(sellerApplications)
      .set({
        status: 'approved',
        firstSubmittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sellerApplications.id, approved.id));

    const readClosed = await getCurrent(user.token);
    expect(readClosed.json<ApplicationResponse>().data.application).toMatchObject({
      id: approved.id,
      status: 'approved',
    });

    const newCycle = await createDraft(user.token, { category: 'individual' });
    expect(newCycle.statusCode).toBe(409);
    expectRequestError(newCycle);
  });

  it('allows field updates in Changes requested but keeps the submitted category locked', async () => {
    const user = await createAuthenticatedFixture();
    const created = await createDraft(user.token, {
      category: 'commercial',
      registeredBusinessName: 'Synthetic Tennis Ltd',
    });
    const application = created.json<ApplicationResponse>().data.application;

    if (!application) {
      throw new Error('Draft creation returned no application.');
    }

    await getDatabase()
      .db.update(sellerApplications)
      .set({
        status: 'changes_requested',
        firstSubmittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sellerApplications.id, application.id));

    const fieldUpdate = await updateApplication(user.token, application.id, {
      expectedRevision: 1,
      areaServed: 'Mfoundi',
    });
    expect(fieldUpdate.statusCode).toBe(200);
    expect(fieldUpdate.json<ApplicationResponse>().data.application).toMatchObject({
      status: 'changes_requested',
      revision: 2,
      areaServed: 'Mfoundi',
    });

    const categoryUpdate = await updateApplication(user.token, application.id, {
      expectedRevision: 2,
      category: 'individual',
    });
    expect(categoryUpdate.statusCode).toBe(409);
    expectRequestError(categoryUpdate);
  });
});
