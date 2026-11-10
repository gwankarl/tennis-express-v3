import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse } from '../../../../src/http/contract.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../src/infrastructure/database/client.js';
import { buildApp } from '../../../../src/app.js';
import { identityUserPermissions } from '../../../../src/modules/identity/accounts/permission.table.js';
import { identityUsers } from '../../../../src/modules/identity/accounts/user.table.js';
import { createSession } from '../../../../src/modules/identity/sessions/session.service.js';
import { identitySessions } from '../../../../src/modules/identity/sessions/session.table.js';
import { sellerApplicationEvidence } from '../../../../src/modules/seller-onboarding/application-evidence.table.js';
import { sellerApplications } from '../../../../src/modules/seller-onboarding/application.table.js';
import {
  sellerApplicationReviewDecisions,
  sellerOperatingAccess,
} from '../../../../src/modules/seller-onboarding/review.table.js';
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

interface UserFixture {
  id: string;
  token: string;
  sessionId: string;
}

interface ApplicationFixture {
  id: string;
  owner: UserFixture;
  revision: number;
}

interface ApplicationResponse {
  data: {
    application: {
      id: string;
      revision: number;
      status: string;
      proofOfAuthorityRequired: boolean;
      review: {
        decision: 'approve' | 'request_changes' | 'reject';
        feedback: string | null;
        requestedEvidence: string[];
        decidedAt: string;
      } | null;
    } | null;
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

async function createUser(
  options: { administrator?: boolean; elevation?: 'valid' | 'none' | 'expired' } = {},
) {
  sequence += 1;
  const email = `seller-review-${runId}-${sequence}@example.test`;
  const [user] = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: email,
      status: 'active',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning({ id: identityUsers.id });

  if (!user) throw new Error('Could not create seller review test user.');
  fixtureUserIds.push(user.id);

  if (options.administrator) {
    await getDatabase().db.insert(identityUserPermissions).values({
      userId: user.id,
      permission: 'administrator',
    });
  }

  const session = await createSession(getDatabase().db, user.id);
  if (!session) throw new Error('Could not create seller review test session.');

  if (options.elevation === 'valid') {
    const elevatedAt = new Date(Date.now() - 5_000);
    const elevatedUntil = new Date(Date.now() + 10 * 60_000);
    await getDatabase()
      .db.update(identitySessions)
      .set({ adminMfaElevatedAt: elevatedAt, adminMfaElevatedUntil: elevatedUntil })
      .where(eq(identitySessions.id, session.sessionId));
  } else if (options.elevation === 'expired') {
    const elevatedAt = new Date(Date.now() - 10 * 60_000);
    const elevatedUntil = new Date(Date.now() - 60_000);
    await getDatabase()
      .db.update(identitySessions)
      .set({ adminMfaElevatedAt: elevatedAt, adminMfaElevatedUntil: elevatedUntil })
      .where(eq(identitySessions.id, session.sessionId));
  }

  return { id: user.id, token: session.rawToken, sessionId: session.sessionId };
}

async function createSubmittedApplication(
  category: 'individual' | 'commercial' = 'individual',
): Promise<ApplicationFixture> {
  const owner = await createUser();
  const created = await getApp().inject({
    method: 'POST',
    url: '/api/v1/me/seller-applications',
    headers: { authorization: `Bearer ${owner.token}` },
    payload: { category },
  });

  expect(created.statusCode, created.body).toBe(201);
  const application = created.json<ApplicationResponse>().data.application;
  if (!application) throw new Error('Draft creation returned no application.');

  const submittedAt = new Date();
  await getDatabase()
    .db.update(sellerApplications)
    .set({
      status: 'submitted',
      revision: 2,
      firstSubmittedAt: submittedAt,
      applicantLegalName: 'Synthetic Applicant',
      areaServed: 'Central Yaounde',
      ...(category === 'individual'
        ? { sellerDisplayName: 'Synthetic Tennis Seller' }
        : { registeredBusinessName: 'Synthetic Tennis Ltd', businessRole: 'Owner' }),
      updatedAt: submittedAt,
    })
    .where(eq(sellerApplications.id, application.id));

  return { id: application.id, owner, revision: 2 };
}

async function addEvidence(
  applicationId: string,
  type: 'applicant_id' | 'business_registration' | 'proof_of_authority',
): Promise<void> {
  const now = new Date();
  await getDatabase()
    .db.insert(sellerApplicationEvidence)
    .values({
      applicationId,
      type,
      storageKey: `synthetic/${runId}/${applicationId}/${type}.pdf`,
      mediaType: 'application/pdf',
      byteSize: 2048,
      sha256: 'a'.repeat(64),
      createdAt: now,
      updatedAt: now,
    });
}

function request(
  user: UserFixture,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
) {
  return getApp().inject({
    method,
    url,
    headers: { authorization: `Bearer ${user.token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

function decide(reviewer: UserFixture, applicationId: string, payload: Record<string, unknown>) {
  return request(
    reviewer,
    'POST',
    `/api/v1/admin/seller-applications/${applicationId}/decision`,
    payload,
  );
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
      await database.pool.query(
        `DELETE FROM seller_application_review_decisions
          WHERE reviewer_user_id = ANY($1::uuid[])
             OR application_id IN (
               SELECT id FROM seller_onboarding_applications WHERE user_id = ANY($1::uuid[])
             )`,
        [fixtureUserIds],
      );
      await database.pool.query(
        `DELETE FROM seller_onboarding_operating_access
          WHERE user_id = ANY($1::uuid[])
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
  }
});

describe('administrator seller application review', () => {
  it('requires current Admin MFA elevation and rejects an expired elevation', async () => {
    const applicant = await createSubmittedApplication();
    const unelevated = await createUser({ administrator: true, elevation: 'none' });
    const expired = await createUser({ administrator: true, elevation: 'expired' });

    const missingMfa = await request(unelevated, 'GET', '/api/v1/admin/seller-applications');
    const expiredMfa = await request(expired, 'GET', '/api/v1/admin/seller-applications');

    expect(missingMfa.statusCode).toBe(403);
    expect(missingMfa.json<ApiErrorResponse>().error.code).toBe('REQUEST_ERROR');
    expect(expiredMfa.statusCode).toBe(403);
    expect(expiredMfa.json<ApiErrorResponse>().error.code).toBe('REQUEST_ERROR');
    expect(applicant.id).toBeDefined();
  });

  it('excludes self-owned applications and denies self detail, evidence, and decisions', async () => {
    const own = await createSubmittedApplication();
    const other = await createSubmittedApplication();
    const ownAdmin = await createUser({ administrator: true, elevation: 'valid' });

    // Attach this submitted application to the elevated synthetic Admin so the
    // queue and direct-resource checks exercise an actual self-owned record.
    await getDatabase()
      .db.update(sellerApplications)
      .set({ userId: ownAdmin.id })
      .where(eq(sellerApplications.id, own.id));
    await addEvidence(own.id, 'applicant_id');

    const queue = await request(ownAdmin, 'GET', '/api/v1/admin/seller-applications');
    const queueIds = queue
      .json<{ data: { items: Array<{ id: string }> } }>()
      .data.items.map((item) => item.id);
    expect(queue.statusCode).toBe(200);
    expect(queueIds).toContain(other.id);
    expect(queueIds).not.toContain(own.id);

    const ownDetail = await request(ownAdmin, 'GET', `/api/v1/admin/seller-applications/${own.id}`);
    const ownEvidence = await request(
      ownAdmin,
      'GET',
      `/api/v1/admin/seller-applications/${own.id}/evidence/applicant_id`,
    );
    const ownDecision = await decide(ownAdmin, own.id, {
      expectedRevision: own.revision,
      decision: 'reject',
      feedback: 'Synthetic self-review attempt.',
    });

    expect(ownDetail.statusCode).toBe(404);
    expect(ownEvidence.statusCode).toBe(404);
    expect(ownDecision.statusCode).toBe(404);
  });

  it('records Approve, Request changes, and Reject with their applicant-facing outcomes', async () => {
    const reviewer = await createUser({ administrator: true, elevation: 'valid' });
    const approved = await createSubmittedApplication();
    const changesRequested = await createSubmittedApplication('commercial');
    const rejected = await createSubmittedApplication();

    const approval = await decide(reviewer, approved.id, {
      expectedRevision: approved.revision,
      decision: 'approve',
    });
    const requestChanges = await decide(reviewer, changesRequested.id, {
      expectedRevision: changesRequested.revision,
      decision: 'request_changes',
      feedback: 'Please provide proof of authority.',
      requestedEvidence: ['proof_of_authority'],
    });
    const rejection = await decide(reviewer, rejected.id, {
      expectedRevision: rejected.revision,
      decision: 'reject',
      feedback: 'The submitted information could not be verified.',
    });

    expect(approval.statusCode).toBe(200);
    expect(approval.json().data).toMatchObject({
      reviewedRevision: approved.revision,
      decision: 'approve',
      applicationStatus: 'approved',
    });
    expect(requestChanges.statusCode).toBe(200);
    expect(requestChanges.json().data).toMatchObject({
      decision: 'request_changes',
      feedback: 'Please provide proof of authority.',
      requestedEvidence: ['proof_of_authority'],
      applicationStatus: 'changes_requested',
    });
    expect(rejection.statusCode).toBe(200);
    expect(rejection.json().data).toMatchObject({
      decision: 'reject',
      feedback: 'The submitted information could not be verified.',
      applicationStatus: 'rejected',
    });

    const [access] = await getDatabase()
      .db.select()
      .from(sellerOperatingAccess)
      .where(eq(sellerOperatingAccess.userId, approved.owner.id));
    const [changedApplication] = await getDatabase()
      .db.select()
      .from(sellerApplications)
      .where(eq(sellerApplications.id, changesRequested.id));
    const applicantStatus = await request(
      changesRequested.owner,
      'GET',
      '/api/v1/me/seller-applications/current',
    );

    expect(access).toMatchObject({
      userId: approved.owner.id,
      applicationId: approved.id,
      status: 'active',
    });
    expect(changedApplication?.proofOfAuthorityRequired).toBe(true);
    expect(applicantStatus.json<ApplicationResponse>().data.application?.review).toMatchObject({
      decision: 'request_changes',
      feedback: 'Please provide proof of authority.',
      requestedEvidence: ['proof_of_authority'],
    });
  });

  it('requires requested proof of authority for resubmission and preserves review feedback', async () => {
    const reviewer = await createUser({ administrator: true, elevation: 'valid' });
    const application = await createSubmittedApplication('commercial');
    await addEvidence(application.id, 'applicant_id');
    await addEvidence(application.id, 'business_registration');

    const decision = await decide(reviewer, application.id, {
      expectedRevision: application.revision,
      decision: 'request_changes',
      feedback: 'Please provide proof of authority.',
      requestedEvidence: ['proof_of_authority'],
    });
    expect(decision.statusCode).toBe(200);

    const changed = await getDatabase()
      .db.select({ revision: sellerApplications.revision })
      .from(sellerApplications)
      .where(eq(sellerApplications.id, application.id));
    const revision = changed[0]?.revision;
    if (!revision) throw new Error('Reviewed application revision was not found.');

    const missingProof = await request(
      application.owner,
      'POST',
      `/api/v1/me/seller-applications/${application.id}/submit`,
      { expectedRevision: revision },
    );
    expect(missingProof.statusCode).toBe(400);
    expect(missingProof.json<ApiErrorResponse>().error.details).toContainEqual({
      field: 'evidence.proof_of_authority',
      rule: 'required',
    });

    await addEvidence(application.id, 'proof_of_authority');
    const resubmitted = await request(
      application.owner,
      'POST',
      `/api/v1/me/seller-applications/${application.id}/submit`,
      { expectedRevision: revision },
    );

    expect(resubmitted.statusCode).toBe(200);
    expect(resubmitted.json<ApplicationResponse>().data.application).toMatchObject({
      status: 'submitted',
      proofOfAuthorityRequired: false,
      review: {
        decision: 'request_changes',
        feedback: 'Please provide proof of authority.',
        requestedEvidence: ['proof_of_authority'],
      },
    });
  });

  it('rejects stale and duplicate decisions and allows only one competing decision to win', async () => {
    const reviewerOne = await createUser({ administrator: true, elevation: 'valid' });
    const reviewerTwo = await createUser({ administrator: true, elevation: 'valid' });
    const staleTarget = await createSubmittedApplication();
    const competingTarget = await createSubmittedApplication();

    const stale = await decide(reviewerOne, staleTarget.id, {
      expectedRevision: staleTarget.revision - 1,
      decision: 'reject',
      feedback: 'Stale synthetic decision.',
    });
    expect(stale.statusCode).toBe(409);

    const competing = await Promise.all([
      decide(reviewerOne, competingTarget.id, {
        expectedRevision: competingTarget.revision,
        decision: 'approve',
      }),
      decide(reviewerTwo, competingTarget.id, {
        expectedRevision: competingTarget.revision,
        decision: 'reject',
        feedback: 'Competing synthetic decision.',
      }),
    ]);

    expect(competing.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const duplicate = await decide(reviewerOne, competingTarget.id, {
      expectedRevision: competingTarget.revision,
      decision: 'approve',
    });
    expect(duplicate.statusCode).toBe(409);

    const decisions = await getDatabase().pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM seller_application_review_decisions
        WHERE application_id = $1 AND reviewed_revision = $2`,
      [competingTarget.id, competingTarget.revision],
    );
    expect(decisions.rows[0]?.count).toBe('1');
  });

  it('rolls back application approval and access changes when access insertion fails', async () => {
    const reviewer = await createUser({ administrator: true, elevation: 'valid' });
    const application = await createSubmittedApplication();
    const conflictingAccessOwner = await createUser();

    // The deliberately conflicting synthetic row makes the approval's access
    // insert fail on the unique application constraint, exercising rollback.
    await getDatabase().db.insert(sellerOperatingAccess).values({
      userId: conflictingAccessOwner.id,
      applicationId: application.id,
      status: 'active',
    });

    const response = await decide(reviewer, application.id, {
      expectedRevision: application.revision,
      decision: 'approve',
    });

    expect(response.statusCode).toBe(409);

    const [storedApplication] = await getDatabase()
      .db.select({ status: sellerApplications.status, revision: sellerApplications.revision })
      .from(sellerApplications)
      .where(eq(sellerApplications.id, application.id));
    const decisionRows = await getDatabase()
      .db.select()
      .from(sellerApplicationReviewDecisions)
      .where(eq(sellerApplicationReviewDecisions.applicationId, application.id));
    const [applicantAccess] = await getDatabase()
      .db.select()
      .from(sellerOperatingAccess)
      .where(eq(sellerOperatingAccess.userId, application.owner.id));

    expect(storedApplication).toEqual({ status: 'submitted', revision: application.revision });
    expect(decisionRows).toHaveLength(0);
    expect(applicantAccess).toBeUndefined();
  });
});
