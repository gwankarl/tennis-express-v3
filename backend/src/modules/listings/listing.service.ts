import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import { catalogProducts } from '../catalog/product.table.js';
import { catalogVariants } from '../catalog/variant.table.js';
import {
  sellerListingApprovedRevisions,
  sellerListingDraftConfigurations,
  sellerListingDrafts,
  sellerListings,
} from './listing.table.js';
import {
  assertExpectedDraftRevision,
  ListingValidationError,
  normalizeCatalogVariantIds,
  normalizeListingDraftFields,
  type ListingDraftFieldsInput,
  type SellerListingCondition,
} from './listing.validation.js';

type ListingDatabase = DatabaseClient['db'];

export interface CreateSellerListingInput extends ListingDraftFieldsInput {
  catalogProductId: string;
  catalogVariantIds?: readonly string[];
}

export interface UpdateSellerListingDraftInput extends ListingDraftFieldsInput {
  expectedDraftRevision: number;
  catalogProductId?: string;
  catalogVariantIds?: readonly string[];
}

export interface SellerListingPagination {
  limit: number;
  offset: number;
}

export class SellerListingServiceError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    readonly field?: string,
    readonly rule?: string,
  ) {
    super('Seller listing request failed.');
    this.name = 'SellerListingServiceError';
  }
}

export interface SellerListingDraftData {
  revision: number;
  catalogProductId: string;
  catalogVariantIds: string[];
  title: string | null;
  description: string | null;
  condition: SellerListingCondition | null;
  createdAt: string;
  updatedAt: string;
}

export interface SellerListingData {
  id: string;
  status: (typeof sellerListings.$inferSelect)['status'];
  controlRevision: number;
  approvedRevisionId: string | null;
  pausedAt: string | null;
  archivedAt: string | null;
  administratorRemovedAt: string | null;
  draft: SellerListingDraftData | null;
  createdAt: string;
  updatedAt: string;
}

function toListingData(
  listing: typeof sellerListings.$inferSelect,
  draft: typeof sellerListingDrafts.$inferSelect | null,
  approvedRevisionId: string | null,
  catalogVariantIds: string[],
): SellerListingData {
  return {
    id: listing.id,
    status: listing.status,
    controlRevision: listing.controlRevision,
    approvedRevisionId,
    pausedAt: listing.pausedAt?.toISOString() ?? null,
    archivedAt: listing.archivedAt?.toISOString() ?? null,
    administratorRemovedAt: listing.administratorRemovedAt?.toISOString() ?? null,
    draft: draft
      ? {
          revision: draft.revision,
          catalogProductId: draft.catalogProductId,
          catalogVariantIds,
          title: draft.title,
          description: draft.description,
          condition: draft.condition,
          createdAt: draft.createdAt.toISOString(),
          updatedAt: draft.updatedAt.toISOString(),
        }
      : null,
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
  };
}

function sendValidationError(error: ListingValidationError): never {
  throw new SellerListingServiceError(400, error.field, error.rule);
}

function normalizeFields(input: ListingDraftFieldsInput) {
  try {
    return normalizeListingDraftFields(input);
  } catch (error) {
    if (error instanceof ListingValidationError) {
      sendValidationError(error);
    }

    throw error;
  }
}

function normalizeVariantIds(ids: readonly string[] | undefined): string[] | undefined {
  try {
    return normalizeCatalogVariantIds(ids);
  } catch (error) {
    if (error instanceof ListingValidationError) {
      sendValidationError(error);
    }

    throw error;
  }
}

async function assertSelectableProduct(
  tx: Parameters<Parameters<ListingDatabase['transaction']>[0]>[0],
  catalogProductId: string,
): Promise<void> {
  const [product] = await tx
    .select({ id: catalogProducts.id })
    .from(catalogProducts)
    .where(and(eq(catalogProducts.id, catalogProductId), eq(catalogProducts.isVisible, true)))
    .for('update')
    .limit(1);

  if (!product) {
    throw new SellerListingServiceError(400, 'catalogProductId', 'not_found_or_unavailable');
  }
}

