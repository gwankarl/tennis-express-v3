import { sellerListingCondition, sellerListingStatus } from './listing.table.js';

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

const listingDraftResponseSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'revision',
    'catalogProductId',
    'catalogVariantIds',
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
