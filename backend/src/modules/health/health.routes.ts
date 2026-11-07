import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { apiErrorResponseSchema, type ApiSuccess } from '../../http/contract.js';
import {
  healthResponseSchema,
  readinessResponseSchema,
  type HealthResponseData,
  type ReadinessResponseData,
} from './health.schema.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get(
    '/api/v1/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Check API health',
        description: 'Checks that the backend can serve requests without querying PostgreSQL.',
        response: {
          200: {
            ...healthResponseSchema,
            description: 'The backend is available.',
          },
          400: {
            ...apiErrorResponseSchema,
            description: 'The request is invalid.',
          },
          404: {
            ...apiErrorResponseSchema,
            description: 'The route was not found.',
          },
          500: {
            ...apiErrorResponseSchema,
            description: 'An unexpected error occurred.',
          },
        },
      },
    },
    async (): Promise<ApiSuccess<HealthResponseData>> => ({
      data: { status: 'ok' },
    }),
  );

  app.get(
    '/api/v1/ready',
    {
      schema: {
        tags: ['Health'],
        summary: 'Check backend readiness',
        description: 'Runs a bounded PostgreSQL readiness query.',
        response: {
          200: {
            ...readinessResponseSchema,
            description: 'The backend and database are ready.',
          },
          503: {
            ...apiErrorResponseSchema,
            description: 'The database is unavailable.',
          },
        },
      },
    },
    async (request, reply): Promise<ApiSuccess<ReadinessResponseData> | void> => {
      const unavailable = () =>
        reply.code(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Database unavailable',
          },
          requestId: request.id,
        });

      if (!app.db) {
        request.log.error(
          { statusCode: 503, requestId: request.id },
          'Database readiness check failed',
        );
        return unavailable();
      }

      try {
        await app.db.execute(sql`SELECT 1`);

        return reply.code(200).send({
          data: { status: 'ready' },
        });
      } catch {
        request.log.error(
          { statusCode: 503, requestId: request.id },
          'Database readiness check failed',
        );
        return unavailable();
      }
    },
  );
}
