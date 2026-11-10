import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import { identityUsers } from '../identity/accounts/user.table.js';
import { sellerApplicationEvidence } from './application-evidence.table.js';
import { sellerApplications } from './application.table.js';
import { sellerApplicationReviewDecisions, sellerOperatingAccess } from './review.table.js';
import {
  normalizeSellerReviewDecisionInput,
  SellerReviewValidationError,
  type SellerReviewDecisionInput,
} from './review.validation.js';

type SellerReviewDatabase = DatabaseClient['db'];
type ApplicationRow = typeof sellerApplications.$inferSelect;

function hasPostgresErrorCode(error: unknown, code: string): boolean {
  const seen = new Set<object>();
  let current: unknown = error;

  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };

    if (candidate.code === code) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}

export class SellerReviewServiceError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    readonly field?: string,
    readonly rule?: string,
  ) {
    super('Seller review request failed.');
    this.name = 'SellerReviewServiceError';
  }
}

export interface SellerReviewQueueItem {
  id: string;
  category: ApplicationRow['category'];
  submittedRevision: number;
  submittedAt: string;
  applicantEmail: string;
  legalName: string;
}

export interface SellerReviewDetail {
  id: string;
  category: ApplicationRow['category'];
  status: ApplicationRow['status'];
  submittedRevision: number;
  submittedAt: string;
  applicantEmail: string;
  legalName: string;
  sellerDisplayName: string | null;
  areaServed: string | null;
  contactPhone: string | null;
  registeredBusinessName: string | null;
  businessRole: string | null;
  storefrontName: string | null;
  evidence: Array<{
    type: typeof sellerApplicationEvidence.$inferSelect.type;
    mediaType: typeof sellerApplicationEvidence.$inferSelect.mediaType;
    byteSize: number;
    updatedAt: string;
  }>;
}

export interface SellerReviewDecisionResult {
  applicationId: string;
  reviewedRevision: number;
  decision: typeof sellerApplicationReviewDecisions.$inferSelect.decision;
  feedback: string | null;
  requestedEvidence: typeof sellerApplicationReviewDecisions.$inferSelect.requestedEvidence;
  decidedAt: string;
  applicationStatus: ApplicationRow['status'];
  applicationRevision: number;
}

function toReviewDetail(
  application: ApplicationRow,
  applicantEmail: string,
  evidence: SellerReviewDetail['evidence'],
): SellerReviewDetail {
  if (!application.firstSubmittedAt) {
    throw new SellerReviewServiceError(409, 'status', 'not_submitted');
  }

  return {
    id: application.id,
    category: application.category,
    status: application.status,
    submittedRevision: application.revision,
    submittedAt: application.firstSubmittedAt.toISOString(),
    applicantEmail,
    legalName: application.applicantLegalName ?? '',
    sellerDisplayName: application.sellerDisplayName,
    areaServed: application.areaServed,
    contactPhone: application.contactPhone,
    registeredBusinessName: application.registeredBusinessName,
    businessRole: application.businessRole,
    storefrontName: application.storefrontName,
    evidence,
  };
}

/**
 * Returns a bounded page of submitted applications and excludes the reviewer’s
 * own application before any result is returned.
 */
export async function listSellerApplicationsForReview(
  db: SellerReviewDatabase,
  reviewerUserId: string,
  input: { limit: number; offset: number },
): Promise<{ items: SellerReviewQueueItem[]; limit: number; offset: number }> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0
  ) {
    throw new SellerReviewServiceError(400, 'pagination', 'out_of_range');
  }

  const rows = await db
    .select({
      id: sellerApplications.id,
      category: sellerApplications.category,
      revision: sellerApplications.revision,
      submittedAt: sellerApplications.firstSubmittedAt,
      applicantEmail: identityUsers.deliveryEmail,
      legalName: sellerApplications.applicantLegalName,
    })
    .from(sellerApplications)
    .innerJoin(identityUsers, eq(sellerApplications.userId, identityUsers.id))
    .where(
      and(
        eq(sellerApplications.status, 'submitted'),
        ne(sellerApplications.userId, reviewerUserId),
      ),
    )
    .orderBy(desc(sellerApplications.updatedAt), desc(sellerApplications.id))
    .limit(input.limit)
    .offset(input.offset);

  return {
    items: rows.map((row) => {
      if (!row.submittedAt) {
        throw new SellerReviewServiceError(409, 'status', 'submission_timestamp_missing');
      }

      return {
        id: row.id,
        category: row.category,
        submittedRevision: row.revision,
        submittedAt: row.submittedAt.toISOString(),
        applicantEmail: row.applicantEmail,
        legalName: row.legalName ?? '',
      };
    }),
    limit: input.limit,
    offset: input.offset,
  };
}

/**
 * Returns an application only while it is submitted and only to a different
 * account. Self-owned and unknown IDs share the same not-found response.
 */
