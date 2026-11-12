import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import {
  sellerListingApprovedRevisions,
  sellerListingDraftConfigurations,
  sellerListingDrafts,
  sellerListingRevisionConfigurations,
  sellerListingRevisions,
  sellerListingReviewOutcomes,
  sellerListings,
} from './listing.table.js';
import {
  sellerListingDraftImages,
  sellerListingImages,
  sellerListingRevisionImages,
} from './listing-image.table.js';
import { getSellerListing, SellerListingServiceError } from './listing.service.js';

type ListingDatabase = DatabaseClient['db'];
type ListingTransaction = Parameters<Parameters<ListingDatabase['transaction']>[0]>[0];

export type CreateSellerListingDraftInput =
  | {
      sourceApprovedRevisionId: string;
      sourceRevisionId?: never;
      expectedControlRevision: number;
    }
  | {
      sourceRevisionId: string;
      sourceApprovedRevisionId?: never;
      expectedControlRevision: number;
    };

export interface SellerListingWorkflowDetail {
  listing: Awaited<ReturnType<typeof getSellerListing>> & {
    pendingSubmission: {
      revisionId: string;
      revision: number;
      submittedAt: string;
    } | null;
    latestReviewOutcome: {
      revisionId: string;
      revision: number;
      decision: 'changes_requested' | 'rejected' | 'approved';
      feedback: string | null;
      reviewedAt: string;
    } | null;
  };
}

/**
 * Copies the current approved revision or the latest reviewed revision into
 * the listing's editable draft. The listing lock serializes this transition
 * with seller edits, submission, and review decisions. Immutable revisions
 * and their image references remain intact.
 */
export async function createSellerListingDraftFromRevision(
  db: ListingDatabase,
  sellerId: string,
  listingId: string,
  input: CreateSellerListingDraftInput,
): Promise<void> {
  if (!Number.isSafeInteger(input.expectedControlRevision) || input.expectedControlRevision < 1) {
    throw new SellerListingServiceError(400, 'expectedControlRevision', 'invalid_revision');
  }

  await db.transaction(async (tx: ListingTransaction) => {
    const [listing] = await tx
      .select()
      .from(sellerListings)
      .where(and(eq(sellerListings.id, listingId), eq(sellerListings.sellerId, sellerId)))
      .for('update')
      .limit(1);

    if (!listing) {
      throw new SellerListingServiceError(404);
    }

    if (listing.controlRevision !== input.expectedControlRevision) {
      throw new SellerListingServiceError(409, 'expectedControlRevision', 'stale_revision');
    }

    const approvedSource = typeof input.sourceApprovedRevisionId === 'string';
    const sourceRevisionId = approvedSource
      ? input.sourceApprovedRevisionId
      : input.sourceRevisionId;

    if (approvedSource) {
      if (listing.status !== 'approved') {
        throw new SellerListingServiceError(409, 'status', 'replacement_draft_not_allowed');
      }

      const [approvedPointer] = await tx
        .select({ revisionId: sellerListingApprovedRevisions.revisionId })
        .from(sellerListingApprovedRevisions)
        .where(eq(sellerListingApprovedRevisions.listingId, listingId))
        .for('update')
        .limit(1);

      if (approvedPointer?.revisionId !== sourceRevisionId) {
        throw new SellerListingServiceError(
          409,
          'sourceApprovedRevisionId',
          'stale_approved_revision',
        );
      }
    } else if (listing.status !== 'changes_requested' && listing.status !== 'rejected') {
      throw new SellerListingServiceError(409, 'status', 'correction_draft_not_allowed');
    }

    const [sourceRevision] = await tx
      .select()
      .from(sellerListingRevisions)
      .where(
        and(
          eq(sellerListingRevisions.id, sourceRevisionId),
          eq(sellerListingRevisions.listingId, listingId),
        ),
      )
      .limit(1);

    const [outcome] = approvedSource
      ? []
      : await tx
          .select({ decision: sellerListingReviewOutcomes.decision })
          .from(sellerListingReviewOutcomes)
          .where(
            and(
              eq(sellerListingReviewOutcomes.revisionId, sourceRevisionId),
              eq(sellerListingReviewOutcomes.listingId, listingId),
            ),
          )
          .limit(1);

    if (
      !sourceRevision ||
      (!approvedSource &&
        (!outcome ||
          (outcome.decision !== 'changes_requested' && outcome.decision !== 'rejected')))
    ) {
      throw new SellerListingServiceError(409, 'sourceRevisionId', 'reviewed_revision_required');
    }

    const [latestRevision] = await tx
      .select({ id: sellerListingRevisions.id })
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.listingId, listingId))
      .orderBy(desc(sellerListingRevisions.revision))
      .limit(1);

    if (latestRevision?.id !== sourceRevision.id) {
      throw new SellerListingServiceError(409, 'sourceRevisionId', 'stale_reviewed_revision');
    }

    const [draft] = await tx
      .select()
      .from(sellerListingDrafts)
      .where(eq(sellerListingDrafts.listingId, listingId))
      .for('update')
      .limit(1);

    if (!draft || draft.revision !== sourceRevision.revision) {
      throw new SellerListingServiceError(409, 'draft', 'correction_draft_not_available');
    }

    const configurations = await tx
      .select({
        catalogProductId: sellerListingRevisionConfigurations.catalogProductId,
        catalogVariantId: sellerListingRevisionConfigurations.catalogVariantId,
      })
      .from(sellerListingRevisionConfigurations)
      .where(
        and(
          eq(sellerListingRevisionConfigurations.listingId, listingId),
          eq(sellerListingRevisionConfigurations.revisionId, sourceRevision.id),
        ),
      )
      .orderBy(sellerListingRevisionConfigurations.catalogVariantId);

    const images = await tx
      .select({
        imageId: sellerListingRevisionImages.imageId,
        variantId: sellerListingRevisionImages.variantId,
        sortOrder: sellerListingRevisionImages.sortOrder,
        isCover: sellerListingRevisionImages.isCover,
      })
      .from(sellerListingRevisionImages)
      .where(
        and(
          eq(sellerListingRevisionImages.listingId, listingId),
          eq(sellerListingRevisionImages.revisionId, sourceRevision.id),
        ),
      )
      .orderBy(
        sellerListingRevisionImages.variantId,
        sellerListingRevisionImages.sortOrder,
        sellerListingRevisionImages.imageId,
      );

    const now = new Date();

    const [updatedDraft] = await tx
      .update(sellerListingDrafts)
      .set({
        revision: sourceRevision.revision + 1,
        catalogProductId: sourceRevision.catalogProductId,
        title: sourceRevision.title,
        description: sourceRevision.description,
        condition: sourceRevision.condition,
        updatedAt: now,
      })
      .where(
        and(
          eq(sellerListingDrafts.listingId, listingId),
          eq(sellerListingDrafts.revision, sourceRevision.revision),
        ),
      )
      .returning({ listingId: sellerListingDrafts.listingId });

    if (!updatedDraft) {
      throw new SellerListingServiceError(409, 'draft', 'stale_revision');
    }

    await tx
      .delete(sellerListingDraftConfigurations)
      .where(eq(sellerListingDraftConfigurations.listingId, listingId));

    if (configurations.length > 0) {
      await tx.insert(sellerListingDraftConfigurations).values(
        configurations.map((configuration) => ({
          listingId,
          catalogProductId: configuration.catalogProductId,
          catalogVariantId: configuration.catalogVariantId,
        })),
      );
    }

    await tx
      .delete(sellerListingDraftImages)
      .where(eq(sellerListingDraftImages.listingId, listingId));

    if (images.length > 0) {
      await tx.insert(sellerListingDraftImages).values(
        images.map((image) => ({
          listingId,
          imageId: image.imageId,
          variantId: image.variantId,
          sortOrder: image.sortOrder,
          isCover: image.isCover,
        })),
      );

      await tx
        .update(sellerListingImages)
        .set({ unreferencedAt: null })
        .where(
          and(
            eq(sellerListingImages.listingId, listingId),
            inArray(
              sellerListingImages.id,
              images.map((image) => image.imageId),
            ),
          ),
        );
    }

    const [updatedListing] = await tx
      .update(sellerListings)
      .set({
        status: 'draft',
        controlRevision: listing.controlRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(sellerListings.id, listingId),
          eq(sellerListings.sellerId, sellerId),
          eq(sellerListings.controlRevision, input.expectedControlRevision),
          eq(sellerListings.status, listing.status),
        ),
      )
      .returning({ id: sellerListings.id });

    if (!updatedListing) {
      throw new SellerListingServiceError(409, 'expectedControlRevision', 'stale_revision');
    }
  });
}

