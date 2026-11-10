import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
import { sellerApplicationEvidence } from '../../../../src/modules/seller-onboarding/application-evidence.table.js';
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
) {
  return getApp().inject({
    method: 'PUT',
    url: `/api/v1/me/seller-applications/${applicationId}/evidence/applicant_id?expectedRevision=${revision}`,
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
});