async function assertProductConfigurations(
  tx: Parameters<Parameters<ListingDatabase['transaction']>[0]>[0],
  catalogProductId: string,
  catalogVariantIds: readonly string[],
): Promise<void> {
  if (catalogVariantIds.length === 0) {
    return;
  }

  const variants = await tx
    .select({ id: catalogVariants.id })
    .from(catalogVariants)
    .where(
      and(
        eq(catalogVariants.productId, catalogProductId),
        inArray(catalogVariants.id, [...catalogVariantIds]),
      ),
    )
    .for('key share');

  if (variants.length !== catalogVariantIds.length) {
    throw new SellerListingServiceError(400, 'catalogVariantIds', 'invalid_configuration');
  }
}

async function loadConfigurationIds(db: ListingDatabase, listingId: string): Promise<string[]> {
  const rows = await db
    .select({ catalogVariantId: sellerListingDraftConfigurations.catalogVariantId })
    .from(sellerListingDraftConfigurations)
    .where(eq(sellerListingDraftConfigurations.listingId, listingId))
    .orderBy(sellerListingDraftConfigurations.catalogVariantId);

  return rows.map((row) => row.catalogVariantId);
}

/** Creates a listing and its initial incomplete draft atomically. */
export async function createSellerListing(
  db: ListingDatabase,
  sellerId: string,
  input: CreateSellerListingInput,
): Promise<SellerListingData> {
  const fields = normalizeFields(input);
  const catalogVariantIds = normalizeVariantIds(input.catalogVariantIds) ?? [];

  return db.transaction(async (tx) => {
    await assertSelectableProduct(tx, input.catalogProductId);
    await assertProductConfigurations(tx, input.catalogProductId, catalogVariantIds);

    const [listing] = await tx.insert(sellerListings).values({ sellerId }).returning();

    if (!listing) {
      throw new SellerListingServiceError(409);
    }

    const [draft] = await tx
      .insert(sellerListingDrafts)
      .values({
        listingId: listing.id,
        revision: 1,
        catalogProductId: input.catalogProductId,
        title: fields.title ?? null,
        description: fields.description ?? null,
        condition: fields.condition ?? null,
      })
      .returning();

    if (!draft) {
      throw new SellerListingServiceError(409);
    }

    if (catalogVariantIds.length > 0) {
      await tx.insert(sellerListingDraftConfigurations).values(
        catalogVariantIds.map((catalogVariantId) => ({
          listingId: listing.id,
          catalogProductId: input.catalogProductId,
          catalogVariantId,
        })),
      );
    }

    return toListingData(listing, draft, null, catalogVariantIds);
  });
}