/** Returns safe seller-facing status and feedback with the owned listing. */
export async function getSellerListingWorkflowDetail(
  db: ListingDatabase,
  sellerId: string,
  listingId: string,
): Promise<SellerListingWorkflowDetail> {
  const listing = await getSellerListing(db, sellerId, listingId);

  const [latestRevision] = await db
    .select({
      id: sellerListingRevisions.id,
      revision: sellerListingRevisions.revision,
      submittedAt: sellerListingRevisions.submittedAt,
    })
    .from(sellerListingRevisions)
    .where(eq(sellerListingRevisions.listingId, listingId))
    .orderBy(desc(sellerListingRevisions.revision))
    .limit(1);

  const [latestOutcome] = await db
    .select({
      revisionId: sellerListingReviewOutcomes.revisionId,
      revision: sellerListingRevisions.revision,
      decision: sellerListingReviewOutcomes.decision,
      feedback: sellerListingReviewOutcomes.feedback,
      reviewedAt: sellerListingReviewOutcomes.reviewedAt,
    })
    .from(sellerListingReviewOutcomes)
    .innerJoin(
      sellerListingRevisions,
      and(
        eq(sellerListingRevisions.id, sellerListingReviewOutcomes.revisionId),
        eq(sellerListingRevisions.listingId, sellerListingReviewOutcomes.listingId),
      ),
    )
    .where(eq(sellerListingReviewOutcomes.listingId, listingId))
    .orderBy(desc(sellerListingRevisions.revision))
    .limit(1);

  let latestReviewOutcome: SellerListingWorkflowDetail['listing']['latestReviewOutcome'] = null;
  const decision = latestOutcome?.decision;

  if (
    latestOutcome &&
    (decision === 'changes_requested' || decision === 'rejected' || decision === 'approved')
  ) {
    latestReviewOutcome = {
      revisionId: latestOutcome.revisionId,
      revision: latestOutcome.revision,
      decision,
      feedback: latestOutcome.feedback,
      reviewedAt: latestOutcome.reviewedAt.toISOString(),
    };
  }

  return {
    listing: {
      ...listing,
      pendingSubmission:
        listing.status === 'submitted' && latestRevision
          ? {
              revisionId: latestRevision.id,
              revision: latestRevision.revision,
              submittedAt: latestRevision.submittedAt.toISOString(),
            }
          : null,
      latestReviewOutcome,
    },
  };
}
