import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../src/infrastructure/database/client.js';
import { buildApp } from '../../../../src/app.js';
import { PrivateEvidenceFileStore } from '../../../../src/infrastructure/storage/private-evidence-file-store.js';
import { requireWorkspaceAccess } from '../../../../src/http/guards/authorize-workspace.js';
import { identityUserPermissions } from '../../../../src/modules/identity/accounts/permission.table.js';
import { identityUsers } from '../../../../src/modules/identity/accounts/user.table.js';
import { createSession } from '../../../../src/modules/identity/sessions/session.service.js';
import { identitySessions } from '../../../../src/modules/identity/sessions/session.table.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../helpers/test-database.js';

const runId = randomUUID();
const fixtureUserIds: string[] = [];
const boundary = `----tx-onboarding-${runId}`;
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let sequence = 0;
let database: DatabaseClient | undefined;
let app: FastifyInstance | undefined;
let evidenceStore: PrivateEvidenceFileStore | undefined;
let storageDirectory: string | undefined;
let testDatabaseVerified = false;

interface UserFixture {
  id: string;
  token: string;
  sessionId: string;
}

interface ApplicationData {
  id: string;
  category: 'individual' | 'commercial';
  status: 'draft' | 'submitted' | 'changes_requested' | 'approved' | 'rejected';
  revision: number;
  proofOfAuthorityRequired: boolean;
  review: {
    decision: 'approve' | 'request_changes' | 'reject';
    feedback: string | null;
    requestedEvidence: string[];
  } | null;
}

interface ApplicationResponse {
  data: { application: ApplicationData | null };
}

interface WorkspaceResponse {
  data: {
    availableWorkspaces: { buyer: true; seller: boolean };
    sellerApplicationStatus: 'not_applied' | 'pending' | 'approved' | 'rejected' | null;
  };
}

function getDatabase(): DatabaseClient {
  if (!database) throw new Error('Test database was not initialized.');
  return database;
}

function getApp(): FastifyInstance {
  if (!app) throw new Error('Test app was not initialized.');
  return app;
}

async function createUser(): Promise<UserFixture> {
  sequence += 1;
  const email = `seller-workflow-${runId}-${sequence}@example.test`;
  const [user] = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: email,
      status: 'active',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning({ id: identityUsers.id });

  if (!user) throw new Error('Could not create workflow test user.');
  fixtureUserIds.push(user.id);

  const session = await createSession(getDatabase().db, user.id);
  if (!session) throw new Error('Could not create workflow test session.');

  return { id: user.id, token: session.rawToken, sessionId: session.sessionId };
}

async function createReviewer(): Promise<UserFixture> {
  const reviewer = await createUser();
  await getDatabase().db.insert(identityUserPermissions).values({
    userId: reviewer.id,
    permission: 'administrator',
  });

  const elevatedAt = new Date(Date.now() - 5_000);
  const elevatedUntil = new Date(Date.now() + 10 * 60_000);
  await getDatabase()
    .db.update(identitySessions)
    .set({ adminMfaElevatedAt: elevatedAt, adminMfaElevatedUntil: elevatedUntil })
    .where(eq(identitySessions.id, reviewer.sessionId));

  return reviewer;
}

