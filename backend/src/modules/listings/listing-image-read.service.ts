import { and, eq, inArray, lte } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import type { PrivateListingImageFileStore } from '../../infrastructure/storage/private-listing-image-file-store.js';
import {
  sellerListingDraftImages,
  sellerListingImages,
  sellerListingRevisionImages,
} from './listing-image.table.js';
import { sellerListingDrafts, sellerListings } from './listing.table.js';
import { ListingImageServiceError, type SellerListingImageData } from './listing-image.service.js';

type ListingDatabase = DatabaseClient['db'];
type ListingTransaction = Parameters<Parameters<ListingDatabase['transaction']>[0]>[0];

export interface SellerListingImageFile {
  storageKey: string;
  mediaType: (typeof sellerListingImages.$inferSelect)['mediaType'];
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
}

const IMAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;

/** Lists safe metadata for the authenticated seller's current draft. */
export async function listSellerListingDraftImages(
  db: ListingDatabase,
  sellerId: string,
  listingId: string,
): Promise<{ draftRevision: number | null; images: SellerListingImageData[] }> {
  const [listing] = await db
    .select({ id: sellerListings.id })
    .from(sellerListings)
    .where(and(eq(sellerListings.id, listingId), eq(sellerListings.sellerId, sellerId)))
    .limit(1);

  if (!listing) throw new ListingImageServiceError(404);

  const [draft] = await db
    .select({ revision: sellerListingDrafts.revision })
    .from(sellerListingDrafts)
    .where(eq(sellerListingDrafts.listingId, listingId))
    .limit(1);

  const rows = await db
    .select({
      id: sellerListingImages.id,
      mediaType: sellerListingImages.mediaType,
      byteSize: sellerListingImages.byteSize,
      width: sellerListingImages.width,
      height: sellerListingImages.height,
      variantId: sellerListingDraftImages.variantId,
      sortOrder: sellerListingDraftImages.sortOrder,
      isCover: sellerListingDraftImages.isCover,
    })
    .from(sellerListingDraftImages)
    .innerJoin(
      sellerListingImages,
      and(
        eq(sellerListingImages.listingId, sellerListingDraftImages.listingId),
        eq(sellerListingImages.id, sellerListingDraftImages.imageId),
      ),
    )
    .where(
      and(
        eq(sellerListingDraftImages.listingId, listingId),
        eq(sellerListingImages.lifecycle, 'ready'),
      ),
    )
    .orderBy(sellerListingDraftImages.variantId, sellerListingDraftImages.sortOrder);

  const imagesById = new Map<string, SellerListingImageData>();

  for (const row of rows) {
    const image = imagesById.get(row.id) ?? {
      id: row.id,
      mediaType: row.mediaType,
      byteSize: row.byteSize,
      width: row.width,
      height: row.height,
      assignments: [],
    };

    image.assignments.push({
      variantId: row.variantId,
      sortOrder: row.sortOrder,
      isCover: row.isCover,
    });
    imagesById.set(row.id, image);
  }

  return {
    draftRevision: draft?.revision ?? null,
    images: [...imagesById.values()],
  };
}

/**
 * Resolves private file metadata for a listing after the caller has authorized
 * the owner or reviewer. If revisionId is supplied, the image must be assigned
 * to that exact immutable revision.
 */
export async function getListingImageForAuthorizedReader(
  db: ListingDatabase,
  listingId: string,
  imageId: string,
  revisionId?: string,
): Promise<SellerListingImageFile> {
  const [image] = await db
    .select({
      storageKey: sellerListingImages.storageKey,
      mediaType: sellerListingImages.mediaType,
      byteSize: sellerListingImages.byteSize,
      width: sellerListingImages.width,
      height: sellerListingImages.height,
      sha256: sellerListingImages.sha256,
    })
    .from(sellerListingImages)
    .where(
      and(
        eq(sellerListingImages.listingId, listingId),
        eq(sellerListingImages.id, imageId),
        eq(sellerListingImages.lifecycle, 'ready'),
      ),
    )
    .limit(1);

  if (!image) throw new ListingImageServiceError(404);

  const draftReference = revisionId
    ? []
    : await db
        .select({ imageId: sellerListingDraftImages.imageId })
        .from(sellerListingDraftImages)
        .where(
          and(
            eq(sellerListingDraftImages.listingId, listingId),
            eq(sellerListingDraftImages.imageId, imageId),
          ),
        )
        .limit(1);

  const revisionConditions = [
    eq(sellerListingRevisionImages.listingId, listingId),
    eq(sellerListingRevisionImages.imageId, imageId),
  ];
  if (revisionId) {
    revisionConditions.push(eq(sellerListingRevisionImages.revisionId, revisionId));
  }

  const revisionReference = await db
    .select({ imageId: sellerListingRevisionImages.imageId })
    .from(sellerListingRevisionImages)
    .where(and(...revisionConditions))
    .limit(1);

  if (draftReference.length === 0 && revisionReference.length === 0) {
    throw new ListingImageServiceError(404);
  }

  return image;
}

