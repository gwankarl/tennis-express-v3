import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../http/contract.js';
import { apiErrorResponseSchema } from '../../http/contract.js';
import { requireWorkspaceAccess } from '../../http/guards/authorize-workspace.js';
import {
  CatalogProductServiceError,
  createCatalogProduct,
  getAdminCatalogProduct,
  listAdminCatalogProducts,
  updateCatalogProduct,
} from './product.service.js';
import type {
  CatalogProductPagination,
  CreateCatalogProductInput,
  UpdateCatalogProductInput,
} from './product.service.js';
import { CatalogProductValidationError } from './product-validation.js';
import {
  catalogProductDetailResponseSchema,
  catalogProductListQuerySchema,
  catalogProductListResponseSchema,
  catalogProductParamsSchema,
  createCatalogProductRequestSchema,
  updateCatalogProductRequestSchema,
} from './product-admin.schema.js';

interface ProductParams {
  id: string;
}

interface ProductQuery {
  limit?: number;
  offset?: number;
}

function requestError(requestId: string): ApiErrorResponse {
  return {
    error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    requestId,
  };
}

function sendProductServiceError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof CatalogProductValidationError) {
    return reply.code(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: [{ field: error.field, rule: error.rule }],
      },
      requestId: request.id,
    } satisfies ApiErrorResponse);
  }

  if (!(error instanceof CatalogProductServiceError)) {
    throw error;
  }

  const isValidation = error.statusCode === 400;

  return reply.code(error.statusCode).send({
    error: {
      code: isValidation ? 'VALIDATION_ERROR' : 'REQUEST_ERROR',
      message: isValidation ? 'Request validation failed' : 'Request failed',
      ...(isValidation ? { details: [{ field: error.field, rule: error.rule }] } : {}),
    },
    requestId: request.id,
  } satisfies ApiErrorResponse);
}

export function registerCatalogProductAdminRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: ProductQuery }>(
    '/api/v1/admin/catalog/products',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'List catalog products for administration',
        querystring: catalogProductListQuerySchema,
        response: {
          200: catalogProductListResponseSchema,
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

      if (!app.db) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const pagination: CatalogProductPagination = {
          limit: request.query.limit ?? 25,
          offset: request.query.offset ?? 0,
        };
        const result = await listAdminCatalogProducts(app.db, pagination);
        const response: ApiSuccess<typeof result> = { data: result };
        return reply.code(200).send(response);
      } catch (error) {
        return sendProductServiceError(error, request, reply);
      }
    },
  );

  app.post<{ Body: CreateCatalogProductInput }>(
    '/api/v1/admin/catalog/products',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'Create a catalog product and its variants',
        body: createCatalogProductRequestSchema,
        response: {
          201: catalogProductDetailResponseSchema,
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

      if (!app.db) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const result = await createCatalogProduct(app.db, request.body);
        const response: ApiSuccess<typeof result> = { data: result };
        return reply.code(201).send(response);
      } catch (error) {
        return sendProductServiceError(error, request, reply);
      }
    },
  );

  app.get<{ Params: ProductParams }>(
    '/api/v1/admin/catalog/products/:id',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'Get a catalog product and its variants',
        params: catalogProductParamsSchema,
        response: {
          200: catalogProductDetailResponseSchema,
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

      if (!app.db) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const result = await getAdminCatalogProduct(app.db, request.params.id);
        const response: ApiSuccess<typeof result> = { data: result };
        return reply.code(200).send(response);
      } catch (error) {
        return sendProductServiceError(error, request, reply);
      }
    },
  );

  app.patch<{ Params: ProductParams; Body: UpdateCatalogProductInput }>(
    '/api/v1/admin/catalog/products/:id',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'Update a catalog product and its variants',
        params: catalogProductParamsSchema,
        body: updateCatalogProductRequestSchema,
        response: {
          200: catalogProductDetailResponseSchema,
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

      if (!app.db) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const result = await updateCatalogProduct(app.db, request.params.id, request.body);
        const response: ApiSuccess<typeof result> = { data: result };
        return reply.code(200).send(response);
      } catch (error) {
        return sendProductServiceError(error, request, reply);
      }
    },
  );
}
