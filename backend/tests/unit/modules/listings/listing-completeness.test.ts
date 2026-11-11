import { describe, expect, it } from 'vitest';
import {
  evaluateListingCompleteness,
  type EvaluateListingCompletenessInput,
  type ListingCompletenessImage,
  type ListingCompletenessSellableVariant,
} from '../../../../src/modules/listings/listing-completeness.js';

const listingId = 'listing-0001';
const sellerId = 'seller-0001';
const productId = 'product-0001';
const catalogVariantOneId = 'catalog-variant-0001';
const catalogVariantTwoId = 'catalog-variant-0002';
const sellableVariantOneId = 'sellable-variant-0001';
const sellableVariantTwoId = 'sellable-variant-0002';

function makeVariant(
  overrides: Partial<ListingCompletenessSellableVariant> = {},
): ListingCompletenessSellableVariant {
  return {
    id: sellableVariantOneId,
    listingId,
    sellerId,
    catalogVariantId: catalogVariantOneId,
    sku: 'TX-SYNTHETIC-001',
    priceXaf: 25_000,
    stockQuantity: 0,
    reservedQuantity: 0,
    isOfferedForSale: true,
    ...overrides,
  };
}

function makeCommonImage(): ListingCompletenessImage {
  return {
    id: 'image-common-0001',
    listingId,
    lifecycle: 'ready',
    mediaType: 'image/jpeg',
    byteSize: 2048,
    width: 600,
    height: 400,
    storageAvailable: true,
    assignments: [
      {
        imageId: 'image-common-0001',
        listingId,
        variantId: null,
        sortOrder: 0,
        isCover: true,
      },
    ],
  };
}

function makeInput(
  overrides: Partial<EvaluateListingCompletenessInput> = {},
): EvaluateListingCompletenessInput {
  const variantOne = makeVariant();
  const variantTwo = makeVariant({
    id: sellableVariantTwoId,
    catalogVariantId: catalogVariantTwoId,
    sku: 'TX-SYNTHETIC-002',
  });

  return {
    listingId,
    sellerId,
    draftRevision: 7,
    title: 'Synthetic adult tennis racquet',
    description: 'Synthetic listing used by the completeness evaluator test.',
    condition: 'new',
    catalogProduct: {
      id: productId,
      isVisible: true,
      attributeRuleSetKey: 'tennis_racquets',
      fixedAttributes: {
        audience: 'adult',
        lengthInches: 27,
      },
      variantOptionKeys: ['gripSize'],
      variants: [
        {
          id: catalogVariantOneId,
          productId,
          optionValues: { gripSize: 'L2' },
          optionSignature: '{"gripSize":"L2"}',
          isDefault: false,
        },
        {
          id: catalogVariantTwoId,
          productId,
          optionValues: { gripSize: 'L3' },
          optionSignature: '{"gripSize":"L3"}',
          isDefault: false,
        },
      ],
    },
    selectedConfigurations: [
      { catalogProductId: productId, catalogVariantId: catalogVariantOneId },
      { catalogProductId: productId, catalogVariantId: catalogVariantTwoId },
    ],
    sellableVariants: [variantOne, variantTwo],
    sellerSkuRecords: [
      { id: sellableVariantOneId, sku: 'TX-SYNTHETIC-001' },
      { id: sellableVariantTwoId, sku: 'TX-SYNTHETIC-002' },
    ],
    images: [makeCommonImage()],
    ...overrides,
  };
}

