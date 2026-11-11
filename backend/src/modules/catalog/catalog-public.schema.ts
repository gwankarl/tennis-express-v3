const publicImageUrlSchema = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
} as const;

const publicCategoryReferenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'slug', 'name', 'imageUrl', 'attributeRuleSetKey', 'attributeRules'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    name: { type: 'string' },
    imageUrl: publicImageUrlSchema,
    attributeRuleSetKey: { type: 'string' },
    attributeRules: { type: 'array', items: { $ref: 'catalogPublicAttributeRule#' } },
  },
} as const;

const publicBrandReferenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'slug', 'name', 'imageUrl'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    name: { type: 'string' },
    imageUrl: publicImageUrlSchema,
  },
} as const;

const publicProductSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'description',
    'category',
    'brand',
    'fixedAttributes',
    'variantOptionKeys',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    category: publicCategoryReferenceSchema,
    brand: {
      anyOf: [publicBrandReferenceSchema, { type: 'null' }],
    },
    fixedAttributes: { type: 'object', additionalProperties: true },
    variantOptionKeys: { type: 'array', items: { type: 'string' } },
  },
} as const;

const publicVariantSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'optionValues', 'isDefault'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    optionValues: { type: 'object', additionalProperties: true },
    isDefault: { type: 'boolean' },
  },
} as const;

const publicProductWithVariantsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['product', 'variants'],
  properties: {
    product: publicProductSchema,
    variants: { type: 'array', items: publicVariantSchema },
  },
} as const;

export const catalogPublicAttributeRuleSchema = {
  $id: 'catalogPublicAttributeRule',
  type: 'object',
  additionalProperties: false,
  required: ['key', 'label', 'type', 'required', 'variantAllowed', 'requiredWhen'],
  properties: {
    key: { type: 'string' },
    label: { type: 'string' },
    type: {
      type: 'string',
      enum: ['enum', 'number', 'integer', 'string', 'string_array', 'dimensions'],
    },
    required: { type: 'boolean' },
    variantAllowed: { type: 'boolean' },
    allowedValues: {
      type: 'array',
      items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    },
    unit: { type: 'string' },
    min: { type: 'number' },
    max: { type: 'number' },
    step: { type: 'number' },
    maxLength: { type: 'integer', minimum: 0 },
    maxItems: { type: 'integer', minimum: 0 },
    pattern: { type: 'string' },
    requiredWhen: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'equals'],
        properties: {
          field: { type: 'string' },
          equals: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        },
      },
    },
  },
} as const;

export const catalogPublicCategoryListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            ...publicCategoryReferenceSchema,
            properties: {
              ...publicCategoryReferenceSchema.properties,
              attributeRules: {
                type: 'array',
                items: catalogPublicAttributeRuleSchema,
              },
            },
          },
        },
      },
    },
  },
} as const;

export const catalogPublicBrandListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: { type: 'array', items: publicBrandReferenceSchema },
      },
    },
  },
} as const;

export const catalogPublicProductListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    offset: { type: 'integer', minimum: 0, default: 0 },
    categoryId: { type: 'string', format: 'uuid' },
    brandId: { type: 'string', format: 'uuid' },
  },
} as const;

export const catalogPublicProductParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const catalogPublicProductDetailResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: publicProductWithVariantsSchema,
  },
} as const;

export const catalogPublicProductListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'limit', 'offset'],
      properties: {
        items: { type: 'array', items: publicProductWithVariantsSchema },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const;
