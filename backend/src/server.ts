import { buildApp } from './app.js';
import { type BackendConfig, EnvValidationError, loadBackendEnv, parseEnv } from './config/env.js';
import type { FastifyInstance } from 'fastify';
import { createDatabaseClient, type DatabaseClient } from './infrastructure/database/client.js';
import { createSmtpEmailSender } from './infrastructure/email/smtp-email-sender.js';
import { PrivateEvidenceFileStore } from './infrastructure/storage/private-evidence-file-store.js';
import { sellerApplicationEvidence } from './modules/seller-onboarding/application-evidence.table.js';

function registerShutdownHandlers(app: FastifyInstance): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    app.log.info({ signal }, 'Backend server shutting down');

    try {
      await app.close();
      app.log.info({ signal }, 'Backend server stopped');
    } catch {
      app.log.error({ signal }, 'Backend server shutdown failed');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return undefined;
}

async function startServer(): Promise<void> {
  let config: BackendConfig;

  try {
    loadBackendEnv();
    config = parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(`Invalid backend configuration: ${error.message}`);
    } else {
      console.error('Unable to load backend/.env.');
    }

    process.exitCode = 1;
    return;
  }

  let database: DatabaseClient | undefined;
  let app: FastifyInstance | undefined;

  try {
    database = createDatabaseClient(config.databaseUrl);
    const emailSender =
      config.email.enabled && config.email.smtp
        ? createSmtpEmailSender(config.email.smtp)
        : undefined;

    const evidenceFileStore = new PrivateEvidenceFileStore(config.sellerEvidenceStorageDirectory);
    await evidenceFileStore.initialize();
    await evidenceFileStore.cleanupAbandonedStaging();
    const referencedEvidence = await database.db
      .select({ storageKey: sellerApplicationEvidence.storageKey })
      .from(sellerApplicationEvidence);
    await evidenceFileStore.cleanupOrphanedObjects(
      new Set(referencedEvidence.map(({ storageKey }) => storageKey)),
    );

    app = buildApp({
      database,
      emailSender,
      frontendOrigin: config.email.frontendOrigin,
      adminMfa: config.adminMfa,
      evidenceFileStore,
    });

    database.pool.on('error', (error) => {
      app?.log.error({ errorCode: getErrorCode(error) }, 'Idle PostgreSQL connection failed');
    });

    await app.listen({
      host: config.host,
      port: config.port,
    });

    app.log.info({ host: config.host, port: config.port }, 'Backend server started');
    registerShutdownHandlers(app);
  } catch (error) {
    const errorCode = getErrorCode(error);

    if (app) {
      app.log.error({ errorCode }, 'Backend server startup failed');

      try {
        await app.close();
      } catch {
        app.log.error('Fastify cleanup after startup failure failed');
      }
    } else {
      console.error('Backend server startup failed.');
    }

    if (database) {
      try {
        await database.close();
      } catch {
        app?.log.error('Database pool cleanup after startup failure failed');
      }
    }

    process.exitCode = 1;
  }
}

void startServer();
