import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login } from '../../../../../src/modules/identity/sessions/auth.service.js';
import {
  createSession,
  validateSession,
} from '../../../../../src/modules/identity/sessions/session.service.js';
import { identityCredentials } from '../../../../../src/modules/identity/passwords/credentials.table.js';
import { hashPassword } from '../../../../../src/modules/identity/passwords/credentials.js';
import { identityUserPermissions } from '../../../../../src/modules/identity/accounts/permission.table.js';
import { identityUsers } from '../../../../../src/modules/identity/accounts/user.table.js';
import {
  identityAdminAuditEvents,
  identityAdminEnrollmentAuthorizations,
  identityMfaFactors,
  identityMfaRecoveries,
  identityMfaRecoveryCodes,
} from '../../../../../src/modules/identity/admin/admin-security.table.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../../src/infrastructure/database/client.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../../helpers/test-database.js';
import { eq } from 'drizzle-orm';

const runId = randomUUID();
const fixtureUserIds: string[] = [];
const counterDigests: string[] = [];
let userSequence = 0;
let database: DatabaseClient | undefined;
let testDatabaseVerified = false;

function getDatabase(): DatabaseClient {
  if (!database) {
    throw new Error('Test database was not initialized.');
  }

  return database;
}

async function createUser(emailPrefix = 'admin-persistence'): Promise<{
  id: string;
  email: string;
}> {
  userSequence += 1;
  const email = `${emailPrefix}-${runId}-${userSequence}@example.test`;
  const users = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: email,
      status: 'active',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: identityUsers.id });

  const user = users[0];
  if (!user) {
    throw new Error('Could not create a synthetic MFA persistence user.');
  }

  fixtureUserIds.push(user.id);
  return { id: user.id, email };
}

async function createActiveFactor(userId: string): Promise<string> {
  const factors = await getDatabase()
    .db.insert(identityMfaFactors)
    .values({
      userId,
      factorType: 'totp',
      status: 'active',
      secretCiphertext: 'synthetic-ciphertext-not-a-real-seed',
      keyVersion: 'synthetic-key-version',
      confirmedAt: new Date(),
      lastAcceptedTimeStep: null,
    })
    .returning({ id: identityMfaFactors.id });

  const factor = factors[0];
  if (!factor) {
    throw new Error('Could not create a synthetic active factor.');
  }

  return factor.id;
}

async function expectPgCode(action: Promise<unknown>, code: string): Promise<void> {
  let rejection: unknown;

  try {
    await action;
  } catch (error) {
    rejection = error;
  }

  expect(rejection).toBeDefined();

  if (typeof rejection !== 'object' || rejection === null) {
    throw new Error('Expected a PostgreSQL error object.');
  }

  const error = rejection as { cause?: unknown; code?: unknown };
  const cause =
    typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { code?: unknown })
      : undefined;

  expect(error.code ?? cause?.code).toBe(code);
}

function digestForTest(label: string): string {
  return createHash('sha256').update(`${runId}:${label}`).digest('hex');
}

async function consumeEnrollmentAuthorization(authorizationId: string, targetUserId: string) {
  return getDatabase().pool.query(
    `UPDATE identity_admin_enrollment_authorizations
       SET consumed_at = clock_timestamp()
     WHERE id = $1
       AND target_user_id = $2
       AND consumed_at IS NULL
       AND expires_at > clock_timestamp()
     RETURNING id`,
    [authorizationId, targetUserId],
  );
}

async function consumeRecoveryCode(codeDigest: string) {
  return getDatabase().pool.query(
    `UPDATE identity_mfa_recovery_codes
       SET consumed_at = clock_timestamp()
     WHERE code_digest = $1
       AND consumed_at IS NULL
       AND revoked_at IS NULL
     RETURNING id`,
    [codeDigest],
  );
}

async function incrementCounter(scope: 'account' | 'ip', subjectDigest: string): Promise<number> {
  const result = await getDatabase().pool.query<{ attempt_count: number }>(
    `INSERT INTO identity_mfa_attempt_counters
       (scope, action, subject_digest, window_started_at, attempt_count, updated_at)
     VALUES ($1, 'elevation', $2, clock_timestamp(), 1, clock_timestamp())
     ON CONFLICT (scope, action, subject_digest)
     DO UPDATE SET
       attempt_count = identity_mfa_attempt_counters.attempt_count + 1,
       updated_at = clock_timestamp()
     RETURNING attempt_count`,
    [scope, subjectDigest],
  );

  return result.rows[0]?.attempt_count ?? 0;
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;
});

