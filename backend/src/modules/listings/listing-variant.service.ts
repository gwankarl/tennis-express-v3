import { and, eq } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import {
  sellerListingApprovedRevisions,
  sellerListingPriceHistory,
  sellerListingRevisionConfigurations,
  sellerListingRevisions,
  sellerListingVariants,
} from './listing.table.js';
import {
  assertExpectedVariantVersion,
  assertStockCoversReservations,
  assertVariantOfferable,
  ListingValidationError,
  normalizeSellerListingVariantOperationalFields,
  type SellerListingVariantOperationalFields,
} from './listing.validation.js';
import {
  SellerListingServiceError,
  type SellerListingVariantData,
} from './listing.service.js';

type ListingDatabase = DatabaseClient['db'];

export interface PatchSellerListingVariantInput extends SellerListingVariantOperationalFields {
  expectedVersion: number;
}

function toVariantData(variant: typeof sellerListingVariants.$inferSelect): SellerListingVariantData {
  return {
    id: variant.id,
    catalogVariantId: variant.catalogVariantId,
    sku: variant.sku,
    priceXaf: variant.priceXaf,
    stockQuantity: variant.stockQuantity,
    reservedQuantity: variant.reservedQuantity,
    isOfferedForSale: variant.isOfferedForSale,
    version: variant.version,
  };
}

function validationError(error: ListingValidationError): SellerListingServiceError {
  return new SellerListingServiceError(400, error.field, error.rule);
}

function isSellerSkuConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };

    if (
      candidate.code === '23505' &&
      candidate.constraint === 'seller_listing_variants_seller_sku_uq'
    ) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}

async function isConfigurationApproved(
  tx: Parameters<Parameters<ListingDatabase['transaction']>[0]>[0],
  listingId: string,
  catalogVariantId: string,
): Promise<boolean> {
  // Share-lock the pointer so approval cannot replace it midway through this
  // offerability check. Concurrent updates to different variant rows can share it.
  const [approved] = await tx
    .select({ revisionId: sellerListingApprovedRevisions.revisionId })
    .from(sellerListingApprovedRevisions)
    .where(eq(sellerListingApprovedRevisions.listingId, listingId))
    .for('share')
    .limit(1);

  if (!approved) {
    return false;
  }

  const [revision] = await tx
    .select({ id: sellerListingRevisions.id })
    .from(sellerListingRevisions)
    .where(
      and(
        eq(sellerListingRevisions.id, approved.revisionId),
        eq(sellerListingRevisions.listingId, listingId),
      ),
    )
    .limit(1);

  if (!revision) {
    return false;
  }

  const [configuration] = await tx
    .select({ catalogVariantId: sellerListingRevisionConfigurations.catalogVariantId })
    .from(sellerListingRevisionConfigurations)
    .where(
      and(
        eq(sellerListingRevisionConfigurations.listingId, listingId),
        eq(sellerListingRevisionConfigurations.revisionId, approved.revisionId),
        eq(sellerListingRevisionConfigurations.catalogVariantId, catalogVariantId),
      ),
    )
    .limit(1);

  return Boolean(configuration);
}

/** Updates only seller-controlled operational fields on one owned offer. */
export async function patchSellerListingVariant(
  db: ListingDatabase,
  sellerId: string,
  listingId: string,
  variantId: string,
  input: PatchSellerListingVariantInput,
): Promise<SellerListingVariantData> {
  try {
    assertExpectedVariantVersion(input.expectedVersion);
  } catch (error) {
    if (error instanceof ListingValidationError) {
      throw validationError(error);
    }

    throw error;
  }

  let fields: ReturnType<typeof normalizeSellerListingVariantOperationalFields>;
  try {
    fields = normalizeSellerListingVariantOperationalFields(input);
  } catch (error) {
    if (error instanceof ListingValidationError) {
      throw validationError(error);
    }

    throw error;
  }

  try {
    return await db.transaction(async (tx) => {
      // The composite listing/seller ownership predicate gives foreign and
      // unknown listing or variant IDs the same not-found outcome.
      const [variant] = await tx
        .select()
        .from(sellerListingVariants)
        .where(
          and(
            eq(sellerListingVariants.id, variantId),
            eq(sellerListingVariants.listingId, listingId),
            eq(sellerListingVariants.sellerId, sellerId),
          ),
        )
        .for('update')
        .limit(1);

      if (!variant) {
        throw new SellerListingServiceError(404);
      }

      if (variant.version !== input.expectedVersion) {
        throw new SellerListingServiceError(409, 'expectedVersion', 'stale_version');
      }

      const nextPriceXaf = fields.priceXaf === undefined ? variant.priceXaf : fields.priceXaf;
      const nextStockQuantity =
        fields.stockQuantity === undefined ? variant.stockQuantity : fields.stockQuantity;
      const nextSku = fields.sku ?? variant.sku;
      const nextIsOfferedForSale =
        fields.isOfferedForSale ?? variant.isOfferedForSale;

      try {
        assertStockCoversReservations(nextStockQuantity, variant.reservedQuantity);
        assertVariantOfferable(nextPriceXaf, nextIsOfferedForSale);
      } catch (error) {
        if (error instanceof ListingValidationError) {
          if (error.rule === 'below_reserved_quantity') {
            throw new SellerListingServiceError(409, error.field, error.rule);
          }

          throw validationError(error);
        }

        throw error;
      }

      if (
        nextIsOfferedForSale &&
        !(await isConfigurationApproved(tx, listingId, variant.catalogVariantId))
      ) {
        throw new SellerListingServiceError(409, 'isOfferedForSale', 'configuration_not_approved');
      }

      const [updated] = await tx
        .update(sellerListingVariants)
        .set({
          priceXaf: nextPriceXaf,
          stockQuantity: nextStockQuantity,
          sku: nextSku,
          isOfferedForSale: nextIsOfferedForSale,
          version: variant.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sellerListingVariants.id, variant.id),
            eq(sellerListingVariants.version, input.expectedVersion),
          ),
        )
        .returning();

      if (!updated) {
        throw new SellerListingServiceError(409, 'expectedVersion', 'stale_version');
      }

      if (variant.priceXaf !== nextPriceXaf) {
        await tx.insert(sellerListingPriceHistory).values({
          sellerListingVariantId: variant.id,
          previousPriceXaf: variant.priceXaf,
          newPriceXaf: nextPriceXaf,
        });
      }

      return toVariantData(updated);
    });
  } catch (error) {
    if (isSellerSkuConflict(error)) {
      throw new SellerListingServiceError(409, 'sku', 'already_in_use');
    }

    throw error;
  }
}
