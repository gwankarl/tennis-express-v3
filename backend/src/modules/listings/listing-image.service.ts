import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import type {
  PrivateListingImageFileStore,
  StagedListingImage,
} from '../../infrastructure/storage/private-listing-image-file-store.js';
import {
  sellerListingDraftImages,
  sellerListingImages,
  sellerListingRevisionImages,
} from './listing-image.table.js';
import { sellerListingDrafts, sellerListingVariants, sellerListings } from './listing.table.js';

type ListingDatabase = DatabaseClient['db'];

export const MAX_LISTING_IMAGES_PER_LISTING = 10;

export class ListingImageServiceError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    readonly field?: string,
    readonly rule?: string,
  ) {
    super('Seller listing image request failed.');
    this.name = 'ListingImageServiceError';
  }
}

export interface ListingImageAssignmentInput {
  imageId: string;
  variantId: string | null;
  sortOrder: number;
  isCover: boolean;
}

export interface ReplaceListingImageAssignmentsInput {
  expectedDraftRevision: number;
  assignments: readonly ListingImageAssignmentInput[];
}

export interface ListingImageAssignmentData {
  variantId: string | null;
  sortOrder: number;
  isCover: boolean;
}

export interface SellerListingImageData {
  id: string;
  mediaType: (typeof sellerListingImages.$inferSelect)['mediaType'];
  byteSize: number;
  width: number;
  height: number;
  assignments: ListingImageAssignmentData[];
}

export interface SellerListingImageMutationData {
  draftRevision: number;
  images: SellerListingImageData[];
}

function validationError(field: string, rule: string): never {
  throw new ListingImageServiceError(400, field, rule);
}

async function lockEditableDraft(
  tx: Parameters<Parameters<ListingDatabase['transaction']>[0]>[0],
  sellerId: string,
  listingId: string,
  expectedDraftRevision: number,
) {
  const [listing] = await tx
    .select()
    .from(sellerListings)
    .where(and(eq(sellerListings.id, listingId), eq(sellerListings.sellerId, sellerId)))
    .for('update')
    .limit(1);

  if (!listing) {
    throw new ListingImageServiceError(404);
  }

  if (listing.status !== 'draft' && listing.status !== 'changes_requested') {
    throw new ListingImageServiceError(409, 'status', 'draft_not_editable');
  }

  const [draft] = await tx
    .select()
    .from(sellerListingDrafts)
    .where(eq(sellerListingDrafts.listingId, listingId))
    .for('update')
    .limit(1);

  if (!draft) {
    throw new ListingImageServiceError(409, 'draft', 'not_available');
  }

  if (draft.revision !== expectedDraftRevision) {
    throw new ListingImageServiceError(409, 'expectedDraftRevision', 'stale_revision');
  }

  return { listing, draft };
}

async function bumpDraftRevision(
  tx: Parameters<Parameters<ListingDatabase['transaction']>[0]>[0],
  listingId: string,
  expectedDraftRevision: number,
): Promise<number> {
  const [updated] = await tx
    .update(sellerListingDrafts)
    .set({
      revision: expectedDraftRevision + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sellerListingDrafts.listingId, listingId),
        eq(sellerListingDrafts.revision, expectedDraftRevision),
      ),
    )
    .returning({ revision: sellerListingDrafts.revision });

  if (!updated) {
    throw new ListingImageServiceError(409, 'expectedDraftRevision', 'stale_revision');
  }

  return updated.revision;
}

