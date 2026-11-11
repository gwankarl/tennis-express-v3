import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse, ApiSuccess } from '../../http/contract.js';
import { apiErrorResponseSchema } from '../../http/contract.js';
import {
  getPublicCatalogProduct,
  listPublicCatalogBrands,
  listPublicCatalogCategories,
  listPublicCatalogProducts,
} from './catalog-public.service.js';
import type { PublicCatalogProductQuery } from './catalog-public.service.js';
import {
  catalogPublicAttributeRuleSchema,
  catalogPublicBrandListResponseSchema,
  catalogPublicCategoryListResponseSchema,
  catalogPublicProductDetailResponseSchema,
  catalogPublicProductListQuerySchema,
  catalogPublicProductListResponseSchema,
  catalogPublicProductParamsSchema,
} from './catalog-public.schema.js';

interface ProductParams {
  id: string;
}

interface ProductQuery {
  limit?: number;
  offset?: number;
  categoryId?: string;
  brandId?: string;
}

function serviceUnavailable(requestId: string): ApiErrorResponse {
  return {
    error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' },
    requestId,
  };
}

export function registerCatalogPublicRoutes(app: FastifyInstance): void {
  app.addSchema(catalogPublicAttributeRuleSchema);

  app.get(
    '/api/v1/catalog/categories',
    {
      schema: {
        tags: ['Catalog'],
        summary: 'List active catalog categories and their attribute rules',
        response: {
          200: catalogPublicCategoryListResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      reply.header('cache-control', 'public, max-age=0, must-revalidate');

      if (!app.db) {
        return reply.code(503).send(serviceUnavailable(reply.request.id));
      }

      const data = await listPublicCatalogCategories(app.db);
      const response: ApiSuccess<typeof data> = { data };
      return reply.code(200).send(response);
    },
  );

  app.get(
    '/api/v1/catalog/brands',
    {
      schema: {
        tags: ['Catalog'],
        summary: 'List active catalog brands',
        response: {
          200: catalogPublicBrandListResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      reply.header('cache-control', 'public, max-age=0, must-revalidate');

      if (!app.db) {
        return reply.code(503).send(serviceUnavailable(reply.request.id));
      }

      const data = await listPublicCatalogBrands(app.db);
      const response: ApiSuccess<typeof data> = { data };
      return reply.code(200).send(response);
    },
  );

  app.get<{ Querystring: ProductQuery }>(
    '/api/v1/catalog/products',
    {
      schema: {
        tags: ['Catalog'],
        summary: 'List visible catalog products',
        querystring: catalogPublicProductListQuerySchema,
        response: {
          200: catalogPublicProductListResponseSchema,
          400: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'public, max-age=0, must-revalidate');

      if (!app.db) {
        return reply.code(503).send(serviceUnavailable(request.id));
      }

      const query: PublicCatalogProductQuery = {
        limit: request.query.limit ?? 25,
        offset: request.query.offset ?? 0,
        ...(request.query.categoryId ? { categoryId: request.query.categoryId } : {}),
        ...(request.query.brandId ? { brandId: request.query.brandId } : {}),
      };
      const data = await listPublicCatalogProducts(app.db, query);
      const response: ApiSuccess<typeof data> = { data };
      return reply.code(200).send(response);
    },
  );

  app.get<{ Params: ProductParams }>(
    '/api/v1/catalog/products/:id',
    {
      schema: {
        tags: ['Catalog'],
        summary: 'Get a visible catalog product and its variants',
        params: catalogPublicProductParamsSchema,
        response: {
          200: catalogPublicProductDetailResponseSchema,
          400: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'public, max-age=0, must-revalidate');

      if (!app.db) {
        return reply.code(503).send(serviceUnavailable(request.id));
      }

      const data = await getPublicCatalogProduct(app.db, request.params.id);

      if (!data) {
        return reply.code(404).send({
          error: { code: 'REQUEST_ERROR', message: 'Request failed' },
          requestId: request.id,
        } satisfies ApiErrorResponse);
      }

      const response: ApiSuccess<typeof data> = { data };
      return reply.code(200).send(response);
    },
  );
}
