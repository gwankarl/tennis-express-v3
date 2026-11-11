import { sellerListingCondition } from './listing.table.js';
import { catalogAttributeRulesByRuleSet } from '../catalog/attribute-rules.js';
import {
  catalogAttributeRuleSetKeys,
  type CatalogAttributeRuleSetKey,
} from '../catalog/category-attribute-rule-sets.js';
import {
  CatalogProductValidationError,
  canonicalizeCatalogVariantOptions,
  validateCatalogProductAttributes,
} from '../catalog/product-validation.js';

export type ListingCompletenessIssueKind = 'seller_input' | 'invalid_reference';

export type ListingCompletenessItemType = 'sellable_variant' | 'image';

export interface ListingCompletenessIssue {
  code: string;
  kind: ListingCompletenessIssueKind;
  path: string;
  message: string;
  item?: {
    type: ListingCompletenessItemType;
    id: string;
  };
}

export interface ListingCompletenessCatalogVariant {
  id: string;
  productId: string;
  optionValues: unknown;
  optionSignature: string;
  isDefault: boolean;
}

export interface ListingCompletenessCatalogProduct {
  id: string;
  isVisible: boolean;
  attributeRuleSetKey: string;
  fixedAttributes: unknown;
  variantOptionKeys: unknown;
  variants: readonly ListingCompletenessCatalogVariant[];
}

export interface ListingCompletenessSelectedConfiguration {
  catalogProductId: string;
  catalogVariantId: string;
}

export interface ListingCompletenessSellableVariant {
  id: string;
  listingId: string;
  sellerId: string;
  catalogVariantId: string;
  sku: string;
  priceXaf: number | null;
  stockQuantity: number;
  reservedQuantity: number;
  isOfferedForSale: boolean;
}

export interface ListingCompletenessSellerSkuRecord {
  id: string;
  sku: string;
}

export interface ListingCompletenessImageAssignment {
  imageId: string;
  listingId: string;
  variantId: string | null;
  sortOrder: number;
  isCover: boolean;
}

export interface ListingCompletenessImage {
  id: string;
  listingId: string;
  lifecycle: 'ready' | 'deleting';
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
  storageAvailable: boolean;
  assignments: readonly ListingCompletenessImageAssignment[];
}

export interface EvaluateListingCompletenessInput {
  listingId: string;
  sellerId: string;
  draftRevision: number;
  title: unknown;
  description: unknown;
  condition: unknown;
  catalogProduct: ListingCompletenessCatalogProduct | null;
  selectedConfigurations: readonly ListingCompletenessSelectedConfiguration[];
  sellableVariants: readonly ListingCompletenessSellableVariant[];
  /** All SKU records for this seller, not just those selected in this draft. */
  sellerSkuRecords: readonly ListingCompletenessSellerSkuRecord[];
  images: readonly ListingCompletenessImage[];
}

export interface ListingCompletenessResult {
  listingId: string;
  draftRevision: number;
  ready: boolean;
  issues: ListingCompletenessIssue[];
}

const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_IMAGE_COUNT = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8000;
const MAX_IMAGE_PIXELS = 40_000_000;
const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/u;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function createIssue(
  code: string,
  kind: ListingCompletenessIssueKind,
  path: string,
  message: string,
  item?: ListingCompletenessIssue['item'],
): ListingCompletenessIssue {
  return { code, kind, path, message, ...(item ? { item } : {}) };
}

function isRuleSetKey(value: string): value is CatalogAttributeRuleSetKey {
  return catalogAttributeRuleSetKeys.some((key) => key === value);
}

function normalizeSkuForComparison(sku: string): string {
  return sku.trim().toUpperCase();
}

function addProductValidationIssue(issues: ListingCompletenessIssue[], error: unknown): void {
  if (error instanceof CatalogProductValidationError) {
    const path = error.field.startsWith('attributes.')
      ? `catalogProduct.${error.field}`
      : `catalogProduct.${error.field}`;

    issues.push(
      createIssue(
        'catalog_configuration_invalid',
        'invalid_reference',
        path,
        'The selected catalog product configuration is invalid.',
      ),
    );
    return;
  }

  issues.push(
    createIssue(
      'catalog_configuration_invalid',
      'invalid_reference',
      'catalogProduct',
      'The selected catalog product configuration is invalid.',
    ),
  );
}

