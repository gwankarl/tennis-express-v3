import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../../http/contract.js';
import { apiErrorResponseSchema } from '../../../http/contract.js';
import { requireAuthentication } from '../../../http/guards/authenticate.js';
import {
  AdminMfaWorkflowError,
  confirmAdminMfaEnrollment,
  startAdminMfaEnrollment,
} from './mfa-enrollment.service.js';
import {
  AdminMfaElevationError,
  confirmAdminMfaElevation,
  startAdminMfaElevation,
} from './mfa-elevation.service.js';
import {
  confirmAdminMfaEnrollmentRequestSchema,
  confirmAdminMfaEnrollmentResponseSchema,
  confirmAdminMfaElevationRequestSchema,
  confirmAdminMfaElevationResponseSchema,
  recoverAdminMfaRequestSchema,
  recoverAdminMfaResponseSchema,
  startAdminMfaEnrollmentRequestSchema,
  startAdminMfaEnrollmentResponseSchema,
  startAdminMfaElevationRequestSchema,
  startAdminMfaElevationResponseSchema,
  type ConfirmAdminMfaEnrollmentBody,
  type ConfirmAdminMfaEnrollmentData,
  type ConfirmAdminMfaElevationBody,
  type ConfirmAdminMfaElevationData,
  type RecoverAdminMfaBody,
  type RecoverAdminMfaData,
  type StartAdminMfaEnrollmentBody,
  type StartAdminMfaEnrollmentData,
  type StartAdminMfaElevationBody,
  type StartAdminMfaElevationData,
} from './admin-mfa.schema.js';
import { recoverAdminMfaWithRecoveryCode as recoverWithCode } from './mfa-recovery.service.js';

