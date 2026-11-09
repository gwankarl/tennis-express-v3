import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../../../src/app.js';
import { requireWorkspaceAccess } from '../../../../../src/http/guards/authorize-workspace.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../../src/infrastructure/database/client.js';
import { FakeEmailSender } from '../../../../helpers/fake-email-sender.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../../helpers/test-database.js';
import { hashPassword } from '../../../../../src/modules/identity/passwords/credentials.js';
import { createSession } from '../../../../../src/modules/identity/sessions/session.service.js';
import {
  digestIdentityToken,
  generateSessionToken,
} from '../../../../../src/modules/identity/token.js';
import { createTotpCode, verifyTotpCode } from '../../../../../src/modules/identity/admin/totp.js';
import { digestRecoveryCode } from '../../../../../src/modules/identity/admin/recovery-codes.js';
import { consumeMfaAttempt } from '../../../../../src/modules/identity/admin/mfa-attempts.service.js';

const runId = randomUUID();
const fixtureUserIds: string[] = [];
const password = 'synthetic administrator passphrase';
const mfaConfig = {
  encryptionKey: Buffer.alloc(32, 0x11).toString('base64'),
  keyVersion: 'integration-v1',
  attemptHmacKey: Buffer.alloc(32, 0x22).toString('base64'),
};
const emailSender = new FakeEmailSender();

let database: DatabaseClient | undefined;
let appDatabase: DatabaseClient | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let testDatabaseVerified = false;
let sequence = 0;
let ipSequence = 1;

function getDatabase(): DatabaseClient {
  if (!database) throw new Error('Test database was not initialized.');
  return database;
}

function getApp(): NonNullable<typeof app> {
  if (!app) throw new Error('MFA test app was not initialized.');
  return app;
}

function nextIpAddress(): string {
  const runNamespace = runId.replaceAll('-', '');
  const address = `2001:db8:${runNamespace.slice(0, 4)}:${runNamespace.slice(4, 8)}::${ipSequence}`;
  ipSequence = (ipSequence % 250) + 1;
  return address;
}

async function createUser(options: { administrator?: boolean } = {}): Promise<{
  id: string;
  email: string;
}> {
  sequence += 1;
  const id = randomUUID();
  const email = `admin-mfa-${runId}-${sequence}@example.test`;
  fixtureUserIds.push(id);

  await getDatabase().pool.query(
    `INSERT INTO identity_users
       (id, delivery_email, normalized_email, status, email_verified_at)
     VALUES ($1, $2, $2, 'active', now())`,
    [id, email],
  );

  await getDatabase().pool.query(
    `INSERT INTO identity_credentials (user_id, password_hash)
     VALUES ($1, $2)`,
    [id, await hashPassword(password)],
  );

  if (options.administrator !== false) {
    await getDatabase().pool.query(
      `INSERT INTO identity_user_permissions (user_id, permission)
       VALUES ($1, 'administrator')`,
      [id],
    );
  }

  return { id, email };
}

async function createUserSession(userId: string) {
  const session = await createSession(getDatabase().db, userId);
  if (!session) throw new Error('Could not create the synthetic user session.');
  return session;
}

