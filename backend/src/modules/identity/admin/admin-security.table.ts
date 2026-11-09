import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { identityUsers } from '../accounts/user.table.js';
import { identitySessions } from '../sessions/session.table.js';

export const identityMfaFactorStatus = pgEnum('identity_mfa_factor_status', [
  'pending',
  'active',
  'revoked',
]);

export const identityMfaAttemptScope = pgEnum('identity_mfa_attempt_scope', ['account', 'ip']);

export const identityMfaAttemptAction = pgEnum('identity_mfa_attempt_action', [
  'enrollment',
  'elevation',
  'recovery',
]);

export const identityMfaRecoveryMethod = pgEnum('identity_mfa_recovery_method', [
  'recovery_code',
  'operator',
]);

export const identityMfaRecoveryStatus = pgEnum('identity_mfa_recovery_status', [
  'requested',
  'approved',
  'completed',
  'denied',
  'cancelled',
]);

export const identityAdminAuditEventType = pgEnum('identity_admin_audit_event_type', [
  'administrator_granted',
  'administrator_revoked',
  'administrator_revocation_emergency',
  'administrator_revocation_reviewed',
  'mfa_enrollment_authorized',
  'mfa_enrollment_started',
  'mfa_enrollment_confirmed',
  'mfa_factor_revoked',
  'mfa_elevation_succeeded',
  'mfa_elevation_failed',
  'mfa_recovery_requested',
  'mfa_recovery_approved',
  'mfa_recovery_completed',
  'mfa_recovery_denied',
]);

export const identityAdminAuditActorType = pgEnum('identity_admin_audit_actor_type', [
  'user',
  'operator',
  'system',
]);

export const identityAdminAuditOutcome = pgEnum('identity_admin_audit_outcome', [
  'success',
  'denied',
  'pending',
  'no_op',
]);

/**
 * Stores encrypted TOTP seed ciphertext. The encryption key is managed outside
 * PostgreSQL; keyVersion identifies which external key encrypted the value.
 */
export const identityMfaFactors = pgTable(
  'identity_mfa_factors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    pendingSessionId: uuid('pending_session_id').references(() => identitySessions.id, {
      onDelete: 'cascade',
    }),
    factorType: text('factor_type').notNull().default('totp'),
    status: identityMfaFactorStatus('status').notNull(),
    secretCiphertext: text('secret_ciphertext').notNull(),
    keyVersion: text('key_version').notNull(),
    pendingExpiresAt: timestamp('pending_expires_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastAcceptedTimeStep: integer('last_accepted_time_step'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('identity_mfa_factors_one_current_per_user_uq')
      .on(table.userId)
      .where(sql`${table.status} IN ('pending', 'active')`),
    index('identity_mfa_factors_user_status_idx').on(table.userId, table.status),
    check('identity_mfa_factors_type_ck', sql`${table.factorType} = 'totp'`),
    check(
      'identity_mfa_factors_secret_not_blank_ck',
      sql`${table.secretCiphertext} <> '' AND ${table.keyVersion} <> ''`,
    ),
    check(
      'identity_mfa_factors_state_ck',
      sql`(
        (${table.status} = 'pending'
          AND ${table.pendingExpiresAt} IS NOT NULL
          AND ${table.pendingSessionId} IS NOT NULL
          AND ${table.confirmedAt} IS NULL
          AND ${table.revokedAt} IS NULL)
        OR
        (${table.status} = 'active'
          AND ${table.pendingExpiresAt} IS NULL
          AND ${table.pendingSessionId} IS NULL
          AND ${table.confirmedAt} IS NOT NULL
          AND ${table.revokedAt} IS NULL)
        OR
        (${table.status} = 'revoked'
          AND ${table.pendingSessionId} IS NULL
          AND ${table.revokedAt} IS NOT NULL)
      )`,
    ),
    check(
      'identity_mfa_factors_last_step_nonnegative_ck',
      sql`${table.lastAcceptedTimeStep} IS NULL OR ${table.lastAcceptedTimeStep} >= 0`,
    ),
  ],
);

/**
 * Holds recovery workflow state and the post-recovery Admin hold. Operator
 * recovery requires two distinct operators; recovery-code recovery has no
 * operator fields. The hold is exactly 24 hours after completion.
 */