export function registerAdminMfaRoutes(app: FastifyInstance): void {
  app.post<{ Body: StartAdminMfaEnrollmentBody }>(
    '/api/v1/admin/mfa/enrollment',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Identity'],
        summary: 'Start administrator MFA enrollment',
        body: startAdminMfaEnrollmentRequestSchema,
        response: {
          200: startAdminMfaEnrollmentResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          429: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.mfaPool || !app.adminMfaConfig || !request.identitySession) {
        return sendUnavailable(request, reply);
      }

      try {
        const setup = await startAdminMfaEnrollment({
          pool: app.mfaPool,
          config: app.adminMfaConfig,
          userId: request.identitySession.userId,
          sessionId: request.identitySession.sessionId,
          password: request.body.password,
          authorization: request.body.authorization,
          ipAddress: request.ip,
        });

        const response: ApiSuccess<StartAdminMfaEnrollmentData> = {
          data: {
            secret: setup.secret,
            provisioningUri: setup.provisioningUri,
            expiresAt: setup.expiresAt.toISOString(),
          },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return handleWorkflowError(error, request, reply);
      }
    },
  );

  app.post<{ Body: ConfirmAdminMfaEnrollmentBody }>(
    '/api/v1/admin/mfa/enrollment/confirm',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Identity'],
        summary: 'Confirm administrator MFA enrollment',
        body: confirmAdminMfaEnrollmentRequestSchema,
        response: {
          200: confirmAdminMfaEnrollmentResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          429: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.mfaPool || !app.adminMfaConfig || !request.identitySession) {
        return sendUnavailable(request, reply);
      }

      try {
        const result = await confirmAdminMfaEnrollment({
          pool: app.mfaPool,
          config: app.adminMfaConfig,
          userId: request.identitySession.userId,
          sessionId: request.identitySession.sessionId,
          code: request.body.code,
          ipAddress: request.ip,
        });

        const response: ApiSuccess<ConfirmAdminMfaEnrollmentData> = {
          data: {
            status: 'enrolled',
            recoveryCodes: result.recoveryCodes,
          },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return handleWorkflowError(error, request, reply);
      }
    },
  );

  app.post<{ Body: RecoverAdminMfaBody }>(
    '/api/v1/admin/mfa/recovery',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Identity'],
        summary: 'Recover administrator MFA with a recovery code',
        body: recoverAdminMfaRequestSchema,
        response: {
          200: recoverAdminMfaResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          429: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.mfaPool || !app.adminMfaConfig || !app.emailSender || !request.identitySession) {
        return sendUnavailable(request, reply);
      }

      try {
        const result = await recoverWithCode({
          pool: app.mfaPool,
          config: app.adminMfaConfig,
          emailSender: app.emailSender,
          frontendOrigin: app.frontendOrigin,
          userId: request.identitySession.userId,
          sessionId: request.identitySession.sessionId,
          currentPassword: request.body.currentPassword,
          recoveryCode: request.body.recoveryCode,
          ipAddress: request.ip,
        });

        const response: ApiSuccess<RecoverAdminMfaData> = {
          data: {
            status: 'recovered',
            adminHoldUntil: result.adminHoldUntil.toISOString(),
            notificationSent: result.notificationSent,
            replacementEnrollmentAuthorization: result.replacementEnrollmentAuthorization,
          },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return handleWorkflowError(error, request, reply);
      }
    },
  );

  app.post<{ Body: StartAdminMfaElevationBody }>(
    '/api/v1/admin/mfa/elevation/challenge',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Identity'],
        summary: 'Start administrator MFA elevation',
        body: startAdminMfaElevationRequestSchema,
        response: {
          200: startAdminMfaElevationResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          429: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      const sessionToken = getCurrentBearerToken(request);

      if (!app.mfaPool || !app.adminMfaConfig || !request.identitySession || !sessionToken) {
        return sendUnauthorized(request, reply);
      }

      try {
        const result = await startAdminMfaElevation({
          pool: app.mfaPool,
          config: app.adminMfaConfig,
          userId: request.identitySession.userId,
          sessionId: request.identitySession.sessionId,
          sessionToken,
          password: request.body.password,
          ipAddress: request.ip,
          requestId: request.id,
        });

        const response: ApiSuccess<StartAdminMfaElevationData> = {
          data: {
            challenge: result.challenge,
            expiresAt: result.expiresAt.toISOString(),
          },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return handleWorkflowError(error, request, reply);
      }
    },
  );

  app.post<{ Body: ConfirmAdminMfaElevationBody }>(
    '/api/v1/admin/mfa/elevation/confirm',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Identity'],
        summary: 'Confirm administrator MFA elevation',
        body: confirmAdminMfaElevationRequestSchema,
        response: {
          200: confirmAdminMfaElevationResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          429: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      const sessionToken = getCurrentBearerToken(request);

      if (!app.mfaPool || !app.adminMfaConfig || !request.identitySession || !sessionToken) {
        return sendUnauthorized(request, reply);
      }

      try {
        const result = await confirmAdminMfaElevation({
          pool: app.mfaPool,
          config: app.adminMfaConfig,
          userId: request.identitySession.userId,
          sessionId: request.identitySession.sessionId,
          sessionToken,
          challenge: request.body.challenge,
          code: request.body.code,
          ipAddress: request.ip,
          requestId: request.id,
        });

        const response: ApiSuccess<ConfirmAdminMfaElevationData> = {
          data: {
            sessionToken: result.sessionToken,
            tokenType: 'Bearer',
            expiresAt: result.absoluteExpiresAt.toISOString(),
            elevatedUntil: result.elevatedUntil.toISOString(),
          },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return handleWorkflowError(error, request, reply);
      }
    },
  );
}

function handleWorkflowError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  let statusCode: number;
  let retryAfterSeconds: number | undefined;

  if (error instanceof AdminMfaElevationError) {
    statusCode =
      error.code === 'not_authorized'
        ? 403
        : error.code === 'attempts_blocked'
          ? 429
          : error.code === 'service_unavailable'
            ? 503
            : error.code === 'invalid_credentials'
              ? 401
              : 400;
    retryAfterSeconds = error.retryAfterSeconds;
  } else if (error instanceof AdminMfaWorkflowError) {
    statusCode =
      error.code === 'not_authorized'
        ? 403
        : error.code === 'attempts_blocked'
          ? 429
          : error.code === 'factor_unavailable'
            ? 409
            : error.code === 'service_unavailable'
              ? 503
              : error.code === 'invalid_credentials'
                ? 401
                : 400;
    retryAfterSeconds = error.retryAfterSeconds;
  } else {
    throw error;
  }

  if (statusCode === 429 && retryAfterSeconds) {
    reply.header('retry-after', String(retryAfterSeconds));
  }

  const body: ApiErrorResponse = {
    error: {
      code: statusCode === 503 ? 'SERVICE_UNAVAILABLE' : 'REQUEST_ERROR',
      message: statusCode === 503 ? 'Service unavailable' : 'Request failed',
    },
    requestId: request.id,
  };

  return reply.code(statusCode).send(body);
}

function sendUnavailable(request: FastifyRequest, reply: FastifyReply) {
  const body: ApiErrorResponse = {
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
    },
    requestId: request.id,
  };

  return reply.code(503).send(body);
}

function getCurrentBearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;

  if (typeof authorization !== 'string') {
    return undefined;
  }

  const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/iu.exec(authorization);
  return match?.[1];
}

function sendUnauthorized(request: FastifyRequest, reply: FastifyReply) {
  const body: ApiErrorResponse = {
    error: {
      code: 'REQUEST_ERROR',
      message: 'Request failed',
    },
    requestId: request.id,
  };

  return reply.code(401).send(body);
}
