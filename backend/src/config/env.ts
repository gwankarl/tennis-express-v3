import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

export interface BackendConfig {
  host: string;
  port: number;
  databaseUrl: string;
}

export type EnvSetting = 'HOST' | 'PORT' | 'DATABASE_URL';

export class EnvValidationError extends Error {
  constructor(
    readonly setting: EnvSetting,
    message: string,
  ) {
    super(`${setting} ${message}`);
    this.name = 'EnvValidationError';
  }
}

export function loadBackendEnv(): void {
  const envFilePath = resolve(__dirname, '../../.env');

  if (!existsSync(envFilePath)) {
    return;
  }

  const shellHost = process.env.HOST;
  const shellPort = process.env.PORT;
  const shellDatabaseUrl = process.env.DATABASE_URL;

  loadEnvFile(envFilePath);

  if (shellHost !== undefined) {
    process.env.HOST = shellHost;
  }

  if (shellPort !== undefined) {
    process.env.PORT = shellPort;
  }

  if (shellDatabaseUrl !== undefined) {
    process.env.DATABASE_URL = shellDatabaseUrl;
  }
}

export function parseEnv(env: NodeJS.ProcessEnv): BackendConfig {
  return {
    host: parseHost(env.HOST),
    port: parsePort(env.PORT),
    databaseUrl: parseDatabaseUrl(env.DATABASE_URL),
  };
}

function parseHost(value: string | undefined): string {
  if (value === undefined) {
    return '127.0.0.1';
  }

  const host = value.trim();

  if (host.length === 0) {
    throw new EnvValidationError('HOST', 'must not be blank');
  }

  return host;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 3000;
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0 || !/^\d+$/.test(normalizedValue)) {
    throw new EnvValidationError('PORT', 'must be an integer from 1 to 65535');
  }

  const port = Number(normalizedValue);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new EnvValidationError('PORT', 'must be an integer from 1 to 65535');
  }

  return port;
}

function parseDatabaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new EnvValidationError('DATABASE_URL', 'must be set to a PostgreSQL connection URL');
  }

  const databaseUrl = value.trim();

  try {
    const parsedUrl = new URL(databaseUrl);
    const validProtocol = ['postgres:', 'postgresql:'].includes(parsedUrl.protocol);
    const hasHost = parsedUrl.hostname.length > 0;
    const hasDatabase = parsedUrl.pathname.length > 1;

    if (!validProtocol || !hasHost || !hasDatabase) {
      throw new Error();
    }
  } catch {
    throw new EnvValidationError('DATABASE_URL', 'must be a valid PostgreSQL connection URL');
  }

  return databaseUrl;
}
