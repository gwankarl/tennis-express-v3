import { once } from 'node:events';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireWorkspaceAccess } from '../../http/guards/authorize-workspace.js';
import { requireAuthentication } from '../../http/guards/authenticate.js';
import { apiErrorResponseSchema } from '../../http/contract.js';
import {
  getOwnedSellerEvidence,
  getReviewableSellerEvidence,
  SellerEvidenceServiceError,
  sellerEvidenceTypes,
  type SellerEvidenceType,
} from './application-evidence.service.js';

interface EvidenceParams {
  id: string;
  type: SellerEvidenceType;
}

const evidenceParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: sellerEvidenceTypes },
  },
} as const;

function sendNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({
    error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    requestId: request.id,
  });
}

function sendUnavailable(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    requestId: request.id,
  });
}

async function deliverEvidence(
  request: FastifyRequest<{ Params: EvidenceParams }>,
  reply: FastifyReply,
  storageKey: string,
  mediaType: string,
  byteSize: number,
) {
  const store = request.server.evidenceFileStore;

  if (!store) {
    return sendUnavailable(request, reply);
  }

  const stream = store.openStored(storageKey);

  try {
    // Wait for the file descriptor before sending headers. This lets a missing
    // or unreadable private object return a safe API error instead of a partial body.
    await once(stream, 'open');
  } catch {
    stream.destroy();
    return sendUnavailable(request, reply);
  }

  reply
    .header('cache-control', 'private, no-store')
    .header('content-type', mediaType)
    .header('content-length', String(byteSize))
    .header('content-disposition', 'attachment; filename="seller-evidence"')
    .header('x-content-type-options', 'nosniff');

  return reply.send(stream);
}

function handleLookupError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof SellerEvidenceServiceError && error.statusCode === 404) {
    return sendNotFound(request, reply);
  }

  throw error;
}

export function registerSellerApplicationEvidenceReadRoutes(app: FastifyInstance): void {
  app.get<{ Params: EvidenceParams }>(
    '/api/v1/me/seller-applications/:id/evidence/:type',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Seller onboarding'],
        summary: 'Retrieve evidence for an owned seller application',
        params: evidenceParamsSchema,
        response: {
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!app.db || !request.identitySession) {
        return sendUnavailable(request, reply);
      }

      try {
        const evidence = await getOwnedSellerEvidence(
          app.db,
          request.identitySession.userId,
          request.params.id,
          request.params.type,
        );

        return deliverEvidence(
          request,
          reply,
          evidence.storageKey,
          evidence.mediaType,
          evidence.byteSize,
        );
      } catch (error) {
        return handleLookupError(error, request, reply);
      }
    },
  );

  app.get<{ Params: EvidenceParams }>(
    '/api/v1/admin/seller-applications/:id/evidence/:type',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Seller onboarding'],
        summary: 'Retrieve evidence for an eligible submitted application',
        params: evidenceParamsSchema,
        response: {
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!app.db || !request.identitySession) {
        return sendUnavailable(request, reply);
      }

      try {
        const evidence = await getReviewableSellerEvidence(
          app.db,
          request.identitySession.userId,
          request.params.id,
          request.params.type,
        );

        return deliverEvidence(
          request,
          reply,
          evidence.storageKey,
          evidence.mediaType,
          evidence.byteSize,
        );
      } catch (error) {
        return handleLookupError(error, request, reply);
      }
    },
  );
}
