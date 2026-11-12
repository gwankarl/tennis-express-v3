import { describe, expect, it } from 'vitest';
import {
  evaluateListingAvailability,
  type EvaluateListingAvailabilityInput,
  type ListingAvailabilityVariant,
} from '../../../../src/modules/listings/listing-availability.js';

const approvedRevisionId = 'approved-revision-001';
const approvedSellableVariantId = 'sellable-variant-approved';
const approvedCatalogVariantId = 'catalog-variant-approved';
const pendingSellableVariantId = 'sellable-variant-pending';
const pendingCatalogVariantId = 'catalog-variant-pending';

function makeVariant(
  overrides: Partial<ListingAvailabilityVariant> = {},
): ListingAvailabilityVariant {
  return {
    id: approvedSellableVariantId,
    catalogVariantId: approvedCatalogVariantId,
    priceXaf: 25_000,
    stockQuantity: 5,
    reservedQuantity: 1,
    isOfferedForSale: true,
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<EvaluateListingAvailabilityInput> = {},
): EvaluateListingAvailabilityInput {
  return {
    sellerEligible: true,
    administratorRemoved: false,
    archived: false,
    paused: false,
    approvedRevision: {
      id: approvedRevisionId,
      offers: [
        {
          sellerListingVariantId: approvedSellableVariantId,
          catalogVariantId: approvedCatalogVariantId,
        },
      ],
    },
    operationalVariants: [makeVariant()],
    ...overrides,
  };
}

describe('evaluateListingAvailability', () => {
  it('keeps an eligible approved listing visible at zero stock but not orderable', () => {
    const result = evaluateListingAvailability(
      makeInput({
        operationalVariants: [makeVariant({ stockQuantity: 0, reservedQuantity: 0 })],
      }),
    );

    expect(result).toMatchObject({
      visible: true,
      orderable: false,
      variants: [
        {
          sellerListingVariantId: approvedSellableVariantId,
          catalogVariantId: approvedCatalogVariantId,
          availableStock: 0,
          orderable: false,
        },
      ],
    });
  });

  it('keeps a paused approved listing visible but makes every variant unavailable to order', () => {
    const result = evaluateListingAvailability(makeInput({ paused: true }));

    expect(result.visible).toBe(true);
    expect(result.orderable).toBe(false);
    expect(result.variants[0]?.orderable).toBe(false);
  });

  it('hides archived, administrator-removed, or seller-ineligible listings', () => {
    for (const overrides of [
      { archived: true },
      { administratorRemoved: true },
      { sellerEligible: false },
    ]) {
      const result = evaluateListingAvailability(makeInput(overrides));

      expect(result.visible).toBe(false);
      expect(result.orderable).toBe(false);
      expect(result.variants[0]?.orderable).toBe(false);
    }
  });

  it('hides a listing that has no approved revision', () => {
    const result = evaluateListingAvailability(makeInput({ approvedRevision: null }));

    expect(result).toEqual({
      visible: false,
      orderable: false,
      variants: [],
    });
  });

  it('keeps a stopped approved variant represented but not orderable', () => {
    const result = evaluateListingAvailability(
      makeInput({
        operationalVariants: [makeVariant({ isOfferedForSale: false })],
      }),
    );

    expect(result.visible).toBe(true);
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]).toMatchObject({
      sellerListingVariantId: approvedSellableVariantId,
      catalogVariantId: approvedCatalogVariantId,
      orderable: false,
    });
  });

  it('uses on-hand stock minus reserved stock for orderability', () => {
    const someAvailable = evaluateListingAvailability(
      makeInput({
        operationalVariants: [makeVariant({ stockQuantity: 4, reservedQuantity: 3 })],
      }),
    );
    const allReserved = evaluateListingAvailability(
      makeInput({
        operationalVariants: [makeVariant({ stockQuantity: 4, reservedQuantity: 4 })],
      }),
    );

    expect(someAvailable.variants[0]).toMatchObject({
      availableStock: 1,
      orderable: true,
    });
    expect(allReserved.variants[0]).toMatchObject({
      availableStock: 0,
      orderable: false,
    });
  });

  it('requires a positive whole-XAF price before a variant can be ordered', () => {
    for (const priceXaf of [null, 0, -1, 25_000.5]) {
      const result = evaluateListingAvailability(
        makeInput({
          operationalVariants: [makeVariant({ priceXaf })],
        }),
      );

      expect(result.visible).toBe(true);
      expect(result.orderable).toBe(false);
      expect(result.variants[0]?.orderable).toBe(false);
    }
  });

  it('exposes only configurations in the approved revision, not draft or pending configurations', () => {
    const result = evaluateListingAvailability(
      makeInput({
        operationalVariants: [
          makeVariant(),
          makeVariant({
            id: pendingSellableVariantId,
            catalogVariantId: pendingCatalogVariantId,
          }),
        ],
      }),
    );

    expect(result.variants).toEqual([
      {
        sellerListingVariantId: approvedSellableVariantId,
        catalogVariantId: approvedCatalogVariantId,
        availableStock: 4,
        orderable: true,
      },
    ]);
    expect(
      result.variants.some((variant) => variant.catalogVariantId === pendingCatalogVariantId),
    ).toBe(false);
  });

  it('fails closed if the approved offer and stable sellable variant disagree', () => {
    const result = evaluateListingAvailability(
      makeInput({
        operationalVariants: [makeVariant({ catalogVariantId: pendingCatalogVariantId })],
      }),
    );

    expect(result.visible).toBe(true);
    expect(result.orderable).toBe(false);
    expect(result.variants[0]).toMatchObject({
      catalogVariantId: approvedCatalogVariantId,
      availableStock: 4,
      orderable: false,
    });
  });

  it('fails closed for invalid inventory values', () => {
    for (const values of [
      { stockQuantity: -1, reservedQuantity: 0 },
      { stockQuantity: 2.5, reservedQuantity: 0 },
      { stockQuantity: 2, reservedQuantity: -1 },
      { stockQuantity: 2, reservedQuantity: 3 },
    ]) {
      const result = evaluateListingAvailability(
        makeInput({ operationalVariants: [makeVariant(values)] }),
      );

      expect(result.visible).toBe(true);
      expect(result.orderable).toBe(false);
      expect(result.variants[0]?.availableStock).toBe(0);
    }
  });
});
