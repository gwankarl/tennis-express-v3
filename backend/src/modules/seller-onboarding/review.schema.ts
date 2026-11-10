import {
  sellerApplicationCategories,
  sellerApplicationEvidenceTypes,
} from './application.schema.js';

const queueItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'category', 'submittedRevision', 'submittedAt', 'applicantEmail', 'legalName'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    category: { type: 'string', enum: sellerApplicationCategories },
    submittedRevision: { type: 'integer', minimum: 1 },
    submittedAt: { type: 'string', format: 'date-time' },
    applicantEmail: { type: 'string', format: 'email' },
    legalName: { type: 'string' },
  },
} as const;

const queueResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'limit', 'offset'],
      properties: {
        items: { type: 'array', items: queueItemSchema },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const;

const evidenceSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'mediaType', 'byteSize', 'updatedAt'],
  properties: {
    type: { type: 'string', enum: sellerApplicationEvidenceTypes },
    mediaType: { type: 'string', enum: ['image/jpeg', 'image/png', 'application/pdf'] },
    byteSize: { type: 'integer', minimum: 1, maximum: 10485760 },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const reviewDetailSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'category',
    'status',
    'submittedRevision',
    'submittedAt',
    'applicantEmail',
    'legalName',
    'sellerDisplayName',
    'areaServed',
    'contactPhone',
    'registeredBusinessName',
    'businessRole',
    'storefrontName',
    'evidence',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    category: { type: 'string', enum: sellerApplicationCategories },
    status: { type: 'string', enum: ['submitted'] },
    submittedRevision: { type: 'integer', minimum: 1 },
    submittedAt: { type: 'string', format: 'date-time' },
    applicantEmail: { type: 'string', format: 'email' },
    legalName: { type: 'string' },
    sellerDisplayName: { type: ['string', 'null'] },
    areaServed: { type: ['string', 'null'] },
    contactPhone: { type: ['string', 'null'] },
    registeredBusinessName: { type: ['string', 'null'] },
    businessRole: { type: ['string', 'null'] },
    storefrontName: { type: ['string', 'null'] },
    evidence: { type: 'array', items: evidenceSummarySchema },
  },
} as const;

export const sellerReviewDetailResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['application'],
      properties: { application: reviewDetailSchema },
    },
  },
} as const;

export const sellerReviewQueueResponseSchema = queueResponseSchema;

export const sellerReviewDecisionRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedRevision', 'decision'],
  properties: {
    expectedRevision: { type: 'integer', minimum: 1 },
    decision: { type: 'string', enum: ['approve', 'request_changes', 'reject'] },
    feedback: { type: 'string', maxLength: 2000 },
    requestedEvidence: {
      type: 'array',
      uniqueItems: true,
      maxItems: sellerApplicationEvidenceTypes.length,
      items: { type: 'string', enum: sellerApplicationEvidenceTypes },
    },
  },
} as const;

export const sellerReviewDecisionResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: [
        'applicationId',
        'reviewedRevision',
        'decision',
        'feedback',
        'requestedEvidence',
        'decidedAt',
        'applicationStatus',
        'applicationRevision',
      ],
      properties: {
        applicationId: { type: 'string', format: 'uuid' },
        reviewedRevision: { type: 'integer', minimum: 1 },
        decision: { type: 'string', enum: ['approve', 'request_changes', 'reject'] },
        feedback: { type: ['string', 'null'] },
        requestedEvidence: {
          type: 'array',
          items: { type: 'string', enum: sellerApplicationEvidenceTypes },
        },
        decidedAt: { type: 'string', format: 'date-time' },
        applicationStatus: {
          type: 'string',
          enum: ['approved', 'changes_requested', 'rejected'],
        },
        applicationRevision: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

export const sellerReviewQueueQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

export const sellerReviewApplicationParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;
