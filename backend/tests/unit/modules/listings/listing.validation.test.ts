import { describe, expect, it } from 'vitest';
import {
  assertExpectedDraftRevision,
  assertExpectedVariantVersion,
  assertStockCoversReservations,
  assertVariantOfferable,
  generateSellerSku,
  ListingValidationError,
  normalizeCatalogVariantIds,
  normalizeListingDraftFields,
  normalizePriceXaf,
  normalizeSellerListingVariantOperationalFields,
  normalizeSellerSku,
  normalizeStockQuantity,
} from '../../../../src/modules/listings/listing.validation.js';

describe('seller listing draft validation', () => {
  it('allows an incomplete draft and trims supplied fields', () => {
    expect(normalizeListingDraftFields({})).toEqual({});
    expect(
      normalizeListingDraftFields({
        title: '  Court-ready racquet  ',
        description: '  Synthetic test listing  ',
        condition: 'good',
      }),
    ).toEqual({
      title: 'Court-ready racquet',
      description: 'Synthetic test listing',
      condition: 'good',
    });
  });

  it('allows clearing optional draft values', () => {
    expect(
      normalizeListingDraftFields({
        title: null,
        description: null,
        condition: null,
      }),
    ).toEqual({
      title: null,
      description: null,
      condition: null,
    });
  });

  it('rejects a blank title and titles over 120 characters', () => {
    expect(() => normalizeListingDraftFields({ title: '   ' })).toThrowError(
      new ListingValidationError('title', 'required'),
    );

    expect(() => normalizeListingDraftFields({ title: 'x'.repeat(121) })).toThrowError(
      new ListingValidationError('title', 'max_length'),
    );
  });

  it('accepts a 120-character title and a 5000-character description', () => {
    expect(normalizeListingDraftFields({ title: 'x'.repeat(120) }).title).toHaveLength(120);
    expect(normalizeListingDraftFields({ description: 'x'.repeat(5000) }).description).toHaveLength(
      5000,
    );
  });

  it('normalizes an empty description to null and rejects an overlong description', () => {
    expect(normalizeListingDraftFields({ description: '   ' }).description).toBeNull();

    expect(() => normalizeListingDraftFields({ description: 'x'.repeat(5001) })).toThrowError(
      new ListingValidationError('description', 'max_length'),
    );
  });

  it('rejects unsupported condition values', () => {
    expect(() => normalizeListingDraftFields({ condition: 'excellent' as never })).toThrowError(
      new ListingValidationError('condition', 'unsupported_value'),
    );
  });

  it('sorts selected configuration IDs and rejects duplicates', () => {
    expect(normalizeCatalogVariantIds(['b', 'a'])).toEqual(['a', 'b']);
    expect(normalizeCatalogVariantIds(undefined)).toBeUndefined();

    expect(() => normalizeCatalogVariantIds(['same', 'same'])).toThrowError(
      new ListingValidationError('catalogVariantIds', 'duplicate'),
    );
  });

  it('requires a positive integer expected draft revision', () => {
    expect(() => assertExpectedDraftRevision(1)).not.toThrow();
    expect(() => assertExpectedDraftRevision(0)).toThrowError(
      new ListingValidationError('expectedDraftRevision', 'positive_integer'),
    );
    expect(() => assertExpectedDraftRevision(1.5)).toThrowError(
      new ListingValidationError('expectedDraftRevision', 'positive_integer'),
    );
  });
});

describe('seller listing variant validation', () => {
  it('allows an unset draft price and accepts positive whole XAF amounts', () => {
    expect(normalizePriceXaf(null)).toBeNull();
    expect(normalizePriceXaf(1)).toBe(1);
    expect(normalizePriceXaf(250_000)).toBe(250_000);

    for (const price of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => normalizePriceXaf(price)).toThrowError(
        new ListingValidationError('priceXaf', 'positive_whole_xaf'),
      );
    }
  });

  it('accepts nonnegative whole-unit stock and rejects invalid quantities', () => {
    expect(normalizeStockQuantity(0)).toBe(0);
    expect(normalizeStockQuantity(12)).toBe(12);

    for (const quantity of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => normalizeStockQuantity(quantity)).toThrowError(
        new ListingValidationError('stockQuantity', 'nonnegative_whole_units'),
      );
    }
  });

  it('normalizes seller SKUs and rejects blank or unsupported formats', () => {
    expect(normalizeSellerSku('  tx-racket_02  ')).toBe('TX-RACKET_02');

    for (const sku of ['', '   ', 'has spaces', 'ümlaut', 'x'.repeat(65)]) {
      expect(() => normalizeSellerSku(sku)).toThrowError(
        new ListingValidationError('sku', 'invalid_format'),
      );
    }
  });

  it('generates the same normalized SKU for the same sellable variant ID', () => {
    const variantId = 'f6d1c2b4-6ac7-48fa-9a20-96c338e3dc51';

    expect(generateSellerSku(variantId)).toBe('TX-F6D1C2B46AC748FA9A2096C338E3DC51');
    expect(generateSellerSku(variantId)).toBe(generateSellerSku(variantId));
  });

  it('preserves reservations and rejects stock below the reserved quantity', () => {
    expect(() => assertStockCoversReservations(8, 5)).not.toThrow();
    expect(() => assertStockCoversReservations(5, 5)).not.toThrow();

    expect(() => assertStockCoversReservations(4, 5)).toThrowError(
      new ListingValidationError('stockQuantity', 'below_reserved_quantity'),
    );
  });

  it('requires a price before a variant can be offered for sale', () => {
    expect(() => assertVariantOfferable(10_000, true)).not.toThrow();
    expect(() => assertVariantOfferable(null, false)).not.toThrow();

    expect(() => assertVariantOfferable(null, true)).toThrowError(
      new ListingValidationError('priceXaf', 'required_when_offered'),
    );
  });

  it('normalizes only provided operational fields', () => {
    expect(
      normalizeSellerListingVariantOperationalFields({
        priceXaf: 15_000,
        stockQuantity: 3,
        sku: ' tennis-01 ',
        isOfferedForSale: false,
      }),
    ).toEqual({
      priceXaf: 15_000,
      stockQuantity: 3,
      sku: 'TENNIS-01',
      isOfferedForSale: false,
    });

    expect(normalizeSellerListingVariantOperationalFields({})).toEqual({});
  });

  it('requires a positive expected variant version', () => {
    expect(() => assertExpectedVariantVersion(1)).not.toThrow();

    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => assertExpectedVariantVersion(version)).toThrowError(
        new ListingValidationError('expectedVersion', 'positive_integer'),
      );
    }
  });
});
