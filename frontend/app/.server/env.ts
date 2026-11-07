import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

export interface FrontendServerConfig {
  backendApiBaseUrl: string;
  backendApiTimeoutMs: number;
}

export type FrontendEnvSetting = 'BACKEND_API_BASE_URL' | 'BACKEND_API_TIMEOUT_MS';

export class FrontendEnvValidationError extends Error {
  constructor(
    readonly setting: FrontendEnvSetting,
    message: string,
  ) {
    super(`${setting} ${message}`);
    this.name = 'FrontendEnvValidationError';
  }
}

let loadedConfig: FrontendServerConfig | undefined;

/**
 * Parses the server-only frontend environment settings without exposing their values.
 */
export function parseFrontendEnv(env: NodeJS.ProcessEnv): FrontendServerConfig {
  return {
    backendApiBaseUrl: parseBackendApiBaseUrl(env.BACKEND_API_BASE_URL),
    backendApiTimeoutMs: parseBackendApiTimeoutMs(env.BACKEND_API_TIMEOUT_MS),
  };
}

/**
 * Loads frontend/.env once, preserving values already supplied by the shell.
 */
export function loadFrontendConfig(): FrontendServerConfig {
  if (loadedConfig) {
    return loadedConfig;
  }

  const envFilePath = resolve(process.cwd(), '.env');

  if (existsSync(envFilePath)) {
    const shellBaseUrl = process.env.BACKEND_API_BASE_URL;
    const shellTimeout = process.env.BACKEND_API_TIMEOUT_MS;

    loadEnvFile(envFilePath);

    if (shellBaseUrl !== undefined) {
      process.env.BACKEND_API_BASE_URL = shellBaseUrl;
    }

    if (shellTimeout !== undefined) {
      process.env.BACKEND_API_TIMEOUT_MS = shellTimeout;
    }
  }

  loadedConfig = parseFrontendEnv(process.env);
  return loadedConfig;
}

function parseBackendApiBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new FrontendEnvValidationError(
      'BACKEND_API_BASE_URL',
      'must be set to an absolute HTTP(S) URL',
    );
  }

  const baseUrl = value.trim();

  try {
    const parsedUrl = new URL(baseUrl);

    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.hostname.length === 0) {
      throw new Error();
    }
  } catch {
    throw new FrontendEnvValidationError(
      'BACKEND_API_BASE_URL',
      'must be a valid absolute HTTP(S) URL',
    );
  }

  return baseUrl.replace(/\/+$/, '');
}

function parseBackendApiTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0 || !/^\d+$/.test(value.trim())) {
    throw new FrontendEnvValidationError(
      'BACKEND_API_TIMEOUT_MS',
      'must be a positive integer in milliseconds',
    );
  }

  const timeoutMs = Number(value.trim());

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new FrontendEnvValidationError(
      'BACKEND_API_TIMEOUT_MS',
      'must be a positive integer in milliseconds',
    );
  }

  return timeoutMs;
}