/** Lists only the authenticated seller's listings in stable newest-first order. */
export async function listSellerListings(
  db: ListingDatabase,
  sellerId: string,
  pagination: SellerListingPagination,
): Promise<{ items: SellerListingData[]; limit: number; offset: number }> {
  const rows = await db
    .select({
      listing: sellerListings,
      draft: sellerListingDrafts,
      approvedRevisionId: sellerListingApprovedRevisions.revisionId,
    })
    .from(sellerListings)
    .leftJoin(sellerListingDrafts, eq(sellerListingDrafts.listingId, sellerListings.id))
    .leftJoin(
      sellerListingApprovedRevisions,
      eq(sellerListingApprovedRevisions.listingId, sellerListings.id),
    )
    .where(eq(sellerListings.sellerId, sellerId))
    .orderBy(desc(sellerListings.createdAt), desc(sellerListings.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  const listingIds = rows.map((row) => row.listing.id);
  const configurationRows =
    listingIds.length === 0
      ? []
      : await db
          .select({
            listingId: sellerListingDraftConfigurations.listingId,
            catalogVariantId: sellerListingDraftConfigurations.catalogVariantId,
          })
          .from(sellerListingDraftConfigurations)
          .where(inArray(sellerListingDraftConfigurations.listingId, listingIds));

  const configurationsByListing = new Map<string, string[]>();
  for (const row of configurationRows) {
    const ids = configurationsByListing.get(row.listingId) ?? [];
    ids.push(row.catalogVariantId);
    configurationsByListing.set(row.listingId, ids);
  }

  return {
    items: rows.map((row) =>
      toListingData(
        row.listing,
        row.draft,
        row.approvedRevisionId,
        configurationsByListing.get(row.listing.id) ?? [],
      ),
    ),
    ...pagination,
  };
}

/** Reads an owned listing; foreign and unknown IDs return the same 404. */
export async function getSellerListing(
  db: ListingDatabase,
  sellerId: string,
  listingId: string,
): Promise<SellerListingData> {
  const [row] = await db
    .select({
      listing: sellerListings,
      draft: sellerListingDrafts,
      approvedRevisionId: sellerListingApprovedRevisions.revisionId,
    })
    .from(sellerListings)
    .leftJoin(sellerListingDrafts, eq(sellerListingDrafts.listingId, sellerListings.id))
    .leftJoin(
      sellerListingApprovedRevisions,
      eq(sellerListingApprovedRevisions.listingId, sellerListings.id),
    )
    .where(and(eq(sellerListings.id, listingId), eq(sellerListings.sellerId, sellerId)))
    .limit(1);

  if (!row) {
    throw new SellerListingServiceError(404);
  }

  return toListingData(
    row.listing,
    row.draft,
    row.approvedRevisionId,
    row.draft ? await loadConfigurationIds(db, listingId) : [],
  );
}

/**
 * Updates an existing Draft only. The listing and draft locks serialize edits;
 * expectedDraftRevision makes stale client updates fail with a conflict.
 */
export async function updateSellerListingDraft(
  db: ListingDatabase,
  sellerId: string,
  listingId: string,
  input: UpdateSellerListingDraftInput,
): Promise<SellerListingData> {
  try {
    assertExpectedDraftRevision(input.expectedDraftRevision);
  } catch (error) {
    if (error instanceof ListingValidationError) {
      sendValidationError(error);
    }

    throw error;
  }

  const fields = normalizeFields(input);
  const requestedVariantIds = normalizeVariantIds(input.catalogVariantIds);

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

    if (listing.status !== 'draft') {
      throw new SellerListingServiceError(409, 'status', 'draft_not_editable');
    }

    const [draft] = await tx
      .select()
      .from(sellerListingDrafts)
      .where(eq(sellerListingDrafts.listingId, listingId))
      .for('update')
      .limit(1);

    if (!draft) {
      throw new SellerListingServiceError(409, 'draft', 'not_available');
    }

    if (draft.revision !== input.expectedDraftRevision) {
      throw new SellerListingServiceError(409, 'expectedDraftRevision', 'stale_revision');
    }

    const nextProductId = input.catalogProductId ?? draft.catalogProductId;
    const productChanged = nextProductId !== draft.catalogProductId;
    const replaceConfigurations = productChanged || requestedVariantIds !== undefined;

    const existingVariantIds =
      !productChanged && requestedVariantIds === undefined
        ? await tx
            .select({
              catalogVariantId: sellerListingDraftConfigurations.catalogVariantId,
            })
            .from(sellerListingDraftConfigurations)
            .where(eq(sellerListingDraftConfigurations.listingId, listingId))
            .orderBy(sellerListingDraftConfigurations.catalogVariantId)
        : [];

    const nextVariantIds = productChanged
      ? (requestedVariantIds ?? [])
      : (requestedVariantIds ?? existingVariantIds.map((row) => row.catalogVariantId));

    if (productChanged || requestedVariantIds !== undefined) {
      await assertSelectableProduct(tx, nextProductId);
      await assertProductConfigurations(tx, nextProductId, nextVariantIds);
    }

    const [updatedDraft] = await tx
      .update(sellerListingDrafts)
      .set({
        catalogProductId: nextProductId,
        ...(fields.title === undefined ? {} : { title: fields.title }),
        ...(fields.description === undefined ? {} : { description: fields.description }),
        ...(fields.condition === undefined ? {} : { condition: fields.condition }),
        revision: draft.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sellerListingDrafts.listingId, listingId),
          eq(sellerListingDrafts.revision, input.expectedDraftRevision),
        ),
      )
      .returning();

    if (!updatedDraft) {
      throw new SellerListingServiceError(409, 'expectedDraftRevision', 'stale_revision');
    }

    if (replaceConfigurations) {
      await tx
        .delete(sellerListingDraftConfigurations)
        .where(eq(sellerListingDraftConfigurations.listingId, listingId));

      if (nextVariantIds.length > 0) {
        await tx.insert(sellerListingDraftConfigurations).values(
          nextVariantIds.map((catalogVariantId) => ({
            listingId,
            catalogProductId: nextProductId,
            catalogVariantId,
          })),
        );
      }
    }

    const [approved] = await tx
      .select({ revisionId: sellerListingApprovedRevisions.revisionId })
      .from(sellerListingApprovedRevisions)
      .where(eq(sellerListingApprovedRevisions.listingId, listingId))
      .limit(1);

    return toListingData(listing, updatedDraft, approved?.revisionId ?? null, nextVariantIds);
  });
}