describe('evaluateListingCompleteness', () => {
  it('accepts a complete draft with zero stock and common-image coverage', () => {
    const result = evaluateListingCompleteness(makeInput());

    expect(result).toMatchObject({
      listingId,
      draftRevision: 7,
      ready: true,
      issues: [],
    });
  });

  it('returns issues for incomplete seller fields and a missing price without changing input', () => {
    const input = makeInput({
      title: null,
      description: '   ',
      condition: null,
      sellableVariants: [
        makeVariant({ priceXaf: null }),
        makeVariant({
          id: sellableVariantTwoId,
          catalogVariantId: catalogVariantTwoId,
          sku: 'TX-SYNTHETIC-002',
        }),
      ],
    });
    const before = structuredClone(input);

    const result = evaluateListingCompleteness(input);

    expect(result.ready).toBe(false);
    expect(result.issues.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'condition_required', path: 'condition' },
      { code: 'description_required', path: 'description' },
      {
        code: 'variant_price_required',
        path: `sellableVariants.${sellableVariantOneId}.priceXaf`,
      },
      { code: 'title_required', path: 'title' },
    ]);
    expect(input).toEqual(before);
  });

  it('returns issues in the same stable order regardless of row order', () => {
    const input = makeInput({
      title: null,
      description: null,
      condition: null,
      selectedConfigurations: [],
      sellableVariants: [],
      sellerSkuRecords: [],
      images: [],
    });

    const first = evaluateListingCompleteness(input);
    const second = evaluateListingCompleteness({
      ...input,
      selectedConfigurations: [...input.selectedConfigurations].reverse(),
      images: [...input.images].reverse(),
    });

    expect(first).toEqual(second);
    expect(first.issues.map((issue) => issue.path)).toEqual(
      [...first.issues.map((issue) => issue.path)].sort(),
    );
  });

  it('reuses category rules to report missing required adult racquet attributes', () => {
    const input = makeInput({
      catalogProduct: {
        ...makeInput().catalogProduct!,
        fixedAttributes: { audience: 'adult', lengthInches: 27 },
        variantOptionKeys: [],
        variants: [
          {
            id: catalogVariantOneId,
            productId,
            optionValues: {},
            optionSignature: '{}',
            isDefault: true,
          },
        ],
      },
      selectedConfigurations: [
        { catalogProductId: productId, catalogVariantId: catalogVariantOneId },
      ],
      sellableVariants: [makeVariant()],
      sellerSkuRecords: [{ id: sellableVariantOneId, sku: 'TX-SYNTHETIC-001' }],
    });

    const result = evaluateListingCompleteness(input);

    expect(result.ready).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'catalog_configuration_invalid',
        kind: 'invalid_reference',
        path: 'catalogProduct.attributes.gripSize',
      }),
    );
  });

  it('rejects invalid catalog option values and mismatched option signatures', () => {
    const product = makeInput().catalogProduct!;
    const input = makeInput({
      catalogProduct: {
        ...product,
        variants: [
          {
            id: catalogVariantOneId,
            productId,
            optionValues: { gripSize: 'L9' },
            optionSignature: '{"gripSize":"L9"}',
            isDefault: false,
          },
        ],
      },
      selectedConfigurations: [
        { catalogProductId: productId, catalogVariantId: catalogVariantOneId },
      ],
      sellableVariants: [makeVariant()],
      sellerSkuRecords: [{ id: sellableVariantOneId, sku: 'TX-SYNTHETIC-001' }],
    });

    const result = evaluateListingCompleteness(input);

    expect(result.ready).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'catalog_configuration_invalid')).toBe(
      true,
    );
  });

  it('requires and accepts the single default configuration for a fixed product', () => {
    const fixedProduct = {
      id: productId,
      isVisible: true,
      attributeRuleSetKey: 'tennis_racquets',
      fixedAttributes: {
        audience: 'adult',
        lengthInches: 27,
        gripSize: 'L2',
      },
      variantOptionKeys: [],
      variants: [
        {
          id: catalogVariantOneId,
          productId,
          optionValues: {},
          optionSignature: '{}',
          isDefault: true,
        },
      ],
    };
    const ready = makeInput({
      catalogProduct: fixedProduct,
      selectedConfigurations: [
        { catalogProductId: productId, catalogVariantId: catalogVariantOneId },
      ],
      sellableVariants: [makeVariant()],
      sellerSkuRecords: [{ id: sellableVariantOneId, sku: 'TX-SYNTHETIC-001' }],
    });

    expect(evaluateListingCompleteness(ready).ready).toBe(true);

    const missingDefault = evaluateListingCompleteness({
      ...ready,
      selectedConfigurations: [],
      sellableVariants: [],
      sellerSkuRecords: [],
    });

    expect(missingDefault.issues).toContainEqual(
      expect.objectContaining({ code: 'default_variant_required' }),
    );
  });

  it('reports missing price, negative stock, reservations, and duplicate seller SKUs', () => {
    const input = makeInput({
      sellableVariants: [
        makeVariant({
          priceXaf: 0,
          stockQuantity: -1,
          reservedQuantity: 1,
        }),
        makeVariant({
          id: sellableVariantTwoId,
          catalogVariantId: catalogVariantTwoId,
          sku: 'TX-SYNTHETIC-001',
        }),
      ],
      sellerSkuRecords: [
        { id: sellableVariantOneId, sku: 'TX-SYNTHETIC-001' },
        { id: sellableVariantTwoId, sku: 'TX-SYNTHETIC-001' },
      ],
    });

    const result = evaluateListingCompleteness(input);
    const codes = result.issues.map((issue) => issue.code);

    expect(codes).toContain('variant_price_required');
    expect(codes).toContain('variant_stock_invalid');
    expect(codes).toContain('variant_reservation_invalid');
    expect(codes).toContain('variant_sku_conflict');
  });

  it('uses variant-specific images and falls back to common images only when none are assigned', () => {
    const variantSpecific: ListingCompletenessImage = {
      ...makeCommonImage(),
      id: 'image-variant-0001',
      assignments: [
        {
          imageId: 'image-variant-0001',
          listingId,
          variantId: sellableVariantOneId,
          sortOrder: 0,
          isCover: true,
        },
      ],
    };
    const input = makeInput({
      images: [makeCommonImage(), variantSpecific],
    });

    expect(evaluateListingCompleteness(input).ready).toBe(true);

    const missingFallback = evaluateListingCompleteness({
      ...input,
      images: [variantSpecific],
    });

    expect(missingFallback.issues).toContainEqual(
      expect.objectContaining({
        code: 'variant_image_required',
        item: { type: 'sellable_variant', id: sellableVariantTwoId },
      }),
    );
  });

  it('reports invalid or foreign configuration, variant, and image references', () => {
    const image: ListingCompletenessImage = {
      ...makeCommonImage(),
      assignments: [
        {
          imageId: 'image-common-0001',
          listingId: 'another-listing',
          variantId: 'foreign-sellable-variant',
          sortOrder: -1,
          isCover: true,
        },
      ],
    };
    const input = makeInput({
      selectedConfigurations: [
        { catalogProductId: 'another-product', catalogVariantId: catalogVariantOneId },
      ],
      sellableVariants: [
        makeVariant({
          listingId: 'another-listing',
          sellerId: 'another-seller',
        }),
      ],
      images: [image],
    });

    const result = evaluateListingCompleteness(input);

    expect(result.ready).toBe(false);
    expect(result.issues.some((issue) => issue.kind === 'invalid_reference')).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'image_assignment_invalid')).toBe(true);
  });

  it('reports an unavailable stored file separately from invalid metadata', () => {
    const image = { ...makeCommonImage(), storageAvailable: false };

    const result = evaluateListingCompleteness(makeInput({ images: [image] }));

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'image_storage_missing',
        kind: 'invalid_reference',
        path: 'images.image-common-0001',
      }),
    );
  });

  it('requires valid media, dimensions, and a selected variant for image assignments', () => {
    const input = makeInput({
      images: [
        {
          ...makeCommonImage(),
          mediaType: 'image/svg+xml',
          width: 100,
          assignments: [
            {
              imageId: 'image-common-0001',
              listingId,
              variantId: 'unselected-seller-variant',
              sortOrder: 0,
              isCover: true,
            },
          ],
        },
      ],
    });

    const result = evaluateListingCompleteness(input);
    const codes = result.issues.map((issue) => issue.code);

    expect(codes).toContain('image_reference_invalid');
    expect(codes).toContain('image_assignment_invalid');
    expect(codes).toContain('variant_image_required');
  });

  it('allows image order gaps and zero stock under the proposed policy', () => {
    const image = makeCommonImage();
    const second = {
      ...makeCommonImage(),
      id: 'image-common-0002',
      assignments: [
        {
          imageId: 'image-common-0002',
          listingId,
          variantId: null,
          sortOrder: 5,
          isCover: false,
        },
      ],
    };

    const result = evaluateListingCompleteness(makeInput({ images: [image, second] }));

    expect(result.ready).toBe(true);
  });
});
