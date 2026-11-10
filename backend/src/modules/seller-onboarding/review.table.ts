import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { identityUsers } from '../identity/accounts/user.table.js';
import { sellerApplications } from './application.table.js';
import { sellerApplicationEvidenceType } from './application-evidence.table.js';

export const sellerApplicationReviewDecisionType = pgEnum('seller_application_review_decision', [
  'approve',
  'request_changes',
  'reject',
]);

export const sellerOperatingAccessStatus = pgEnum('seller_operating_access_status', [
  'active',
  'suspended',
]);

/**
 * Records one reviewer decision for the exact application revision that was
 * submitted for review. Requested evidence is populated only for
 * Request changes decisions.
 */
export const sellerApplicationReviewDecisions = pgTable(
  'seller_application_review_decisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => sellerApplications.id, { onDelete: 'cascade' }),
    reviewedRevision: integer('reviewed_revision').notNull(),
    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'restrict' }),
    decision: sellerApplicationReviewDecisionType('decision').notNull(),
    feedback: text('feedback'),
    requestedEvidence: sellerApplicationEvidenceType('requested_evidence')
      .array()
      .notNull()
      .default(sql`ARRAY[]::seller_application_evidence_type[]`),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('seller_application_review_decisions_revision_uq').on(
      table.applicationId,
      table.reviewedRevision,
    ),
    index('seller_application_review_decisions_reviewer_time_idx').on(
      table.reviewerUserId,
      table.decidedAt,
    ),
    check(
      'seller_application_review_decisions_revision_positive_ck',
      sql`${table.reviewedRevision} > 0`,
    ),
    check(
      'seller_application_review_decisions_feedback_required_ck',
      sql`(
        ${table.decision} = 'approve'
        OR (${table.feedback} IS NOT NULL AND btrim(${table.feedback}) <> '')
      )`,
    ),
    check(
      'seller_application_review_decisions_requested_evidence_ck',
      sql`${table.decision} = 'request_changes'
        OR cardinality(${table.requestedEvidence}) = 0`,
    ),
  ],
);

/**
 * A missing row means the user has no Seller operating access. Approval creates
 * an active row in the same transaction as the application decision.
 */
export const sellerOperatingAccess = pgTable(
  'seller_onboarding_operating_access',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id')
      .notNull()
      .unique()
      .references(() => sellerApplications.id, { onDelete: 'cascade' }),
    status: sellerOperatingAccessStatus('status').notNull().default('active'),
    activatedAt: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('seller_onboarding_operating_access_status_idx').on(table.status, table.updatedAt),
  ],
);
