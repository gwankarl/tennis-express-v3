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

const MAX_POSTGRES_INTEGER = 2_147_483_647;

export interface SellerListingVariantOperationalFields {
  priceXaf?: number | null;
  stockQuantity?: number;
  sku?: string;
  isOfferedForSale?: boolean;
}

export interface NormalizedSellerListingVariantOperationalFields {
  priceXaf?: number | null;
  stockQuantity?: number;
  sku?: string;
  isOfferedForSale?: boolean;
}

/** Validates a positive whole-number XAF price; null is allowed for incomplete drafts. */
export function normalizePriceXaf(priceXaf: number | null): number | null {
  if (
    priceXaf !== null &&
    (!Number.isSafeInteger(priceXaf) || priceXaf < 1 || priceXaf > MAX_POSTGRES_INTEGER)
  ) {
    throw new ListingValidationError('priceXaf', 'positive_whole_xaf');
  }

  return priceXaf;
}

/** Stock is counted in whole sellable units and cannot be negative. */
export function normalizeStockQuantity(stockQuantity: number): number {
  if (
    !Number.isSafeInteger(stockQuantity) ||
    stockQuantity < 0 ||
    stockQuantity > MAX_POSTGRES_INTEGER
  ) {
    throw new ListingValidationError('stockQuantity', 'nonnegative_whole_units');
  }

  return stockQuantity;
}

/**
 * Trims and uppercases seller SKUs. The database stores this normalized form,
 * making uniqueness checks consistent regardless of the submitted casing.
 */
export function normalizeSellerSku(sku: string): string {
  const normalized = sku.trim().toUpperCase();

  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(normalized)) {
    throw new ListingValidationError('sku', 'invalid_format');
  }

  return normalized;
}

/** Derives a stable generated SKU from the already assigned sellable variant ID. */
export function generateSellerSku(variantId: string): string {
  return normalizeSellerSku(`TX-${variantId.replaceAll('-', '')}`);
}

/** Rejects stock edits that would put available units below existing reservations. */
export function assertStockCoversReservations(
  stockQuantity: number,
  reservedQuantity: number,
): void {
  normalizeStockQuantity(stockQuantity);
  normalizeStockQuantity(reservedQuantity);

  if (reservedQuantity > stockQuantity) {
    throw new ListingValidationError('stockQuantity', 'below_reserved_quantity');
  }
}

/** A variant cannot be offered for sale without a configured positive price. */
export function assertVariantOfferable(priceXaf: number | null, isOfferedForSale: boolean): void {
  normalizePriceXaf(priceXaf);

  if (isOfferedForSale && priceXaf === null) {
    throw new ListingValidationError('priceXaf', 'required_when_offered');
  }
}

/** Normalizes only supplied operational fields, leaving omitted fields unchanged. */
export function normalizeSellerListingVariantOperationalFields(
  input: SellerListingVariantOperationalFields,
): NormalizedSellerListingVariantOperationalFields {
  return {
    ...(input.priceXaf === undefined ? {} : { priceXaf: normalizePriceXaf(input.priceXaf) }),
    ...(input.stockQuantity === undefined
      ? {}
      : { stockQuantity: normalizeStockQuantity(input.stockQuantity) }),
    ...(input.sku === undefined ? {} : { sku: normalizeSellerSku(input.sku) }),
    ...(input.isOfferedForSale === undefined ? {} : { isOfferedForSale: input.isOfferedForSale }),
  };
}

/** Expected sellable-variant versions must be positive whole numbers. */
export function assertExpectedVariantVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_POSTGRES_INTEGER) {
    throw new ListingValidationError('expectedVersion', 'positive_integer');
  }
}