export const identityMfaRecoveries = pgTable(
  'identity_mfa_recoveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    method: identityMfaRecoveryMethod('method').notNull(),
    status: identityMfaRecoveryStatus('status').notNull(),
    requestedByOperatorId: text('requested_by_operator_id'),
    approvedByOperatorId: text('approved_by_operator_id'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    adminHoldUntil: timestamp('admin_hold_until', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('identity_mfa_recoveries_one_open_per_user_uq')
      .on(table.userId)
      .where(sql`${table.status} IN ('requested', 'approved')`),
    index('identity_mfa_recoveries_user_hold_idx').on(table.userId, table.adminHoldUntil),
    check(
      'identity_mfa_recoveries_operator_approvals_distinct_ck',
      sql`${table.requestedByOperatorId} IS NULL
        OR ${table.approvedByOperatorId} IS NULL
        OR ${table.requestedByOperatorId} <> ${table.approvedByOperatorId}`,
    ),
    check(
      'identity_mfa_recoveries_operator_approval_required_ck',
      sql`${table.method} <> 'operator'
        OR ${table.status} NOT IN ('approved', 'completed')
        OR (${table.requestedByOperatorId} IS NOT NULL
          AND ${table.approvedByOperatorId} IS NOT NULL)`,
    ),
    check(
      'identity_mfa_recoveries_approval_timestamp_pair_ck',
      sql`(${table.approvedAt} IS NULL) = (${table.approvedByOperatorId} IS NULL)`,
    ),
    check(
      'identity_mfa_recoveries_hold_timestamp_ck',
      sql`(
        (${table.completedAt} IS NULL AND ${table.adminHoldUntil} IS NULL)
        OR
        (${table.completedAt} IS NOT NULL
          AND ${table.adminHoldUntil} = ${table.completedAt} + interval '24 hours')
      )`,
    ),
    check(
      'identity_mfa_recoveries_completed_state_ck',
      sql`${table.status} <> 'completed' OR ${table.completedAt} IS NOT NULL`,
    ),
  ],
);

/**
 * Stores only a digest for the operator-issued, target-specific, single-use
 * authorization to begin the first TOTP enrollment.
 */
export const identityAdminEnrollmentAuthorizations = pgTable(
  'identity_admin_enrollment_authorizations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    recoveryId: uuid('recovery_id').references(() => identityMfaRecoveries.id, {
      onDelete: 'cascade',
    }),
    authorizationDigest: text('authorization_digest').notNull(),
    issuedByOperatorId: text('issued_by_operator_id'),
    approvedByOperatorId: text('approved_by_operator_id'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('identity_admin_enrollment_authorizations_digest_uq').on(table.authorizationDigest),
    uniqueIndex('identity_admin_enrollment_authorizations_recovery_uq').on(table.recoveryId),
    index('identity_admin_enrollment_authorizations_target_expiry_idx').on(
      table.targetUserId,
      table.expiresAt,
    ),
    check(
      'identity_admin_enrollment_authorizations_digest_not_blank_ck',
      sql`${table.authorizationDigest} <> ''`,
    ),
    check(
      'identity_admin_enrollment_authorizations_issuer_shape_ck',
      sql`(
        (${table.recoveryId} IS NULL
          AND ${table.issuedByOperatorId} IS NOT NULL
          AND ${table.approvedByOperatorId} IS NOT NULL
          AND ${table.issuedByOperatorId} <> ${table.approvedByOperatorId})
        OR
        (${table.recoveryId} IS NOT NULL
          AND ${table.issuedByOperatorId} IS NULL
          AND ${table.approvedByOperatorId} IS NULL)
      )`,
    ),
    check(
      'identity_admin_enrollment_authorizations_expiry_ck',
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
  ],
);

/** Stores only one-way digests of single-use recovery codes. */
export const identityMfaRecoveryCodes = pgTable(
  'identity_mfa_recovery_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    factorId: uuid('factor_id')
      .notNull()
      .references(() => identityMfaFactors.id, { onDelete: 'cascade' }),
    codeDigest: text('code_digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('identity_mfa_recovery_codes_digest_uq').on(table.codeDigest),
    index('identity_mfa_recovery_codes_factor_status_idx').on(
      table.factorId,
      table.consumedAt,
      table.revokedAt,
    ),
    check('identity_mfa_recovery_codes_digest_not_blank_ck', sql`${table.codeDigest} <> ''`),
    check(
      'identity_mfa_recovery_codes_single_terminal_state_ck',
      sql`${table.consumedAt} IS NULL OR ${table.revokedAt} IS NULL`,
    ),
  ],
);

