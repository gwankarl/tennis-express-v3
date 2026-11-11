import { describe, expect, it } from 'vitest';
import {
  assertExpectedDraftRevision,
  ListingValidationError,
  normalizeCatalogVariantIds,
  normalizeListingDraftFields,
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
