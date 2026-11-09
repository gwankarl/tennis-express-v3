import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { generateSessionToken } from '../token.js';

const ADMIN_HOLD_MS = 24 * 60 * 60 * 1000;
const ENROLLMENT_AUTHORIZATION_AFTER_HOLD_MS = 24 * 60 * 60 * 1000;

export interface ApplyOperatorMfaRecoveryInput {
  client: PoolClient;
  userId: string;
  deliveryEmail: string;
  actorOperatorId: string;
  approverOperatorId: string;
  operationId: string;
  caseReference: string;
  reason: string;
  now: Date;
}

export interface AppliedOperatorMfaRecovery {
  enrollmentAuthorization: string;
  adminHoldUntil: Date;
  notificationRecipient: string;
}

/**
 * Applies operator recovery inside the caller's existing transaction.
 * The caller must already have locked and verified the active, verified user.
 */
export async function applyOperatorMfaRecovery(
  input: ApplyOperatorMfaRecoveryInput,
): Promise<AppliedOperatorMfaRecovery> {
  if (input.actorOperatorId === input.approverOperatorId) {
    throw new Error('Operator recovery requires two different operators.');
  }

  const permission = await input.client.query(
    `SELECT user_id
       FROM identity_user_permissions
      WHERE user_id = $1 AND permission = 'administrator'
      FOR SHARE`,
    [input.userId],
  );

  if (permission.rowCount !== 1) {
    throw new Error('Operator recovery target has no administrator grant.');
  }

  await input.client.query(
    `UPDATE identity_mfa_recovery_codes
        SET revoked_at = $2
      WHERE factor_id IN (
        SELECT id FROM identity_mfa_factors WHERE user_id = $1
      )
        AND consumed_at IS NULL
        AND revoked_at IS NULL`,
    [input.userId, input.now],
  );

  await input.client.query(
    `UPDATE identity_mfa_factors
        SET status = 'revoked',
            pending_session_id = NULL,
            revoked_at = $2,
            updated_at = $2
      WHERE user_id = $1 AND status IN ('pending', 'active')`,
    [input.userId, input.now],
  );

  await input.client.query(
    `UPDATE identity_sessions
        SET revoked_at = COALESCE(revoked_at, $2),
            admin_mfa_elevated_at = NULL,
            admin_mfa_elevated_until = NULL
      WHERE user_id = $1
        AND (
          revoked_at IS NULL
          OR admin_mfa_elevated_at IS NOT NULL
          OR admin_mfa_elevated_until IS NOT NULL
        )`,
    [input.userId, input.now],
  );

  await input.client.query(
    `UPDATE identity_admin_enrollment_authorizations
        SET consumed_at = $2
      WHERE target_user_id = $1 AND consumed_at IS NULL`,
    [input.userId, input.now],
  );

  const recoveryId = randomUUID();
  const adminHoldUntil = new Date(input.now.getTime() + ADMIN_HOLD_MS);
  const authorizationExpiresAt = new Date(
    adminHoldUntil.getTime() + ENROLLMENT_AUTHORIZATION_AFTER_HOLD_MS,
  );

  await input.client.query(
    `INSERT INTO identity_mfa_recoveries
       (id, user_id, method, status, requested_by_operator_id,
        approved_by_operator_id, requested_at, approved_at,
        completed_at, admin_hold_until)
     VALUES ($1, $2, 'operator', 'completed', $3, $4, $5, $5, $5, $6)`,
    [
      recoveryId,
      input.userId,
      input.actorOperatorId,
      input.approverOperatorId,
      input.now,
      adminHoldUntil,
    ],
  );

  const authorization = generateSessionToken();

  await input.client.query(
    `INSERT INTO identity_admin_enrollment_authorizations
       (target_user_id, recovery_id, authorization_digest,
        issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.userId, recoveryId, authorization.digest, input.now, authorizationExpiresAt],
  );

  await input.client.query(
    `INSERT INTO identity_admin_audit_events
       (event_type, outcome, actor_type, actor_operator_id,
        approver_operator_id, target_user_id, reason, operation_id,
        case_reference, occurred_at)
     VALUES ('mfa_recovery_approved', 'success', 'operator', $1, $2, $3, $4, $5, $6, $7)`,
    [
      input.actorOperatorId,
      input.approverOperatorId,
      input.userId,
      input.reason,
      input.operationId,
      input.caseReference,
      input.now,
    ],
  );

  return {
    enrollmentAuthorization: authorization.rawToken,
    adminHoldUntil,
    notificationRecipient: input.deliveryEmail,
  };
}
