import { catalogAttributeRuleSetKeys } from './category-attribute-rule-sets.js';

const imageUrlInputSchema = {
  anyOf: [{ type: 'string', format: 'uri', maxLength: 2048 }, { type: 'null' }],
} as const;

const imageUrlResponseSchema = {
  type: ['string', 'null'],
} as const;

const categorySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'slug',
    'name',
    'imageUrl',
    'attributeRuleSetKey',
    'isActive',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    name: { type: 'string' },
    imageUrl: imageUrlResponseSchema,
    attributeRuleSetKey: { type: 'string', enum: catalogAttributeRuleSetKeys },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const brandSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'slug', 'name', 'imageUrl', 'isActive', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    name: { type: 'string' },
    imageUrl: imageUrlResponseSchema,
    isActive: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const catalogReferenceParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const catalogReferenceListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

export const createCatalogCategoryRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'name', 'attributeRuleSetKey'],
  properties: {
    slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 120 },
    name: { type: 'string', minLength: 1, maxLength: 160 },
    imageUrl: imageUrlInputSchema,
    attributeRuleSetKey: { type: 'string', enum: catalogAttributeRuleSetKeys },
    isActive: { type: 'boolean' },
  },
} as const;

export const updateCatalogCategoryRequestSchema = {
  type: 'object',
  additionalProperties: false,
  anyOf: [{ required: ['name'] }, { required: ['imageUrl'] }, { required: ['isActive'] }],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 160 },
    imageUrl: imageUrlInputSchema,
    isActive: { type: 'boolean' },
  },
} as const;

export const createCatalogBrandRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'name'],
  properties: {
    slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 120 },
    name: { type: 'string', minLength: 1, maxLength: 160 },
    imageUrl: imageUrlInputSchema,
    isActive: { type: 'boolean' },
  },
} as const;

export const updateCatalogBrandRequestSchema = {
  type: 'object',
  additionalProperties: false,
  anyOf: [{ required: ['name'] }, { required: ['imageUrl'] }, { required: ['isActive'] }],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 160 },
    imageUrl: imageUrlInputSchema,
    isActive: { type: 'boolean' },
  },
} as const;

export const catalogCategoryDetailResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['category'],
      properties: { category: categorySchema },
    },
  },
} as const;

export const catalogBrandDetailResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['brand'],
      properties: { brand: brandSchema },
    },
  },
} as const;

export const catalogCategoryListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'limit', 'offset'],
      properties: {
        items: { type: 'array', items: categorySchema },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const;

export const catalogBrandListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'limit', 'offset'],
      properties: {
        items: { type: 'array', items: brandSchema },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const;