async function issueEnrollmentAuthorization(
  userId: string,
  expiresAt = new Date(Date.now() + 15 * 60 * 1000),
): Promise<string> {
  const token = generateSessionToken();
  const issuedAt =
    expiresAt.getTime() <= Date.now() ? new Date(expiresAt.getTime() - 60_000) : new Date();

  await getDatabase().pool.query(
    `INSERT INTO identity_admin_enrollment_authorizations
       (target_user_id, authorization_digest, issued_by_operator_id,
        approved_by_operator_id, issued_at, expires_at)
     VALUES ($1, $2, 'test-operator-a', 'test-operator-b', $3, $4)`,
    [userId, token.digest, issuedAt, expiresAt],
  );

  return token.rawToken;
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function startEnrollment(
  userId: string,
  sessionToken: string,
  authorization: string,
  options: { submittedPassword?: string; ipAddress?: string } = {},
) {
  return getApp().inject({
    method: 'POST',
    url: '/api/v1/admin/mfa/enrollment',
    remoteAddress: options.ipAddress ?? nextIpAddress(),
    headers: authHeaders(sessionToken),
    payload: {
      password: options.submittedPassword ?? password,
      authorization,
    },
  });
}

async function codeOutsideWindow(secret: string, now = new Date()): Promise<string> {
  for (let value = 0; value < 1_000_000; value += 1) {
    const candidate = String(value).padStart(6, '0');
    if (verifyTotpCode(secret, candidate, now) === null) return candidate;
  }

  throw new Error('Could not find an invalid synthetic TOTP code.');
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  appDatabase = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(appDatabase.pool);

  app = buildApp({
    database: appDatabase,
    emailSender,
    frontendOrigin: 'http://127.0.0.1:5173',
    adminMfa: mfaConfig,
    workspaceAuthorizationSources: {
      isSessionMfaElevated: async (sessionId) => {
        const result = await appDatabase!.pool.query(
          `SELECT 1
             FROM identity_sessions
            WHERE id = $1
              AND revoked_at IS NULL
              AND admin_mfa_elevated_until > now()`,
          [sessionId],
        );
        return result.rowCount === 1;
      },
    },
  });

  app.get('/__test/admin-only', { preHandler: requireWorkspaceAccess('admin') }, async () => ({
    ok: true,
  }));
  app.get('/__test/buyer-only', { preHandler: requireWorkspaceAccess('buyer') }, async () => ({
    ok: true,
  }));
});

beforeEach(() => {
  emailSender.reset();
});

afterAll(async () => {
  try {
    await app?.close();

    if (database && testDatabaseVerified && fixtureUserIds.length > 0) {
      await database.pool.query(
        `DELETE FROM identity_admin_audit_events
          WHERE target_user_id = ANY($1::uuid[])`,
        [fixtureUserIds],
      );
      await database.pool.query(
        `DELETE FROM identity_admin_operations
          WHERE target_user_id = ANY($1::uuid[])`,
        [fixtureUserIds],
      );
      await database.pool.query(`DELETE FROM identity_users WHERE id = ANY($1::uuid[])`, [
        fixtureUserIds,
      ]);
    }
  } finally {
    await Promise.allSettled([appDatabase?.close(), database?.close()]);
  }
});