/** Owner-scoped resolver; reviewer routes should authorize separately first. */
export async function getSellerListingImageFile(
  db: ListingDatabase,
  sellerId: string,
  listingId: string,
  imageId: string,
): Promise<SellerListingImageFile> {
  const [listing] = await db
    .select({ id: sellerListings.id })
    .from(sellerListings)
    .where(and(eq(sellerListings.id, listingId), eq(sellerListings.sellerId, sellerId)))
    .limit(1);

  if (!listing) throw new ListingImageServiceError(404);

  return getListingImageForAuthorizedReader(db, listingId, imageId);
}

/**
 * Reclaims old unreferenced objects. Each candidate is locked and changed to
 * deleting before unlinking, so assignment/revision writers must lock the same
 * image row and require lifecycle=ready before attaching it.
 */
export async function cleanupSellerListingImages(
  db: ListingDatabase,
  store: PrivateListingImageFileStore,
  now = Date.now(),
): Promise<{ removedMetadataRows: number; removedOrphanObjects: number }> {
  await store.cleanupAbandonedStaging();

  const cutoff = new Date(now - IMAGE_RETENTION_MS);
  const candidates = await db
    .select({ id: sellerListingImages.id })
    .from(sellerListingImages)
    .where(
      and(
        lte(sellerListingImages.unreferencedAt, cutoff),
        inArray(sellerListingImages.lifecycle, ['ready', 'deleting']),
      ),
    )
    .limit(CLEANUP_BATCH_SIZE);

  let removedMetadataRows = 0;

  for (const candidate of candidates) {
    const storageKey = await db.transaction(async (tx: ListingTransaction) => {
      const [image] = await tx
        .select({
          id: sellerListingImages.id,
          listingId: sellerListingImages.listingId,
          storageKey: sellerListingImages.storageKey,
          unreferencedAt: sellerListingImages.unreferencedAt,
        })
        .from(sellerListingImages)
        .where(eq(sellerListingImages.id, candidate.id))
        .for('update')
        .limit(1);

      if (!image || !image.unreferencedAt || image.unreferencedAt.getTime() > cutoff.getTime()) {
        return null;
      }

      const [draftReference] = await tx
        .select({ imageId: sellerListingDraftImages.imageId })
        .from(sellerListingDraftImages)
        .where(
          and(
            eq(sellerListingDraftImages.listingId, image.listingId),
            eq(sellerListingDraftImages.imageId, image.id),
          ),
        )
        .limit(1);

      const [revisionReference] = await tx
        .select({ imageId: sellerListingRevisionImages.imageId })
        .from(sellerListingRevisionImages)
        .where(eq(sellerListingRevisionImages.imageId, image.id))
        .limit(1);

      if (draftReference || revisionReference) return null;

      // Delete the metadata while the row lock is held. Draft and revision
      // writers lock this row before attaching; FK checks also prevent a new
      // reference from committing after this delete.
      const [deleted] = await tx
        .delete(sellerListingImages)
        .where(eq(sellerListingImages.id, image.id))
        .returning({ storageKey: sellerListingImages.storageKey });

      return deleted?.storageKey ?? null;
    });

    if (!storageKey) continue;

    try {
      await store.deleteStored(storageKey);
      removedMetadataRows += 1;
    } catch {
      // The missing metadata makes this an orphan; the age-gated object sweep
      // can retry it on a later cleanup run.
    }
  }

  const remaining = await db
    .select({ storageKey: sellerListingImages.storageKey })
    .from(sellerListingImages);

  const removedOrphanObjects = await store.cleanupOrphanedObjects(
    new Set(remaining.map((row) => row.storageKey)),
    IMAGE_RETENTION_MS,
    now,
  );

  return { removedMetadataRows, removedOrphanObjects };
}
