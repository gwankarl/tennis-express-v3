import Fastify, { type FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { registerErrorHandlers } from './http/error-handler.js';
import { generateRequestId, setRequestIdHeader } from './http/request-context.js';
import type { DatabaseClient } from './infrastructure/database/client.js';
import { createLoggerOptions } from './infrastructure/logging/logger.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseClient['db'] | null;
  }
}

export interface AppOptions {
  database?: DatabaseClient;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: createLoggerOptions(),
    genReqId: generateRequestId,
    requestIdHeader: false,
  });

  app.decorate('db', options.database?.db ?? null);

  if (options.database) {
    app.addHook('onClose', async () => {
      await options.database?.close();
    });
  }

  app.addHook('onRequest', setRequestIdHeader);
  registerErrorHandlers(app);

  if (process.env.NODE_ENV !== 'production') {
    app.register(fastifySwagger, {
      openapi: {
        openapi: '3.0.3',
        info: {
          title: 'Tennis Xpress API',
          description: 'Versioned HTTP API for Tennis Xpress.',
          version: '1.0.0',
        },
      },
    });

    app.register(fastifySwaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
      staticCSP: true,
    });
  }

  registerHealthRoutes(app);

  return app;
}
