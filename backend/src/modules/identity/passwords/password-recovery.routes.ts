import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../../http/contract.js';
import { apiErrorResponseSchema } from '../../../http/contract.js';
import { createPasswordResetEmail } from './password-reset-email.js';
import { checkPasswordPolicy } from './password-policy.js';
import {
  forgotPasswordRequestSchema,
  forgotPasswordResponseSchema,
  resetPasswordRequestSchema,
  resetPasswordResponseSchema,
  type ForgotPasswordRequestBody,
  type ForgotPasswordResponseData,
  type ResetPasswordRequestBody,
  type ResetPasswordResponseData,
} from './password-recovery.schema.js';
import { createPasswordResetRequest, resetPassword } from './password-recovery.service.js';
import { normalizeEmail } from '../accounts/email-normalization.js';

const FORGOT_IP_LIMIT = 5;
const FORGOT_IP_WINDOW = '15 minutes';
const FORGOT_EMAIL_LIMIT = 3;
const FORGOT_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_EMAILS = 10_000;

const RESET_IP_LIMIT = 5;
const RESET_IP_WINDOW = '15 minutes';

export function registerPasswordRecoveryRoutes(app: FastifyInstance): void {
  const forgotIpLimiter = app.rateLimit({
    max: FORGOT_IP_LIMIT,
    timeWindow: FORGOT_IP_WINDOW,
    keyGenerator: (request) => request.ip,
  });
  const attemptsByEmail = new Map<string, number[]>();

  app.post<{ Body: ForgotPasswordRequestBody }>(
    '/api/v1/auth/forgot-password',
    {
      schema: {
        tags: ['Identity'],
        summary: 'Request a password reset',
        body: forgotPasswordRequestSchema,
        response: {
          202: forgotPasswordResponseSchema,
          400: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
      preHandler: [
        returnGenericAcceptedOnLimit(forgotIpLimiter),
        createEmailRateLimiter(attemptsByEmail),
      ],
    },
    async (request, reply) => {
      if (!app.db) {
        throw new Error('Password recovery database is unavailable.');
      }

      const delivery = await createPasswordResetRequest(app.db, request.body.email);

      if (delivery) {
        scheduleResetEmail(app, request.id, delivery.recipient, delivery.rawToken);
      }

      const response: ApiSuccess<ForgotPasswordResponseData> = {
        data: { status: 'accepted' },
      };

      return reply.header('cache-control', 'no-store').code(202).send(response);
    },
  );

  app.post<{ Body: ResetPasswordRequestBody }>(
    '/api/v1/auth/reset-password',
    {
      schema: {
        tags: ['Identity'],
        summary: 'Reset a password',
        body: resetPasswordRequestSchema,
        response: {
          200: resetPasswordResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          429: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
      config: {
        rateLimit: {
          max: RESET_IP_LIMIT,
          timeWindow: RESET_IP_WINDOW,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');

      if (!app.db) {
        throw new Error('Password reset database is unavailable.');
      }

      const policy = checkPasswordPolicy(request.body.password);

      if (!policy.valid) {
        const body: ApiErrorResponse = {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: [{ field: 'password', rule: policy.reason }],
          },
          requestId: request.id,
        };

        return reply.code(400).send(body);
      }

      const reset = await resetPassword(app.db, request.body);

      if (!reset) {
        const body: ApiErrorResponse = {
          error: {
            code: 'REQUEST_ERROR',
            message: 'Request failed',
          },
          requestId: request.id,
        };

        return reply.code(401).send(body);
      }

      const response: ApiSuccess<ResetPasswordResponseData> = {
        data: { status: 'reset' },
      };

      return reply.code(200).send(response);
    },
  );
}

function returnGenericAcceptedOnLimit(
  limiter: preHandlerAsyncHookHandler,
): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    try {
      await limiter.call(request.server, request, reply);
    } catch (error) {
      if (!isRateLimitError(error)) throw error;

      for (const header of [
        'retry-after',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
      ]) {
        reply.removeHeader(header);
      }

      const response: ApiSuccess<ForgotPasswordResponseData> = {
        data: { status: 'accepted' },
      };

      reply.header('cache-control', 'no-store').code(202).send(response);
    }
  };
}

function createEmailRateLimiter(
  attemptsByEmail: Map<string, number[]>,
): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const now = Date.now();
    const windowStart = now - FORGOT_EMAIL_WINDOW_MS;

    for (const [email, attempts] of attemptsByEmail) {
      const recent = attempts.filter((attemptAt) => attemptAt > windowStart);

      if (recent.length === 0) {
        attemptsByEmail.delete(email);
      } else if (recent.length !== attempts.length) {
        attemptsByEmail.set(email, recent);
      }
    }

    const body = request.body as ForgotPasswordRequestBody;
    const normalizedEmail = normalizeEmail(body.email);
    const attempts = attemptsByEmail.get(normalizedEmail) ?? [];

    if (attempts.length >= FORGOT_EMAIL_LIMIT || attemptsByEmail.size >= MAX_TRACKED_EMAILS) {
      const response: ApiSuccess<ForgotPasswordResponseData> = {
        data: { status: 'accepted' },
      };

      reply.header('cache-control', 'no-store').code(202).send(response);
      return;
    }

    attempts.push(now);
    attemptsByEmail.set(normalizedEmail, attempts);
  };
}

function isRateLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429
  );
}

function scheduleResetEmail(
  app: FastifyInstance,
  requestId: string,
  recipient: string,
  rawToken: string,
): void {
  const sender = app.emailSender;

  if (!sender) return;

  try {
    const message = createPasswordResetEmail({
      to: recipient,
      rawToken,
      frontendOrigin: app.frontendOrigin,
    });

    // createPasswordResetRequest has committed before this is scheduled.
    // Delivery latency and errors never change the generic 202 response.
    void Promise.resolve()
      .then(() => sender.send(message))
      .catch(() => {
        app.log.warn({ requestId }, 'Password reset email delivery failed');
      });
  } catch {
    app.log.warn({ requestId }, 'Password reset email delivery failed');
  }
}
