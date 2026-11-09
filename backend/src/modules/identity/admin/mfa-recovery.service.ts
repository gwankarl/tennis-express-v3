import type { EmailSender } from '../../../infrastructure/email/email-sender.js';
import type { AdminMfaConfig } from '../../../config/env.js';
import type { Pool, PoolClient } from 'pg';
import { verifyPassword } from '../passwords/credentials.js';
import { generateSessionToken } from '../token.js';
import { consumeMfaAttempt } from './mfa-attempts.service.js';
import { createAdminMfaRecoveryEmail } from './mfa-recovery-email.js';
import { digestRecoveryCode } from './recovery-codes.js';
import { AdminMfaWorkflowError } from './mfa-enrollment.service.js';

const ADMIN_HOLD_MS = 24 * 60 * 60 * 1000;
const ENROLLMENT_AUTHORIZATION_WINDOW_AFTER_HOLD_MS = 24 * 60 * 60 * 1000;

export interface RecoverAdminMfaInput {
  pool: Pool;
  config: AdminMfaConfig;
  emailSender: EmailSender;
  frontendOrigin: string;
  userId: string;
  sessionId: string;
  currentPassword: string;
  recoveryCode: string;
  ipAddress: string;
  now?: Date;
}

export interface AdminMfaRecoveryResult {
  recoveryId: string;
  adminHoldUntil: Date;
  notificationSent: boolean;
  /**
   * Return once to the caller so it can survive revocation of this session.
   * Never log or persist this raw authorization.
   */
  replacementEnrollmentAuthorization: string;
}

/**
 * Recovers MFA with a current password and one unused recovery code.
 *
 * The factor/code revocation, session revocation, 24-hour hold, replacement
 * authorization digest, and audit events commit together. The notification is
 * sent only after commit and contains no authorization or recovery secret.
 */
