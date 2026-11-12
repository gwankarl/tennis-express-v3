export interface ListingAvailabilityVariant {
  id: string;
  catalogVariantId: string;
  priceXaf: number | null;
  stockQuantity: number;
  reservedQuantity: number;
  isOfferedForSale: boolean;
}

export interface ListingAvailabilityApprovedOffer {
  sellerListingVariantId: string;
  catalogVariantId: string;
}

export interface EvaluateListingAvailabilityInput {
  /** Current Seller operating eligibility, resolved from authoritative state. */
  sellerEligible: boolean;
  administratorRemoved: boolean;
  archived: boolean;
  paused: boolean;
  /**
   * Offers must come from the revision currently referenced by the approved
   * revision pointer. Workflow status is deliberately not used here.
   */
  approvedRevision: {
    id: string;
    offers: readonly ListingAvailabilityApprovedOffer[];
  } | null;
  operationalVariants: readonly ListingAvailabilityVariant[];
}

export interface ListingAvailabilityVariantResult {
  sellerListingVariantId: string;
  catalogVariantId: string;
  availableStock: number;
  orderable: boolean;
}

export interface ListingAvailabilityResult {
  visible: boolean;
  orderable: boolean;
  variants: ListingAvailabilityVariantResult[];
}

function isNonnegativeWholeNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function availableStock(variant: ListingAvailabilityVariant | undefined): number {
  if (
    !variant ||
    !isNonnegativeWholeNumber(variant.stockQuantity) ||
    !isNonnegativeWholeNumber(variant.reservedQuantity) ||
    variant.reservedQuantity > variant.stockQuantity
  ) {
    return 0;
  }

  return variant.stockQuantity - variant.reservedQuantity;
}

function hasValidPrice(variant: ListingAvailabilityVariant | undefined): boolean {
  return (
    variant !== undefined &&
    Number.isSafeInteger(variant.priceXaf) &&
    variant.priceXaf !== null &&
    variant.priceXaf > 0
  );
}

/**
 * Derives listing visibility and orderability from the approved revision and
 * current operational facts. Only approved-revision offers are returned.
 */
export function evaluateListingAvailability(
  input: EvaluateListingAvailabilityInput,
): ListingAvailabilityResult {
  const visible =
    input.sellerEligible &&
    !input.administratorRemoved &&
    !input.archived &&
    input.approvedRevision !== null;

  const operationalById = new Map(
    input.operationalVariants.map((variant) => [variant.id, variant]),
  );

  const variants = (input.approvedRevision?.offers ?? []).map((offer) => {
    const variant = operationalById.get(offer.sellerListingVariantId);
    const matchesApprovedConfiguration = variant?.catalogVariantId === offer.catalogVariantId;
    const stockAvailable = availableStock(variant);
    const orderable =
      visible &&
      !input.paused &&
      matchesApprovedConfiguration &&
      variant?.isOfferedForSale === true &&
      hasValidPrice(variant) &&
      stockAvailable > 0;

    return {
      sellerListingVariantId: offer.sellerListingVariantId,
      catalogVariantId: offer.catalogVariantId,
      availableStock: stockAvailable,
      orderable,
    };
  });

  return {
    visible,
    orderable: variants.some((variant) => variant.orderable),
    variants,
  };
}
