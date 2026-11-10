import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../http/contract.js';
import { apiErrorResponseSchema } from '../../http/contract.js';
import { requireAuthentication } from '../../http/guards/authenticate.js';
import {
  EvidenceUploadTooLargeError,
  MAX_EVIDENCE_FILE_BYTES,
  UnsupportedEvidenceFileError,
} from '../../infrastructure/storage/private-evidence-file-store.js';
import {
  replaceSellerEvidence,
  SellerEvidenceServiceError,
  sellerEvidenceTypes,
  type SellerEvidenceType,
  type UploadedEvidence,
} from './application-evidence.service.js';

interface EvidenceParams {
  id: string;
  type: SellerEvidenceType;
}

interface EvidenceQuery {
  expectedRevision: number;
}

const evidenceParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: sellerEvidenceTypes },
  },
} as const;

const evidenceQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedRevision'],
  properties: {
    expectedRevision: { type: 'integer', minimum: 1 },
  },
} as const;

const uploadResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['evidence'],
      properties: {
        evidence: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'mediaType', 'byteSize', 'updatedAt', 'revision'],
          properties: {
            type: { type: 'string', enum: sellerEvidenceTypes },
            mediaType: { type: 'string', enum: ['image/jpeg', 'image/png', 'application/pdf'] },
            byteSize: { type: 'integer', minimum: 1, maximum: MAX_EVIDENCE_FILE_BYTES },
            updatedAt: { type: 'string', format: 'date-time' },
            revision: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  },
} as const;

function requestError(requestId: string): ApiErrorResponse {
  return {
    error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    requestId,
  };
}

function sendEvidenceError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof SellerEvidenceServiceError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.statusCode === 400 ? 'VALIDATION_ERROR' : 'REQUEST_ERROR',
        message: error.statusCode === 400 ? 'Request validation failed' : 'Request failed',
        ...(error.field && error.rule
          ? { details: [{ field: error.field, rule: error.rule }] }
          : {}),
      },
      requestId: request.id,
    } satisfies ApiErrorResponse);
  }

  if (error instanceof EvidenceUploadTooLargeError) {
    return reply.code(413).send(requestError(request.id));
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'FST_REQ_FILE_TOO_LARGE'
  ) {
    return reply.code(413).send(requestError(request.id));
  }

  if (error instanceof UnsupportedEvidenceFileError) {
    return reply.code(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: [{ field: 'file', rule: 'unsupported_type' }],
      },
      requestId: request.id,
    } satisfies ApiErrorResponse);
  }

  throw error;
}

export function registerSellerApplicationEvidenceRoutes(app: FastifyInstance): void {
  app.put<{ Params: EvidenceParams; Querystring: EvidenceQuery }>(
    '/api/v1/me/seller-applications/:id/evidence/:type',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Seller onboarding'],
        summary: 'Upload or replace owned seller application evidence',
        consumes: ['multipart/form-data'],
        params: evidenceParamsSchema,
        querystring: evidenceQuerySchema,
        response: {
          200: uploadResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          413: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !app.evidenceFileStore || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      let staged: Awaited<ReturnType<typeof app.evidenceFileStore.stage>> | undefined;

      try {
        const part = await request.file({
          limits: { files: 1, fields: 0, fileSize: MAX_EVIDENCE_FILE_BYTES },
        });

        if (!part) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
              details: [{ field: 'file', rule: 'required' }],
            },
            requestId: request.id,
          } satisfies ApiErrorResponse);
        }

        staged = await app.evidenceFileStore.stage(part.file, part.mimetype);

        if (part.file.truncated) {
          throw new EvidenceUploadTooLargeError();
        }

        const evidence: UploadedEvidence = await replaceSellerEvidence(
          app.db,
          app.evidenceFileStore,
          {
            userId: request.identitySession.userId,
            applicationId: request.params.id,
            type: request.params.type,
            expectedRevision: request.query.expectedRevision,
            staged,
          },
        );

        const response: ApiSuccess<{ evidence: UploadedEvidence }> = {
          data: { evidence },
        };

        return reply.code(200).send(response);
      } catch (error) {
        if (staged) {
          await app.evidenceFileStore.discardStaged(staged).catch(() => undefined);
        }

        return sendEvidenceError(error, request, reply);
      }
    },
  );
}
