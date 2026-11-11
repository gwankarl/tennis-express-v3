import { sellerListingCondition } from './listing.table.js';

export type SellerListingCondition = (typeof sellerListingCondition.enumValues)[number];

export interface ListingDraftFieldsInput {
  title?: string | null;
  description?: string | null;
  condition?: SellerListingCondition | null;
}

export interface NormalizedListingDraftFields {
  title?: string | null;
  description?: string | null;
  condition?: SellerListingCondition | null;
}

export class ListingValidationError extends Error {
  constructor(
    readonly field: string,
    readonly rule: string,
  ) {
    super('Seller listing input is invalid.');
    this.name = 'ListingValidationError';
  }
}

/** Trims and validates supplied draft fields while allowing incomplete drafts. */
export function normalizeListingDraftFields(
  input: ListingDraftFieldsInput,
): NormalizedListingDraftFields {
  const normalized: NormalizedListingDraftFields = {};

  if (input.title !== undefined) {
    if (input.title === null) {
      normalized.title = null;
    } else {
      const title = input.title.trim();

      if (!title) {
        throw new ListingValidationError('title', 'required');
      }

      if (title.length > 120) {
        throw new ListingValidationError('title', 'max_length');
      }

      normalized.title = title;
    }
  }

  if (input.description !== undefined) {
    if (input.description === null) {
      normalized.description = null;
    } else {
      const description = input.description.trim();

      if (description.length > 5000) {
        throw new ListingValidationError('description', 'max_length');
      }

      normalized.description = description || null;
    }
  }

  if (input.condition !== undefined) {
    if (input.condition !== null && !sellerListingCondition.enumValues.includes(input.condition)) {
      throw new ListingValidationError('condition', 'unsupported_value');
    }

    normalized.condition = input.condition;
  }

  return normalized;
}

/** Rejects repeated catalog configuration IDs and returns a stable order. */
export function normalizeCatalogVariantIds(
  ids: readonly string[] | undefined,
): string[] | undefined {
  if (ids === undefined) {
    return undefined;
  }

  if (new Set(ids).size !== ids.length) {
    throw new ListingValidationError('catalogVariantIds', 'duplicate');
  }

  return [...ids].sort();
}

/** Expected draft revisions must be positive whole numbers. */
export function assertExpectedDraftRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new ListingValidationError('expectedDraftRevision', 'positive_integer');
  }
}
