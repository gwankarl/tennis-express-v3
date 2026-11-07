import type { FastifyInstance } from 'fastify';
import type { ApiSuccess } from '../../../http/contract.js';
import { apiErrorResponseSchema } from '../../../http/contract.js';
import { createVerificationEmail } from '../verification/verification-email.js';
import {
  registrationRequestSchema,
  registrationResponseSchema,
  type RegistrationRequestBody,
  type RegistrationResponseData,
} from './registration.schema.js';
import { createPendingAccount } from './registration.service.js';

export function registerRegistrationRoutes(app: FastifyInstance): void {
  app.post<{ Body: RegistrationRequestBody }>(
    '/api/v1/auth/register',
    {
      schema: {
        tags: ['Identity'],
        summary: 'Register an account',
        body: registrationRequestSchema,
        response: {
          202: registrationResponseSchema,
          400: apiErrorResponseSchema,
          429: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '15 minutes',
        },
      },
    },
    async (request, reply) => {
      const db = app.db;

      if (!db) {
        throw new Error('Registration database is unavailable.');
      }

      const rawVerificationToken = await createPendingAccount(db, request.body);

      if (rawVerificationToken) {
        scheduleVerificationEmail(app, request.id, request.body.email.trim(), rawVerificationToken);
      }

      const response: ApiSuccess<RegistrationResponseData> = {
        data: { status: 'accepted' },
      };

      return reply.code(202).send(response);
    },
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

    // Start delivery after the transaction commits, without awaiting SMTP in the
    // request. A delivery failure can't change the generic 202 response or account state.
    void Promise.resolve()
      .then(() => sender.send(message))
      .catch(() => {
        app.log.warn({ requestId }, 'Registration verification email delivery failed');
      });
  } catch {
    app.log.warn({ requestId }, 'Registration verification email delivery failed');
  }
}
