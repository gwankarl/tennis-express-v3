import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import type { ApiErrorResponse } from '../contract.js';
import {
  type AuthenticatedSession,
  validateSessionState,
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

/** Requires a valid session for an active, verified, unrestricted account. */
export async function requireAuthentication(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await authenticateSession(request, reply, false);
}

/** Allows a restricted account to validate and revoke its current session. */
export async function requireSessionForLogout(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await authenticateSession(request, reply, true);
}

async function authenticateSession(
  request: FastifyRequest,
  reply: FastifyReply,
  allowRestrictedAccount: boolean,
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

  const result = await validateSessionState(db, rawToken);

  if (!result) {
    sendUnauthorized(request, reply);
    return;
  }

  request.identitySession = result.session;

  if (result.kind === 'account_restricted' && !allowRestrictedAccount) {
    sendAccountRestricted(request, reply);
  }
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

function sendAccountRestricted(request: FastifyRequest, reply: FastifyReply): void {
  const body: ApiErrorResponse = {
    error: {
      code: 'ACCOUNT_RESTRICTED',
      message: 'Account access is restricted',
    },
    requestId: request.id,
  };

  reply.code(403).send(body);
}
