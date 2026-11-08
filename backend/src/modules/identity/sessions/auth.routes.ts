import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../../http/contract.js';
import { apiErrorResponseSchema } from '../../../http/contract.js';
import {
  requireAuthentication,
  requireSessionForLogout,
} from '../../../http/guards/authenticate.js';
import { identityUsers } from '../accounts/user.table.js';
import { login } from './auth.service.js';
import {
  currentUserResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutResponseSchema,
  type CurrentUserResponseData,
  type LoginRequestBody,
  type LoginResponseData,
  type LogoutResponseData,
} from './auth.schema.js';
import { revokeSession } from './session.service.js';

const LOGIN_IP_LIMIT = 5;
const LOGIN_WINDOW = '15 minutes';

function sendUnauthorized(requestId: string): ApiErrorResponse {
  return {
    error: {
      code: 'REQUEST_ERROR',
      message: 'Request failed',
    },
    requestId,
  };
}

export function registerSessionAuthRoutes(app: FastifyInstance): void {
  app.post<{ Body: LoginRequestBody }>(
    '/api/v1/auth/login',
    {
      schema: {
        tags: ['Identity'],
        summary: 'Sign in',
        body: loginRequestSchema,
        response: {
          200: loginResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          429: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
      config: {
        rateLimit: {
          max: LOGIN_IP_LIMIT,
          timeWindow: LOGIN_WINDOW,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db) {
        throw new Error('Login database is unavailable.');
      }

      const session = await login(app.db, request.body);

      if (!session) {
        return reply.code(401).send(sendUnauthorized(request.id));
      }

      const response: ApiSuccess<LoginResponseData> = {
        data: {
          sessionToken: session.rawToken,
          tokenType: 'Bearer',
          expiresAt: session.absoluteExpiresAt.toISOString(),
        },
      };

      return reply.code(200).send(response);
    },
  );

  app.post(
    '/api/v1/auth/logout',
    {
      preHandler: requireSessionForLogout,
      schema: {
        tags: ['Identity'],
        summary: 'Sign out the current session',
        response: {
          200: logoutResponseSchema,
          401: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(401).send(sendUnauthorized(request.id));
      }

      await revokeSession(
        app.db,
        request.identitySession.userId,
        request.identitySession.sessionId,
      );

      const response: ApiSuccess<LogoutResponseData> = {
        data: { status: 'logged_out' },
      };

      return reply.code(200).send(response);
    },
  );

  app.get(
    '/api/v1/auth/me',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Identity'],
        summary: 'Get the current user',
        response: {
          200: currentUserResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(401).send(sendUnauthorized(request.id));
      }

      const users = await app.db
        .select({
          id: identityUsers.id,
          email: identityUsers.deliveryEmail,
          status: identityUsers.status,
          emailVerifiedAt: identityUsers.emailVerifiedAt,
        })
        .from(identityUsers)
        .where(eq(identityUsers.id, request.identitySession.userId))
        .limit(1);

      const user = users[0];

      if (!user || user.status !== 'active' || user.emailVerifiedAt === null) {
        return reply.code(401).send(sendUnauthorized(request.id));
      }

      const response: ApiSuccess<CurrentUserResponseData> = {
        data: {
          id: user.id,
          email: user.email,
        },
      };

      return reply.code(200).send(response);
    },
  );
}
