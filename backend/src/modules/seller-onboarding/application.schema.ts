export const sellerApplicationCategories = ['individual', 'commercial'] as const;
export const sellerApplicationStatuses = [
  'draft',
  'submitted',
  'changes_requested',
  'approved',
  'rejected',
] as const;

export interface SellerApplicationFields {
  legalName: string | null;
  sellerDisplayName: string | null;
  areaServed: string | null;
  contactPhone: string | null;
  registeredBusinessName: string | null;
  businessRole: string | null;
  storefrontName: string | null;
}

export interface SellerApplicationData extends SellerApplicationFields {
  id: string;
  category: (typeof sellerApplicationCategories)[number];
  status: (typeof sellerApplicationStatuses)[number];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SellerApplicationResponseData {
  application: SellerApplicationData | null;
}

export interface CreateSellerApplicationBody {
  category: (typeof sellerApplicationCategories)[number];
  legalName?: string | null;
  sellerDisplayName?: string | null;
  areaServed?: string | null;
  contactPhone?: string | null;
  registeredBusinessName?: string | null;
  businessRole?: string | null;
  storefrontName?: string | null;
}

export interface UpdateSellerApplicationBody extends Partial<CreateSellerApplicationBody> {
  expectedRevision: number;
}

export interface SubmitSellerApplicationBody {
  expectedRevision: number;
}

const nullableText = (maxLength: number) => ({
  anyOf: [{ type: 'string', minLength: 1, maxLength, pattern: '\\S' }, { type: 'null' }],
});

const applicantFieldProperties = {
  legalName: nullableText(200),
  sellerDisplayName: nullableText(200),
  areaServed: nullableText(120),
  contactPhone: nullableText(40),
  registeredBusinessName: nullableText(200),
  businessRole: nullableText(120),
  storefrontName: nullableText(200),
} as const;

const applicantFieldNames = [
  'legalName',
  'sellerDisplayName',
  'areaServed',
  'contactPhone',
  'registeredBusinessName',
  'businessRole',
  'storefrontName',
] as const;

const sellerApplicationProperties = {
  category: { type: 'string', enum: sellerApplicationCategories },
  ...applicantFieldProperties,
} as const;

export const createSellerApplicationRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['category'],
  properties: sellerApplicationProperties,
} as const;

export const updateSellerApplicationRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedRevision'],
  properties: {
    expectedRevision: { type: 'integer', minimum: 1 },
    ...sellerApplicationProperties,
  },
  anyOf: [
    { required: ['category'] },
    ...applicantFieldNames.map((field) => ({ required: [field] })),
  ],
} as const;

export const submitSellerApplicationRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedRevision'],
  properties: {
    expectedRevision: { type: 'integer', minimum: 1 },
  },
} as const;

const sellerApplicationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'category',
    'status',
    'revision',
    'legalName',
    'sellerDisplayName',
    'areaServed',
    'contactPhone',
    'registeredBusinessName',
    'businessRole',
    'storefrontName',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    category: { type: 'string', enum: sellerApplicationCategories },
    status: { type: 'string', enum: sellerApplicationStatuses },
    revision: { type: 'integer', minimum: 1 },
    ...Object.fromEntries(
      applicantFieldNames.map((field) => [field, { type: ['string', 'null'] }]),
    ),
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const sellerApplicationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['application'],
      properties: {
        application: {
          anyOf: [sellerApplicationSchema, { type: 'null' }],
        },
      },
    },
  },
} as const;
