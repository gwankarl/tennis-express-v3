import { and, eq } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import { sellerListingApprovedRevisions, sellerListings } from './listing.table.js';
import { SellerListingServiceError } from './listing.service.js';

type ListingDatabase = DatabaseClient['db'];
type ListingControlAction = 'pause' | 'resume' | 'archive' | 'restore';

export interface UpdateSellerListingControlInput {
  expectedControlRevision: number;
}

export interface SellerListingControlData {
  id: string;
  status: (typeof sellerListings.$inferSelect)['status'];
  controlRevision: number;
  approvedRevisionId: string | null;
  pausedAt: string | null;
  archivedAt: string | null;
  administratorRemovedAt: string | null;
}

/**
 * Applies a seller control without changing workflow status or revision content.
 * The listing lock serializes this transition with draft creation and submission.
 */
export async function applySellerListingControl(
  db: ListingDatabase,
  sellerId: string,
  listingId: string,
  action: ListingControlAction,
  input: UpdateSellerListingControlInput,
): Promise<SellerListingControlData> {
  if (
    !Number.isSafeInteger(input.expectedControlRevision) ||
    input.expectedControlRevision < 1 ||
    input.expectedControlRevision > 2_147_483_647
  ) {
    throw new SellerListingServiceError(400, 'expectedControlRevision', 'invalid_revision');
  }

  return db.transaction(async (tx) => {
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

    const [approved] = await tx
      .select({ revisionId: sellerListingApprovedRevisions.revisionId })
      .from(sellerListingApprovedRevisions)
      .where(eq(sellerListingApprovedRevisions.listingId, listingId))
      .for('share')
      .limit(1);

    const now = new Date();
    const changes: { pausedAt?: Date | null; archivedAt?: Date | null } = {};

    switch (action) {
      case 'pause':
        if (
          !approved ||
          listing.pausedAt !== null ||
          listing.archivedAt !== null ||
          listing.administratorRemovedAt !== null
        ) {
          throw new SellerListingServiceError(409, 'action', 'pause_not_allowed');
        }
        changes.pausedAt = now;
        break;

      case 'resume':
        if (
          listing.pausedAt === null ||
          listing.archivedAt !== null ||
          listing.administratorRemovedAt !== null
        ) {
          throw new SellerListingServiceError(409, 'action', 'resume_not_allowed');
        }
        changes.pausedAt = null;
        break;

      case 'archive':
        if (listing.archivedAt !== null) {
          throw new SellerListingServiceError(409, 'action', 'archive_not_allowed');
        }
        changes.archivedAt = now;
        break;

      case 'restore':
        if (listing.archivedAt === null || listing.administratorRemovedAt !== null) {
          throw new SellerListingServiceError(409, 'action', 'restore_not_allowed');
        }
        changes.archivedAt = null;
        break;
    }

    const [updated] = await tx
      .update(sellerListings)
      .set({
        ...changes,
        controlRevision: listing.controlRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(sellerListings.id, listingId),
          eq(sellerListings.sellerId, sellerId),
          eq(sellerListings.controlRevision, input.expectedControlRevision),
        ),
      )
      .returning({
        id: sellerListings.id,
        status: sellerListings.status,
        controlRevision: sellerListings.controlRevision,
        pausedAt: sellerListings.pausedAt,
        archivedAt: sellerListings.archivedAt,
        administratorRemovedAt: sellerListings.administratorRemovedAt,
      });

    if (!updated) {
      throw new SellerListingServiceError(409, 'expectedControlRevision', 'stale_revision');
    }

    return {
      ...updated,
      approvedRevisionId: approved?.revisionId ?? null,
      pausedAt: updated.pausedAt?.toISOString() ?? null,
      archivedAt: updated.archivedAt?.toISOString() ?? null,
      administratorRemovedAt: updated.administratorRemovedAt?.toISOString() ?? null,
    };
  });
}
