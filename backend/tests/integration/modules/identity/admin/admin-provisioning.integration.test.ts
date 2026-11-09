import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../../../src/app.js';
import { requireWorkspaceAccess } from '../../../../../src/http/guards/authorize-workspace.js';
import {
  canonicalizeAdminIntent,
  executeAdminOperation,
  type AdminApproval,
  type AdminOperationIntent,
  type AdminOperator,
} from '../../../../../src/modules/identity/admin/admin-operations.service.js';
import { digestIdentityToken } from '../../../../../src/modules/identity/token.js';
import { createSession } from '../../../../../src/modules/identity/sessions/session.service.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../../src/infrastructure/database/client.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../../helpers/test-database.js';

const runId = randomUUID();
const fixtureUserIds: string[] = [];
let database: DatabaseClient | undefined;
let appDatabase: DatabaseClient | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let testDatabaseVerified = false;
let sequence = 0;

const keyPairs = [
  generateKeyPairSync('ed25519'),
  generateKeyPairSync('ed25519'),
  generateKeyPairSync('ed25519'),
];
const operators: AdminOperator[] = keyPairs.map((pair, index) => ({
  id: `synthetic-operator-${index + 1}`,
  accountUserId: randomUUID(),
  publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}));

function getDatabase(): DatabaseClient {
  if (!database) throw new Error('Test database was not initialized.');
  return database;
}

async function createUser(
  options: {
    id?: string;
    status?: string;
    verified?: boolean;
  } = {},
): Promise<{ id: string; email: string }> {
  sequence += 1;
  const id = options.id ?? randomUUID();
  const email = `admin-ops-${runId}-${sequence}@example.test`;
  const verifiedAt = options.verified === false ? null : new Date();
  await getDatabase().pool.query(
    `INSERT INTO identity_users (id, delivery_email, normalized_email, status, email_verified_at)
     VALUES ($1,$2,$2,$3,$4)`,
    [id, email, options.status ?? 'active', verifiedAt],
  );
  fixtureUserIds.push(id);
  return { id, email };
}

function makeIntent(
  target: { id: string; email: string },
  action: AdminOperationIntent['action'] = 'grant',
  additions: Partial<AdminOperationIntent> = {},
): AdminOperationIntent {
  return {
    environment: 'test',
    action,
    operationId: randomUUID(),
    targetUserId: target.id,
    normalizedEmail: target.email,
    caseReference: `CASE-${runId}-${sequence}`,
    reason: 'Synthetic integration test operation',
    relatedOperationId: null,
    ...additions,
  };
}

function approvalsFor(intent: AdminOperationIntent, indexes: number[]): AdminApproval[] {
  const payload = Buffer.from(canonicalizeAdminIntent(intent));
  return indexes.map((index) => ({
    operatorId: operators[index]!.id,
    signatureBase64: sign(null, payload, keyPairs[index]!.privateKey).toString('base64'),
  }));
}

async function getAuthorizationTestApp(): Promise<NonNullable<typeof app>> {
  if (app) return app;

  appDatabase = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(appDatabase.pool);
  app = buildApp({
    database: appDatabase,
    workspaceAuthorizationSources: {
      isSessionMfaElevated: async (sessionId) => {
        const result = await appDatabase!.pool.query(
          `SELECT 1 FROM identity_sessions
            WHERE id = $1 AND revoked_at IS NULL
              AND admin_mfa_elevated_until > now()`,
          [sessionId],
        );
        return result.rowCount === 1;
      },
    },
  });
  app.get('/__test/admin', { preHandler: requireWorkspaceAccess('admin') }, async () => ({
    ok: true,
  }));
  app.get('/__test/buyer', { preHandler: requireWorkspaceAccess('buyer') }, async () => ({
    ok: true,
  }));
  return app;
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;
});

afterAll(async () => {
  try {
    try {
      await app?.close();
    } finally {
      if (database && testDatabaseVerified && fixtureUserIds.length > 0) {
        await database.pool.query(
          'DELETE FROM identity_admin_audit_events WHERE target_user_id = ANY($1::uuid[])',
          [fixtureUserIds],
        );
        await database.pool.query(
          'DELETE FROM identity_admin_operations WHERE target_user_id = ANY($1::uuid[])',
          [fixtureUserIds],
        );
        await database.pool.query('DELETE FROM identity_users WHERE id = ANY($1::uuid[])', [
          fixtureUserIds,
        ]);
      }
    }
  } finally {
    await Promise.allSettled([appDatabase?.close(), database?.close()]);
  }
});

