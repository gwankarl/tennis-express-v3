import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../http/contract.js';
import { apiErrorResponseSchema } from '../../http/contract.js';
import { requireWorkspaceAccess } from '../../http/guards/authorize-workspace.js';
import {
  createSellerListing,
  getSellerListing,
  listSellerListings,
  SellerListingServiceError,
  updateSellerListingDraft,
  type CreateSellerListingInput,
  type SellerListingPagination,
  type UpdateSellerListingDraftInput,
} from './listing.service.js';
import {
  createSellerListingRequestSchema,
  sellerListingIdParamsSchema,
  sellerListingListResponseSchema,
  sellerListingPaginationQuerySchema,
  sellerListingResponseSchema,
  updateSellerListingDraftRequestSchema,
} from './listing.schema.js';

interface ListingParams {
  id: string;
}

interface ListingQuery {
  limit?: number;
  offset?: number;
}

function requestError(requestId: string): ApiErrorResponse {
  return {
    error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    requestId,
  };
}

function sendServiceError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (!(error instanceof SellerListingServiceError)) {
    throw error;
  }

  const isValidation = error.statusCode === 400;

  return reply.code(error.statusCode).send({
    error: {
      code: isValidation ? 'VALIDATION_ERROR' : 'REQUEST_ERROR',
      message: isValidation ? 'Request validation failed' : 'Request failed',
      ...(isValidation && error.field && error.rule
        ? { details: [{ field: error.field, rule: error.rule }] }
        : {}),
    },
    requestId: request.id,
  } satisfies ApiErrorResponse);
}

export function registerSellerListingRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateSellerListingInput }>(
    '/api/v1/seller/listings',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Create a seller listing draft',
        body: createSellerListingRequestSchema,
        response: {
          201: sellerListingResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const listing = await createSellerListing(
          app.db,
          request.identitySession.userId,
          request.body,
        );
        const response: ApiSuccess<{ listing: typeof listing }> = {
          data: { listing },
        };

        return reply.code(201).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );

  app.get<{ Querystring: ListingQuery }>(
    '/api/v1/seller/listings',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'List the authenticated seller’s listings',
        querystring: sellerListingPaginationQuerySchema,
        response: {
          200: sellerListingListResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const pagination: SellerListingPagination = {
          limit: request.query.limit ?? 25,
          offset: request.query.offset ?? 0,
        };
        const result = await listSellerListings(app.db, request.identitySession.userId, pagination);
        const response: ApiSuccess<typeof result> = { data: result };

        return reply.code(200).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );

  app.get<{ Params: ListingParams }>(
    '/api/v1/seller/listings/:id',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Get an owned seller listing',
        params: sellerListingIdParamsSchema,
        response: {
          200: sellerListingResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const listing = await getSellerListing(
          app.db,
          request.identitySession.userId,
          request.params.id,
        );
        const response: ApiSuccess<{ listing: typeof listing }> = {
          data: { listing },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );

  app.patch<{
    Params: ListingParams;
    Body: UpdateSellerListingDraftInput;
  }>(
    '/api/v1/seller/listings/:id/draft',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Update an owned listing draft',
        params: sellerListingIdParamsSchema,
        body: updateSellerListingDraftRequestSchema,
        response: {
          200: sellerListingResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const listing = await updateSellerListingDraft(
          app.db,
          request.identitySession.userId,
          request.params.id,
          request.body,
        );
        const response: ApiSuccess<{ listing: typeof listing }> = {
          data: { listing },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );
}
