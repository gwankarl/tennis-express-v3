import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AdminMfaConfig } from '../../../config/env.js';
import { verifyPassword } from '../passwords/credentials.js';
import { digestIdentityToken } from '../token.js';
import { consumeMfaAttempt } from './mfa-attempts.service.js';
import { decryptMfaSeed, encryptMfaSeed } from './mfa-crypto.js';
import { generateRecoveryCodes } from './recovery-codes.js';
import { createTotpProvisioningUri, generateTotpSecret, verifyTotpCode } from './totp.js';

const PENDING_ENROLLMENT_LIFETIME_MS = 10 * 60 * 1000;

export type AdminMfaWorkflowErrorCode =
  | 'not_authorized'
  | 'invalid_credentials'
  | 'invalid_authorization'
  | 'invalid_code'
  | 'attempts_blocked'
  | 'factor_unavailable'
  | 'service_unavailable';

export class AdminMfaWorkflowError extends Error {
  constructor(
    readonly code: AdminMfaWorkflowErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(safeMessage(code));
    this.name = 'AdminMfaWorkflowError';
  }
}

export interface StartAdminMfaEnrollmentInput {
  pool: Pool;
  config: AdminMfaConfig;
  userId: string;
  sessionId: string;
  password: string;
  authorization: string;
  ipAddress: string;
  now?: Date;
}

export interface AdminMfaEnrollmentSetup {
  /** Return once in the protected enrollment response. Never log or persist. */
  secret: string;
  /** Return once in the protected enrollment response. Never log or persist. */
  provisioningUri: string;
  expiresAt: Date;
}

export interface ConfirmAdminMfaEnrollmentInput {
  pool: Pool;
  config: AdminMfaConfig;
  userId: string;
  sessionId: string;
  code: string;
  ipAddress: string;
  now?: Date;
}

export interface ConfirmedAdminMfaEnrollment {
  /** Display once to the administrator. Persist only their digests. */
  recoveryCodes: string[];
}

/**
 * Consumes a target-bound operator or recovery authorization and creates a
 * ten-minute, session-bound pending TOTP factor. Password hashing is verified
 * before acquiring database locks, then rechecked under lock to prevent a
 * concurrent password change from authorizing enrollment.
 */