async function readDraftImages(
  tx: Parameters<Parameters<ListingDatabase['transaction']>[0]>[0],
  listingId: string,
): Promise<SellerListingImageData[]> {
  const imageRows = await tx
    .select({
      id: sellerListingImages.id,
      mediaType: sellerListingImages.mediaType,
      byteSize: sellerListingImages.byteSize,
      width: sellerListingImages.width,
      height: sellerListingImages.height,
    })
    .from(sellerListingDraftImages)
    .innerJoin(
      sellerListingImages,
      and(
        eq(sellerListingImages.id, sellerListingDraftImages.imageId),
        eq(sellerListingImages.listingId, sellerListingDraftImages.listingId),
      ),
    )
    .where(eq(sellerListingDraftImages.listingId, listingId))
    .groupBy(
      sellerListingImages.id,
      sellerListingImages.mediaType,
      sellerListingImages.byteSize,
      sellerListingImages.width,
      sellerListingImages.height,
    )
    .orderBy(sellerListingImages.createdAt, sellerListingImages.id);

  const assignmentRows = await tx
    .select({
      imageId: sellerListingDraftImages.imageId,
      variantId: sellerListingDraftImages.variantId,
      sortOrder: sellerListingDraftImages.sortOrder,
      isCover: sellerListingDraftImages.isCover,
    })
    .from(sellerListingDraftImages)
    .where(eq(sellerListingDraftImages.listingId, listingId))
    .orderBy(sellerListingDraftImages.variantId, sellerListingDraftImages.sortOrder);

  const assignmentsByImage = new Map<string, ListingImageAssignmentData[]>();

  for (const assignment of assignmentRows) {
    const items = assignmentsByImage.get(assignment.imageId) ?? [];
    items.push({
      variantId: assignment.variantId,
      sortOrder: assignment.sortOrder,
      isCover: assignment.isCover,
    });
    assignmentsByImage.set(assignment.imageId, items);
  }

  return imageRows.map((image) => ({
    ...image,
    assignments: assignmentsByImage.get(image.id) ?? [],
  }));
}

async function markUnreferencedDraftImages(
  tx: Parameters<Parameters<ListingDatabase['transaction']>[0]>[0],
  listingId: string,
  imageIds: readonly string[],
): Promise<void> {
  if (imageIds.length === 0) return;

  const referencedRows = await tx
    .select({ imageId: sellerListingRevisionImages.imageId })
    .from(sellerListingRevisionImages)
    .where(
      and(
        eq(sellerListingRevisionImages.listingId, listingId),
        inArray(sellerListingRevisionImages.imageId, [...imageIds]),
      ),
    );

  const referenced = new Set(referencedRows.map((row) => row.imageId));
  const now = new Date();

  for (const imageId of imageIds) {
    if (referenced.has(imageId)) continue;

    await tx
      .update(sellerListingImages)
      .set({ unreferencedAt: now })
      .where(
        and(
          eq(sellerListingImages.listingId, listingId),
          eq(sellerListingImages.id, imageId),
          eq(sellerListingImages.lifecycle, 'ready'),
        ),
      );
  }
}

/**
 * Promotes a staged immutable object and attaches it to the current draft.
 * On a failed database transaction, the promoted file is removed; if cleanup
 * itself fails, Batch 4's orphan cleanup can safely reclaim it later.
 */