afterAll(async () => {
  try {
    if (database && testDatabaseVerified) {
      if (fixtureUserIds.length > 0) {
        await database.pool.query(
          'DELETE FROM identity_admin_audit_events WHERE target_user_id = ANY($1::uuid[])',
          [fixtureUserIds],
        );
        await database.pool.query('DELETE FROM identity_users WHERE id = ANY($1::uuid[])', [
          fixtureUserIds,
        ]);
      }

      if (counterDigests.length > 0) {
        await database.pool.query(
          'DELETE FROM identity_mfa_attempt_counters WHERE subject_digest = ANY($1::text[])',
          [counterDigests],
        );
      }
    }
  } finally {
    await database?.close();
  }
});

describe('administrator MFA and audit persistence', () => {
  it('keeps existing and newly created sessions unelevated and bounds elevation by absolute expiry', async () => {
    const user = await createUser();
    const created = await createSession(getDatabase().db, user.id);
    if (!created) {
      throw new Error('Expected the synthetic user session to be created.');
    }

    const stored = await getDatabase().pool.query<{
      admin_mfa_elevated_at: Date | null;
      admin_mfa_elevated_until: Date | null;
      absolute_expires_at: Date;
    }>(
      `SELECT admin_mfa_elevated_at, admin_mfa_elevated_until, absolute_expires_at
         FROM identity_sessions
        WHERE id = $1`,
      [created.sessionId],
    );

    expect(stored.rows[0]?.admin_mfa_elevated_at).toBeNull();
    expect(stored.rows[0]?.admin_mfa_elevated_until).toBeNull();

    const row = stored.rows[0];
    if (!row) {
      throw new Error('Expected the created session row.');
    }

    await expectPgCode(
      getDatabase().pool.query(
        `UPDATE identity_sessions
            SET admin_mfa_elevated_at = $2,
                admin_mfa_elevated_until = $3
          WHERE id = $1`,
        [created.sessionId, new Date(), new Date(row.absolute_expires_at.getTime() + 60_000)],
      ),
      '23514',
    );

    await expect(validateSession(getDatabase().db, created.rawToken)).resolves.toMatchObject({
      userId: user.id,
    });
  });

  it('allows an ordinary verified account to sign in and creates an unelevated session', async () => {
    const user = await createUser('ordinary-signin');
    const password = 'Synthetic ordinary account password';
    const passwordHash = await hashPassword(password);

    await getDatabase().db.insert(identityCredentials).values({
      userId: user.id,
      passwordHash,
    });

    const session = await login(getDatabase().db, { email: user.email, password });
    expect(session).toBeDefined();
    if (!session) {
      throw new Error('Expected ordinary account sign-in to succeed.');
    }

    const result = await getDatabase().pool.query<{
      admin_mfa_elevated_at: Date | null;
      admin_mfa_elevated_until: Date | null;
    }>(
      `SELECT admin_mfa_elevated_at, admin_mfa_elevated_until
         FROM identity_sessions
        WHERE id = $1`,
      [session.sessionId],
    );

    expect(result.rows[0]).toEqual({
      admin_mfa_elevated_at: null,
      admin_mfa_elevated_until: null,
    });
    await expect(validateSession(getDatabase().db, session.rawToken)).resolves.toMatchObject({
      userId: user.id,
    });
  });

  it('keeps administrator grants unique and rejects grants for nonexistent users', async () => {
    const user = await createUser();

    await getDatabase().db.insert(identityUserPermissions).values({
      userId: user.id,
      permission: 'administrator',
    });

    await expectPgCode(
      getDatabase().db.insert(identityUserPermissions).values({
        userId: user.id,
        permission: 'administrator',
      }),
      '23505',
    );

    await expectPgCode(
      getDatabase().db.insert(identityUserPermissions).values({
        userId: randomUUID(),
        permission: 'administrator',
      }),
      '23503',
    );
  });

  it('ties enrollment authorization to its target and allows only one atomic consumption', async () => {
    const user = await createUser();
    const digest = digestForTest('enrollment-authorization');

    const rows = await getDatabase()
      .db.insert(identityAdminEnrollmentAuthorizations)
      .values({
        targetUserId: user.id,
        authorizationDigest: digest,
        issuedByOperatorId: 'synthetic-operator-a',
        approvedByOperatorId: 'synthetic-operator-b',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      })
      .returning({ id: identityAdminEnrollmentAuthorizations.id });

    const authorization = rows[0];
    if (!authorization) {
      throw new Error('Could not create the synthetic enrollment authorization.');
    }

    await expectPgCode(
      getDatabase()
        .db.insert(identityAdminEnrollmentAuthorizations)
        .values({
          targetUserId: user.id,
          authorizationDigest: digest,
          issuedByOperatorId: 'synthetic-operator-a',
          approvedByOperatorId: 'synthetic-operator-b',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        }),
      '23505',
    );

    const wrongTarget = await consumeEnrollmentAuthorization(authorization.id, randomUUID());
    expect(wrongTarget.rowCount).toBe(0);

    const results = await Promise.all([
      consumeEnrollmentAuthorization(authorization.id, user.id),
      consumeEnrollmentAuthorization(authorization.id, user.id),
    ]);
    expect(results.reduce((total, result) => total + (result.rowCount ?? 0), 0)).toBe(1);
  });

  it('allows only one current pending or active TOTP factor per user', async () => {
    const user = await createUser();
    await createActiveFactor(user.id);

    await expectPgCode(
      getDatabase().db.insert(identityMfaFactors).values({
        userId: user.id,
        factorType: 'totp',
        status: 'active',
        secretCiphertext: 'another-synthetic-ciphertext',
        keyVersion: 'synthetic-key-version',
        confirmedAt: new Date(),
      }),
      '23505',
    );

    await expectPgCode(
      getDatabase().db.insert(identityMfaFactors).values({
        userId: randomUUID(),
        factorType: 'totp',
        status: 'active',
        secretCiphertext: 'synthetic-ciphertext',
        keyVersion: 'synthetic-key-version',
        confirmedAt: new Date(),
      }),
      '23503',
    );
  });

  it('prevents replay of an accepted TOTP time step under concurrent updates', async () => {
    const user = await createUser();
    const factorId = await createActiveFactor(user.id);
    const acceptedStep = 90_000_000;

    const acceptStep = () =>
      getDatabase().pool.query(
        `UPDATE identity_mfa_factors
            SET last_accepted_time_step = $2
          WHERE id = $1
            AND status = 'active'
            AND (last_accepted_time_step IS NULL OR last_accepted_time_step < $2)
          RETURNING id`,
        [factorId, acceptedStep],
      );

    const results = await Promise.all([acceptStep(), acceptStep()]);
    expect(results.reduce((total, result) => total + (result.rowCount ?? 0), 0)).toBe(1);
  });

  it('consumes a recovery code at most once, even with concurrent requests', async () => {
    const user = await createUser();
    const factorId = await createActiveFactor(user.id);
    const codeDigest = digestForTest('recovery-code');

    await getDatabase().db.insert(identityMfaRecoveryCodes).values({
      factorId,
      codeDigest,
    });

    const results = await Promise.all([
      consumeRecoveryCode(codeDigest),
      consumeRecoveryCode(codeDigest),
    ]);
    expect(results.reduce((total, result) => total + (result.rowCount ?? 0), 0)).toBe(1);
  });

  it('shares MFA attempt counters across concurrent database connections', async () => {
    const accountDigest = digestForTest('account-counter');
    const ipDigest = digestForTest('ip-counter');
    counterDigests.push(accountDigest, ipDigest);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => incrementCounter('account', accountDigest)),
    );

    expect(Math.max(...results)).toBe(20);

    const ipCount = await incrementCounter('ip', ipDigest);
    expect(ipCount).toBe(1);
  });

  it('stores 24-hour operator recovery holds and requires distinct operators', async () => {
    const user = await createUser();
    const completedAt = new Date();
    const validRecovery = {
      userId: user.id,
      method: 'operator' as const,
      status: 'completed' as const,
      requestedByOperatorId: 'synthetic-recovery-operator-a',
      approvedByOperatorId: 'synthetic-recovery-operator-b',
      requestedAt: completedAt,
      approvedAt: completedAt,
      completedAt,
      adminHoldUntil: new Date(completedAt.getTime() + 24 * 60 * 60 * 1000),
    };

    await getDatabase().db.insert(identityMfaRecoveries).values(validRecovery);

    await expectPgCode(
      getDatabase()
        .db.insert(identityMfaRecoveries)
        .values({
          ...validRecovery,
          requestedByOperatorId: 'same-operator',
          approvedByOperatorId: 'same-operator',
          adminHoldUntil: new Date(completedAt.getTime() + 24 * 60 * 60 * 1000),
        }),
      '23514',
    );
  });

  it('retains audit history after the target user is deleted', async () => {
    const user = await createUser('audit-retention');

    await getDatabase()
      .db.insert(identityAdminAuditEvents)
      .values({
        eventType: 'administrator_granted',
        outcome: 'success',
        actorType: 'operator',
        actorOperatorId: 'synthetic-owner-operator',
        approverOperatorId: 'synthetic-security-operator',
        targetUserId: user.id,
        requestId: `synthetic-request-${runId}`,
        reason: 'Synthetic test event',
      });

    await getDatabase().db.delete(identityUsers).where(eq(identityUsers.id, user.id));

    const events = await getDatabase()
      .db.select({ id: identityAdminAuditEvents.id })
      .from(identityAdminAuditEvents)
      .where(eq(identityAdminAuditEvents.targetUserId, user.id));

    expect(events).toHaveLength(1);
  });
});
