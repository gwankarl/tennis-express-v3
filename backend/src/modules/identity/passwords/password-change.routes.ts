import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../../http/contract.js';
import { apiErrorResponseSchema } from '../../../http/contract.js';
import { requireAuthentication } from '../../../http/guards/authenticate.js';
import { checkPasswordPolicy } from './password-policy.js';
import { changePassword } from './password-change.service.js';
import {
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  type ChangePasswordRequestBody,
  type ChangePasswordResponseData,
} from './password-change.schema.js';

const CHANGE_PASSWORD_IP_LIMIT = 5;
const CHANGE_PASSWORD_IP_WINDOW = '15 minutes';

function requestError(requestId: string): ApiErrorResponse {
  return {
    error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    requestId,
  };
}

export function registerPasswordChangeRoutes(app: FastifyInstance): void {
  app.post<{ Body: ChangePasswordRequestBody }>(
    '/api/v1/auth/change-password',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Identity'],
        summary: 'Change the current password',
        body: changePasswordRequestSchema,
        response: {
          200: changePasswordResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          429: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
      // The app rate-limit plugin uses an onRequest hook, before the auth
      // preHandler and before route code can invoke Argon2.
      config: {
        rateLimit: {
          max: CHANGE_PASSWORD_IP_LIMIT,
          timeWindow: CHANGE_PASSWORD_IP_WINDOW,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(401).send(requestError(request.id));
      }

      const policy = checkPasswordPolicy(request.body.newPassword);
      if (!policy.valid) {
        const body: ApiErrorResponse = {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: [{ field: 'newPassword', rule: policy.reason }],
          },
          requestId: request.id,
        };
        return reply.code(400).send(body);
      }

      const result = await changePassword(app.db, {
        userId: request.identitySession.userId,
        sessionId: request.identitySession.sessionId,
        currentPassword: request.body.currentPassword,
        newPassword: request.body.newPassword,
      });

      if (result === 'changed') {
        const response: ApiSuccess<ChangePasswordResponseData> = {
          data: { status: 'changed' },
        };
        return reply.code(200).send(response);
      }

      if (result === 'invalid_current_password') {
        const body: ApiErrorResponse = {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: [{ field: 'currentPassword', rule: 'incorrect' }],
          },
          requestId: request.id,
        };
        return reply.code(400).send(body);
      }

      return reply.code(401).send(requestError(request.id));
    },
  );
}