function request(
  user: UserFixture,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: Record<string, unknown> | Buffer,
  headers: Record<string, string> = {},
) {
  return getApp().inject({
    method,
    url,
    headers: { authorization: `Bearer ${user.token}`, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
}

function createDraft(user: UserFixture, category: 'individual' | 'commercial') {
  return request(user, 'POST', '/api/v1/me/seller-applications', { category });
}

function updateApplication(user: UserFixture, id: string, payload: Record<string, unknown>) {
  return request(user, 'PATCH', `/api/v1/me/seller-applications/${id}`, payload);
}

function submitApplication(user: UserFixture, id: string, expectedRevision: number) {
  return request(user, 'POST', `/api/v1/me/seller-applications/${id}/submit`, {
    expectedRevision,
  });
}

function multipartPayload(bytes: Buffer, filename: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

function uploadEvidence(
  user: UserFixture,
  id: string,
  type: 'applicant_id' | 'business_registration' | 'proof_of_authority',
  expectedRevision: number,
) {
  return request(
    user,
    'PUT',
    `/api/v1/me/seller-applications/${id}/evidence/${type}?expectedRevision=${expectedRevision}`,
    multipartPayload(pngBytes, `${type}.png`),
    { 'content-type': `multipart/form-data; boundary=${boundary}` },
  );
}

function makeDecision(reviewer: UserFixture, id: string, payload: Record<string, unknown>) {
  return request(reviewer, 'POST', `/api/v1/admin/seller-applications/${id}/decision`, payload);
}

async function expectSellerAvailability(
  user: UserFixture,
  applicationStatus: WorkspaceResponse['data']['sellerApplicationStatus'],
  available: boolean,
): Promise<void> {
  const response = await request(user, 'GET', '/api/v1/me/workspaces');
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<WorkspaceResponse>().data).toMatchObject({
    availableWorkspaces: { buyer: true, seller: available },
    sellerApplicationStatus: applicationStatus,
  });

  const seller = await request(user, 'GET', '/__test/api/v1/seller');
  expect(seller.statusCode).toBe(available ? 200 : 403);
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  storageDirectory = await mkdtemp(join(tmpdir(), 'tennis-xpress-onboarding-workflow-'));
  evidenceStore = new PrivateEvidenceFileStore(storageDirectory);
  await evidenceStore.initialize();

  app = buildApp({ database, evidenceFileStore: evidenceStore });
  app.get(
    '/__test/api/v1/seller',
    { preHandler: requireWorkspaceAccess('seller') },
    async (request) => ({ data: { userId: request.identitySession?.userId } }),
  );
  await app.ready();
});

afterAll(async () => {
  try {
    if (database && testDatabaseVerified && fixtureUserIds.length > 0) {
      await database.pool.query(
        `DELETE FROM seller_application_review_decisions
          WHERE reviewer_user_id = ANY($1::uuid[])
             OR application_id IN (
               SELECT id FROM seller_onboarding_applications WHERE user_id = ANY($1::uuid[])
             )`,
        [fixtureUserIds],
      );
      await database.pool.query('DELETE FROM identity_users WHERE id = ANY($1::uuid[])', [
        fixtureUserIds,
      ]);
    }
  } finally {
    if (app) await app.close();
    else if (database) await database.close();

    if (storageDirectory) {
      await rm(storageDirectory, { recursive: true, force: true });
    }
  }
});

describe('complete seller onboarding workflows', () => {
  it('creates, uploads, submits, approves, and enables Seller on the applicant account', async () => {
    const applicant = await createUser();
    const reviewer = await createReviewer();

    const created = await createDraft(applicant, 'individual');
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json<ApplicationResponse>().data.application;
    if (!draft) throw new Error('Draft response did not include an application.');

    const updated = await updateApplication(applicant, draft.id, {
      expectedRevision: draft.revision,
      legalName: 'Synthetic End-to-End Applicant',
      sellerDisplayName: 'Synthetic Tennis Shop',
      areaServed: 'Mfoundi',
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const updatedApplication = updated.json<ApplicationResponse>().data.application;
    if (!updatedApplication) throw new Error('Update response did not include an application.');

    const evidence = await uploadEvidence(
      applicant,
      draft.id,
      'applicant_id',
      updatedApplication.revision,
    );
    expect(evidence.statusCode, evidence.body).toBe(200);
    const evidenceRevision = evidence.json<{ data: { evidence: { revision: number } } }>().data
      .evidence.revision;

    const submitted = await submitApplication(applicant, draft.id, evidenceRevision);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const submittedApplication = submitted.json<ApplicationResponse>().data.application;
    if (!submittedApplication)
      throw new Error('Submission response did not include an application.');
    expect(submittedApplication.status).toBe('submitted');
    await expectSellerAvailability(applicant, 'pending', false);

    const decision = await makeDecision(reviewer, draft.id, {
      expectedRevision: submittedApplication.revision,
      decision: 'approve',
    });
    expect(decision.statusCode, decision.body).toBe(200);
    expect(decision.json().data).toMatchObject({
      decision: 'approve',
      applicationStatus: 'approved',
    });

    await expectSellerAvailability(applicant, 'approved', true);

    const current = await request(applicant, 'GET', '/api/v1/me/seller-applications/current');
    expect(current.statusCode).toBe(200);
    expect(current.json<ApplicationResponse>().data.application).toMatchObject({
      id: draft.id,
      status: 'approved',
      review: { decision: 'approve' },
    });
  });

  it('requires explicitly requested Commercial proof of authority before resubmission', async () => {
    const applicant = await createUser();
    const reviewer = await createReviewer();

    const created = await createDraft(applicant, 'commercial');
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json<ApplicationResponse>().data.application;
    if (!draft) throw new Error('Draft response did not include an application.');

    const updated = await updateApplication(applicant, draft.id, {
      expectedRevision: draft.revision,
      legalName: 'Synthetic Commercial Applicant',
      registeredBusinessName: 'Synthetic Tennis Trading Ltd',
      businessRole: 'Director',
      areaServed: 'Mfoundi',
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const updatedApplication = updated.json<ApplicationResponse>().data.application;
    if (!updatedApplication) throw new Error('Update response did not include an application.');

    const applicantId = await uploadEvidence(
      applicant,
      draft.id,
      'applicant_id',
      updatedApplication.revision,
    );
    expect(applicantId.statusCode, applicantId.body).toBe(200);
    const applicantIdRevision = applicantId.json<{
      data: { evidence: { revision: number } };
    }>().data.evidence.revision;

    const registration = await uploadEvidence(
      applicant,
      draft.id,
      'business_registration',
      applicantIdRevision,
    );
    expect(registration.statusCode, registration.body).toBe(200);
    const registrationRevision = registration.json<{
      data: { evidence: { revision: number } };
    }>().data.evidence.revision;

    const submitted = await submitApplication(applicant, draft.id, registrationRevision);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const submittedApplication = submitted.json<ApplicationResponse>().data.application;
    if (!submittedApplication)
      throw new Error('Submission response did not include an application.');

    const requested = await makeDecision(reviewer, draft.id, {
      expectedRevision: submittedApplication.revision,
      decision: 'request_changes',
      feedback: 'Please provide proof of authority for the business.',
      requestedEvidence: ['proof_of_authority'],
    });
    expect(requested.statusCode, requested.body).toBe(200);

    const current = await request(applicant, 'GET', '/api/v1/me/seller-applications/current');
    const changedApplication = current.json<ApplicationResponse>().data.application;
    if (!changedApplication) throw new Error('Current response did not include the application.');
    expect(changedApplication).toMatchObject({
      status: 'changes_requested',
      proofOfAuthorityRequired: true,
      review: {
        decision: 'request_changes',
        requestedEvidence: ['proof_of_authority'],
      },
    });

    const missingAuthority = await submitApplication(
      applicant,
      draft.id,
      changedApplication.revision,
    );
    expect(missingAuthority.statusCode).toBe(400);
    expect(missingAuthority.json().error.details).toContainEqual({
      field: 'evidence.proof_of_authority',
      rule: 'required',
    });

    const authority = await uploadEvidence(
      applicant,
      draft.id,
      'proof_of_authority',
      changedApplication.revision,
    );
    expect(authority.statusCode, authority.body).toBe(200);
    const authorityRevision = authority.json<{
      data: { evidence: { revision: number } };
    }>().data.evidence.revision;

    const resubmitted = await submitApplication(applicant, draft.id, authorityRevision);
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);
    expect(resubmitted.json<ApplicationResponse>().data.application).toMatchObject({
      status: 'submitted',
      proofOfAuthorityRequired: false,
      review: {
        decision: 'request_changes',
        feedback: 'Please provide proof of authority for the business.',
        requestedEvidence: ['proof_of_authority'],
      },
    });
  });

  it('lets an applicant read a rejection and start a new draft', async () => {
    const applicant = await createUser();
    const reviewer = await createReviewer();

    const created = await createDraft(applicant, 'individual');
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json<ApplicationResponse>().data.application;
    if (!draft) throw new Error('Draft response did not include an application.');

    const updated = await updateApplication(applicant, draft.id, {
      expectedRevision: draft.revision,
      legalName: 'Synthetic Rejected Applicant',
      sellerDisplayName: 'Synthetic Tennis Seller',
      areaServed: 'Mfoundi',
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const updatedApplication = updated.json<ApplicationResponse>().data.application;
    if (!updatedApplication) throw new Error('Update response did not include an application.');

    const evidence = await uploadEvidence(
      applicant,
      draft.id,
      'applicant_id',
      updatedApplication.revision,
    );
    expect(evidence.statusCode, evidence.body).toBe(200);
    const evidenceRevision = evidence.json<{
      data: { evidence: { revision: number } };
    }>().data.evidence.revision;

    const submitted = await submitApplication(applicant, draft.id, evidenceRevision);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const submittedApplication = submitted.json<ApplicationResponse>().data.application;
    if (!submittedApplication)
      throw new Error('Submission response did not include an application.');

    const rejection = await makeDecision(reviewer, draft.id, {
      expectedRevision: submittedApplication.revision,
      decision: 'reject',
      feedback: 'The synthetic evidence could not be verified.',
    });
    expect(rejection.statusCode, rejection.body).toBe(200);

    const outcome = await request(applicant, 'GET', '/api/v1/me/seller-applications/current');
    expect(outcome.statusCode).toBe(200);
    expect(outcome.json<ApplicationResponse>().data.application).toMatchObject({
      id: draft.id,
      status: 'rejected',
      review: {
        decision: 'reject',
        feedback: 'The synthetic evidence could not be verified.',
      },
    });
    await expectSellerAvailability(applicant, 'rejected', false);

    const reapplication = await createDraft(applicant, 'individual');
    expect(reapplication.statusCode, reapplication.body).toBe(201);
    expect(reapplication.json<ApplicationResponse>().data.application).toMatchObject({
      category: 'individual',
      status: 'draft',
    });
  });
});
