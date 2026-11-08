import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import type { ApiErrorResponse } from '../contract.js';
import {
  type AuthenticatedSession,
  validateSession,
} from '../../modules/identity/sessions/session.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseClient['db'] | null;
  }

  interface FastifyRequest {
    identitySession: AuthenticatedSession | null;
  }
}

/** Registers the per-request identity context before routes are initialized. */
export function registerAuthenticationContext(app: FastifyInstance): void {
  app.decorateRequest('identitySession', null);
}

/**
 * Fastify pre-handler for routes that require a valid active-account session.
 * Expected credential failures share one response; database failures propagate
 * to the existing generic 500 handler.
 */
export async function requireAuthentication(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/iu.exec(request.headers.authorization ?? '');
  const rawToken = match?.[1];

  if (!rawToken) {
    sendUnauthorized(request, reply);
    return;
  }

  const db = request.server.db;

  if (!db) {
    throw new Error('Session authentication database is unavailable.');
  }

  const session = await validateSession(db, rawToken);

  if (!session) {
    sendUnauthorized(request, reply);
    return;
  }

  request.identitySession = session;
}

function sendUnauthorized(request: FastifyRequest, reply: FastifyReply): void {
  const body: ApiErrorResponse = {
    error: {
      code: 'REQUEST_ERROR',
      message: 'Request failed',
    },
    requestId: request.id,
  };

  reply.code(401).send(body);
}
