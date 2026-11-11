import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../http/contract.js';
import { apiErrorResponseSchema } from '../../http/contract.js';
import { requireWorkspaceAccess } from '../../http/guards/authorize-workspace.js';
import {
  CatalogReferenceAdminServiceError,
  createAdminCatalogBrand,
  createAdminCatalogCategory,
  getAdminCatalogBrand,
  getAdminCatalogCategory,
  listAdminCatalogBrands,
  listAdminCatalogCategories,
  updateAdminCatalogBrand,
  updateAdminCatalogCategory,
} from './catalog-reference-admin.service.js';
import type {
  CreateCatalogBrandInput,
  CreateCatalogCategoryInput,
  UpdateCatalogBrandInput,
  UpdateCatalogCategoryInput,
} from './catalog-reference-admin.service.js';
import {
  catalogBrandDetailResponseSchema,
  catalogBrandListResponseSchema,
  catalogCategoryDetailResponseSchema,
  catalogCategoryListResponseSchema,
  catalogReferenceListQuerySchema,
  catalogReferenceParamsSchema,
  createCatalogBrandRequestSchema,
  createCatalogCategoryRequestSchema,
  updateCatalogBrandRequestSchema,
  updateCatalogCategoryRequestSchema,
} from './catalog-reference-admin.schema.js';

interface ReferenceParams {
  id: string;
}

interface ReferenceQuery {
  limit?: number;
  offset?: number;
}

function requestError(requestId: string): ApiErrorResponse {
  return {
    error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    requestId,
  };
}

function sendCatalogReferenceError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (!(error instanceof CatalogReferenceAdminServiceError)) {
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

export function registerCatalogReferenceAdminRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: ReferenceQuery }>(
    '/api/v1/admin/catalog/categories',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'List catalog categories for administration',
        querystring: catalogReferenceListQuerySchema,
        response: {
          200: catalogCategoryListResponseSchema,
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
        const result = await listAdminCatalogCategories(app.db, {
          limit: request.query.limit ?? 25,
          offset: request.query.offset ?? 0,
        });
        const response: ApiSuccess<typeof result> = { data: result };
        return reply.code(200).send(response);
      } catch (error) {
        return sendCatalogReferenceError(error, request, reply);
      }
    },
  );

  app.post<{ Body: CreateCatalogCategoryInput }>(
    '/api/v1/admin/catalog/categories',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'Create a catalog category',
        body: createCatalogCategoryRequestSchema,
        response: {
          201: catalogCategoryDetailResponseSchema,
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
        const category = await createAdminCatalogCategory(app.db, request.body);
        const response: ApiSuccess<{ category: typeof category }> = {
          data: { category },
        };
        return reply.code(201).send(response);
      } catch (error) {
        return sendCatalogReferenceError(error, request, reply);
      }
    },
  );

  app.get<{ Params: ReferenceParams }>(
    '/api/v1/admin/catalog/categories/:id',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'Get a catalog category for administration',
        params: catalogReferenceParamsSchema,
        response: {
          200: catalogCategoryDetailResponseSchema,
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
        const category = await getAdminCatalogCategory(app.db, request.params.id);
        const response: ApiSuccess<{ category: typeof category }> = {
          data: { category },
        };
        return reply.code(200).send(response);
      } catch (error) {
        return sendCatalogReferenceError(error, request, reply);
      }
    },
  );

  app.patch<{ Params: ReferenceParams; Body: UpdateCatalogCategoryInput }>(
    '/api/v1/admin/catalog/categories/:id',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'Update a catalog category',
        params: catalogReferenceParamsSchema,
        body: updateCatalogCategoryRequestSchema,
        response: {
          200: catalogCategoryDetailResponseSchema,
          400: apiErrorResponseSchema,
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
        const category = await updateAdminCatalogCategory(app.db, request.params.id, request.body);
        const response: ApiSuccess<{ category: typeof category }> = {
          data: { category },
        };
        return reply.code(200).send(response);
      } catch (error) {
        return sendCatalogReferenceError(error, request, reply);
      }
    },
  );

  app.get<{ Querystring: ReferenceQuery }>(
    '/api/v1/admin/catalog/brands',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'List catalog brands for administration',
        querystring: catalogReferenceListQuerySchema,
        response: {
          200: catalogBrandListResponseSchema,
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
        const result = await listAdminCatalogBrands(app.db, {
          limit: request.query.limit ?? 25,
          offset: request.query.offset ?? 0,
        });
        const response: ApiSuccess<typeof result> = { data: result };
        return reply.code(200).send(response);
      } catch (error) {
        return sendCatalogReferenceError(error, request, reply);
      }
    },
  );

  app.post<{ Body: CreateCatalogBrandInput }>(
    '/api/v1/admin/catalog/brands',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'Create a catalog brand',
        body: createCatalogBrandRequestSchema,
        response: {
          201: catalogBrandDetailResponseSchema,
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
        const brand = await createAdminCatalogBrand(app.db, request.body);
        const response: ApiSuccess<{ brand: typeof brand }> = {
          data: { brand },
        };
        return reply.code(201).send(response);
      } catch (error) {
        return sendCatalogReferenceError(error, request, reply);
      }
    },
  );

  app.get<{ Params: ReferenceParams }>(
    '/api/v1/admin/catalog/brands/:id',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'Get a catalog brand for administration',
        params: catalogReferenceParamsSchema,
        response: {
          200: catalogBrandDetailResponseSchema,
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
        const brand = await getAdminCatalogBrand(app.db, request.params.id);
        const response: ApiSuccess<{ brand: typeof brand }> = {
          data: { brand },
        };
        return reply.code(200).send(response);
      } catch (error) {
        return sendCatalogReferenceError(error, request, reply);
      }
    },
  );

  app.patch<{ Params: ReferenceParams; Body: UpdateCatalogBrandInput }>(
    '/api/v1/admin/catalog/brands/:id',
    {
      preHandler: requireWorkspaceAccess('admin'),
      schema: {
        tags: ['Admin catalog'],
        summary: 'Update a catalog brand',
        params: catalogReferenceParamsSchema,
        body: updateCatalogBrandRequestSchema,
        response: {
          200: catalogBrandDetailResponseSchema,
          400: apiErrorResponseSchema,
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
        const brand = await updateAdminCatalogBrand(app.db, request.params.id, request.body);
        const response: ApiSuccess<{ brand: typeof brand }> = {
          data: { brand },
        };
        return reply.code(200).send(response);
      } catch (error) {
        return sendCatalogReferenceError(error, request, reply);
      }
    },
  );
}