export async function uploadSellerListingImage(
  db: ListingDatabase,
  fileStore: PrivateListingImageFileStore,
  input: {
    sellerId: string;
    listingId: string;
    expectedDraftRevision: number;
    staged: StagedListingImage;
  },
): Promise<SellerListingImageMutationData> {
  let promoted = false;

  try {
    return await db.transaction(async (tx) => {
      const { draft } = await lockEditableDraft(
        tx,
        input.sellerId,
        input.listingId,
        input.expectedDraftRevision,
      );

      const currentRows = await tx
        .select({ imageId: sellerListingDraftImages.imageId })
        .from(sellerListingDraftImages)
        .where(eq(sellerListingDraftImages.listingId, input.listingId));

      const imageIds = new Set(currentRows.map((row) => row.imageId));
      if (imageIds.size >= MAX_LISTING_IMAGES_PER_LISTING) {
        validationError('file', 'image_limit_reached');
      }

      const commonAssignments = await tx
        .select({ sortOrder: sellerListingDraftImages.sortOrder })
        .from(sellerListingDraftImages)
        .where(
          and(
            eq(sellerListingDraftImages.listingId, input.listingId),
            isNull(sellerListingDraftImages.variantId),
          ),
        )
        .orderBy(sellerListingDraftImages.sortOrder);

      const nextCommonOrder =
        commonAssignments.length === 0
          ? 0
          : Math.max(...commonAssignments.map((row) => row.sortOrder)) + 1;
      const isFirstCommonImage = commonAssignments.length === 0;

      await fileStore.promote(input.staged);
      promoted = true;

      const [image] = await tx
        .insert(sellerListingImages)
        .values({
          listingId: input.listingId,
          storageKey: input.staged.storageKey,
          mediaType: input.staged.mediaType,
          byteSize: input.staged.byteSize,
          width: input.staged.width,
          height: input.staged.height,
          sha256: input.staged.sha256,
          lifecycle: 'ready',
          unreferencedAt: null,
        })
        .returning({ id: sellerListingImages.id });

      if (!image) {
        throw new Error('Listing image metadata insert failed.');
      }

      await tx.insert(sellerListingDraftImages).values({
        listingId: input.listingId,
        imageId: image.id,
        variantId: null,
        sortOrder: nextCommonOrder,
        isCover: isFirstCommonImage,
      });

      const draftRevision = await bumpDraftRevision(
        tx,
        input.listingId,
        input.expectedDraftRevision,
      );
      const images = await readDraftImages(tx, input.listingId);

      return { draftRevision, images };
    });
  } catch (error) {
    if (promoted) {
      await fileStore.deleteStored(input.staged.storageKey).catch(() => undefined);
    } else {
      await fileStore.discardStaged(input.staged).catch(() => undefined);
    }

    throw error;
  }
}

/**
 * Replaces the complete image selection for the editable draft. The list may
 * assign one image to several variants; null variantId denotes common images.
 */
