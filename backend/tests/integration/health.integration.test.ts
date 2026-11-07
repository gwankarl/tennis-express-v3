import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiErrorResponse } from '../../src/http/contract.js';
import { buildApp } from '../../src/app.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../src/infrastructure/database/client.js';
import { requireTestDatabaseUrl, verifyTestDatabaseIdentity } from '../helpers/test-database.js';

describe('health and readiness PostgreSQL integration', () => {
  const databaseClients: DatabaseClient[] = [];
  const apps: FastifyInstance[] = [];
  let readyApp: FastifyInstance;

  beforeAll(async () => {
    const connectionString = requireTestDatabaseUrl(process.env);
    const database = createDatabaseClient(connectionString);
    databaseClients.push(database);

    await verifyTestDatabaseIdentity(database.pool);

    readyApp = buildApp({ database });
    apps.push(readyApp);
    await readyApp.ready();
  });

  afterAll(async () => {
    try {
      await Promise.all(apps.map((app) => app.close()));
    } finally {
      await Promise.all(databaseClients.map((database) => database.close()));
    }
  });

  it('returns 200 from readiness when SELECT 1 succeeds', async () => {
    const response = await readyApp.inject({
      method: 'GET',
      url: '/api/v1/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { status: 'ready' },
    });
  });

  it('returns a safe 503 on database failure while health remains 200', async () => {
    const connectionString = requireTestDatabaseUrl(process.env);
    const failedDatabase = createDatabaseClient(connectionString);
    databaseClients.push(failedDatabase);

    // Ending this test-owned pool makes the readiness query fail deterministically.
    await failedDatabase.close();

    const failedApp = buildApp({ database: failedDatabase });
    apps.push(failedApp);
    await failedApp.ready();

    const readiness = await failedApp.inject({
      method: 'GET',
      url: '/api/v1/ready',
    });

    expect(readiness.statusCode).toBe(503);

    const errorBody = readiness.json() as ApiErrorResponse;
    expect(errorBody.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(errorBody.error.message).toBe('Database unavailable');
    expect(errorBody.requestId).toBe(readiness.headers['x-request-id']);

    const health = await failedApp.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({
      data: { status: 'ok' },
    });
  });
});
