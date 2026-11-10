import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../../http/contract.js';
import { apiErrorResponseSchema } from '../../../http/contract.js';
import {
  resolveWorkspaceAvailability,
  type WorkspaceAuthorizationSources,
} from '../../../http/guards/authorize-workspace.js';
import { requireAuthentication } from '../../../http/guards/authenticate.js';
import { workspacesResponseSchema, type WorkspacesResponseData } from './workspaces.schema.js';

function requestError(requestId: string): ApiErrorResponse {
  return {
    error: {
      code: 'REQUEST_ERROR',
      message: 'Request failed',
    },
    requestId,
  };
}

export function registerWorkspacesRoutes(
  app: FastifyInstance,
  sources: WorkspaceAuthorizationSources = {},
): void {
  app.get(
    '/api/v1/me/workspaces',
    {
      preHandler: requireAuthentication,
      schema: {
        tags: ['Identity'],
        summary: 'Get current workspace availability',
        response: {
          200: workspacesResponseSchema,
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

      const decision = await resolveWorkspaceAvailability(
        app.db,
        request.identitySession.userId,
        request.identitySession.sessionId,
        sources,
      );

      const data: WorkspacesResponseData = {
        adminMfaFactorState: decision.adminMfaFactorState,
        defaultWorkspace: 'buyer',
        availableWorkspaces: {
          buyer: true,
          seller: decision.sellerAvailable,
        },
        sellerApplicationStatus: decision.sellerApplicationStatus,
        adminEntryState: decision.adminEntryState,
      };
      const response: ApiSuccess<WorkspacesResponseData> = { data };

      return reply.code(200).send(response);
    },
  );
}