export async function startAdminMfaEnrollment(
  input: StartAdminMfaEnrollmentInput,
): Promise<AdminMfaEnrollmentSetup> {
  const now = input.now ?? new Date();

  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('MFA enrollment time is invalid.');
  }

  await requireAllowedAttempt(input, 'enrollment', now);

  let initialPasswordHash: string | undefined;

  try {
    const initial = await input.pool.query<{ password_hash: string }>(
      `SELECT password_hash
         FROM identity_credentials
        WHERE user_id = $1`,
      [input.userId],
    );
    initialPasswordHash = initial.rows[0]?.password_hash;
  } catch {
    throw new AdminMfaWorkflowError('service_unavailable');
  }

  if (!initialPasswordHash || !(await verifyPassword(input.password, initialPasswordHash))) {
    throw new AdminMfaWorkflowError('invalid_credentials');
  }

  const factorId = randomUUID();
  const secret = generateTotpSecret();
  const encrypted = encryptMfaSeed(secret, input.config.encryptionKey, input.config.keyVersion, {
    userId: input.userId,
    factorId,
  });
  const setup: AdminMfaEnrollmentSetup = {
    secret,
    provisioningUri: createTotpProvisioningUri(secret, input.userId),
    expiresAt: new Date(now.getTime() + PENDING_ENROLLMENT_LIFETIME_MS),
  };
  const client = await connect(input.pool);

  try {
    await client.query('BEGIN');

    const user = await lockEligibleUser(client, input.userId);
    if (!user) {
      throw new AdminMfaWorkflowError('not_authorized');
    }

    const session = await lockValidSession(client, input.userId, input.sessionId, now);
    if (!session) {
      throw new AdminMfaWorkflowError('not_authorized');
    }

    const credential = await client.query<{ password_hash: string }>(
      `SELECT password_hash
         FROM identity_credentials
        WHERE user_id = $1
        FOR UPDATE`,
      [input.userId],
    );

    if (credential.rows[0]?.password_hash !== initialPasswordHash) {
      throw new AdminMfaWorkflowError('invalid_credentials');
    }

    if (!(await hasAdministratorGrant(client, input.userId))) {
      throw new AdminMfaWorkflowError('not_authorized');
    }

    const authorization = await client.query<{
      id: string;
      recovery_id: string | null;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT id, recovery_id, expires_at, consumed_at
         FROM identity_admin_enrollment_authorizations
        WHERE target_user_id = $1
          AND authorization_digest = $2
        FOR UPDATE`,
      [input.userId, digestIdentityToken(input.authorization)],
    );
    const grant = authorization.rows[0];

    if (!grant || grant.consumed_at !== null || grant.expires_at.getTime() <= now.getTime()) {
      throw new AdminMfaWorkflowError('invalid_authorization');
    }

    if (grant.recovery_id) {
      const recovery = await client.query<{
        status: string;
        admin_hold_until: Date | null;
      }>(
        `SELECT status, admin_hold_until
           FROM identity_mfa_recoveries
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [grant.recovery_id, input.userId],
      );
      const completedRecovery = recovery.rows[0];

      if (
        completedRecovery?.status !== 'completed' ||
        !completedRecovery.admin_hold_until ||
        completedRecovery.admin_hold_until.getTime() > now.getTime()
      ) {
        throw new AdminMfaWorkflowError('invalid_authorization');
      }
    }

    const existingFactors = await client.query<{
      status: 'pending' | 'active';
      pending_expires_at: Date | null;
    }>(
      `SELECT status, pending_expires_at
         FROM identity_mfa_factors
        WHERE user_id = $1 AND status IN ('pending', 'active')
        FOR UPDATE`,
      [input.userId],
    );

    if (existingFactors.rows.some((factor) => factor.status === 'active')) {
      throw new AdminMfaWorkflowError('factor_unavailable');
    }

    const unexpiredPendingFactor = existingFactors.rows.some(
      (factor) =>
        factor.status === 'pending' &&
        factor.pending_expires_at !== null &&
        factor.pending_expires_at.getTime() > now.getTime(),
    );

    if (unexpiredPendingFactor) {
      throw new AdminMfaWorkflowError('factor_unavailable');
    }

    await client.query(
      `UPDATE identity_mfa_factors
          SET status = 'revoked',
              pending_session_id = NULL,
              revoked_at = $2,
              updated_at = $2
        WHERE user_id = $1 AND status = 'pending'`,
      [input.userId, now],
    );

    const consumed = await client.query(
      `UPDATE identity_admin_enrollment_authorizations
          SET consumed_at = $3
        WHERE id = $1
          AND target_user_id = $2
          AND consumed_at IS NULL
          AND expires_at > $3
        RETURNING id`,
      [grant.id, input.userId, now],
    );

    if (consumed.rowCount !== 1) {
      throw new AdminMfaWorkflowError('invalid_authorization');
    }

    await client.query(
      `INSERT INTO identity_mfa_factors
         (id, user_id, pending_session_id, factor_type, status, secret_ciphertext,
          key_version, pending_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'totp', 'pending', $4, $5, $6, $7, $7)`,
      [
        factorId,
        input.userId,
        input.sessionId,
        encrypted.secretCiphertext,
        encrypted.keyVersion,
        setup.expiresAt,
        now,
      ],
    );

    await insertUserAudit(client, 'mfa_enrollment_started', input.userId, input.sessionId, now);

    await client.query('COMMIT');
    return setup;
  } catch (error) {
    await rollback(client);

    if (error instanceof AdminMfaWorkflowError) {
      throw error;
    }

    throw new AdminMfaWorkflowError('service_unavailable');
  } finally {
    client.release();
  }
}

/**
 * Activates one pending factor after a valid TOTP. The factor row lock and
 * conditional state update serialize simultaneous confirmations. It creates
 * exactly one set of ten recovery-code digests and returns the raw codes once.
 */