function validateCatalogProduct(
  product: ListingCompletenessCatalogProduct,
  issues: ListingCompletenessIssue[],
): {
  optionKeys: string[];
  catalogVariantIds: Set<string>;
  defaultVariantId: string | null;
} {
  if (!product.isVisible) {
    issues.push(
      createIssue(
        'catalog_product_unavailable',
        'invalid_reference',
        'catalogProductId',
        'The selected catalog product is unavailable.',
      ),
    );
  }

  if (!isRuleSetKey(product.attributeRuleSetKey)) {
    issues.push(
      createIssue(
        'catalog_rule_set_invalid',
        'invalid_reference',
        'catalogProduct.category.attributeRuleSetKey',
        'The selected catalog product has an unsupported attribute rule set.',
      ),
    );
    return { optionKeys: [], catalogVariantIds: new Set(), defaultVariantId: null };
  }

  if (!isRecord(product.fixedAttributes)) {
    issues.push(
      createIssue(
        'catalog_attributes_invalid',
        'invalid_reference',
        'catalogProduct.fixedAttributes',
        'The selected catalog product attributes are invalid.',
      ),
    );
    return { optionKeys: [], catalogVariantIds: new Set(), defaultVariantId: null };
  }

  if (
    !Array.isArray(product.variantOptionKeys) ||
    product.variantOptionKeys.some((key) => typeof key !== 'string')
  ) {
    issues.push(
      createIssue(
        'catalog_options_invalid',
        'invalid_reference',
        'catalogProduct.variantOptionKeys',
        'The selected catalog product options are invalid.',
      ),
    );
    return { optionKeys: [], catalogVariantIds: new Set(), defaultVariantId: null };
  }

  const optionKeys = product.variantOptionKeys as string[];
  const catalogVariantIds = new Set<string>();
  let defaultVariantId: string | null = null;

  for (const variant of product.variants) {
    if (catalogVariantIds.has(variant.id)) {
      issues.push(
        createIssue(
          'catalog_configuration_invalid',
          'invalid_reference',
          'catalogProduct.variants',
          'The selected catalog product configurations are inconsistent.',
        ),
      );
    }
    catalogVariantIds.add(variant.id);

    if (variant.productId !== product.id) {
      issues.push(
        createIssue(
          'catalog_configuration_invalid',
          'invalid_reference',
          `catalogProduct.variants.${variant.id}`,
          'A catalog configuration does not belong to the selected product.',
        ),
      );
    }

    if (variant.isDefault) {
      if (defaultVariantId !== null) {
        issues.push(
          createIssue(
            'catalog_default_variant_invalid',
            'invalid_reference',
            'catalogProduct.variants',
            'The selected catalog product has inconsistent default configurations.',
          ),
        );
      } else {
        defaultVariantId = variant.id;
      }
    }
  }

  if (optionKeys.length === 0) {
    if (
      product.variants.length !== 1 ||
      defaultVariantId === null ||
      !isRecord(product.variants[0]?.optionValues) ||
      Object.keys(product.variants[0].optionValues).length !== 0 ||
      product.variants[0]?.optionSignature !== '{}'
    ) {
      issues.push(
        createIssue(
          'catalog_default_variant_invalid',
          'invalid_reference',
          'catalogProduct.variants',
          'A product without selectable options must have exactly one default configuration.',
        ),
      );
    }
  } else if (defaultVariantId !== null) {
    issues.push(
      createIssue(
        'catalog_default_variant_invalid',
        'invalid_reference',
        'catalogProduct.variants',
        'A product with selectable options cannot have a default configuration.',
      ),
    );
  }

  try {
    const ruleSetKey = product.attributeRuleSetKey;
    const rules = catalogAttributeRulesByRuleSet[ruleSetKey];

    const validationVariants =
      optionKeys.length === 0
        ? []
        : product.variants.map((variant) => ({
            optionValues: isRecord(variant.optionValues) ? variant.optionValues : {},
          }));

    const validated = validateCatalogProductAttributes({
      ruleSetKey,
      fixedAttributes: product.fixedAttributes,
      variantOptionKeys: optionKeys,
      variants: validationVariants,
    });

    if (optionKeys.length > 0) {
      const expectedSignatures = new Set(
        validated.variants.map((variant) => variant.optionSignature),
      );

      for (const variant of product.variants) {
        if (!isRecord(variant.optionValues)) continue;

        const signature = canonicalizeCatalogVariantOptions(variant.optionValues);
        if (!expectedSignatures.has(signature) || variant.optionSignature !== signature) {
          issues.push(
            createIssue(
              'catalog_configuration_invalid',
              'invalid_reference',
              `catalogProduct.variants.${variant.id}`,
              'A catalog configuration does not match the current category rules.',
            ),
          );
        }
      }
    }

    // Accessing the rule set here ensures unsupported persisted keys are never
    // silently treated as a product with no attribute requirements.
    if (!rules) {
      issues.push(
        createIssue(
          'catalog_rule_set_invalid',
          'invalid_reference',
          'catalogProduct.category.attributeRuleSetKey',
          'The selected catalog product has an unsupported attribute rule set.',
        ),
      );
    }
  } catch (error) {
    addProductValidationIssue(issues, error);
  }

  return { optionKeys, catalogVariantIds, defaultVariantId };
}