describe('controlled administrator provisioning and revocation', () => {
  it('requires two valid independent signatures and issues only a digest-backed enrollment authorization', async () => {
    const target = await createUser();
    const intent = makeIntent(target);
    const result = await executeAdminOperation(
      getDatabase().pool,
      intent,
      approvalsFor(intent, [0, 1]),
      operators,
    );

    expect(result.status).toBe('completed');
    expect(result.enrollmentState).toBe('authorization_issued');
    expect(result.enrollmentAuthorization).toBeTruthy();
    const permission = await getDatabase().pool.query(
      `SELECT 1 FROM identity_user_permissions WHERE user_id = $1 AND permission = 'administrator'`,
      [target.id],
    );
    expect(permission.rowCount).toBe(1);

    const authorization = await getDatabase().pool.query<{
      authorization_digest: string;
      expires_at: Date;
    }>(
      `SELECT authorization_digest, expires_at
         FROM identity_admin_enrollment_authorizations WHERE target_user_id = $1`,
      [target.id],
    );
    expect(authorization.rowCount).toBe(1);
    expect(authorization.rows[0]?.authorization_digest).toBe(
      digestIdentityToken(result.enrollmentAuthorization!),
    );
    expect(authorization.rows[0]?.authorization_digest).not.toBe(result.enrollmentAuthorization);
    expect(authorization.rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now());

    const audit = await getDatabase().pool.query<{
      event_type: string;
      approver_operator_id: string | null;
    }>(
      `SELECT event_type, approver_operator_id FROM identity_admin_audit_events WHERE operation_id = $1`,
      [intent.operationId],
    );
    expect(audit.rows.map((row) => row.event_type)).toContain('administrator_granted');
    expect(audit.rows.map((row) => row.event_type)).toContain('mfa_enrollment_authorized');
    expect(audit.rows.every((row) => row.approver_operator_id === operators[1]!.id)).toBe(true);

    const session = await createSession(getDatabase().db, target.id);
    expect(session).toBeDefined();
    const testApp = await getAuthorizationTestApp();
    const adminResponse = await testApp.inject({
      method: 'GET',
      url: '/__test/admin',
      headers: { authorization: `Bearer ${session!.rawToken}` },
    });
    const buyerResponse = await testApp.inject({
      method: 'GET',
      url: '/__test/buyer',
      headers: { authorization: `Bearer ${session!.rawToken}` },
    });
    expect(adminResponse.statusCode).toBe(403);
    expect(buyerResponse.statusCode).toBe(200);
  });

  it('rejects unauthorized, duplicate, and self-approving operators before mutation', async () => {
    const target = await createUser();
    const intent = makeIntent(target);
    const valid = approvalsFor(intent, [0, 1]);

    await expect(
      executeAdminOperation(getDatabase().pool, intent, [valid[0]!, valid[0]!], operators),
    ).rejects.toThrow();
    await expect(
      executeAdminOperation(
        getDatabase().pool,
        intent,
        [{ operatorId: 'unknown-operator', signatureBase64: valid[0]!.signatureBase64 }, valid[1]!],
        operators,
      ),
    ).rejects.toThrow();

    const selfOperator: AdminOperator = { ...operators[2]!, accountUserId: target.id };
    await expect(
      executeAdminOperation(getDatabase().pool, intent, approvalsFor(intent, [0, 2]), [
        operators[0]!,
        operators[1]!,
        selfOperator,
      ]),
    ).rejects.toThrow();

    const permission = await getDatabase().pool.query(
      `SELECT 1 FROM identity_user_permissions WHERE user_id = $1`,
      [target.id],
    );
    expect(permission.rowCount).toBe(0);
  });

  it('rejects mismatched, inactive, and unverified targets and records the denied outcome', async () => {
    const active = await createUser();
    const mismatched = makeIntent(active, 'grant', { normalizedEmail: 'wrong@example.test' });
    expect(
      (
        await executeAdminOperation(
          getDatabase().pool,
          mismatched,
          approvalsFor(mismatched, [0, 1]),
          operators,
        )
      ).status,
    ).toBe('rejected');

    const suspended = await createUser({ status: 'suspended' });
    const suspendedIntent = makeIntent(suspended);
    expect(
      (
        await executeAdminOperation(
          getDatabase().pool,
          suspendedIntent,
          approvalsFor(suspendedIntent, [0, 1]),
          operators,
        )
      ).status,
    ).toBe('rejected');

    const unverified = await createUser({ verified: false });
    const unverifiedIntent = makeIntent(unverified);
    expect(
      (
        await executeAdminOperation(
          getDatabase().pool,
          unverifiedIntent,
          approvalsFor(unverifiedIntent, [0, 1]),
          operators,
        )
      ).status,
    ).toBe('rejected');

    await getDatabase().pool.query(
      `INSERT INTO identity_user_permissions (user_id, permission) VALUES ($1, 'administrator')`,
      [suspended.id],
    );
    const revokeIntent = makeIntent(suspended, 'revoke');
    expect(
      (
        await executeAdminOperation(
          getDatabase().pool,
          revokeIntent,
          approvalsFor(revokeIntent, [0, 1]),
          operators,
        )
      ).status,
    ).toBe('completed');
    const remainingGrant = await getDatabase().pool.query(
      `SELECT 1 FROM identity_user_permissions WHERE user_id = $1 AND permission = 'administrator'`,
      [suspended.id],
    );
    expect(remainingGrant.rowCount).toBe(0);
  });

  it('makes retries and concurrent retries idempotent and does not reissue authorization', async () => {
    const target = await createUser();
    const intent = makeIntent(target);
    const approvals = approvalsFor(intent, [0, 1]);
    const results = await Promise.all([
      executeAdminOperation(getDatabase().pool, intent, approvals, operators),
      executeAdminOperation(getDatabase().pool, intent, approvals, operators),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['completed', 'replayed']);

    const replay = await executeAdminOperation(getDatabase().pool, intent, approvals, operators);
    expect(replay.status).toBe('replayed');
    expect(replay.enrollmentAuthorization).toBeUndefined();
    const count = await getDatabase().pool.query(
      `SELECT count(*)::int AS count FROM identity_admin_enrollment_authorizations WHERE target_user_id = $1`,
      [target.id],
    );
    expect(count.rows[0]?.count).toBe(1);

    const changed = { ...intent, reason: 'Changed intent under same idempotency key' };
    await expect(
      executeAdminOperation(getDatabase().pool, changed, approvalsFor(changed, [0, 1]), operators),
    ).rejects.toThrow(/different intent/u);
  });

  it('revokes Admin immediately, preserves Buyer sessions, and records a distinct emergency review', async () => {
    const target = await createUser();
    const grantIntent = makeIntent(target);
    await executeAdminOperation(
      getDatabase().pool,
      grantIntent,
      approvalsFor(grantIntent, [0, 1]),
      operators,
    );

    const session = await createSession(getDatabase().db, target.id);
    expect(session).toBeDefined();
    await getDatabase().pool.query(
      `UPDATE identity_sessions
          SET admin_mfa_elevated_at = now(), admin_mfa_elevated_until = LEAST(now() + interval '15 minutes', absolute_expires_at)
        WHERE id = $1`,
      [session!.sessionId],
    );

    const emergencyIntent = makeIntent(target, 'emergency_revoke');
    const emergency = await executeAdminOperation(
      getDatabase().pool,
      emergencyIntent,
      approvalsFor(emergencyIntent, [0]),
      operators,
    );
    expect(emergency.status).toBe('completed');

    const state = await getDatabase().pool.query<{
      permission_count: number;
      revoked_at: Date | null;
      elevated_at: Date | null;
      elevated_until: Date | null;
      consumed_at: Date | null;
    }>(
      `SELECT
         (SELECT count(*)::int FROM identity_user_permissions WHERE user_id = $1) AS permission_count,
         s.revoked_at, s.admin_mfa_elevated_at AS elevated_at,
         s.admin_mfa_elevated_until AS elevated_until,
         (SELECT consumed_at FROM identity_admin_enrollment_authorizations
           WHERE target_user_id = $1 ORDER BY issued_at DESC LIMIT 1) AS consumed_at
       FROM identity_sessions s WHERE s.id = $2`,
      [target.id, session!.sessionId],
    );
    expect(state.rows[0]?.permission_count).toBe(0);
    expect(state.rows[0]?.revoked_at).toBeNull();
    expect(state.rows[0]?.elevated_at).toBeNull();
    expect(state.rows[0]?.elevated_until).toBeNull();
    expect(state.rows[0]?.consumed_at).not.toBeNull();

    const reviewIntent = makeIntent(target, 'review_emergency_revoke', {
      caseReference: emergencyIntent.caseReference,
      relatedOperationId: emergencyIntent.operationId,
    });
    expect(
      (
        await executeAdminOperation(
          getDatabase().pool,
          reviewIntent,
          approvalsFor(reviewIntent, [1]),
          operators,
        )
      ).status,
    ).toBe('reviewed');

    const testApp = await getAuthorizationTestApp();

    const adminResponse = await testApp.inject({
      method: 'GET',
      url: '/__test/admin',
      headers: { authorization: `Bearer ${session!.rawToken}` },
    });
    const buyerResponse = await testApp.inject({
      method: 'GET',
      url: '/__test/buyer',
      headers: { authorization: `Bearer ${session!.rawToken}` },
    });
    expect(adminResponse.statusCode).toBe(403);
    expect(buyerResponse.statusCode).toBe(200);
  });
});
