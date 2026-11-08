import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

export interface FrontendServerConfig {
  backendApiBaseUrl: string;
  backendApiTimeoutMs: number;
  frontendOrigin: string;
  csrfSecret: string;
}

export type FrontendEnvSetting =
  'BACKEND_API_BASE_URL' | 'BACKEND_API_TIMEOUT_MS' | 'FRONTEND_ORIGIN' | 'CSRF_SECRET';

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
    frontendOrigin: parseFrontendOrigin(env.FRONTEND_ORIGIN),
    csrfSecret: parseCsrfSecret(env.CSRF_SECRET),
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
    const shellFrontendOrigin = process.env.FRONTEND_ORIGIN;
    const shellCsrfSecret = process.env.CSRF_SECRET;

    loadEnvFile(envFilePath);

    if (shellBaseUrl !== undefined) {
      process.env.BACKEND_API_BASE_URL = shellBaseUrl;
    }

    if (shellTimeout !== undefined) {
      process.env.BACKEND_API_TIMEOUT_MS = shellTimeout;
    }

    if (shellFrontendOrigin !== undefined) {
      process.env.FRONTEND_ORIGIN = shellFrontendOrigin;
    }

    if (shellCsrfSecret !== undefined) {
      process.env.CSRF_SECRET = shellCsrfSecret;
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

function parseFrontendOrigin(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new FrontendEnvValidationError('FRONTEND_ORIGIN', 'must be set to an HTTP(S) origin');
  }

  const origin = value.trim();

  try {
    const parsedUrl = new URL(origin);
    const hasOnlyRootPath = parsedUrl.pathname === '/' || parsedUrl.pathname === '';

    if (
      !['http:', 'https:'].includes(parsedUrl.protocol) ||
      parsedUrl.hostname.length === 0 ||
      parsedUrl.username.length > 0 ||
      parsedUrl.password.length > 0 ||
      !hasOnlyRootPath ||
      parsedUrl.search.length > 0 ||
      parsedUrl.hash.length > 0
    ) {
      throw new Error();
    }

    return parsedUrl.origin;
  } catch {
    throw new FrontendEnvValidationError(
      'FRONTEND_ORIGIN',
      'must be a valid HTTP(S) origin without a path, query, or fragment',
    );
  }
}

function parseCsrfSecret(value: string | undefined): string {
  if (value === undefined || new TextEncoder().encode(value.trim()).byteLength < 32) {
    throw new FrontendEnvValidationError('CSRF_SECRET', 'must contain at least 32 bytes');
  }

  return value.trim();
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
