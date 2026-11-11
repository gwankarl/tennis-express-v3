import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import type { PrivateListingImageFileStore } from '../../infrastructure/storage/private-listing-image-file-store.js';
import { catalogBrands } from '../catalog/brand.table.js';
import { catalogCategories } from '../catalog/category.table.js';
import { catalogProducts } from '../catalog/product.table.js';
import { catalogVariants } from '../catalog/variant.table.js';
import {
  sellerListingApprovedRevisions,
  sellerListingDraftConfigurations,
  sellerListingDrafts,
  sellerListingRevisionConfigurations,
  sellerListingRevisionOffers,
  sellerListingRevisions,
  sellerListingVariants,
  sellerListings,
  type SellerListingCatalogSnapshot,
} from './listing.table.js';
import {
  sellerListingDraftImages,
  sellerListingImages,
  sellerListingRevisionImages,
} from './listing-image.table.js';
import {
  evaluateListingCompleteness,
  type EvaluateListingCompletenessInput,
  type ListingCompletenessIssue,
} from './listing-completeness.js';
import { SellerListingServiceError } from './listing.service.js';

type ListingDatabase = DatabaseClient['db'];
type ListingTransaction = Parameters<Parameters<ListingDatabase['transaction']>[0]>[0];

export interface SubmitSellerListingInput {
  expectedDraftRevision: number;
}

export interface SellerListingSubmissionData {
  listingId: string;
  status: 'submitted';
  approvedRevisionId: string | null;
  pendingSubmission: {
    id: string;
    revision: number;
    submittedAt: string;
  };
}

/** Carries Task 8.6 issues to the HTTP validation envelope. */
export class ListingSubmissionIncompleteError extends Error {
  constructor(readonly issues: ListingCompletenessIssue[]) {
    super('The listing draft is incomplete.');
    this.name = 'ListingSubmissionIncompleteError';
  }
}

/**
 * Revalidates and seals the current draft in one transaction. Listing and draft
 * locks serialize content changes; row locks coordinate with catalog updates,
 * offer updates, and image cleanup. Operational offer values are read for
 * completeness only and are never stored in the revision.
 */
