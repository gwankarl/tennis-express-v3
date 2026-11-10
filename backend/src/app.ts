import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import type { EmailSender } from './infrastructure/email/email-sender.js';
import { registerRegistrationRoutes } from './modules/identity/accounts/registration.routes.js';
import { registerUserProfileRoutes } from './modules/identity/accounts/profile.routes.js';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { registerErrorHandlers } from './http/error-handler.js';
import { generateRequestId, setRequestIdHeader } from './http/request-context.js';
import type { DatabaseClient } from './infrastructure/database/client.js';
import { createLoggerOptions } from './infrastructure/logging/logger.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import type { WorkspaceAuthorizationSources } from './http/guards/authorize-workspace.js';
import { registerWorkspacesRoutes } from './modules/identity/accounts/workspaces.routes.js';
import { registerVerificationRoutes } from './modules/identity/verification/verification.routes.js';
import { registerSessionAuthRoutes } from './modules/identity/sessions/auth.routes.js';
import { registerPasswordRecoveryRoutes } from './modules/identity/passwords/password-recovery.routes.js';
import { registerPasswordChangeRoutes } from './modules/identity/passwords/password-change.routes.js';
import { registerAuthenticationContext } from './http/guards/authenticate.js';
import type { AdminMfaConfig } from './config/env.js';
import { registerAdminMfaRoutes } from './modules/identity/admin/admin-mfa.routes.js';
import { registerSellerApplicationRoutes } from './modules/seller-onboarding/application.routes.js';
import fastifyMultipart from '@fastify/multipart';
import {
  PrivateEvidenceFileStore,
  MAX_EVIDENCE_FILE_BYTES,
} from './infrastructure/storage/private-evidence-file-store.js';
import { registerSellerApplicationEvidenceRoutes } from './modules/seller-onboarding/application-evidence.routes.js';
import { registerSellerApplicationEvidenceReadRoutes } from './modules/seller-onboarding/application-evidence-read.routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseClient['db'] | null;
    emailSender: EmailSender | null;
    frontendOrigin: string;
    mfaPool: DatabaseClient['pool'] | null;
    adminMfaConfig: import('./config/env.js').AdminMfaConfig | null;
    evidenceFileStore: PrivateEvidenceFileStore | null;
  }
}

export interface AppOptions {
  database?: DatabaseClient;
  emailSender?: EmailSender;
  frontendOrigin?: string;
  workspaceAuthorizationSources?: WorkspaceAuthorizationSources;
  adminMfa?: AdminMfaConfig;
  evidenceFileStore?: PrivateEvidenceFileStore;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: createLoggerOptions(),
    genReqId: generateRequestId,
    requestIdHeader: false,
  });

  registerAuthenticationContext(app);

  app.register(fastifyMultipart, {
    limits: {
      files: 1,
      fields: 0,
      fileSize: MAX_EVIDENCE_FILE_BYTES,
    },
  });

  app.decorate('db', options.database?.db ?? null);
  app.decorate('mfaPool', options.database?.pool ?? null);
  app.decorate('adminMfaConfig', options.adminMfa ?? null);
  app.decorate('emailSender', options.emailSender ?? null);
  app.decorate('frontendOrigin', options.frontendOrigin ?? 'http://127.0.0.1:5173');
  app.decorate('evidenceFileStore', options.evidenceFileStore ?? null);

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

  app.register(fastifyRateLimit, {
    global: false,
    hook: 'onRequest',
  });

  registerHealthRoutes(app);

  app.after((error) => {
    if (error) {
      throw error;
    }

    registerRegistrationRoutes(app);
    registerVerificationRoutes(app);
    registerSessionAuthRoutes(app);
    registerPasswordRecoveryRoutes(app);
    registerPasswordChangeRoutes(app);
    registerUserProfileRoutes(app);
    registerWorkspacesRoutes(app, options.workspaceAuthorizationSources);
    registerSellerApplicationRoutes(app);
    registerSellerApplicationEvidenceRoutes(app);
    registerSellerApplicationEvidenceReadRoutes(app);
    registerAdminMfaRoutes(app);
  });

  return app;
}
