import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../http/contract.js';
import { apiErrorResponseSchema } from '../../http/contract.js';
import { requireAuthentication } from '../../http/guards/authenticate.js';
import {
  createSellerApplication,
  getCurrentSellerApplication,
  SellerApplicationServiceError,
  updateSellerApplication,
  submitSellerApplication,
} from './application.service.js';
import {
  createSellerApplicationRequestSchema,
  sellerApplicationResponseSchema,
  updateSellerApplicationRequestSchema,
  submitSellerApplicationRequestSchema,
  type SubmitSellerApplicationBody,
  type CreateSellerApplicationBody,
  type SellerApplicationResponseData,
  type UpdateSellerApplicationBody,
} from './application.schema.js';

interface ApplicationIdParams {
  id: string;
}

const applicationIdParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

function requestError(requestId: string): ApiErrorResponse {
  return {
    error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    requestId,
  };
}

function sendServiceError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (!(error instanceof SellerApplicationServiceError)) {
    throw error;
  }

  const body: ApiErrorResponse = {
    error: {
      code: error.statusCode === 400 ? 'VALIDATION_ERROR' : 'REQUEST_ERROR',
      message: error.statusCode === 400 ? 'Request validation failed' : 'Request failed',
      ...(error.statusCode === 400 && error.details?.length
        ? { details: [...error.details] }
        : error.statusCode === 400 && error.field && error.rule
          ? { details: [{ field: error.field, rule: error.rule }] }
          : {}),
    },
    requestId: request.id,
  };

  return reply.code(error.statusCode).send(body);
}

export function registerSellerApplicationRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateSellerApplicationBody }>(
    '/api/v1/me/seller-applications',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Seller onboarding'],
        summary: 'Create a seller application draft',
        body: createSellerApplicationRequestSchema,
        response: {
          201: sellerApplicationResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
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
        const application = await createSellerApplication(
          app.db,
          request.identitySession.userId,
          request.body,
        );
        const response: ApiSuccess<SellerApplicationResponseData> = {
          data: { application },
        };

        return reply.code(201).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );

  app.get(
    '/api/v1/me/seller-applications/current',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Seller onboarding'],
        summary: 'Get the current user’s latest seller application',
        response: {
          200: sellerApplicationResponseSchema,
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

      const application = await getCurrentSellerApplication(app.db, request.identitySession.userId);
      const response: ApiSuccess<SellerApplicationResponseData> = {
        data: { application },
      };

      return reply.code(200).send(response);
    },
  );

  app.patch<{ Params: ApplicationIdParams; Body: UpdateSellerApplicationBody }>(
    '/api/v1/me/seller-applications/:id',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Seller onboarding'],
        summary: 'Update an owned seller application draft',
        params: applicationIdParamsSchema,
        body: updateSellerApplicationRequestSchema,
        response: {
          200: sellerApplicationResponseSchema,
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
        const application = await updateSellerApplication(
          app.db,
          request.identitySession.userId,
          request.params.id,
          request.body,
        );
        const response: ApiSuccess<SellerApplicationResponseData> = {
          data: { application },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );

  app.post<{
    Params: ApplicationIdParams;
    Body: SubmitSellerApplicationBody;
  }>(
    '/api/v1/me/seller-applications/:id/submit',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Seller onboarding'],
        summary: 'Submit an owned seller application',
        params: applicationIdParamsSchema,
        body: submitSellerApplicationRequestSchema,
        response: {
          200: sellerApplicationResponseSchema,
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
        const application = await submitSellerApplication(
          app.db,
          request.identitySession.userId,
          request.params.id,
          request.body.expectedRevision,
        );
        const response: ApiSuccess<SellerApplicationResponseData> = {
          data: { application },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );
}