export async function recoverAdminMfaWithRecoveryCode(
  input: RecoverAdminMfaInput,
): Promise<AdminMfaRecoveryResult> {
  const now = input.now ?? new Date();

  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('MFA recovery time is invalid.');
  }

  let attempt;

  try {
    attempt = await consumeMfaAttempt({
      pool: input.pool,
      action: 'recovery',
      accountSubject: input.userId,
      ipAddress: input.ipAddress,
      hmacKeyBase64: input.config.attemptHmacKey,
      now,
    });
  } catch {
    throw new AdminMfaWorkflowError('service_unavailable');
  }

  if (!attempt.allowed) {
    throw new AdminMfaWorkflowError('attempts_blocked', attempt.retryAfterSeconds);
  }

  let initialPasswordHash: string | undefined;

  try {
    const result = await input.pool.query<{ password_hash: string }>(
      `SELECT password_hash
         FROM identity_credentials
        WHERE user_id = $1`,
      [input.userId],
    );
    initialPasswordHash = result.rows[0]?.password_hash;
  } catch {
    throw new AdminMfaWorkflowError('service_unavailable');
  }

  if (!initialPasswordHash || !(await verifyPassword(input.currentPassword, initialPasswordHash))) {
    throw new AdminMfaWorkflowError('invalid_credentials');
  }

  let codeDigest: string;

  try {
    codeDigest = digestRecoveryCode(input.recoveryCode);
  } catch {
    throw new AdminMfaWorkflowError('invalid_code');
  }

  const replacementAuthorization = generateSessionToken();
  const recoveryIdResult = await input.pool
    .query<{ id: string }>('SELECT gen_random_uuid() AS id')
    .catch(() => {
      throw new AdminMfaWorkflowError('service_unavailable');
    });
  const recoveryId = recoveryIdResult.rows[0]?.id;

  if (!recoveryId) {
    throw new AdminMfaWorkflowError('service_unavailable');
  }

  const adminHoldUntil = new Date(now.getTime() + ADMIN_HOLD_MS);
  const authorizationExpiresAt = new Date(
    adminHoldUntil.getTime() + ENROLLMENT_AUTHORIZATION_WINDOW_AFTER_HOLD_MS,
  );

  let client: PoolClient;

  try {
    client = await input.pool.connect();
  } catch {
    throw new AdminMfaWorkflowError('service_unavailable');
  }

  let recipient: string | undefined;

  try {
    await client.query('BEGIN');

    const user = await client.query<{
      delivery_email: string;
      email_verified_at: Date | null;
    }>(
      `SELECT delivery_email, email_verified_at
         FROM identity_users
        WHERE id = $1
          AND status = 'active'
          AND email_verified_at IS NOT NULL
        FOR UPDATE`,
      [input.userId],
    );
    const account = user.rows[0];

    if (!account) {
      throw new AdminMfaWorkflowError('not_authorized');
    }

    recipient = account.delivery_email;

    const session = await client.query(
      `SELECT id
         FROM identity_sessions
        WHERE id = $1
          AND user_id = $2
          AND revoked_at IS NULL
          AND idle_expires_at > $3
          AND absolute_expires_at > $3
        FOR UPDATE`,
      [input.sessionId, input.userId, now],
    );

    if (session.rowCount !== 1) {
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

    const permission = await client.query(
      `SELECT user_id
         FROM identity_user_permissions
        WHERE user_id = $1 AND permission = 'administrator'
        FOR SHARE`,
      [input.userId],
    );

    if (permission.rowCount !== 1) {
      throw new AdminMfaWorkflowError('not_authorized');
    }

    const factors = await client.query<{ id: string }>(
      `SELECT id
         FROM identity_mfa_factors
        WHERE user_id = $1 AND status = 'active'
        FOR UPDATE`,
      [input.userId],
    );
    const factor = factors.rows[0];

    if (!factor) {
      throw new AdminMfaWorkflowError('factor_unavailable');
    }

    const codes = await client.query<{ id: string }>(
      `SELECT id
         FROM identity_mfa_recovery_codes
        WHERE factor_id = $1
          AND code_digest = $2
          AND consumed_at IS NULL
          AND revoked_at IS NULL
        FOR UPDATE`,
      [factor.id, codeDigest],
    );
    const code = codes.rows[0];

    if (!code) {
      throw new AdminMfaWorkflowError('invalid_code');
    }

    const consumed = await client.query(
      `UPDATE identity_mfa_recovery_codes
          SET consumed_at = $2
        WHERE id = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL
        RETURNING id`,
      [code.id, now],
    );

    if (consumed.rowCount !== 1) {
      throw new AdminMfaWorkflowError('invalid_code');
    }

    await client.query(
      `UPDATE identity_mfa_recovery_codes
          SET revoked_at = $2
        WHERE factor_id = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL`,
      [factor.id, now],
    );

    const revokedFactor = await client.query(
      `UPDATE identity_mfa_factors
          SET status = 'revoked',
              revoked_at = $2,
              updated_at = $2
        WHERE id = $1 AND status = 'active'
        RETURNING id`,
      [factor.id, now],
    );

    if (revokedFactor.rowCount !== 1) {
      throw new AdminMfaWorkflowError('factor_unavailable');
    }

    await client.query(
      `INSERT INTO identity_mfa_recoveries
         (id, user_id, method, status, requested_at, completed_at, admin_hold_until)
       VALUES ($1, $2, 'recovery_code', 'completed', $3, $3, $4)`,
      [recoveryId, input.userId, now, adminHoldUntil],
    );

    await client.query(
      `UPDATE identity_sessions
          SET revoked_at = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [input.userId, now],
    );

    await client.query(
      `UPDATE identity_admin_enrollment_authorizations
          SET consumed_at = $2
        WHERE target_user_id = $1 AND consumed_at IS NULL`,
      [input.userId, now],
    );

    await client.query(
      `INSERT INTO identity_admin_enrollment_authorizations
         (target_user_id, recovery_id, authorization_digest, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.userId, recoveryId, replacementAuthorization.digest, now, authorizationExpiresAt],
    );

    await insertRecoveryAudit(client, 'mfa_factor_revoked', input.userId, input.sessionId, now);
    await insertRecoveryAudit(client, 'mfa_recovery_completed', input.userId, input.sessionId, now);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);

    if (error instanceof AdminMfaWorkflowError) {
      throw error;
    }

    throw new AdminMfaWorkflowError('service_unavailable');
  } finally {
    client.release();
  }

  let notificationSent = false;

  try {
    await input.emailSender.send(
      createAdminMfaRecoveryEmail({
        to: recipient!,
        frontendOrigin: input.frontendOrigin,
        adminHoldUntil,
      }),
    );
    notificationSent = true;
  } catch {
    // Recovery remains committed. The response still carries the one-time
    // replacement authorization; never log recipient or email content here.
  }

  return {
    recoveryId,
    adminHoldUntil,
    notificationSent,
    replacementEnrollmentAuthorization: replacementAuthorization.rawToken,
  };
}

async function insertRecoveryAudit(
  client: PoolClient,
  eventType: 'mfa_factor_revoked' | 'mfa_recovery_completed',
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