describe('administrator MFA enrollment and recovery routes', () => {
  it('starts and confirms enrollment once without granting Admin access', async () => {
    const user = await createUser();
    const session = await createUserSession(user.id);
    const authorization = await issueEnrollmentAuthorization(user.id);

    const startResponse = await startEnrollment(user.id, session.rawToken, authorization);
    expect(startResponse.statusCode, startResponse.body).toBe(200);
    expect(startResponse.headers['cache-control']).toContain('no-store');

    const setup = startResponse.json<{
      data: { secret: string; provisioningUri: string; expiresAt: string };
    }>().data;

    expect(setup.secret).toMatch(/^[A-Z2-7]+$/u);
    expect(setup.provisioningUri).toContain('otpauth://totp/');
    expect(new Date(setup.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const storedFactor = await getDatabase().pool.query<{
      status: string;
      secret_ciphertext: string;
      pending_session_id: string;
    }>(
      `SELECT status, secret_ciphertext, pending_session_id
         FROM identity_mfa_factors
        WHERE user_id = $1`,
      [user.id],
    );

    expect(storedFactor.rows[0]?.status).toBe('pending');
    expect(storedFactor.rows[0]?.secret_ciphertext).not.toContain(setup.secret);
    expect(storedFactor.rows[0]?.pending_session_id).toBe(session.sessionId);

    const currentStep = Math.floor(Date.now() / 1000 / 30);
    const code = createTotpCode(setup.secret, currentStep);
    const confirmation = await getApp().inject({
      method: 'POST',
      url: '/api/v1/admin/mfa/enrollment/confirm',
      remoteAddress: nextIpAddress(),
      headers: authHeaders(session.rawToken),
      payload: { code },
    });

    expect(confirmation.statusCode).toBe(200);
    const confirmed = confirmation.json<{
      data: { status: string; recoveryCodes: string[] };
    }>().data;
    expect(confirmed.status).toBe('enrolled');
    expect(confirmed.recoveryCodes).toHaveLength(10);

    const activeFactor = await getDatabase().pool.query<{
      status: string;
      last_accepted_time_step: number;
      admin_mfa_elevated_at: Date | null;
    }>(
      `SELECT f.status, f.last_accepted_time_step, s.admin_mfa_elevated_at
         FROM identity_mfa_factors f
         JOIN identity_sessions s ON s.id = $2
        WHERE f.user_id = $1`,
      [user.id, session.sessionId],
    );
    expect(activeFactor.rows[0]?.status).toBe('active');
    expect(activeFactor.rows[0]?.last_accepted_time_step).toBeGreaterThan(0);
    expect(activeFactor.rows[0]?.admin_mfa_elevated_at).toBeNull();

    const storedCodes = await getDatabase().pool.query<{ code_digest: string }>(
      `SELECT code_digest
         FROM identity_mfa_recovery_codes
        WHERE factor_id = (
          SELECT id FROM identity_mfa_factors WHERE user_id = $1
        )`,
      [user.id],
    );
    expect(storedCodes.rows).toHaveLength(10);
    expect(storedCodes.rows.map((row) => row.code_digest).sort()).toEqual(
      confirmed.recoveryCodes.map(digestRecoveryCode).sort(),
    );

    const adminResponse = await getApp().inject({
      method: 'GET',
      url: '/__test/admin-only',
      headers: authHeaders(session.rawToken),
    });
    const buyerResponse = await getApp().inject({
      method: 'GET',
      url: '/__test/buyer-only',
      headers: authHeaders(session.rawToken),
    });
    expect(adminResponse.statusCode).toBe(403);
    expect(buyerResponse.statusCode).toBe(200);

    const replay = await getApp().inject({
      method: 'POST',
      url: '/api/v1/admin/mfa/enrollment/confirm',
      remoteAddress: nextIpAddress(),
      headers: authHeaders(session.rawToken),
      payload: { code },
    });
    expect(replay.statusCode).toBe(400);
  });

  it('rejects a missing or revoked administrator grant', async () => {
    const missingGrantUser = await createUser({ administrator: false });
    const missingGrantSession = await createUserSession(missingGrantUser.id);
    const missingGrantAuthorization = await issueEnrollmentAuthorization(missingGrantUser.id);

    const missingGrant = await startEnrollment(
      missingGrantUser.id,
      missingGrantSession.rawToken,
      missingGrantAuthorization,
    );
    expect(missingGrant.statusCode).toBe(403);

    const revokedGrantUser = await createUser();
    const revokedGrantSession = await createUserSession(revokedGrantUser.id);
    const revokedGrantAuthorization = await issueEnrollmentAuthorization(revokedGrantUser.id);

    await getDatabase().pool.query(
      `DELETE FROM identity_user_permissions
        WHERE user_id = $1 AND permission = 'administrator'`,
      [revokedGrantUser.id],
    );

    const revokedGrant = await startEnrollment(
      revokedGrantUser.id,
      revokedGrantSession.rawToken,
      revokedGrantAuthorization,
    );
    expect(revokedGrant.statusCode).toBe(403);
  });

  it('rejects an expired authorization and prevents authorization reuse', async () => {
    const expiredUser = await createUser();
    const expiredSession = await createUserSession(expiredUser.id);
    const expiredAuthorization = await issueEnrollmentAuthorization(
      expiredUser.id,
      new Date(Date.now() - 1_000),
    );

    const expired = await startEnrollment(
      expiredUser.id,
      expiredSession.rawToken,
      expiredAuthorization,
    );
    expect(expired.statusCode).toBe(400);

    const reusedUser = await createUser();
    const reusedSession = await createUserSession(reusedUser.id);
    const authorization = await issueEnrollmentAuthorization(reusedUser.id);

    const first = await startEnrollment(reusedUser.id, reusedSession.rawToken, authorization);
    expect(first.statusCode).toBe(200);

    const second = await startEnrollment(reusedUser.id, reusedSession.rawToken, authorization);
    expect(second.statusCode).toBe(400);
  });

  it('rejects an incorrect fresh password and leaves enrollment unstarted', async () => {
    const user = await createUser();
    const session = await createUserSession(user.id);
    const authorization = await issueEnrollmentAuthorization(user.id);

    const response = await startEnrollment(user.id, session.rawToken, authorization, {
      submittedPassword: 'incorrect synthetic password',
    });

    expect(response.statusCode).toBe(401);
    const factor = await getDatabase().pool.query(
      `SELECT 1 FROM identity_mfa_factors WHERE user_id = $1`,
      [user.id],
    );
    expect(factor.rowCount).toBe(0);
  });

  it('rejects invalid TOTP and permits only one of two concurrent confirmations', async () => {
    const user = await createUser();
    const session = await createUserSession(user.id);
    const authorization = await issueEnrollmentAuthorization(user.id);
    const startResponse = await startEnrollment(user.id, session.rawToken, authorization);
    const secret = startResponse.json<{ data: { secret: string } }>().data.secret;

    const invalidCode = await codeOutsideWindow(secret);
    const invalid = await getApp().inject({
      method: 'POST',
      url: '/api/v1/admin/mfa/enrollment/confirm',
      remoteAddress: nextIpAddress(),
      headers: authHeaders(session.rawToken),
      payload: { code: invalidCode },
    });
    expect(invalid.statusCode).toBe(400);

    const currentStep = Math.floor(Date.now() / 1000 / 30);
    const validCode = createTotpCode(secret, currentStep);
    const results = await Promise.all([
      getApp().inject({
        method: 'POST',
        url: '/api/v1/admin/mfa/enrollment/confirm',
        remoteAddress: nextIpAddress(),
        headers: authHeaders(session.rawToken),
        payload: { code: validCode },
      }),
      getApp().inject({
        method: 'POST',
        url: '/api/v1/admin/mfa/enrollment/confirm',
        remoteAddress: nextIpAddress(),
        headers: authHeaders(session.rawToken),
        payload: { code: validCode },
      }),
    ]);

    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 400]);

    const codeCount = await getDatabase().pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM identity_mfa_recovery_codes
        WHERE factor_id = (
          SELECT id FROM identity_mfa_factors WHERE user_id = $1
        )`,
      [user.id],
    );
    expect(codeCount.rows[0]?.count).toBe(10);
  });

  it('enforces the shared five-attempt limit and 15-minute block', async () => {
    const accountSubject = `mfa-attempt-test-${runId}-${sequence}`;
    const ipAddress = `mfa-attempt-${runId}`;
    const now = new Date('2035-01-01T12:00:00.000Z');

    for (let attemptNumber = 1; attemptNumber <= 5; attemptNumber += 1) {
      const result = await consumeMfaAttempt({
        pool: getDatabase().pool,
        action: 'recovery',
        accountSubject,
        ipAddress,
        hmacKeyBase64: mfaConfig.attemptHmacKey,
        now,
      });
      expect(result.allowed, `attempt ${attemptNumber} was blocked too early`).toBe(true);
    }

    const blocked = await consumeMfaAttempt({
      pool: getDatabase().pool,
      action: 'recovery',
      accountSubject,
      ipAddress,
      hmacKeyBase64: mfaConfig.attemptHmacKey,
      now,
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(900);
  });

  it('uses one recovery code, revokes all sessions and the factor, then rejects reuse', async () => {
    const user = await createUser();
    const session = await createUserSession(user.id);
    const authorization = await issueEnrollmentAuthorization(user.id);
    const startResponse = await startEnrollment(user.id, session.rawToken, authorization);
    const secret = startResponse.json<{ data: { secret: string } }>().data.secret;
    const currentStep = Math.floor(Date.now() / 1000 / 30);

    const confirmation = await getApp().inject({
      method: 'POST',
      url: '/api/v1/admin/mfa/enrollment/confirm',
      remoteAddress: nextIpAddress(),
      headers: authHeaders(session.rawToken),
      payload: { code: createTotpCode(secret, currentStep) },
    });
    expect(confirmation.statusCode).toBe(200);

    const recoveryCodes = confirmation.json<{
      data: { recoveryCodes: string[] };
    }>().data.recoveryCodes;
    const usedCode = recoveryCodes[0]!;

    const recovery = await getApp().inject({
      method: 'POST',
      url: '/api/v1/admin/mfa/recovery',
      remoteAddress: nextIpAddress(),
      headers: authHeaders(session.rawToken),
      payload: {
        currentPassword: password,
        recoveryCode: usedCode,
      },
    });

    expect(recovery.statusCode).toBe(200);
    expect(recovery.headers['cache-control']).toContain('no-store');

    const recoveryData = recovery.json<{
      data: {
        status: string;
        adminHoldUntil: string;
        notificationSent: boolean;
        replacementEnrollmentAuthorization: string;
      };
    }>().data;

    expect(recoveryData.status).toBe('recovered');
    expect(recoveryData.notificationSent).toBe(true);
    expect(recoveryData.replacementEnrollmentAuthorization).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(emailSender.messages).toHaveLength(1);
    expect(emailSender.messages[0]?.text).not.toContain(usedCode);
    expect(emailSender.messages[0]?.text).not.toContain(
      recoveryData.replacementEnrollmentAuthorization,
    );

    const state = await getDatabase().pool.query<{
      revoked_at: Date | null;
      factor_status: string;
      consumed_at: Date | null;
      admin_hold_until: Date;
      authorization_digest: string;
    }>(
      `SELECT s.revoked_at,
              f.status AS factor_status,
              c.consumed_at,
              r.admin_hold_until,
              a.authorization_digest
         FROM identity_sessions s
         JOIN identity_mfa_factors f ON f.user_id = s.user_id
         JOIN identity_mfa_recovery_codes c ON c.factor_id = f.id
         JOIN identity_mfa_recoveries r ON r.user_id = s.user_id
         JOIN identity_admin_enrollment_authorizations a ON a.recovery_id = r.id
        WHERE s.id = $1 AND c.code_digest = $2`,
      [session.sessionId, digestRecoveryCode(usedCode)],
    );

    expect(state.rows[0]?.revoked_at).not.toBeNull();
    expect(state.rows[0]?.factor_status).toBe('revoked');
    expect(state.rows[0]?.consumed_at).not.toBeNull();
    expect(state.rows[0]?.admin_hold_until.getTime()).toBeGreaterThan(Date.now());
    expect(state.rows[0]?.authorization_digest).toBe(
      digestIdentityToken(recoveryData.replacementEnrollmentAuthorization),
    );

    const newSession = await createUserSession(user.id);
    const reuse = await getApp().inject({
      method: 'POST',
      url: '/api/v1/admin/mfa/recovery',
      remoteAddress: nextIpAddress(),
      headers: authHeaders(newSession.rawToken),
      payload: {
        currentPassword: password,
        recoveryCode: usedCode,
      },
    });
    expect(reuse.statusCode).toBe(409);

    const adminResponse = await getApp().inject({
      method: 'GET',
      url: '/__test/admin-only',
      headers: authHeaders(newSession.rawToken),
    });
    expect(adminResponse.statusCode).toBe(403);
  });
});