function validateSelectedConfigurations(
  input: EvaluateListingCompletenessInput,
  product: ListingCompletenessCatalogProduct,
  productState: ReturnType<typeof validateCatalogProduct>,
  issues: ListingCompletenessIssue[],
): void {
  const selectedIds = new Set<string>();

  for (const selected of input.selectedConfigurations) {
    if (selectedIds.has(selected.catalogVariantId)) {
      issues.push(
        createIssue(
          'configuration_selection_duplicate',
          'invalid_reference',
          'selectedConfigurations',
          'A catalog configuration is selected more than once.',
        ),
      );
    }
    selectedIds.add(selected.catalogVariantId);

    if (
      selected.catalogProductId !== product.id ||
      !productState.catalogVariantIds.has(selected.catalogVariantId)
    ) {
      issues.push(
        createIssue(
          'configuration_reference_invalid',
          'invalid_reference',
          `selectedConfigurations.${selected.catalogVariantId}`,
          'A selected configuration does not belong to the listing product.',
          { type: 'sellable_variant', id: selected.catalogVariantId },
        ),
      );
    }
  }

  if (input.selectedConfigurations.length === 0) {
    const isDefaultProduct = productState.optionKeys.length === 0;
    issues.push(
      createIssue(
        isDefaultProduct ? 'default_variant_required' : 'variant_selection_required',
        'seller_input',
        'selectedConfigurations',
        isDefaultProduct
          ? 'Select the product default configuration.'
          : 'Select at least one product configuration.',
      ),
    );
    return;
  }

  if (productState.optionKeys.length === 0) {
    const selected = input.selectedConfigurations[0];

    if (
      input.selectedConfigurations.length !== 1 ||
      !productState.defaultVariantId ||
      selected?.catalogVariantId !== productState.defaultVariantId ||
      selected.catalogProductId !== product.id
    ) {
      issues.push(
        createIssue(
          'default_variant_required',
          'seller_input',
          'selectedConfigurations',
          'Select the product default configuration.',
        ),
      );
    }
  }
}