export async function getSellerApplicationForReview(
  db: SellerReviewDatabase,
  reviewerUserId: string,
  applicationId: string,
): Promise<SellerReviewDetail> {
  const [application] = await db
    .select()
    .from(sellerApplications)
    .where(
      and(
        eq(sellerApplications.id, applicationId),
        eq(sellerApplications.status, 'submitted'),
        ne(sellerApplications.userId, reviewerUserId),
      ),
    )
    .limit(1);

  if (!application || !application.firstSubmittedAt) {
    throw new SellerReviewServiceError(404);
  }

  const [user] = await db
    .select({ email: identityUsers.deliveryEmail })
    .from(identityUsers)
    .where(eq(identityUsers.id, application.userId))
    .limit(1);

  if (!user) {
    throw new SellerReviewServiceError(404);
  }

  const evidence = await db
    .select({
      type: sellerApplicationEvidence.type,
      mediaType: sellerApplicationEvidence.mediaType,
      byteSize: sellerApplicationEvidence.byteSize,
      updatedAt: sellerApplicationEvidence.updatedAt,
    })
    .from(sellerApplicationEvidence)
    .where(eq(sellerApplicationEvidence.applicationId, application.id));

  return toReviewDetail(
    application,
    user.email,
    evidence.map((item) => ({ ...item, updatedAt: item.updatedAt.toISOString() })),
  );
}

/**
 * Applies a decision to exactly the submitted revision returned by the review
 * detail request. Row locking serializes competing decisions. Approval and
 * operating-access creation commit or roll back together.
 */
export async function decideSellerApplication(
  db: SellerReviewDatabase,
  reviewerUserId: string,
  applicationId: string,
  input: SellerReviewDecisionInput,
  now = new Date(),
): Promise<SellerReviewDecisionResult> {
  try {
    return await db.transaction(async (tx) => {
      const [application] = await tx
        .select()
        .from(sellerApplications)
        .where(eq(sellerApplications.id, applicationId))
        .for('update')
        .limit(1);

      if (!application || application.userId === reviewerUserId) {
        throw new SellerReviewServiceError(404);
      }

      if (application.status !== 'submitted' || !application.firstSubmittedAt) {
        throw new SellerReviewServiceError(409, 'status', 'application_not_reviewable');
      }

      if (application.revision !== input.expectedRevision) {
        throw new SellerReviewServiceError(409, 'expectedRevision', 'stale_revision');
      }

      let normalized;

      try {
        normalized = normalizeSellerReviewDecisionInput(application.category, input);
      } catch (error) {
        if (error instanceof SellerReviewValidationError) {
          throw new SellerReviewServiceError(400, error.field, error.rule);
        }

        throw error;
      }

      const nextStatus =
        normalized.decision === 'approve'
          ? 'approved'
          : normalized.decision === 'request_changes'
            ? 'changes_requested'
            : 'rejected';
      const decidedAt = new Date(now);

      const [updated] = await tx
        .update(sellerApplications)
        .set({
          status: nextStatus,
          revision: sql`${sellerApplications.revision} + 1`,
          proofOfAuthorityRequired:
            application.category === 'commercial' &&
            normalized.decision === 'request_changes' &&
            normalized.requestedEvidence.includes('proof_of_authority'),
          updatedAt: decidedAt,
        })
        .where(
          and(
            eq(sellerApplications.id, application.id),
            eq(sellerApplications.status, 'submitted'),
            eq(sellerApplications.revision, normalized.expectedRevision),
          ),
        )
        .returning({
          status: sellerApplications.status,
          revision: sellerApplications.revision,
        });

      if (!updated) {
        throw new SellerReviewServiceError(409, 'expectedRevision', 'stale_revision');
      }

      const [decision] = await tx
        .insert(sellerApplicationReviewDecisions)
        .values({
          applicationId: application.id,
          reviewedRevision: normalized.expectedRevision,
          reviewerUserId,
          decision: normalized.decision,
          feedback: normalized.feedback,
          requestedEvidence: normalized.requestedEvidence,
          decidedAt,
        })
        .returning();

      if (!decision) {
        throw new SellerReviewServiceError(409);
      }

      if (normalized.decision === 'approve') {
        await tx.insert(sellerOperatingAccess).values({
          userId: application.userId,
          applicationId: application.id,
          status: 'active',
          activatedAt: decidedAt,
          updatedAt: decidedAt,
        });
      }

      return {
        applicationId: application.id,
        reviewedRevision: decision.reviewedRevision,
        decision: decision.decision,
        feedback: decision.feedback,
        requestedEvidence: decision.requestedEvidence,
        decidedAt: decision.decidedAt.toISOString(),
        applicationStatus: updated.status,
        applicationRevision: updated.revision,
      };
    });
  } catch (error) {
    if (error instanceof SellerReviewServiceError) {
      throw error;
    }

    // Drizzle wraps PostgreSQL errors; inspect the cause chain so a unique
    // constraint conflict becomes the stable HTTP conflict response.
    if (hasPostgresErrorCode(error, '23505')) {
      throw new SellerReviewServiceError(409);
    }

    throw error;
  }
}