/**
 * Shared account/IP counters. subjectDigest must be a keyed digest of the
 * account identifier or IP, never the raw IP or a raw challenge value.
 */
export const identityMfaAttemptCounters = pgTable(
  'identity_mfa_attempt_counters',
  {
    scope: identityMfaAttemptScope('scope').notNull(),
    action: identityMfaAttemptAction('action').notNull(),
    subjectDigest: text('subject_digest').notNull(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer('attempt_count').notNull().default(0),
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.scope, table.action, table.subjectDigest],
      name: 'identity_mfa_attempt_counters_pk',
    }),
    index('identity_mfa_attempt_counters_blocked_idx').on(table.blockedUntil),
    check('identity_mfa_attempt_counters_subject_not_blank_ck', sql`${table.subjectDigest} <> ''`),
    check('identity_mfa_attempt_counters_nonnegative_ck', sql`${table.attemptCount} >= 0`),
  ],
);

/**
 * Durable security audit history. User and session identifiers intentionally
 * have no foreign keys, so deleting an account or session cannot erase history.
 */
export const identityAdminAuditEvents = pgTable(
  'identity_admin_audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventType: identityAdminAuditEventType('event_type').notNull(),
    outcome: identityAdminAuditOutcome('outcome').notNull(),
    actorType: identityAdminAuditActorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id'),
    actorOperatorId: text('actor_operator_id'),
    approverOperatorId: text('approver_operator_id'),
    targetUserId: uuid('target_user_id'),
    sessionId: uuid('session_id'),
    requestId: text('request_id'),
    reason: text('reason'),
    operationId: uuid('operation_id'),
    caseReference: text('case_reference'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('identity_admin_audit_events_target_time_idx').on(table.targetUserId, table.occurredAt),
    index('identity_admin_audit_events_type_time_idx').on(table.eventType, table.occurredAt),
    index('identity_admin_audit_events_operation_idx').on(table.operationId),
    index('identity_admin_audit_events_case_idx').on(table.caseReference),
    check(
      'identity_admin_audit_events_actor_shape_ck',
      sql`(
        (${table.actorType} = 'user'
          AND ${table.actorUserId} IS NOT NULL
          AND ${table.actorOperatorId} IS NULL)
        OR
        (${table.actorType} = 'operator'
          AND ${table.actorUserId} IS NULL
          AND ${table.actorOperatorId} IS NOT NULL)
        OR
        (${table.actorType} = 'system'
          AND ${table.actorUserId} IS NULL
          AND ${table.actorOperatorId} IS NULL)
      )`,
    ),
    check(
      'identity_admin_audit_events_approvers_distinct_ck',
      sql`${table.approverOperatorId} IS NULL
        OR ${table.actorOperatorId} IS NULL
        OR ${table.approverOperatorId} <> ${table.actorOperatorId}`,
    ),
  ],
);

/**
 * Durable idempotency record for operator-controlled administrator changes.
 * User and operator identifiers intentionally have no foreign keys.
 */
export const identityAdminOperations = pgTable(
  'identity_admin_operations',
  {
    operationId: uuid('operation_id').primaryKey(),
    action: text('action').notNull(),
    targetUserId: uuid('target_user_id').notNull(),
    caseReference: text('case_reference').notNull(),
    reason: text('reason').notNull(),
    intentDigest: text('intent_digest').notNull(),
    outcome: text('outcome').notNull(),
    actorOperatorId: text('actor_operator_id').notNull(),
    approverOperatorId: text('approver_operator_id'),
    relatedOperationId: uuid('related_operation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('identity_admin_operations_target_time_idx').on(table.targetUserId, table.createdAt),
    index('identity_admin_operations_case_idx').on(table.caseReference),
    check(
      'identity_admin_operations_action_ck',
      sql`${table.action} IN ('grant', 'revoke', 'emergency_revoke', 'review_emergency_revoke', 'operator_mfa_recovery')`,
    ),
    check(
      'identity_admin_operations_outcome_ck',
      sql`${table.outcome} IN ('completed', 'rejected', 'no_op', 'reviewed')`,
    ),
    check(
      'identity_admin_operations_reason_not_blank_ck',
      sql`${table.reason} <> '' AND ${table.caseReference} <> '' AND ${table.intentDigest} <> ''`,
    ),
    check(
      'identity_admin_operations_approvers_distinct_ck',
      sql`${table.approverOperatorId} IS NULL OR ${table.actorOperatorId} <> ${table.approverOperatorId}`,
    ),
  ],
);
