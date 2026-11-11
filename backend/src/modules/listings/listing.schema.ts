import { sellerListingCondition, sellerListingStatus } from './listing.table.js';
import type { ListingCompletenessResult } from './listing-completeness.js';

const nullableTitle = {
  anyOf: [{ type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' }, { type: 'null' }],
} as const;

const nullableDescription = {
  anyOf: [{ type: 'string', maxLength: 5000 }, { type: 'null' }],
} as const;

const nullableCondition = {
  anyOf: [{ type: 'string', enum: sellerListingCondition.enumValues }, { type: 'null' }],
} as const;

const draftFields = {
  catalogProductId: { type: 'string', format: 'uuid' },
  catalogVariantIds: {
    type: 'array',
    uniqueItems: true,
    items: { type: 'string', format: 'uuid' },
  },
  title: nullableTitle,
  description: nullableDescription,
  condition: nullableCondition,
} as const;

export const sellerListingIdParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const sellerListingPaginationQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

export const createSellerListingRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['catalogProductId'],
  properties: draftFields,
} as const;

export const updateSellerListingDraftRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedDraftRevision'],
  properties: {
    expectedDraftRevision: { type: 'integer', minimum: 1 },
    ...draftFields,
  },
  anyOf: [
    { required: ['catalogProductId'] },
    { required: ['catalogVariantIds'] },
    { required: ['title'] },
    { required: ['description'] },
    { required: ['condition'] },
  ],
} as const;

export const sellerListingImageParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'imageId'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    imageId: { type: 'string', format: 'uuid' },
  },
} as const;

export const sellerListingImageUploadQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedDraftRevision'],
  properties: {
    expectedDraftRevision: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
  },
} as const;

const sellerListingImageAssignmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['imageId', 'variantId', 'sortOrder', 'isCover'],
  properties: {
    imageId: { type: 'string', format: 'uuid' },
    variantId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    sortOrder: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
    isCover: { type: 'boolean' },
  },
} as const;

export const replaceSellerListingImageAssignmentsRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedDraftRevision', 'assignments'],
  properties: {
    expectedDraftRevision: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
    assignments: { type: 'array', items: sellerListingImageAssignmentSchema },
  },
} as const;

const sellerListingImageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'mediaType', 'byteSize', 'width', 'height', 'assignments'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    mediaType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] },
    byteSize: { type: 'integer', minimum: 1, maximum: 8_388_608 },
    width: { type: 'integer', minimum: 320, maximum: 8000 },
    height: { type: 'integer', minimum: 320, maximum: 8000 },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['variantId', 'sortOrder', 'isCover'],
        properties: {
          variantId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
          sortOrder: { type: 'integer', minimum: 0 },
          isCover: { type: 'boolean' },
        },
      },
    },
  },
} as const;

const sellerListingImagesMutationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['draftRevision', 'images'],
      properties: {
        draftRevision: { type: 'integer', minimum: 1 },
        images: { type: 'array', items: sellerListingImageSchema },
      },
    },
  },
} as const;

export const sellerListingImageUploadResponseSchema = sellerListingImagesMutationResponseSchema;

export const sellerListingImageAssignmentsResponseSchema =
  sellerListingImagesMutationResponseSchema;

export const sellerListingImagesReadResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['draftRevision', 'images'],
      properties: {
        draftRevision: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        images: { type: 'array', items: sellerListingImageSchema },
      },
    },
  },
} as const;

export const sellerListingVariantParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'variantId'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    variantId: { type: 'string', format: 'uuid' },
  },
} as const;

export const patchSellerListingVariantRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
    priceXaf: {
      anyOf: [{ type: 'integer', minimum: 1, maximum: 2_147_483_647 }, { type: 'null' }],
    },
    stockQuantity: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
    sku: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^\\s*[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\s*$',
    },
    isOfferedForSale: { type: 'boolean' },
  },
  anyOf: [
    { required: ['priceXaf'] },
    { required: ['stockQuantity'] },
    { required: ['sku'] },
    { required: ['isOfferedForSale'] },
  ],
} as const;

export const sellerListingVariantResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'catalogVariantId',
    'sku',
    'priceXaf',
    'stockQuantity',
    'reservedQuantity',
    'isOfferedForSale',
    'version',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    catalogVariantId: { type: 'string', format: 'uuid' },
    sku: { type: 'string', minLength: 1, maxLength: 64 },
    priceXaf: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    stockQuantity: { type: 'integer', minimum: 0 },
    reservedQuantity: { type: 'integer', minimum: 0 },
    isOfferedForSale: { type: 'boolean' },
    version: { type: 'integer', minimum: 1 },
  },
} as const;

export const sellerListingVariantResponseEnvelopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['variant'],
      properties: { variant: sellerListingVariantResponseSchema },
    },
  },
} as const;

const listingDraftResponseSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'revision',
    'catalogProductId',
    'catalogVariantIds',
    'sellableVariants',
    'title',
    'description',
    'condition',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    revision: { type: 'integer', minimum: 1 },
    catalogProductId: { type: 'string', format: 'uuid' },
    catalogVariantIds: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
    },
    sellableVariants: {
      type: 'array',
      items: sellerListingVariantResponseSchema,
    },
    title: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    condition: { type: ['string', 'null'], enum: [...sellerListingCondition.enumValues, null] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const sellerListingSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'status',
    'controlRevision',
    'approvedRevisionId',
    'pausedAt',
    'archivedAt',
    'administratorRemovedAt',
    'draft',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: sellerListingStatus.enumValues },
    controlRevision: { type: 'integer', minimum: 1 },
    approvedRevisionId: { type: ['string', 'null'], format: 'uuid' },
    pausedAt: { type: ['string', 'null'], format: 'date-time' },
    archivedAt: { type: ['string', 'null'], format: 'date-time' },
    administratorRemovedAt: { type: ['string', 'null'], format: 'date-time' },
    draft: listingDraftResponseSchema,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const sellerListingResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['listing'],
      properties: { listing: sellerListingSchema },
    },
  },
} as const;

export const sellerListingListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'limit', 'offset'],
      properties: {
        items: { type: 'array', items: sellerListingSchema },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
      },
    },
  },
} as const;

const listingCompletenessIssueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'kind', 'path', 'message'],
  properties: {
    code: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: ['seller_input', 'invalid_reference'] },
    path: { type: 'string', minLength: 1 },
    message: { type: 'string', minLength: 1 },
    item: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', enum: ['sellable_variant', 'image'] },
        id: { type: 'string', format: 'uuid' },
      },
    },
  },
} as const;

export const sellerListingReadinessResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['listingId', 'draftRevision', 'ready', 'issues'],
      properties: {
        listingId: { type: 'string', format: 'uuid' },
        draftRevision: { type: 'integer', minimum: 1 },
        ready: { type: 'boolean' },
        issues: {
          type: 'array',
          items: listingCompletenessIssueSchema,
        },
      },
    },
  },
} as const;
