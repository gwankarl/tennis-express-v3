import { createHash, verify as verifySignature } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { generateSessionToken } from '../token.js';

export type AdminOperationAction =
  'grant' | 'revoke' | 'emergency_revoke' | 'review_emergency_revoke';

export interface AdminOperationIntent {
  environment: string;
  action: AdminOperationAction;
  operationId: string;
  targetUserId: string;
  normalizedEmail: string;
  caseReference: string;
  reason: string;
  relatedOperationId: string | null;
}

export interface AdminOperator {
  id: string;
  accountUserId: string;
  publicKeyPem: string;
}

export interface AdminApproval {
  operatorId: string;
  signatureBase64: string;
}

export interface AdminOperationResult {
  status: 'completed' | 'rejected' | 'no_op' | 'reviewed' | 'replayed';
  enrollmentAuthorization?: string;
  enrollmentState?: 'authorization_issued' | 'already_pending' | 'already_active';
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Serialize exactly the fields all operators sign. Keep this ordering stable. */
export function canonicalizeAdminIntent(intent: AdminOperationIntent): string {
  return JSON.stringify({
    environment: intent.environment,
    action: intent.action,
    operationId: intent.operationId,
    targetUserId: intent.targetUserId,
    normalizedEmail: intent.normalizedEmail,
    caseReference: intent.caseReference,
    reason: intent.reason,
    relatedOperationId: intent.relatedOperationId,
  });
}

function validateIntent(intent: AdminOperationIntent): void {
  if (
    !intent.environment.trim() ||
    !['grant', 'revoke', 'emergency_revoke', 'review_emergency_revoke'].includes(intent.action) ||
    !uuidPattern.test(intent.operationId) ||
    !uuidPattern.test(intent.targetUserId) ||
    (intent.relatedOperationId !== null && !uuidPattern.test(intent.relatedOperationId)) ||
    !intent.normalizedEmail ||
    intent.normalizedEmail !== intent.normalizedEmail.trim().toLowerCase() ||
    !intent.caseReference.trim() ||
    !intent.reason.trim()
  ) {
    throw new Error('Operator intent is invalid.');
  }

  if (intent.action === 'review_emergency_revoke' && !intent.relatedOperationId) {
    throw new Error('Emergency review must reference the original operation.');
  }

  if (intent.action !== 'review_emergency_revoke' && intent.relatedOperationId !== null) {
    throw new Error('Only an emergency review may reference another operation.');
  }
}

function verifyApprovals(
  intent: AdminOperationIntent,
  approvals: AdminApproval[],
  operators: AdminOperator[],
): AdminOperator[] {
  const requiredCount = intent.action === 'grant' || intent.action === 'revoke' ? 2 : 1;
  if (approvals.length !== requiredCount) {
    throw new Error('The number of operator approvals is invalid.');
  }

  const operatorById = new Map(operators.map((operator) => [operator.id, operator]));
  const seen = new Set<string>();
  const valid: AdminOperator[] = [];
  const payload = Buffer.from(canonicalizeAdminIntent(intent), 'utf8');

  for (const approval of approvals) {
    const operator = operatorById.get(approval.operatorId);
    if (!operator || seen.has(operator.id) || operator.accountUserId === intent.targetUserId) {
      throw new Error('An operator approval is not authorized.');
    }

    let signature: Buffer;
    try {
      signature = Buffer.from(approval.signatureBase64, 'base64');
    } catch {
      throw new Error('An operator approval is not authorized.');
    }

    if (
      signature.length === 0 ||
      !verifySignature(null, payload, operator.publicKeyPem, signature)
    ) {
      throw new Error('An operator approval is not authorized.');
    }

    seen.add(operator.id);
    valid.push(operator);
  }

  return valid;
}

/**
 * Applies a signed operator action atomically. The caller must verify the
 * connected database environment before invoking this function.
 */
export async function executeAdminOperation(
  pool: Pool,
  intent: AdminOperationIntent,
  approvals: AdminApproval[],
  operators: AdminOperator[],
  now = new Date(),
): Promise<AdminOperationResult> {
  validateIntent(intent);
  if (!Number.isFinite(now.getTime())) throw new RangeError('Operation time is invalid.');

  const signers = verifyApprovals(intent, approvals, operators);
  const actor = signers[0];
  const approver = signers[1];
  if (!actor) throw new Error('At least one verified operator is required.');

  const canonicalIntent = canonicalizeAdminIntent(intent);
  const intentDigest = createHash('sha256').update(canonicalIntent).digest('hex');
  const client = await pool.connect();
  let rawEnrollmentAuthorization: string | undefined;
  let enrollmentState: AdminOperationResult['enrollmentState'];

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      intent.operationId,
    ]);

    const previous = await client.query<{
      intent_digest: string;
      outcome: AdminOperationResult['status'];
    }>(
      `SELECT intent_digest, outcome
         FROM identity_admin_operations
        WHERE operation_id = $1`,
      [intent.operationId],
    );

    if (previous.rowCount) {
      if (previous.rows[0]?.intent_digest !== intentDigest) {
        throw new Error('Operation ID was already used for a different intent.');
      }
      await client.query('COMMIT');
      return { status: 'replayed' };
    }

    if (intent.action === 'review_emergency_revoke') {
      const original = await client.query<{
        action: string;
        case_reference: string;
        target_user_id: string;
        actor_operator_id: string;
      }>(
        `SELECT action, case_reference, target_user_id, actor_operator_id
           FROM identity_admin_operations
          WHERE operation_id = $1 AND outcome IN ('completed', 'no_op')`,
        [intent.relatedOperationId],
      );
      const emergency = original.rows[0];
      if (
        !emergency ||
        emergency.action !== 'emergency_revoke' ||
        emergency.case_reference !== intent.caseReference ||
        emergency.target_user_id !== intent.targetUserId ||
        emergency.actor_operator_id === actor.id
      ) {
        throw new Error('Emergency review does not match an eligible operation.');
      }

      await insertOperation(client, intent, intentDigest, 'reviewed', actor.id, null);
      await insertAudit(
        client,
        intent,
        'administrator_revocation_reviewed',
        'success',
        actor.id,
        null,
        now,
      );
      await client.query('COMMIT');
      return { status: 'reviewed' };
    }

    const targetResult = await client.query<{ status: string; email_verified_at: Date | null }>(
      `SELECT status, email_verified_at
         FROM identity_users
        WHERE id = $1 AND normalized_email = $2
        FOR UPDATE`,
      [intent.targetUserId, intent.normalizedEmail],
    );
    const target = targetResult.rows[0];

    const grantTargetIsEligible =
      intent.action !== 'grant' ||
      (target?.status === 'active' && target.email_verified_at !== null);
    if (!target || !grantTargetIsEligible) {
      await insertOperation(
        client,
        intent,
        intentDigest,
        'rejected',
        actor.id,
        approver?.id ?? null,
      );
      await insertAudit(
        client,
        intent,
        eventFor(intent.action),
        'denied',
        actor.id,
        approver?.id ?? null,
        now,
      );
      await client.query('COMMIT');
      return { status: 'rejected' };
    }

    let outcome: 'completed' | 'no_op' = 'completed';
    if (intent.action === 'grant') {
      const grant = await client.query(
        `INSERT INTO identity_user_permissions (user_id, permission)
         VALUES ($1, 'administrator')
         ON CONFLICT (user_id, permission) DO NOTHING
         RETURNING user_id`,
        [intent.targetUserId],
      );

      if (!grant.rowCount) {
        outcome = 'no_op';
      } else {
        const factors = await client.query<{
          status: 'pending' | 'active';
          pending_expires_at: Date | null;
        }>(
          `SELECT status, pending_expires_at
             FROM identity_mfa_factors
            WHERE user_id = $1 AND status IN ('pending', 'active')
            FOR UPDATE`,
          [intent.targetUserId],
        );
        const active = factors.rows.some((factor) => factor.status === 'active');
        const pending = factors.rows.some(
          (factor) =>
            factor.status === 'pending' &&
            factor.pending_expires_at &&
            factor.pending_expires_at > now,
        );

        if (active) {
          enrollmentState = 'already_active';
        } else if (pending) {
          enrollmentState = 'already_pending';
        } else {
          await client.query(
            `UPDATE identity_mfa_factors
                SET status = 'revoked', revoked_at = $2, updated_at = $2
              WHERE user_id = $1 AND status = 'pending'`,
            [intent.targetUserId, now],
          );
          await client.query(
            `UPDATE identity_admin_enrollment_authorizations
                SET consumed_at = $2
              WHERE target_user_id = $1 AND consumed_at IS NULL`,
            [intent.targetUserId, now],
          );
          const token = generateSessionToken();
          const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
          await client.query(
            `INSERT INTO identity_admin_enrollment_authorizations
              (target_user_id, authorization_digest, issued_by_operator_id, approved_by_operator_id, issued_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [intent.targetUserId, token.digest, actor.id, approver?.id, now, expiresAt],
          );
          rawEnrollmentAuthorization = token.rawToken;
          enrollmentState = 'authorization_issued';
        }
      }
    } else {
      const revoked = await client.query(
        `DELETE FROM identity_user_permissions
          WHERE user_id = $1 AND permission = 'administrator'
          RETURNING user_id`,
        [intent.targetUserId],
      );
      if (!revoked.rowCount) outcome = 'no_op';

      await client.query(
        `UPDATE identity_sessions
            SET admin_mfa_elevated_at = NULL, admin_mfa_elevated_until = NULL
          WHERE user_id = $1
            AND (admin_mfa_elevated_at IS NOT NULL OR admin_mfa_elevated_until IS NOT NULL)`,
        [intent.targetUserId],
      );
      await client.query(
        `UPDATE identity_admin_enrollment_authorizations
            SET consumed_at = $2
          WHERE target_user_id = $1 AND consumed_at IS NULL`,
        [intent.targetUserId, now],
      );
    }

    await insertOperation(client, intent, intentDigest, outcome, actor.id, approver?.id ?? null);
    await insertAudit(
      client,
      intent,
      eventFor(intent.action),
      outcome === 'completed' ? 'success' : 'no_op',
      actor.id,
      approver?.id ?? null,
      now,
    );
    if (intent.action === 'grant' && enrollmentState === 'authorization_issued') {
      await insertAudit(
        client,
        intent,
        'mfa_enrollment_authorized',
        'success',
        actor.id,
        approver?.id ?? null,
        now,
      );
    }
    await client.query('COMMIT');
    return {
      status: outcome,
      ...(rawEnrollmentAuthorization
        ? { enrollmentAuthorization: rawEnrollmentAuthorization }
        : {}),
      ...(enrollmentState ? { enrollmentState } : {}),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertOperation(
  client: PoolClient,
  intent: AdminOperationIntent,
  intentDigest: string,
  outcome: string,
  actorOperatorId: string,
  approverOperatorId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO identity_admin_operations
      (operation_id, action, target_user_id, case_reference, reason, intent_digest, outcome,
       actor_operator_id, approver_operator_id, related_operation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      intent.operationId,
      intent.action,
      intent.targetUserId,
      intent.caseReference,
      intent.reason,
      intentDigest,
      outcome,
      actorOperatorId,
      approverOperatorId,
      intent.relatedOperationId,
    ],
  );
}

async function insertAudit(
  client: PoolClient,
  intent: AdminOperationIntent,
  eventType: string,
  outcome: string,
  actorOperatorId: string,
  approverOperatorId: string | null,
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO identity_admin_audit_events
      (event_type, outcome, actor_type, actor_operator_id, approver_operator_id,
       target_user_id, reason, operation_id, case_reference, occurred_at)
     VALUES ($1,$2,'operator',$3,$4,$5,$6,$7,$8,$9)`,
    [
      eventType,
      outcome,
      actorOperatorId,
      approverOperatorId,
      intent.targetUserId,
      intent.reason,
      intent.operationId,
      intent.caseReference,
      now,
    ],
  );
}

function eventFor(action: AdminOperationAction): string {
  switch (action) {
    case 'grant':
      return 'administrator_granted';
    case 'revoke':
      return 'administrator_revoked';
    case 'emergency_revoke':
      return 'administrator_revocation_emergency';
    case 'review_emergency_revoke':
      return 'administrator_revocation_reviewed';
  }
}