function validateSelectedSellableVariants(
  input: EvaluateListingCompletenessInput,
  product: ListingCompletenessCatalogProduct,
  issues: ListingCompletenessIssue[],
): Set<string> {
  const selectedIds = new Set(input.selectedConfigurations.map((item) => item.catalogVariantId));
  const variantsByCatalogId = new Map<string, ListingCompletenessSellableVariant[]>();

  for (const variant of input.sellableVariants) {
    const rows = variantsByCatalogId.get(variant.catalogVariantId) ?? [];
    rows.push(variant);
    variantsByCatalogId.set(variant.catalogVariantId, rows);
  }

  const sellerSkusByNormalizedValue = new Map<string, ListingCompletenessSellerSkuRecord[]>();
  for (const record of input.sellerSkuRecords) {
    const normalizedSku = normalizeSkuForComparison(record.sku);
    const rows = sellerSkusByNormalizedValue.get(normalizedSku) ?? [];
    rows.push(record);
    sellerSkusByNormalizedValue.set(normalizedSku, rows);
  }

  const selectedSellableIds = new Set<string>();

  for (const selected of [...input.selectedConfigurations].sort((left, right) =>
    compareText(left.catalogVariantId, right.catalogVariantId),
  )) {
    const rows = variantsByCatalogId.get(selected.catalogVariantId) ?? [];

    if (rows.length !== 1) {
      issues.push(
        createIssue(
          'sellable_variant_reference_invalid',
          'invalid_reference',
          `sellableVariants.${selected.catalogVariantId}`,
          'A selected configuration has no unique sellable listing variant.',
          { type: 'sellable_variant', id: rows[0]?.id ?? selected.catalogVariantId },
        ),
      );
      continue;
    }

    const variant = rows[0]!;
    selectedSellableIds.add(variant.id);

    if (
      variant.listingId !== input.listingId ||
      variant.sellerId !== input.sellerId ||
      !product.variants.some(
        (catalogVariant) =>
          catalogVariant.id === variant.catalogVariantId && catalogVariant.productId === product.id,
      )
    ) {
      issues.push(
        createIssue(
          'sellable_variant_reference_invalid',
          'invalid_reference',
          `sellableVariants.${variant.id}`,
          'A selected sellable variant has an invalid listing or catalog reference.',
          { type: 'sellable_variant', id: variant.id },
        ),
      );
    }

    if (
      !Number.isSafeInteger(variant.priceXaf) ||
      variant.priceXaf === null ||
      variant.priceXaf < 1
    ) {
      issues.push(
        createIssue(
          'variant_price_required',
          'seller_input',
          `sellableVariants.${variant.id}.priceXaf`,
          'Set a positive whole-number XAF price for this variant.',
          { type: 'sellable_variant', id: variant.id },
        ),
      );
    }

    if (!Number.isSafeInteger(variant.stockQuantity) || variant.stockQuantity < 0) {
      issues.push(
        createIssue(
          'variant_stock_invalid',
          'invalid_reference',
          `sellableVariants.${variant.id}.stockQuantity`,
          'The stored stock quantity is invalid.',
          { type: 'sellable_variant', id: variant.id },
        ),
      );
    }

    if (
      !Number.isSafeInteger(variant.reservedQuantity) ||
      variant.reservedQuantity < 0 ||
      variant.reservedQuantity > variant.stockQuantity
    ) {
      issues.push(
        createIssue(
          'variant_reservation_invalid',
          'invalid_reference',
          `sellableVariants.${variant.id}.reservedQuantity`,
          'The stored reservation quantity is inconsistent with stock.',
          { type: 'sellable_variant', id: variant.id },
        ),
      );
    }

    if (!SKU_PATTERN.test(variant.sku) || variant.sku !== normalizeSkuForComparison(variant.sku)) {
      issues.push(
        createIssue(
          'variant_sku_invalid',
          'invalid_reference',
          `sellableVariants.${variant.id}.sku`,
          'The stored seller SKU is invalid.',
          { type: 'sellable_variant', id: variant.id },
        ),
      );
    }

    const conflictingSkuRows =
      sellerSkusByNormalizedValue.get(normalizeSkuForComparison(variant.sku)) ?? [];
    if (conflictingSkuRows.some((record) => record.id !== variant.id)) {
      issues.push(
        createIssue(
          'variant_sku_conflict',
          'invalid_reference',
          `sellableVariants.${variant.id}.sku`,
          'The seller SKU conflicts with another variant.',
          { type: 'sellable_variant', id: variant.id },
        ),
      );
    }
  }

  for (const variant of input.sellableVariants) {
    if (!selectedIds.has(variant.catalogVariantId)) {
      issues.push(
        createIssue(
          'unselected_sellable_variant_reference',
          'invalid_reference',
          `sellableVariants.${variant.id}`,
          'A sellable variant is included that is not selected by this draft.',
          { type: 'sellable_variant', id: variant.id },
        ),
      );
    }
  }

  return selectedSellableIds;
}