export async function confirmAdminMfaEnrollment(
  input: ConfirmAdminMfaEnrollmentInput,
): Promise<ConfirmedAdminMfaEnrollment> {
  const now = input.now ?? new Date();

  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('MFA confirmation time is invalid.');
  }

  await requireAllowedAttempt(input, 'enrollment', now);

  const client = await connect(input.pool);

  try {
    await client.query('BEGIN');

    const user = await lockEligibleUser(client, input.userId);
    if (!user) {
      throw new AdminMfaWorkflowError('not_authorized');
    }

    const session = await lockValidSession(client, input.userId, input.sessionId, now);
    if (!session || !(await hasAdministratorGrant(client, input.userId))) {
      throw new AdminMfaWorkflowError('not_authorized');
    }

    const factors = await client.query<{
      id: string;
      secret_ciphertext: string;
      key_version: string;
      pending_expires_at: Date;
      last_accepted_time_step: number | null;
    }>(
      `SELECT id, secret_ciphertext, key_version, pending_expires_at,
              last_accepted_time_step
         FROM identity_mfa_factors
        WHERE user_id = $1
          AND pending_session_id = $2
          AND status = 'pending'
        FOR UPDATE`,
      [input.userId, input.sessionId],
    );
    const factor = factors.rows[0];

    if (!factor || factor.pending_expires_at.getTime() <= now.getTime()) {
      throw new AdminMfaWorkflowError('invalid_code');
    }

    const seed = decryptMfaSeed(
      factor.secret_ciphertext,
      input.config.encryptionKey,
      factor.key_version,
      { userId: input.userId, factorId: factor.id },
    );
    const acceptedStep = verifyTotpCode(seed, input.code, now);

    if (
      acceptedStep === null ||
      (factor.last_accepted_time_step !== null && acceptedStep <= factor.last_accepted_time_step)
    ) {
      throw new AdminMfaWorkflowError('invalid_code');
    }

    const updated = await client.query(
      `UPDATE identity_mfa_factors
          SET status = 'active',
              pending_session_id = NULL,
              pending_expires_at = NULL,
              confirmed_at = $3,
              last_accepted_time_step = $4,
              updated_at = $3
        WHERE id = $1
          AND user_id = $2
          AND status = 'pending'
          AND pending_session_id = $5
          AND pending_expires_at > $3
          AND (last_accepted_time_step IS NULL OR last_accepted_time_step < $4)
        RETURNING id`,
      [factor.id, input.userId, now, acceptedStep, input.sessionId],
    );

    if (updated.rowCount !== 1) {
      throw new AdminMfaWorkflowError('invalid_code');
    }

    const recoveryCodes = generateRecoveryCodes();
    await client.query(
      `INSERT INTO identity_mfa_recovery_codes (factor_id, code_digest, created_at)
       SELECT $1, code_digest, $3
         FROM unnest($2::text[]) AS code_digest`,
      [factor.id, recoveryCodes.digests, now],
    );

    await insertUserAudit(client, 'mfa_enrollment_confirmed', input.userId, input.sessionId, now);

    await client.query('COMMIT');
    return { recoveryCodes: recoveryCodes.rawCodes };
  } catch (error) {
    await rollback(client);

    if (error instanceof AdminMfaWorkflowError) {
      throw error;
    }

    throw new AdminMfaWorkflowError('service_unavailable');
  } finally {
    client.release();
  }
}

async function requireAllowedAttempt(
  input: {
    pool: Pool;
    config: AdminMfaConfig;
    userId: string;
    ipAddress: string;
  },
  action: 'enrollment',
  now: Date,
): Promise<void> {
  let result;

  try {
    result = await consumeMfaAttempt({
      pool: input.pool,
      action,
      accountSubject: input.userId,
      ipAddress: input.ipAddress,
      hmacKeyBase64: input.config.attemptHmacKey,
      now,
    });
  } catch {
    throw new AdminMfaWorkflowError('service_unavailable');
  }

  if (!result.allowed) {
    throw new AdminMfaWorkflowError('attempts_blocked', result.retryAfterSeconds);
  }
}

async function lockEligibleUser(client: PoolClient, userId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT id
       FROM identity_users
      WHERE id = $1
        AND status = 'active'
        AND email_verified_at IS NOT NULL
      FOR UPDATE`,
    [userId],
  );

  return result.rowCount === 1;
}

async function lockValidSession(
  client: PoolClient,
  userId: string,
  sessionId: string,
  now: Date,
): Promise<boolean> {
  const result = await client.query(
    `SELECT id
       FROM identity_sessions
      WHERE id = $1
        AND user_id = $2
        AND revoked_at IS NULL
        AND idle_expires_at > $3
        AND absolute_expires_at > $3
      FOR UPDATE`,
    [sessionId, userId, now],
  );

  return result.rowCount === 1;
}

async function hasAdministratorGrant(client: PoolClient, userId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT user_id
       FROM identity_user_permissions
      WHERE user_id = $1 AND permission = 'administrator'
      FOR SHARE`,
    [userId],
  );

  return result.rowCount === 1;
}

async function insertUserAudit(
  client: PoolClient,
  eventType: 'mfa_enrollment_started' | 'mfa_enrollment_confirmed',
  userId: string,
  sessionId: string,
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO identity_admin_audit_events
       (event_type, outcome, actor_type, actor_user_id, target_user_id, session_id, occurred_at)
     VALUES ($1, 'success', 'user', $2, $2, $3, $4)`,
    [eventType, userId, sessionId, now],
  );
}

async function connect(pool: Pool): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch {
    throw new AdminMfaWorkflowError('service_unavailable');
  }
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

function safeMessage(code: AdminMfaWorkflowErrorCode): string {
  switch (code) {
    case 'not_authorized':
      return 'Administrator MFA operation is not authorized.';
    case 'invalid_credentials':
      return 'The supplied credentials could not be verified.';
    case 'invalid_authorization':
      return 'The enrollment authorization is invalid or expired.';
    case 'invalid_code':
      return 'The verification code is invalid or expired.';
    case 'attempts_blocked':
      return 'Too many MFA attempts. Try again later.';
    case 'factor_unavailable':
      return 'An MFA factor is already active or pending.';
    case 'service_unavailable':
      return 'Administrator MFA is temporarily unavailable.';
  }
}
