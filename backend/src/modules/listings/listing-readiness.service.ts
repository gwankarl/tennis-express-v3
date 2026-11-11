import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import type { PrivateListingImageFileStore } from '../../infrastructure/storage/private-listing-image-file-store.js';
import { catalogCategories } from '../catalog/category.table.js';
import { catalogProducts } from '../catalog/product.table.js';
import { catalogVariants } from '../catalog/variant.table.js';
import {
  sellerListingDraftConfigurations,
  sellerListingDrafts,
  sellerListingVariants,
  sellerListings,
} from './listing.table.js';
import { sellerListingDraftImages, sellerListingImages } from './listing-image.table.js';
import {
  evaluateListingCompleteness,
  type EvaluateListingCompletenessInput,
  type ListingCompletenessResult,
} from './listing-completeness.js';
import { SellerListingServiceError } from './listing.service.js';

type ListingDatabase = DatabaseClient['db'];
type ListingTransaction = Parameters<Parameters<ListingDatabase['transaction']>[0]>[0];

/**
 * Evaluates the latest owned draft from one repeatable-read snapshot.
 * Database and storage failures propagate as infrastructure errors.
 */
export async function getSellerListingReadiness(
  db: ListingDatabase,
  imageStore: PrivateListingImageFileStore,
  sellerId: string,
  listingId: string,
): Promise<ListingCompletenessResult> {
  return db.transaction(
    async (tx: ListingTransaction) => {
      const [listing] = await tx
        .select({
          id: sellerListings.id,
          status: sellerListings.status,
          sellerId: sellerListings.sellerId,
          revision: sellerListingDrafts.revision,
          catalogProductId: sellerListingDrafts.catalogProductId,
          title: sellerListingDrafts.title,
          description: sellerListingDrafts.description,
          condition: sellerListingDrafts.condition,
        })
        .from(sellerListings)
        .leftJoin(sellerListingDrafts, eq(sellerListingDrafts.listingId, sellerListings.id))
        .where(and(eq(sellerListings.id, listingId), eq(sellerListings.sellerId, sellerId)))
        .limit(1);

      if (!listing) {
        throw new SellerListingServiceError(404);
      }

      if (
        listing.status !== 'draft' ||
        listing.revision === null ||
        listing.catalogProductId === null
      ) {
        throw new SellerListingServiceError(409, 'listing', 'draft_not_available');
      }

      const [product] = await tx
        .select({
          id: catalogProducts.id,
          isVisible: catalogProducts.isVisible,
          fixedAttributes: catalogProducts.fixedAttributes,
          variantOptionKeys: catalogProducts.variantOptionKeys,
          attributeRuleSetKey: catalogCategories.attributeRuleSetKey,
        })
        .from(catalogProducts)
        .innerJoin(catalogCategories, eq(catalogCategories.id, catalogProducts.categoryId))
        .where(eq(catalogProducts.id, listing.catalogProductId))
        .limit(1);

      const productVariants = product
        ? await tx
            .select({
              id: catalogVariants.id,
              productId: catalogVariants.productId,
              optionValues: catalogVariants.optionValues,
              optionSignature: catalogVariants.optionSignature,
              isDefault: catalogVariants.isDefault,
            })
            .from(catalogVariants)
            .where(eq(catalogVariants.productId, product.id))
            .orderBy(catalogVariants.id)
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
              .select({
                id: sellerListingVariants.id,
                listingId: sellerListingVariants.listingId,
                sellerId: sellerListingVariants.sellerId,
                catalogVariantId: sellerListingVariants.catalogVariantId,
                sku: sellerListingVariants.sku,
                priceXaf: sellerListingVariants.priceXaf,
                stockQuantity: sellerListingVariants.stockQuantity,
                reservedQuantity: sellerListingVariants.reservedQuantity,
                isOfferedForSale: sellerListingVariants.isOfferedForSale,
              })
              .from(sellerListingVariants)
              .where(
                and(
                  eq(sellerListingVariants.listingId, listingId),
                  eq(sellerListingVariants.sellerId, sellerId),
                  inArray(sellerListingVariants.catalogVariantId, selectedCatalogVariantIds),
                ),
              )
              .orderBy(sellerListingVariants.id);

      const sellerSkuRecords = await tx
        .select({
          id: sellerListingVariants.id,
          sku: sellerListingVariants.sku,
        })
        .from(sellerListingVariants)
        .where(eq(sellerListingVariants.sellerId, sellerId))
        .orderBy(sellerListingVariants.id);

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

      const storageAvailability = new Map<string, boolean>();
      for (const image of imageRows) {
        if (!storageAvailability.has(image.id)) {
          storageAvailability.set(
            image.id,
            image.lifecycle === 'ready' ? await imageStore.isStored(image.storageKey) : false,
          );
        }
      }

      type MutableCompletenessImage = Omit<
        EvaluateListingCompletenessInput['images'][number],
        'assignments'
      > & {
        assignments: Array<
          EvaluateListingCompletenessInput['images'][number]['assignments'][number]
        >;
      };
      const imagesById = new Map<string, MutableCompletenessImage>();

      for (const row of imageRows) {
        const image = imagesById.get(row.id) ?? {
          id: row.id,
          listingId: row.listingId,
          lifecycle: row.lifecycle,
          mediaType: row.mediaType,
          byteSize: row.byteSize,
          width: row.width,
          height: row.height,
          storageAvailable: storageAvailability.get(row.id) ?? false,
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

      return evaluateListingCompleteness({
        listingId: listing.id,
        sellerId: listing.sellerId,
        draftRevision: listing.revision,
        title: listing.title,
        description: listing.description,
        condition: listing.condition,
        catalogProduct: product
          ? {
              id: product.id,
              isVisible: product.isVisible,
              attributeRuleSetKey: product.attributeRuleSetKey,
              fixedAttributes: product.fixedAttributes,
              variantOptionKeys: product.variantOptionKeys,
              variants: productVariants,
            }
          : null,
        selectedConfigurations,
        sellableVariants,
        sellerSkuRecords,
        images: [...imagesById.values()],
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
