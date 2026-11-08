import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../../http/contract.js';
import { apiErrorResponseSchema } from '../../../http/contract.js';
import { requireAuthentication } from '../../../http/guards/authenticate.js';
import { getUserProfile, updateUserDisplayName } from './profile.service.js';
import {
  updateUserProfileRequestSchema,
  userProfileResponseSchema,
  type UpdateUserProfileRequestBody,
  type UserProfileResponseData,
} from './profile.schema.js';

function requestError(requestId: string): ApiErrorResponse {
  return {
    error: {
      code: 'REQUEST_ERROR',
      message: 'Request failed',
    },
    requestId,
  };
}

function displayNameValidationError(requestId: string): ApiErrorResponse {
  return {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [{ field: 'displayName', rule: 'non_blank' }],
    },
    requestId,
  };
}

export function registerUserProfileRoutes(app: FastifyInstance): void {
  app.get(
    '/api/v1/me/profile',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Identity'],
        summary: 'Get the authenticated user profile',
        response: {
          200: userProfileResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(401).send(requestError(request.id));
      }

      const profile = await getUserProfile(app.db, request.identitySession.userId);

      if (!profile) {
        return reply.code(401).send(requestError(request.id));
      }

      const response: ApiSuccess<UserProfileResponseData> = { data: profile };
      return reply.code(200).send(response);
    },
  );

  app.patch<{ Body: UpdateUserProfileRequestBody }>(
    '/api/v1/me/profile',
    {
      preHandler: requireAuthentication,
      preValidation: async (request, reply) => {
        const requestBody: unknown = request.body;

        if (typeof requestBody !== 'object' || requestBody === null || Array.isArray(requestBody)) {
          return;
        }

        const unexpectedFields = Object.keys(requestBody).filter(
          (field) => field !== 'displayName',
        );

        if (unexpectedFields.length > 0) {
          const error: ApiErrorResponse = {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
              details: unexpectedFields.map((field) => ({ field, rule: 'unexpected' })),
            },
            requestId: request.id,
          };

          return reply.code(400).send(error);
        }
      },
      schema: {
        tags: ['Identity'],
        summary: 'Update the authenticated user display name',
        body: updateUserProfileRequestSchema,
        response: {
          200: userProfileResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(401).send(requestError(request.id));
      }

      const displayName = request.body.displayName.trim();

      if (!displayName) {
        return reply.code(400).send(displayNameValidationError(request.id));
      }

      const profile = await updateUserDisplayName(
        app.db,
        request.identitySession.userId,
        displayName,
      );

      if (!profile) {
        return reply.code(401).send(requestError(request.id));
      }

      const response: ApiSuccess<UserProfileResponseData> = { data: profile };
      return reply.code(200).send(response);
    },
  );
}