export async function submitSellerListing(
  db: ListingDatabase,
  imageStore: PrivateListingImageFileStore,
  sellerId: string,
  listingId: string,
  input: SubmitSellerListingInput,
): Promise<SellerListingSubmissionData> {
  if (!Number.isSafeInteger(input.expectedDraftRevision) || input.expectedDraftRevision < 1) {
    throw new SellerListingServiceError(400, 'expectedDraftRevision', 'invalid_revision');
  }

  // Use PostgreSQL READ COMMITTED: if a concurrent edit holds the listing lock,
  // this transaction must observe its committed revision and return a 409 rather
  // than surfacing a repeatable-read serialization error as an internal failure.
  return db.transaction(
    async (tx: ListingTransaction) => {
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
        throw new SellerListingServiceError(409, 'status', 'submission_not_allowed');
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

      // Share locks prevent a catalog edit from changing the presentation while
      // the evaluator and snapshot are being built.
      const [product] = await tx
        .select()
        .from(catalogProducts)
        .where(eq(catalogProducts.id, draft.catalogProductId))
        .for('share')
        .limit(1);

      const [category] = product
        ? await tx
            .select()
            .from(catalogCategories)
            .where(eq(catalogCategories.id, product.categoryId))
            .for('share')
            .limit(1)
        : [];

      const [brand] =
        product?.brandId !== null && product?.brandId !== undefined
          ? await tx
              .select()
              .from(catalogBrands)
              .where(eq(catalogBrands.id, product.brandId))
              .for('share')
              .limit(1)
          : [];

      const productVariants = product
        ? await tx
            .select()
            .from(catalogVariants)
            .where(eq(catalogVariants.productId, product.id))
            .orderBy(catalogVariants.id)
            .for('share')
        : [];

      const selectedConfigurations = await tx
        .select({
          catalogProductId: sellerListingDraftConfigurations.catalogProductId,
          catalogVariantId: sellerListingDraftConfigurations.catalogVariantId,
        })
        .from(sellerListingDraftConfigurations)
        .where(eq(sellerListingDraftConfigurations.listingId, listingId))
        .orderBy(sellerListingDraftConfigurations.catalogVariantId);

      const selectedCatalogVariantIds = selectedConfigurations.map(
        (configuration) => configuration.catalogVariantId,
      );

      const sellableVariants =
        selectedCatalogVariantIds.length === 0
          ? []
          : await tx
              .select()
              .from(sellerListingVariants)
              .where(
                and(
                  eq(sellerListingVariants.listingId, listingId),
                  eq(sellerListingVariants.sellerId, sellerId),
                  inArray(sellerListingVariants.catalogVariantId, selectedCatalogVariantIds),
                ),
              )
              .orderBy(sellerListingVariants.catalogVariantId)
              .for('share');

      const sellerSkuRecords = await tx
        .select({
          id: sellerListingVariants.id,
          sku: sellerListingVariants.sku,
        })
        .from(sellerListingVariants)
        .where(eq(sellerListingVariants.sellerId, sellerId))
        .orderBy(sellerListingVariants.id);

      // Hold image rows until revision references commit or the transaction
      // rolls back. Cleanup uses the same image-row lock before deleting.
      await tx
        .select({ id: sellerListingImages.id })
        .from(sellerListingImages)
        .where(eq(sellerListingImages.listingId, listingId))
        .for('share');

      const imageRows = await tx
        .select({
          id: sellerListingImages.id,
          listingId: sellerListingImages.listingId,
          storageKey: sellerListingImages.storageKey,
          lifecycle: sellerListingImages.lifecycle,
          mediaType: sellerListingImages.mediaType,
          byteSize: sellerListingImages.byteSize,
          width: sellerListingImages.width,
          height: sellerListingImages.height,
          imageId: sellerListingDraftImages.imageId,
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
        .where(eq(sellerListingDraftImages.listingId, listingId))
        .orderBy(
          sellerListingImages.id,
          sellerListingDraftImages.variantId,
          sellerListingDraftImages.sortOrder,
        );

      const storageAvailableByImageId = new Map<string, boolean>();
      for (const row of imageRows) {
        if (!storageAvailableByImageId.has(row.id)) {
          storageAvailableByImageId.set(
            row.id,
            row.lifecycle === 'ready' ? await imageStore.isStored(row.storageKey) : false,
          );
        }
      }

      type MutableImage = Omit<
        EvaluateListingCompletenessInput['images'][number],
        'assignments'
      > & {
        assignments: Array<
          EvaluateListingCompletenessInput['images'][number]['assignments'][number]
        >;
      };
      const imagesById = new Map<string, MutableImage>();

      for (const row of imageRows) {
        const image = imagesById.get(row.id) ?? {
          id: row.id,
          listingId: row.listingId,
          lifecycle: row.lifecycle,
          mediaType: row.mediaType,
          byteSize: row.byteSize,
          width: row.width,
          height: row.height,
          storageAvailable: storageAvailableByImageId.get(row.id) ?? false,
          assignments: [],
        };

        image.assignments.push({
          imageId: row.imageId,
          listingId: row.listingId,
          variantId: row.variantId,
          sortOrder: row.sortOrder,
          isCover: row.isCover,
        });
        imagesById.set(row.id, image);
      }

      const completeness = evaluateListingCompleteness({
        listingId,
        sellerId,
        draftRevision: draft.revision,
        title: draft.title,
        description: draft.description,
        condition: draft.condition,
        catalogProduct:
          product && category
            ? {
                id: product.id,
                isVisible: product.isVisible,
                attributeRuleSetKey: category.attributeRuleSetKey,
                fixedAttributes: product.fixedAttributes,
                variantOptionKeys: product.variantOptionKeys,
                variants: productVariants.map((variant) => ({
                  id: variant.id,
                  productId: variant.productId,
                  optionValues: variant.optionValues,
                  optionSignature: variant.optionSignature,
                  isDefault: variant.isDefault,
                })),
              }
            : null,
        selectedConfigurations,
        sellableVariants: sellableVariants.map((variant) => ({
          id: variant.id,
          listingId: variant.listingId,
          sellerId: variant.sellerId,
          catalogVariantId: variant.catalogVariantId,
          sku: variant.sku,
          priceXaf: variant.priceXaf,
          stockQuantity: variant.stockQuantity,
          reservedQuantity: variant.reservedQuantity,
          isOfferedForSale: variant.isOfferedForSale,
        })),
        sellerSkuRecords,
        images: [...imagesById.values()],
      });

      if (!completeness.ready) {
        throw new ListingSubmissionIncompleteError(completeness.issues);
      }

      if (!product || !category) {
        // Completeness above should make this unreachable; retain a safe
        // conflict if database references change or are inconsistent.
        throw new SellerListingServiceError(409, 'catalogProductId', 'catalog_reference_changed');
      }

      const sellableByCatalogVariantId = new Map(
        sellableVariants.map((variant) => [variant.catalogVariantId, variant]),
      );
      const catalogVariantById = new Map(productVariants.map((variant) => [variant.id, variant]));

      const catalogSnapshot: SellerListingCatalogSnapshot = {
        category: {
          id: category.id,
          slug: category.slug,
          name: category.name,
          attributeRuleSetKey: category.attributeRuleSetKey,
          imageUrl: category.imageUrl,
        },
        brand: brand
          ? {
              id: brand.id,
              slug: brand.slug,
              name: brand.name,
              imageUrl: brand.imageUrl,
            }
          : null,
        product: {
          id: product.id,
          name: product.name,
          description: product.description,
          fixedAttributes: product.fixedAttributes,
          variantOptionKeys: product.variantOptionKeys,
        },
        configurations: selectedConfigurations.map((configuration) => {
          const catalogVariant = catalogVariantById.get(configuration.catalogVariantId);
          const sellableVariant = sellableByCatalogVariantId.get(configuration.catalogVariantId);

          if (!catalogVariant || !sellableVariant) {
            throw new SellerListingServiceError(
              409,
              'catalogVariantIds',
              'catalog_reference_changed',
            );
          }

          return {
            catalogVariantId: catalogVariant.id,
            sellableVariantId: sellableVariant.id,
            optionValues: catalogVariant.optionValues,
            isDefault: catalogVariant.isDefault,
          };
        }),
      };

      const [revision] = await tx
        .insert(sellerListingRevisions)
        .values({
          listingId,
          revision: draft.revision,
          catalogProductId: draft.catalogProductId,
          submittedByUserId: sellerId,
          catalogSnapshot,
          title: draft.title!,
          description: draft.description,
          condition: draft.condition!,
        })
        .returning({
          id: sellerListingRevisions.id,
          revision: sellerListingRevisions.revision,
          submittedAt: sellerListingRevisions.submittedAt,
        });

      if (!revision) {
        throw new SellerListingServiceError(409, 'revision', 'not_created');
      }

      if (selectedConfigurations.length > 0) {
        await tx.insert(sellerListingRevisionConfigurations).values(
          selectedConfigurations.map((configuration) => ({
            listingId,
            revisionId: revision.id,
            catalogProductId: configuration.catalogProductId,
            catalogVariantId: configuration.catalogVariantId,
          })),
        );

        await tx.insert(sellerListingRevisionOffers).values(
          selectedConfigurations.map((configuration) => {
            const sellableVariant = sellableByCatalogVariantId.get(configuration.catalogVariantId);

            if (!sellableVariant) {
              throw new SellerListingServiceError(
                409,
                'catalogVariantIds',
                'catalog_reference_changed',
              );
            }

            return {
              listingId,
              revisionId: revision.id,
              catalogVariantId: configuration.catalogVariantId,
              sellerListingVariantId: sellableVariant.id,
            };
          }),
        );
      }

      if (imageRows.length > 0) {
        await tx.insert(sellerListingRevisionImages).values(
          imageRows.map((image) => ({
            listingId,
            revisionId: revision.id,
            imageId: image.imageId,
            variantId: image.variantId,
            sortOrder: image.sortOrder,
            isCover: image.isCover,
          })),
        );
      }

      const [approved] = await tx
        .select({ revisionId: sellerListingApprovedRevisions.revisionId })
        .from(sellerListingApprovedRevisions)
        .where(eq(sellerListingApprovedRevisions.listingId, listingId))
        .limit(1);

      const [updatedListing] = await tx
        .update(sellerListings)
        .set({
          status: 'submitted',
          controlRevision: listing.controlRevision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sellerListings.id, listingId),
            eq(sellerListings.sellerId, sellerId),
            eq(sellerListings.status, 'draft'),
            eq(sellerListings.controlRevision, listing.controlRevision),
          ),
        )
        .returning({ id: sellerListings.id });

      if (!updatedListing) {
        throw new SellerListingServiceError(409, 'status', 'submission_conflict');
      }

      return {
        listingId,
        status: 'submitted',
        approvedRevisionId: approved?.revisionId ?? null,
        pendingSubmission: {
          id: revision.id,
          revision: revision.revision,
          submittedAt: revision.submittedAt.toISOString(),
        },
      };
    },
  );
}