function validateImages(
  input: EvaluateListingCompletenessInput,
  selectedSellableVariantIds: ReadonlySet<string>,
  issues: ListingCompletenessIssue[],
): Set<string> {
  const usableImageIds = new Set<string>();
  const scopeOrders = new Map<string, Set<number>>();
  const scopeCovers = new Map<string, number>();
  const knownImageIds = new Set<string>();

  if (input.images.length > MAX_IMAGE_COUNT) {
    issues.push(
      createIssue(
        'image_limit_exceeded',
        'invalid_reference',
        'images',
        'The draft contains more than the allowed number of images.',
      ),
    );
  }

  for (const image of [...input.images].sort((left, right) => compareText(left.id, right.id))) {
    if (knownImageIds.has(image.id)) {
      issues.push(
        createIssue(
          'image_reference_duplicate',
          'invalid_reference',
          `images.${image.id}`,
          'The same image is included more than once.',
          { type: 'image', id: image.id },
        ),
      );
    }
    knownImageIds.add(image.id);

    const metadataValid =
      image.listingId === input.listingId &&
      image.lifecycle === 'ready' &&
      ALLOWED_IMAGE_TYPES.has(image.mediaType) &&
      Number.isSafeInteger(image.byteSize) &&
      image.byteSize > 0 &&
      image.byteSize <= MAX_IMAGE_BYTES &&
      Number.isSafeInteger(image.width) &&
      Number.isSafeInteger(image.height) &&
      image.width >= 320 &&
      image.height >= 320 &&
      image.width <= MAX_IMAGE_SIDE &&
      image.height <= MAX_IMAGE_SIDE &&
      image.width * image.height <= MAX_IMAGE_PIXELS;

    if (!metadataValid) {
      issues.push(
        createIssue(
          'image_reference_invalid',
          'invalid_reference',
          `images.${image.id}`,
          'The selected image metadata is invalid or unavailable.',
          { type: 'image', id: image.id },
        ),
      );
    } else if (!image.storageAvailable) {
      issues.push(
        createIssue(
          'image_storage_missing',
          'invalid_reference',
          `images.${image.id}`,
          'The selected image file is unavailable.',
          { type: 'image', id: image.id },
        ),
      );
    } else {
      usableImageIds.add(image.id);
    }

    if (image.assignments.length === 0) {
      issues.push(
        createIssue(
          'image_assignment_missing',
          'invalid_reference',
          `images.${image.id}.assignments`,
          'The selected image has no draft assignment.',
          { type: 'image', id: image.id },
        ),
      );
    }

    for (const assignment of image.assignments) {
      if (
        assignment.imageId !== image.id ||
        assignment.listingId !== input.listingId ||
        (assignment.variantId !== null && !selectedSellableVariantIds.has(assignment.variantId))
      ) {
        issues.push(
          createIssue(
            'image_assignment_invalid',
            'invalid_reference',
            `images.${image.id}.assignments`,
            'An image assignment references a different listing or an unselected variant.',
            { type: 'image', id: image.id },
          ),
        );
        continue;
      }

      if (!Number.isSafeInteger(assignment.sortOrder) || assignment.sortOrder < 0) {
        issues.push(
          createIssue(
            'image_order_invalid',
            'invalid_reference',
            `images.${image.id}.assignments.sortOrder`,
            'The image order is invalid.',
            { type: 'image', id: image.id },
          ),
        );
      }

      const scope = assignment.variantId ?? 'common';
      const orders = scopeOrders.get(scope) ?? new Set<number>();

      if (orders.has(assignment.sortOrder)) {
        issues.push(
          createIssue(
            'image_order_duplicate',
            'invalid_reference',
            `images.${image.id}.assignments.sortOrder`,
            'Two images in the same scope have the same order.',
            { type: 'image', id: image.id },
          ),
        );
      }
      orders.add(assignment.sortOrder);
      scopeOrders.set(scope, orders);

      if (assignment.isCover) {
        const coverCount = scopeCovers.get(scope) ?? 0;
        scopeCovers.set(scope, coverCount + 1);

        if (coverCount > 0) {
          issues.push(
            createIssue(
              'image_cover_duplicate',
              'invalid_reference',
              `images.${image.id}.assignments.isCover`,
              'More than one image in the same scope is marked as the cover.',
              { type: 'image', id: image.id },
            ),
          );
        }
      }
    }
  }

  for (const variant of input.sellableVariants
    .filter((item) => selectedSellableVariantIds.has(item.id) && item.isOfferedForSale)
    .sort((left, right) => compareText(left.id, right.id))) {
    const variantAssignments = input.images.flatMap((image) =>
      image.assignments.filter(
        (assignment) =>
          assignment.listingId === input.listingId &&
          assignment.imageId === image.id &&
          assignment.variantId === variant.id,
      ),
    );
    const commonAssignments = input.images.flatMap((image) =>
      image.assignments.filter(
        (assignment) =>
          assignment.listingId === input.listingId &&
          assignment.imageId === image.id &&
          assignment.variantId === null,
      ),
    );
    const resolvedAssignments =
      variantAssignments.length > 0 ? variantAssignments : commonAssignments;
    const hasAvailableImage = resolvedAssignments.some((assignment) =>
      usableImageIds.has(assignment.imageId),
    );

    if (!hasAvailableImage) {
      issues.push(
        createIssue(
          'variant_image_required',
          'seller_input',
          `sellableVariants.${variant.id}.images`,
          'Assign an available image to this variant or to the common image set.',
          { type: 'sellable_variant', id: variant.id },
        ),
      );
    }
  }

  return usableImageIds;
}

