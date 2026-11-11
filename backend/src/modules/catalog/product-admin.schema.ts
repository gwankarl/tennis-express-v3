const productVariantInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['optionValues'],
  properties: {
    optionValues: { type: 'object', additionalProperties: true },
  },
} as const;

const productInputFields = {
  categoryId: { type: 'string', format: 'uuid' },
  brandId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
  name: { type: 'string', minLength: 1, maxLength: 240 },
  description: { anyOf: [{ type: 'string', maxLength: 5000 }, { type: 'null' }] },
  isVisible: { type: 'boolean' },
  fixedAttributes: { type: 'object', additionalProperties: true },
  variantOptionKeys: { type: 'array', uniqueItems: true, items: { type: 'string' } },
  variants: { type: 'array', items: productVariantInputSchema },
} as const;

const productVariantResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'productId',
    'optionValues',
    'optionSignature',
    'isDefault',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    productId: { type: 'string', format: 'uuid' },
    optionValues: { type: 'object', additionalProperties: true },
    optionSignature: { type: 'string' },
    isDefault: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const productSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'categoryId',
    'brandId',
    'name',
    'description',
    'isVisible',
    'fixedAttributes',
    'variantOptionKeys',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    categoryId: { type: 'string', format: 'uuid' },
    brandId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    name: { type: 'string' },
    description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    isVisible: { type: 'boolean' },
    fixedAttributes: { type: 'object', additionalProperties: true },
    variantOptionKeys: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const productWithVariantsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['product', 'variants'],
  properties: {
    product: productSchema,
    variants: { type: 'array', items: productVariantResponseSchema },
  },
} as const;

export const catalogProductParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export const catalogProductListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

export const createCatalogProductRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['categoryId', 'brandId', 'name'],
  properties: productInputFields,
} as const;

export const updateCatalogProductRequestSchema = {
  type: 'object',
  additionalProperties: false,
  anyOf: Object.keys(productInputFields).map((key) => ({ required: [key] })),
  properties: productInputFields,
} as const;

export const catalogProductDetailResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: productWithVariantsSchema,
  },
} as const;

export const catalogProductListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'limit', 'offset'],
      properties: {
        items: { type: 'array', items: productWithVariantsSchema },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const;
