import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../../http/contract.js';
import { apiErrorResponseSchema } from '../../../http/contract.js';
import { createVerificationEmail } from './verification-email.js';
import {
  resendVerificationRequestSchema,
  resendVerificationResponseSchema,
  verifyEmailRequestSchema,
  verifyEmailResponseSchema,
  type ResendVerificationRequestBody,
  type ResendVerificationResponseData,
  type VerifyEmailRequestBody,
  type VerifyEmailResponseData,
} from './verification.schema.js';
import { createResendVerification, verifyEmail } from './verification.service.js';
import { normalizeEmail } from '../accounts/email-normalization.js';

const VERIFY_IP_LIMIT = 5;
const VERIFY_WINDOW = '15 minutes';
const RESEND_IP_LIMIT = 5;
const RESEND_EMAIL_LIMIT = 3;
const RESEND_IP_WINDOW = '15 minutes';
const RESEND_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_RESEND_EMAILS = 10_000;

export function registerVerificationRoutes(app: FastifyInstance): void {
  const resendIpLimiter = app.rateLimit({
    max: RESEND_IP_LIMIT,
    timeWindow: RESEND_IP_WINDOW,
    keyGenerator: (request) => request.ip,
  });

  const resendAttemptsByEmail = new Map<string, number[]>();

  app.post<{ Body: VerifyEmailRequestBody }>(
    '/api/v1/auth/verify-email',
    {
      schema: {
        tags: ['Identity'],
        summary: 'Verify an email address',
        body: verifyEmailRequestSchema,
        response: {
          200: verifyEmailResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          429: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
      config: {
        rateLimit: {
          max: VERIFY_IP_LIMIT,
          timeWindow: VERIFY_WINDOW,
        },
      },
    },
    async (request, reply) => {
      if (!app.db) {
        throw new Error('Verification database is unavailable.');
      }

      const verified = await verifyEmail(app.db, request.body);

      if (!verified) {
        const body: ApiErrorResponse = {
          error: {
            code: 'REQUEST_ERROR',
            message: 'Request failed',
          },
          requestId: request.id,
        };

        return reply.code(401).send(body);
      }

      const response: ApiSuccess<VerifyEmailResponseData> = {
        data: { status: 'verified' },
      };

      return reply.code(200).send(response);
    },
  );

  app.post<{ Body: ResendVerificationRequestBody }>(
    '/api/v1/auth/resend-verification',
    {
      schema: {
        tags: ['Identity'],
        summary: 'Request another verification email',
        body: resendVerificationRequestSchema,
        response: {
          202: resendVerificationResponseSchema,
          400: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
      preHandler: [
        returnGenericAcceptedOnLimit(resendIpLimiter),
        createResendEmailLimiter(resendAttemptsByEmail),
      ],
    },
    async (request, reply) => {
      if (!app.db) {
        throw new Error('Verification database is unavailable.');
      }

      const delivery = await createResendVerification(app.db, request.body);

      if (delivery) {
        scheduleVerificationEmail(app, request.id, delivery.recipient, delivery.rawToken);
      }

      const response: ApiSuccess<ResendVerificationResponseData> = {
        data: { status: 'accepted' },
      };

      return reply.code(202).send(response);
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
      if (!isRateLimitError(error)) {
        throw error;
      }

      for (const header of [
        'retry-after',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
      ]) {
        reply.removeHeader(header);
      }

      const response: ApiSuccess<ResendVerificationResponseData> = {
        data: { status: 'accepted' },
      };

      reply.code(202).send(response);
    }
  };
}

function createResendEmailLimiter(
  attemptsByEmail: Map<string, number[]>,
): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const now = Date.now();
    const windowStart = now - RESEND_EMAIL_WINDOW_MS;

    // Prune expired entries so the process-local limiter remains bounded over time.
    for (const [email, attempts] of attemptsByEmail) {
      const recentAttempts = attempts.filter((attemptAt) => attemptAt > windowStart);
      if (recentAttempts.length === 0) {
        attemptsByEmail.delete(email);
      } else if (recentAttempts.length !== attempts.length) {
        attemptsByEmail.set(email, recentAttempts);
      }
    }

    const email = normalizeEmail((request.body as ResendVerificationRequestBody).email);
    const attempts = attemptsByEmail.get(email) ?? [];

    if (
      attempts.length >= RESEND_EMAIL_LIMIT ||
      attemptsByEmail.size >= MAX_TRACKED_RESEND_EMAILS
    ) {
      const response: ApiSuccess<ResendVerificationResponseData> = {
        data: { status: 'accepted' },
      };
      reply.code(202).send(response);
      return;
    }

    attempts.push(now);
    attemptsByEmail.set(email, attempts);
  };
}

function isRateLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429
  );
}

function scheduleVerificationEmail(
  app: FastifyInstance,
  requestId: string,
  recipient: string,
  rawToken: string,
): void {
  const sender = app.emailSender;

  if (!sender) {
    return;
  }

  try {
    const message = createVerificationEmail({
      to: recipient,
      rawToken,
      frontendOrigin: app.frontendOrigin,
    });

    // The route calls this after the database transaction has committed.
    // Keep SMTP latency and delivery errors out of the HTTP result.
    void Promise.resolve()
      .then(() => sender.send(message))
      .catch(() => {
        app.log.warn({ requestId }, 'Verification email delivery failed');
      });
  } catch {
    app.log.warn({ requestId }, 'Verification email delivery failed');
  }
}
