import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
import {
  PrivateEvidenceFileStore,
  MAX_EVIDENCE_FILE_BYTES,
} from '../../../../src/infrastructure/storage/private-evidence-file-store.js';
import { identityUsers } from '../../../../src/modules/identity/accounts/user.table.js';
import { identityUserPermissions } from '../../../../src/modules/identity/accounts/permission.table.js';
import { identitySessions } from '../../../../src/modules/identity/sessions/session.table.js';
import { createSession } from '../../../../src/modules/identity/sessions/session.service.js';
import { sellerApplications } from '../../../../src/modules/seller-onboarding/application.table.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../helpers/test-database.js';

const runId = randomUUID();
const fixtureUserIds: string[] = [];
const boundary = `----tx-evidence-${runId}`;
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let database: DatabaseClient | undefined;
let app: FastifyInstance | undefined;
let fileStore: PrivateEvidenceFileStore | undefined;
let storageDirectory: string | undefined;
let verifiedTestDatabase = false;
let sequence = 0;

interface UserFixture {
  id: string;
  token: string;
}

interface ApplicationBody {
  data: {
    application: {
      id: string;
      revision: number;
    };
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
  const email = `seller-evidence-${runId}-${sequence}@example.test`;
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
  if (!user) throw new Error('Could not create evidence test user.');
  fixtureUserIds.push(user.id);

  const session = await createSession(getDatabase().db, user.id);
  if (!session) throw new Error('Could not create evidence test session.');

  return { id: user.id, token: session.rawToken };
}

async function createDraft(token: string, category: 'individual' | 'commercial' = 'individual') {
  return getApp().inject({
    method: 'POST',
    url: '/api/v1/me/seller-applications',
    headers: { authorization: `Bearer ${token}` },
    payload: { category },
  });
}

async function createSubmittedApplication(owner: UserFixture): Promise<string> {
  const response = await createDraft(owner.token, 'individual');
  expect(response.statusCode, response.body).toBe(201);
  const applicationId = response.json<ApplicationBody>().data.application.id;

  await getDatabase()
    .db.update(sellerApplications)
    .set({
      status: 'submitted',
      firstSubmittedAt: new Date(),
    })
    .where(eq(sellerApplications.id, applicationId));

  return applicationId;
}

function multipartPayload(bytes: Buffer, mediaType = 'image/png'): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.png"\r\nContent-Type: ${mediaType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

function upload(
  token: string,
  applicationId: string,
  revision: number,
  bytes: Buffer = pngBytes,
  mediaType = 'image/png',
  type: 'applicant_id' | 'business_registration' | 'proof_of_authority' = 'applicant_id',
) {
  return getApp().inject({
    method: 'PUT',
    url: `/api/v1/me/seller-applications/${applicationId}/evidence/${type}?expectedRevision=${revision}`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: multipartPayload(bytes, mediaType),
  });
}

function readEvidence(token: string, applicationId: string, type = 'applicant_id', admin = false) {
  return getApp().inject({
    method: 'GET',
    url: `${admin ? '/api/v1/admin' : '/api/v1/me'}/seller-applications/${applicationId}/evidence/${type}`,
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

function submitApplication(token: string, applicationId: string, expectedRevision: number) {
  return getApp().inject({
    method: 'POST',
    url: `/api/v1/me/seller-applications/${applicationId}/submit`,
    headers: { authorization: `Bearer ${token}` },
    payload: { expectedRevision },
  });
}

async function prepareIndividualApplication(token: string) {
  const draft = await createDraft(token, 'individual');
  expect(draft.statusCode, draft.body).toBe(201);
  const applicationId = draft.json<ApplicationBody>().data.application.id;

  const updated = await updateApplication(token, applicationId, {
    expectedRevision: 1,
    legalName: 'Synthetic Individual Applicant',
    sellerDisplayName: 'Yaounde Tennis Gear',
    areaServed: 'Mfoundi',
  });
  expect(updated.statusCode, updated.body).toBe(200);

  const uploaded = await upload(token, applicationId, 2);
  expect(uploaded.statusCode, uploaded.body).toBe(200);

  return { applicationId, revision: 3 };
}

async function prepareCommercialApplication(token: string) {
  const draft = await createDraft(token, 'commercial');
  expect(draft.statusCode, draft.body).toBe(201);
  const applicationId = draft.json<ApplicationBody>().data.application.id;

  const updated = await updateApplication(token, applicationId, {
    expectedRevision: 1,
    legalName: 'Synthetic Commercial Applicant',
    registeredBusinessName: 'Synthetic Tennis Trading Ltd',
    businessRole: 'Director',
    areaServed: 'Mfoundi',
  });
  expect(updated.statusCode, updated.body).toBe(200);

  const applicantId = await upload(token, applicationId, 2);
  expect(applicantId.statusCode, applicantId.body).toBe(200);

  const businessRegistration = await upload(
    token,
    applicationId,
    3,
    pngBytes,
    'image/png',
    'business_registration',
  );
  expect(businessRegistration.statusCode, businessRegistration.body).toBe(200);

  return { applicationId, revision: 4 };
}

async function markChangesRequested(applicationId: string, proofRequired: boolean) {
  const firstSubmittedAt = new Date('2026-01-15T12:00:00.000Z');

  await getDatabase()
    .db.update(sellerApplications)
    .set({
      status: 'changes_requested',
      firstSubmittedAt,
      proofOfAuthorityRequired: proofRequired,
    })
    .where(eq(sellerApplications.id, applicationId));

  return firstSubmittedAt;
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  verifiedTestDatabase = true;

  storageDirectory = await mkdtemp(join(tmpdir(), 'tennis-xpress-evidence-integration-'));
  fileStore = new PrivateEvidenceFileStore(storageDirectory);
  await fileStore.initialize();

  app = buildApp({ database, evidenceFileStore: fileStore });
  await app.ready();
});

afterAll(async () => {
  try {
    if (database && verifiedTestDatabase && fixtureUserIds.length > 0) {
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

describe('seller application evidence', () => {
  it('uploads and retrieves evidence for the owner without exposing private metadata', async () => {
    const owner = await createUser();
    const draft = await createDraft(owner.token);
    const applicationId = draft.json<ApplicationBody>().data.application.id;

    const uploaded = await upload(owner.token, applicationId, 1);
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json().data.evidence).toMatchObject({
      type: 'applicant_id',
      mediaType: 'image/png',
      byteSize: pngBytes.length,
      revision: 2,
    });
    expect(uploaded.body).not.toMatch(/storageKey|storage_key|sha256|filename/i);

    const retrieved = await readEvidence(owner.token, applicationId);
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.headers['content-type']).toContain('image/png');
    expect(retrieved.headers['x-content-type-options']).toBe('nosniff');
    expect(retrieved.rawPayload).toEqual(pngBytes);
  });

  it('replaces evidence only at the current revision and preserves the replacement bytes', async () => {
    const owner = await createUser();
    const draft = await createDraft(owner.token);
    const applicationId = draft.json<ApplicationBody>().data.application.id;

    expect((await upload(owner.token, applicationId, 1)).statusCode).toBe(200);
    const replacement = Buffer.concat([pngBytes, Buffer.from([1, 2, 3])]);
    const uploaded = await upload(owner.token, applicationId, 2, replacement);

    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json().data.evidence.revision).toBe(3);

    const stale = await upload(owner.token, applicationId, 2, pngBytes);
    expect(stale.statusCode).toBe(409);

    const retrieved = await readEvidence(owner.token, applicationId);
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.rawPayload).toEqual(replacement);
  });

  it('rejects unsupported file bytes and keeps the existing evidence readable', async () => {
    const owner = await createUser();
    const draft = await createDraft(owner.token);
    const applicationId = draft.json<ApplicationBody>().data.application.id;

    expect((await upload(owner.token, applicationId, 1)).statusCode).toBe(200);

    const invalid = await upload(
      owner.token,
      applicationId,
      2,
      Buffer.from('not an image'),
      'image/png',
    );
    expect(invalid.statusCode).toBe(400);

    const retrieved = await readEvidence(owner.token, applicationId);
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.rawPayload).toEqual(pngBytes);
  });

  it('returns 413 when the streamed upload exceeds the configured limit', async () => {
    const owner = await createUser();
    const draft = await createDraft(owner.token);
    const applicationId = draft.json<ApplicationBody>().data.application.id;
    const oversized = Buffer.concat([
      pngBytes,
      Buffer.alloc(MAX_EVIDENCE_FILE_BYTES - pngBytes.length + 1, 0x41),
    ]);

    const response = await upload(owner.token, applicationId, 1, oversized);
    expect(response.statusCode).toBe(413);
  });

  it('returns the same 404 for a foreign application and an unknown ID', async () => {
    const owner = await createUser();
    const other = await createUser();
    const draft = await createDraft(owner.token);
    const applicationId = draft.json<ApplicationBody>().data.application.id;

    const foreign = await upload(other.token, applicationId, 1);
    const unknown = await upload(other.token, randomUUID(), 1);

    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.json().error).toEqual(unknown.json().error);
  });

  it('rejects uploads after submission', async () => {
    const owner = await createUser();
    const applicationId = await createSubmittedApplication(owner);

    const response = await upload(owner.token, applicationId, 1);
    expect(response.statusCode).toBe(409);
  });

  it('requires current Admin permission and MFA elevation for reviewer retrieval', async () => {
    const owner = await createUser();
    const draft = await createDraft(owner.token);
    const applicationId = draft.json<ApplicationBody>().data.application.id;
    expect((await upload(owner.token, applicationId, 1)).statusCode).toBe(200);
    await getDatabase()
      .db.update(sellerApplications)
      .set({ status: 'submitted', firstSubmittedAt: new Date() })
      .where(eq(sellerApplications.id, applicationId));

    const admin = await createUser();
    await getDatabase()
      .db.insert(identityUserPermissions)
      .values({ userId: admin.id, permission: 'administrator' });

    const denied = await readEvidence(admin.token, applicationId, 'applicant_id', true);
    expect(denied.statusCode).toBe(403);

    const sessionRows = await getDatabase()
      .db.select({ id: identitySessions.id })
      .from(identitySessions)
      .where(
        eq(
          identitySessions.tokenDigest,
          (await import('../../../../src/modules/identity/token.js')).digestIdentityToken(
            admin.token,
          ),
        ),
      )
      .limit(1);

    const sessionId = sessionRows[0]?.id;
    if (!sessionId) throw new Error('Admin session row was not found.');

    await getDatabase()
      .db.update(identitySessions)
      .set({
        adminMfaElevatedAt: new Date(Date.now() - 60_000),
        adminMfaElevatedUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(identitySessions.id, sessionId));

    const allowed = await readEvidence(admin.token, applicationId, 'applicant_id', true);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.rawPayload).toEqual(pngBytes);

    await getDatabase()
      .db.update(identitySessions)
      .set({
        adminMfaElevatedUntil: new Date(Date.now() - 1_000),
      })
      .where(eq(identitySessions.id, sessionId));

    const expired = await readEvidence(admin.token, applicationId, 'applicant_id', true);
    expect(expired.statusCode).toBe(403);
  });

  it('prevents an administrator from retrieving their own application for review', async () => {
    const admin = await createUser();
    await getDatabase()
      .db.insert(identityUserPermissions)
      .values({ userId: admin.id, permission: 'administrator' });

    const draft = await createDraft(admin.token);
    const applicationId = draft.json<ApplicationBody>().data.application.id;

    expect((await upload(admin.token, applicationId, 1)).statusCode).toBe(200);

    await getDatabase()
      .db.update(sellerApplications)
      .set({
        status: 'submitted',
        firstSubmittedAt: new Date(),
      })
      .where(eq(sellerApplications.id, applicationId));

    const sessionRows = await getDatabase()
      .db.select({ id: identitySessions.id })
      .from(identitySessions)
      .where(eq(identitySessions.userId, admin.id))
      .limit(1);
    const sessionId = sessionRows[0]?.id;
    if (!sessionId) throw new Error('Admin session row was not found.');

    await getDatabase()
      .db.update(identitySessions)
      .set({
        adminMfaElevatedAt: new Date(Date.now() - 60_000),
        adminMfaElevatedUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(identitySessions.id, sessionId));

    const response = await readEvidence(admin.token, applicationId, 'applicant_id', true);
    expect(response.statusCode).toBe(404);
  });

  it('does not leave staging files after a malformed interrupted multipart request', async () => {
    const owner = await createUser();
    const draft = await createDraft(owner.token);
    const applicationId = draft.json<ApplicationBody>().data.application.id;

    const response = await getApp().inject({
      method: 'PUT',
      url: `/api/v1/me/seller-applications/${applicationId}/evidence/applicant_id?expectedRevision=1`,
      headers: {
        authorization: `Bearer ${owner.token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="broken.png"\r\nContent-Type: image/png\r\n\r\n${pngBytes.toString('binary')}`,
      ),
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const staging = await readdir(join(storageDirectory!, '.staging'));
    expect(staging).toHaveLength(0);
  });

  describe('seller application submission', () => {
    it('submits a complete Individual application and blocks later edits and evidence replacement', async () => {
      const owner = await createUser();
      const { applicationId, revision } = await prepareIndividualApplication(owner.token);

      const submitted = await submitApplication(owner.token, applicationId, revision);

      expect(submitted.statusCode, submitted.body).toBe(200);
      expect(submitted.json().data.application).toMatchObject({
        id: applicationId,
        category: 'individual',
        status: 'submitted',
        revision: 4,
        legalName: 'Synthetic Individual Applicant',
        sellerDisplayName: 'Yaounde Tennis Gear',
        areaServed: 'Mfoundi',
      });

      const current = await getApp().inject({
        method: 'GET',
        url: '/api/v1/me/seller-applications/current',
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(current.statusCode).toBe(200);
      expect(current.json().data.application).toMatchObject({
        id: applicationId,
        status: 'submitted',
        revision: 4,
      });

      const edit = await updateApplication(owner.token, applicationId, {
        expectedRevision: 4,
        areaServed: 'Another area',
      });
      expect(edit.statusCode).toBe(409);

      const evidenceReplacement = await upload(owner.token, applicationId, 4);
      expect(evidenceReplacement.statusCode).toBe(409);
    });

    it('submits a complete Commercial application without optional fields', async () => {
      const owner = await createUser();
      const { applicationId, revision } = await prepareCommercialApplication(owner.token);

      const submitted = await submitApplication(owner.token, applicationId, revision);

      expect(submitted.statusCode, submitted.body).toBe(200);
      expect(submitted.json().data.application).toMatchObject({
        id: applicationId,
        category: 'commercial',
        status: 'submitted',
        revision: 5,
        legalName: 'Synthetic Commercial Applicant',
        registeredBusinessName: 'Synthetic Tennis Trading Ltd',
        businessRole: 'Director',
        areaServed: 'Mfoundi',
        contactPhone: null,
        storefrontName: null,
      });
    });

    it('reports every missing Individual field and required document', async () => {
      const owner = await createUser();
      const draft = await createDraft(owner.token, 'individual');
      const applicationId = draft.json<ApplicationBody>().data.application.id;

      const response = await submitApplication(owner.token, applicationId, 1);

      expect(response.statusCode).toBe(400);
      const body = response.json<{
        error: { code: string; details?: Array<{ field: string; rule: string }> };
      }>();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toEqual([
        { field: 'legalName', rule: 'required' },
        { field: 'sellerDisplayName', rule: 'required' },
        { field: 'areaServed', rule: 'required' },
        { field: 'evidence.applicant_id', rule: 'required' },
      ]);
    });

    it('returns the same not-found error for foreign and unknown application IDs', async () => {
      const owner = await createUser();
      const other = await createUser();
      const draft = await createDraft(owner.token, 'individual');
      const applicationId = draft.json<ApplicationBody>().data.application.id;

      const foreign = await submitApplication(other.token, applicationId, 1);
      const unknown = await submitApplication(other.token, randomUUID(), 1);

      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(foreign.json().error).toEqual(unknown.json().error);
    });

    it('rejects stale and repeated submission requests', async () => {
      const owner = await createUser();
      const { applicationId, revision } = await prepareIndividualApplication(owner.token);

      const stale = await submitApplication(owner.token, applicationId, revision - 1);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toEqual({
        code: 'REQUEST_ERROR',
        message: 'Request failed',
      });

      const submitted = await submitApplication(owner.token, applicationId, revision);
      expect(submitted.statusCode).toBe(200);

      const repeated = await submitApplication(owner.token, applicationId, revision);
      expect(repeated.statusCode).toBe(409);
    });

    it('allows Commercial resubmission when proof of authority was not requested', async () => {
      const owner = await createUser();
      const { applicationId, revision } = await prepareCommercialApplication(owner.token);
      const originalFirstSubmittedAt = await markChangesRequested(applicationId, false);

      const submitted = await submitApplication(owner.token, applicationId, revision);

      expect(submitted.statusCode, submitted.body).toBe(200);
      expect(submitted.json().data.application).toMatchObject({
        status: 'submitted',
        revision: revision + 1,
      });

      const [stored] = await getDatabase()
        .db.select({
          firstSubmittedAt: sellerApplications.firstSubmittedAt,
          proofOfAuthorityRequired: sellerApplications.proofOfAuthorityRequired,
        })
        .from(sellerApplications)
        .where(eq(sellerApplications.id, applicationId))
        .limit(1);

      expect(stored?.firstSubmittedAt?.toISOString()).toBe(originalFirstSubmittedAt.toISOString());
      expect(stored?.proofOfAuthorityRequired).toBe(false);
    });

    it('requires requested proof of authority before Commercial resubmission', async () => {
      const owner = await createUser();
      const { applicationId, revision } = await prepareCommercialApplication(owner.token);
      const originalFirstSubmittedAt = await markChangesRequested(applicationId, true);

      const missingProof = await submitApplication(owner.token, applicationId, revision);
      expect(missingProof.statusCode).toBe(400);
      expect(missingProof.json().error.details).toContainEqual({
        field: 'evidence.proof_of_authority',
        rule: 'required',
      });

      const authorityEvidence = await upload(
        owner.token,
        applicationId,
        revision,
        pngBytes,
        'image/png',
        'proof_of_authority',
      );
      expect(authorityEvidence.statusCode, authorityEvidence.body).toBe(200);

      const submitted = await submitApplication(owner.token, applicationId, revision + 1);
      expect(submitted.statusCode, submitted.body).toBe(200);
      expect(submitted.json().data.application).toMatchObject({
        status: 'submitted',
        revision: revision + 2,
      });

      const [stored] = await getDatabase()
        .db.select({
          firstSubmittedAt: sellerApplications.firstSubmittedAt,
          proofOfAuthorityRequired: sellerApplications.proofOfAuthorityRequired,
        })
        .from(sellerApplications)
        .where(eq(sellerApplications.id, applicationId))
        .limit(1);

      expect(stored?.firstSubmittedAt?.toISOString()).toBe(originalFirstSubmittedAt.toISOString());
      expect(stored?.proofOfAuthorityRequired).toBe(false);
    });

    it('serializes submission against a concurrent draft edit', async () => {
      const owner = await createUser();
      const { applicationId, revision } = await prepareIndividualApplication(owner.token);

      const [submission, edit] = await Promise.all([
        submitApplication(owner.token, applicationId, revision),
        updateApplication(owner.token, applicationId, {
          expectedRevision: revision,
          areaServed: 'Concurrent edit area',
        }),
      ]);

      expect([submission.statusCode, edit.statusCode].sort()).toEqual([200, 409]);

      const current = await getApp().inject({
        method: 'GET',
        url: '/api/v1/me/seller-applications/current',
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(current.statusCode).toBe(200);

      const application = current.json().data.application;
      if (submission.statusCode === 200) {
        expect(application).toMatchObject({
          status: 'submitted',
          revision: revision + 1,
          areaServed: 'Mfoundi',
        });
      } else {
        expect(edit.statusCode).toBe(200);
        expect(application).toMatchObject({
          status: 'draft',
          revision: revision + 1,
          areaServed: 'Concurrent edit area',
        });
      }
    });
  });
});
