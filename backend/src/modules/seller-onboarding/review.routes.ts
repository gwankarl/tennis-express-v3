import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../http/contract.js';
import { apiErrorResponseSchema } from '../../http/contract.js';
import { requireWorkspaceAccess } from '../../http/guards/authorize-workspace.js';
import {
  decideSellerApplication,
  SellerReviewServiceError,
  getSellerApplicationForReview,
  listSellerApplicationsForReview,
} from './review.service.js';
import type { SellerReviewDecisionInput } from './review.validation.js';
import {
  sellerReviewApplicationParamsSchema,
  sellerReviewDecisionRequestSchema,
  sellerReviewDecisionResponseSchema,
  sellerReviewDetailResponseSchema,
  sellerReviewQueueQuerySchema,
  sellerReviewQueueResponseSchema,
} from './review.schema.js';

interface ReviewApplicationParams {
  id: string;
}

interface ReviewQueueQuery {
  limit?: number;
  offset?: number;
}

function requestError(requestId: string): ApiErrorResponse {
  return {
    error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    requestId,
  };
}

function sendReviewServiceError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (!(error instanceof SellerReviewServiceError)) {
    throw error;
  }

  const isValidation = error.statusCode === 400;

  return reply.code(error.statusCode).send({
    error: {
      code: isValidation ? 'VALIDATION_ERROR' : 'REQUEST_ERROR',
      message: isValidation ? 'Request validation failed' : 'Request failed',
      ...(isValidation && error.field && error.rule
        ? { details: [{ field: error.field, rule: error.rule }] }
        : {}),
    },
    requestId: request.id,
  } satisfies ApiErrorResponse);
}

export function registerSellerApplicationReviewRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: ReviewQueueQuery }>(
    '/api/v1/admin/seller-applications',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Seller onboarding review'],
        summary: 'List submitted seller applications for review',
        querystring: sellerReviewQueueQuerySchema,
        response: {
          200: sellerReviewQueueResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const result = await listSellerApplicationsForReview(
          app.db,
          request.identitySession.userId,
          {
            limit: request.query.limit ?? 25,
            offset: request.query.offset ?? 0,
          },
        );

        const response: ApiSuccess<typeof result> = { data: result };
        return reply.code(200).send(response);
      } catch (error) {
        return sendReviewServiceError(error, request, reply);
      }
    },
  );

  app.get<{ Params: ReviewApplicationParams }>(
    '/api/v1/admin/seller-applications/:id',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Seller onboarding review'],
        summary: 'Get a submitted seller application for review',
        params: sellerReviewApplicationParamsSchema,
        response: {
          200: sellerReviewDetailResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const application = await getSellerApplicationForReview(
          app.db,
          request.identitySession.userId,
          request.params.id,
        );

        return reply.code(200).send({ data: { application } });
      } catch (error) {
        return sendReviewServiceError(error, request, reply);
      }
    },
  );

  app.post<{
    Params: ReviewApplicationParams;
    Body: SellerReviewDecisionInput;
  }>(
    '/api/v1/admin/seller-applications/:id/decision',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Seller onboarding review'],
        summary: 'Record an administrator decision for a submitted revision',
        params: sellerReviewApplicationParamsSchema,
        body: sellerReviewDecisionRequestSchema,
        response: {
          200: sellerReviewDecisionResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const decision = await decideSellerApplication(
          app.db,
          request.identitySession.userId,
          request.params.id,
          request.body,
        );

        return reply.code(200).send({ data: decision });
      } catch (error) {
        return sendReviewServiceError(error, request, reply);
      }
    },
  );
}