export async function replaceSellerListingImageAssignments(
  db: ListingDatabase,
  input: {
    sellerId: string;
    listingId: string;
    body: ReplaceListingImageAssignmentsInput;
  },
): Promise<SellerListingImageMutationData> {
  const { expectedDraftRevision, assignments } = input.body;

  const uniqueAssignments = new Set<string>();
  const uniqueOrders = new Set<string>();
  const coverScopes = new Set<string>();
  const imageIds = [...new Set(assignments.map((assignment) => assignment.imageId))];
  const variantIds = [
    ...new Set(
      assignments.flatMap((assignment) => (assignment.variantId ? [assignment.variantId] : [])),
    ),
  ];

  if (imageIds.length > MAX_LISTING_IMAGES_PER_LISTING) {
    validationError('assignments', 'image_limit_reached');
  }

  for (const assignment of assignments) {
    if (!Number.isSafeInteger(assignment.sortOrder) || assignment.sortOrder < 0) {
      validationError('assignments', 'invalid_order');
    }

    const scope = assignment.variantId ?? 'common';
    const assignmentKey = `${assignment.imageId}:${scope}`;
    const orderKey = `${scope}:${assignment.sortOrder}`;

    if (uniqueAssignments.has(assignmentKey)) {
      validationError('assignments', 'duplicate_assignment');
    }
    if (uniqueOrders.has(orderKey)) {
      validationError('assignments', 'duplicate_order');
    }
    if (assignment.isCover && coverScopes.has(scope)) {
      validationError('assignments', 'duplicate_cover');
    }

    uniqueAssignments.add(assignmentKey);
    uniqueOrders.add(orderKey);
    if (assignment.isCover) coverScopes.add(scope);
  }

  return db.transaction(async (tx) => {
    await lockEditableDraft(tx, input.sellerId, input.listingId, expectedDraftRevision);

    const existingImages = imageIds.length
      ? await tx
          .select({ id: sellerListingImages.id })
          .from(sellerListingImages)
          .where(
            and(
              eq(sellerListingImages.listingId, input.listingId),
              inArray(sellerListingImages.id, imageIds),
              eq(sellerListingImages.lifecycle, 'ready'),
            ),
          )
          .for('update')
      : [];

    if (existingImages.length !== imageIds.length) {
      throw new ListingImageServiceError(404);
    }

    if (variantIds.length > 0) {
      const variants = await tx
        .select({ id: sellerListingVariants.id })
        .from(sellerListingVariants)
        .where(
          and(
            eq(sellerListingVariants.listingId, input.listingId),
            inArray(sellerListingVariants.id, variantIds),
          ),
        )
        .for('update');

      if (variants.length !== variantIds.length) {
        throw new ListingImageServiceError(404);
      }
    }

    await tx
      .delete(sellerListingDraftImages)
      .where(eq(sellerListingDraftImages.listingId, input.listingId));

    if (assignments.length > 0) {
      await tx.insert(sellerListingDraftImages).values(
        assignments.map((assignment) => ({
          listingId: input.listingId,
          imageId: assignment.imageId,
          variantId: assignment.variantId,
          sortOrder: assignment.sortOrder,
          isCover: assignment.isCover,
        })),
      );
    }

    if (imageIds.length > 0) {
      await tx
        .update(sellerListingImages)
        .set({ unreferencedAt: null })
        .where(
          and(
            eq(sellerListingImages.listingId, input.listingId),
            inArray(sellerListingImages.id, imageIds),
          ),
        );
    }

    const priorRows = await tx
      .select({ imageId: sellerListingDraftImages.imageId })
      .from(sellerListingDraftImages)
      .where(eq(sellerListingDraftImages.listingId, input.listingId));

    const retained = new Set(priorRows.map((row) => row.imageId));
    const candidates = await tx
      .select({ id: sellerListingImages.id })
      .from(sellerListingImages)
      .where(eq(sellerListingImages.listingId, input.listingId));

    await markUnreferencedDraftImages(
      tx,
      input.listingId,
      candidates.map((row) => row.id).filter((id) => !retained.has(id)),
    );

    const draftRevision = await bumpDraftRevision(tx, input.listingId, expectedDraftRevision);
    const images = await readDraftImages(tx, input.listingId);

    return { draftRevision, images };
  });
}

/** Removes all current-draft assignments for one owned image, retaining its file. */
export async function removeSellerListingImageFromDraft(
  db: ListingDatabase,
  input: {
    sellerId: string;
    listingId: string;
    imageId: string;
    expectedDraftRevision: number;
  },
): Promise<SellerListingImageMutationData> {
  return db.transaction(async (tx) => {
    await lockEditableDraft(tx, input.sellerId, input.listingId, input.expectedDraftRevision);

    const [image] = await tx
      .select({ id: sellerListingImages.id })
      .from(sellerListingImages)
      .where(
        and(
          eq(sellerListingImages.listingId, input.listingId),
          eq(sellerListingImages.id, input.imageId),
          eq(sellerListingImages.lifecycle, 'ready'),
        ),
      )
      .for('update')
      .limit(1);

    if (!image) {
      throw new ListingImageServiceError(404);
    }

    const [assignment] = await tx
      .select({ imageId: sellerListingDraftImages.imageId })
      .from(sellerListingDraftImages)
      .where(
        and(
          eq(sellerListingDraftImages.listingId, input.listingId),
          eq(sellerListingDraftImages.imageId, input.imageId),
        ),
      )
      .limit(1);

    if (!assignment) {
      throw new ListingImageServiceError(404);
    }

    await tx
      .delete(sellerListingDraftImages)
      .where(
        and(
          eq(sellerListingDraftImages.listingId, input.listingId),
          eq(sellerListingDraftImages.imageId, input.imageId),
        ),
      );

    await markUnreferencedDraftImages(tx, input.listingId, [input.imageId]);

    const draftRevision = await bumpDraftRevision(tx, input.listingId, input.expectedDraftRevision);
    const images = await readDraftImages(tx, input.listingId);

    return { draftRevision, images };
  });
}