/**
 * Evaluates one already-loaded draft snapshot. This function performs no reads,
 * writes, storage operations, submission, or publication changes.
 */
export function evaluateListingCompleteness(
  input: EvaluateListingCompletenessInput,
): ListingCompletenessResult {
  const issues: ListingCompletenessIssue[] = [];

  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    issues.push(createIssue('title_required', 'seller_input', 'title', 'Add a listing title.'));
  } else if (input.title.trim().length > MAX_TITLE_LENGTH) {
    issues.push(
      createIssue(
        'title_too_long',
        'seller_input',
        'title',
        'Use a title of 120 characters or fewer.',
      ),
    );
  }

  if (typeof input.description !== 'string' || input.description.trim().length === 0) {
    issues.push(
      createIssue(
        'description_required',
        'seller_input',
        'description',
        'Add a listing description.',
      ),
    );
  } else if (input.description.trim().length > MAX_DESCRIPTION_LENGTH) {
    issues.push(
      createIssue(
        'description_too_long',
        'seller_input',
        'description',
        'Use a description of 5,000 characters or fewer.',
      ),
    );
  }

  if (
    typeof input.condition !== 'string' ||
    !sellerListingCondition.enumValues.includes(
      input.condition as (typeof sellerListingCondition.enumValues)[number],
    )
  ) {
    issues.push(
      createIssue(
        'condition_required',
        'seller_input',
        'condition',
        'Select a supported listing condition.',
      ),
    );
  }

  if (!input.catalogProduct) {
    issues.push(
      createIssue(
        'catalog_product_required',
        'invalid_reference',
        'catalogProductId',
        'The listing catalog product is unavailable.',
      ),
    );
  }

  let productState: ReturnType<typeof validateCatalogProduct> | null = null;

  if (input.catalogProduct) {
    productState = validateCatalogProduct(input.catalogProduct, issues);
    validateSelectedConfigurations(input, input.catalogProduct, productState, issues);
  }

  const selectedSellableVariantIds = input.catalogProduct
    ? validateSelectedSellableVariants(input, input.catalogProduct, issues)
    : new Set<string>();

  validateImages(input, selectedSellableVariantIds, issues);

  issues.sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.code, right.code) ||
      compareText(left.item?.id ?? '', right.item?.id ?? ''),
  );

  return {
    listingId: input.listingId,
    draftRevision: input.draftRevision,
    ready: issues.length === 0,
    issues,
  };
}
